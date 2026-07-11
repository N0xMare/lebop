import chalk from "chalk";
import type { Command } from "commander";
import { invalidateTeamMetadata } from "../lib/cache.ts";
import { findGitRoot, hashRepoRoot, resolveConfig } from "../lib/config.ts";
import { envelope } from "../lib/envelope.ts";
import { getTeamMetadata } from "../lib/resolve.ts";
import {
  buildLabelCreateInputFromCli,
  buildLabelDeleteInputFromCli,
  buildLabelListInputFromCli,
  executeLabelCreate,
  executeLabelDelete,
  executeLabelList,
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
    .option("--json", "emit structured records")
    .action(
      async (opts: { team?: string; workspaceOnly?: boolean; all?: boolean; json?: boolean }) => {
        const result = await executeLabelList(buildLabelListInputFromCli({ opts }));

        if (opts.json) {
          process.stdout.write(`${JSON.stringify(envelope(labelListPayload(result)), null, 2)}\n`);
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
    .option("--json", "emit structured result")
    .action(
      async (
        name: string,
        opts: {
          team?: string;
          workspaceScoped?: boolean;
          color?: string;
          description?: string;
          json?: boolean;
        },
      ) => {
        const created = await executeLabelCreate(buildLabelCreateInputFromCli({ name, opts }), {
          resolveTeamKey: resolveLabelCreateTeamKey,
        });
        await invalidateTeamMetadata(created.repoHash ?? currentRepoHash(), created.invalidateTeam);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(envelope({ label: created.label }), null, 2)}\n`);
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} created ${chalk.bold(created.label.name)} ${chalk.gray(`(${created.label.id})`)}\n`,
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
    .option("--json", "emit structured result")
    .action(
      async (
        nameOrId: string,
        opts: { team?: string; scope?: string; yes?: boolean; json?: boolean },
      ) => {
        const r = await executeLabelDelete(buildLabelDeleteInputFromCli({ nameOrId, opts }));
        if (r.mutated) {
          await invalidateTeamMetadata(currentRepoHash(), r.team ?? undefined);
        }
        if (r.status === "deleted" && !r.success) process.exitCode = 1;
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(
              envelope({
                id: r.id,
                selector: r.selector,
                scope: r.scope,
                team: r.team,
                status: r.status,
                success: r.success,
              }),
              null,
              2,
            )}\n`,
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
