import chalk from "chalk";
import type { Command } from "commander";
import { invalidateTeamMetadata } from "../lib/cache.ts";
import { findGitRoot, hashRepoRoot, resolveConfig } from "../lib/config.ts";
import { wantsMachineOutput } from "../lib/encode.ts";
import { writeMachineEnvelope } from "../lib/output.ts";
import { getTeamMetadata } from "../lib/resolve.ts";
import {
  buildLabelCreateInputFromCli,
  buildLabelDeleteInputFromCli,
  buildLabelListInputFromCli,
  buildLabelUpdateInputFromCli,
  executeLabelCreate,
  executeLabelDelete,
  executeLabelList,
  executeLabelUpdate,
  labelListPayload,
} from "../surface/labels.ts";

/**
 * `lebop label list|create|delete` — workspace + team-scoped label management.
 */
export function registerLabel(program: Command): void {
  const cmd = program.command("label").description("manage Linear labels");

  cmd
    .command("list")
    .description("list labels in the current team (default) or workspace")
    .option("--team <key>", "override the resolved team")
    .option("--workspace-only", "only labels with no team scope")
    .option("--all", "every label the token can see (no scope filter)")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (opts: {
        team?: string;
        workspaceOnly?: boolean;
        all?: boolean;
        json?: boolean;
        format?: string;
        pretty?: boolean;
      }) => {
        const result = await executeLabelList(buildLabelListInputFromCli({ opts }));

        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope(
            {
              ...labelListPayload(result),
              next: ["list --label <name>", "label create", "set labels <id> …"],
            } as Record<string, unknown>,
            {
              json: true,
              format: opts.format,
              pretty: opts.pretty,
            },
          );
          return;
        }

        if (result.labels.length === 0) {
          process.stdout.write("no labels\n");
          return;
        }
        const nameWidth = Math.max(...result.labels.map((l) => l.name.length));
        for (const l of result.labels) {
          const scope = l.team ? chalk.gray(`[${l.team.key}]`) : chalk.cyan("[workspace]");
          const desc = l.description ? chalk.gray(` — ${l.description}`) : "";
          process.stdout.write(`${chalk.bold(l.name.padEnd(nameWidth))}  ${scope}${desc}\n`);
        }
      },
    );

  cmd
    .command("create <name>")
    .description("create a label (team-scoped by default; --workspace-scoped for workspace)")
    .option("--team <key>", "override the resolved team")
    .option(
      "--workspace-scoped",
      "create a workspace-scoped label (no team). Renamed from --workspace to avoid clashing with the top-level --workspace <slug> flag.",
    )
    .option("--color <hex>", "hex color (e.g. #ff0000)")
    .option("--description <text>")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (
        name: string,
        opts: {
          team?: string;
          workspaceScoped?: boolean;
          color?: string;
          description?: string;
          json?: boolean;
          format?: string;
          pretty?: boolean;
        },
      ) => {
        const created = await executeLabelCreate(buildLabelCreateInputFromCli({ name, opts }), {
          resolveTeamKey: resolveLabelCreateTeamKey,
        });
        await invalidateTeamMetadata(created.repoHash ?? currentRepoHash(), created.invalidateTeam);
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope({ label: created.label } as Record<string, unknown>, {
            json: true,
            format: opts.format,
            pretty: opts.pretty,
          });
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} created ${chalk.bold(created.label.name)} ${chalk.gray(`(${created.label.id})`)}\n`,
        );
      },
    );

  cmd
    .command("update <id>")
    .description("update a label by UUID (name, color, description)")
    .option("--name <text>", "new label name")
    .option("--color <hex>", "hex color (e.g. #ff0000)")
    .option("--description <text>", "description (pass empty string to clear)")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (
        id: string,
        opts: {
          name?: string;
          color?: string;
          description?: string;
          json?: boolean;
          format?: string;
          pretty?: boolean;
        },
      ) => {
        const label = await executeLabelUpdate(buildLabelUpdateInputFromCli({ id, opts }));
        await invalidateTeamMetadata(currentRepoHash(), label.team?.key ?? undefined);
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope({ label } as Record<string, unknown>, {
            json: true,
            format: opts.format,
            pretty: opts.pretty,
          });
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} updated ${chalk.bold(label.name)} ${chalk.gray(`(${label.id})`)}\n`,
        );
      },
    );

  cmd
    .command("delete <name-or-id>")
    .description(
      "delete a label by name or UUID (irreversible — requires --yes). errors if name is ambiguous",
    )
    .option("--team <key>", "team scope for name lookup")
    .option("--scope <scope>", "name lookup scope: team|workspace", "team")
    .option("--yes", "confirm destructive operation (required)")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (
        nameOrId: string,
        opts: {
          team?: string;
          scope?: string;
          yes?: boolean;
          json?: boolean;
          format?: string;
          pretty?: boolean;
        },
      ) => {
        const r = await executeLabelDelete(buildLabelDeleteInputFromCli({ nameOrId, opts }));
        if (r.mutated) {
          await invalidateTeamMetadata(currentRepoHash(), r.team ?? undefined);
        }
        if (r.status === "deleted" && !r.success) process.exitCode = 1;
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope(
            {
              id: r.id,
              selector: r.selector,
              scope: r.scope,
              team: r.team,
              status: r.status,
              success: r.success,
            } as Record<string, unknown>,
            { json: true, format: opts.format, pretty: opts.pretty },
          );
          return;
        }
        if (r.status === "already-absent") {
          process.stdout.write(`${chalk.gray("✓")} already absent: ${chalk.bold(r.id)} (no-op)\n`);
        } else if (r.success) {
          process.stdout.write(`${chalk.green("✓")} deleted ${chalk.bold(r.id)}\n`);
        } else {
          process.stdout.write(`${chalk.red("✗")} delete failed for ${r.id}\n`);
        }
      },
    );
}

function currentRepoHash(): string {
  const repoRoot = findGitRoot(process.cwd());
  return repoRoot ? hashRepoRoot(repoRoot) : "_global";
}

async function resolveLabelCreateTeamKey(team: string | undefined): Promise<{
  teamId: string;
  teamKey: string;
  repoHash: string;
}> {
  const config = await resolveConfig({ teamOverride: team });
  return {
    repoHash: config.repoHash,
    teamKey: config.team,
    teamId: (await getTeamMetadata(config.repoHash, config.team)).team_id,
  };
}
