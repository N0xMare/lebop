import chalk from "chalk";
import type { Command } from "commander";
import { invalidateTeamMetadata } from "../lib/cache.ts";
import { findGitRoot, hashRepoRoot, resolveConfig } from "../lib/config.ts";
import { envelope } from "../lib/envelope.ts";
import { NotFoundError, tryIdempotentDelete, ValidationError } from "../lib/errors.ts";
import { createLabel, deleteLabel, listLabels, resolveLabelSelectorToId } from "../lib/labels.ts";
import { getTeamMetadata } from "../lib/resolve.ts";
import { getTeam } from "../lib/teams.ts";

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
        const teamScope =
          opts.workspaceOnly || opts.all
            ? undefined
            : (await resolveConfig({ teamOverride: opts.team })).team;
        if (!opts.workspaceOnly && !opts.all && teamScope) {
          const team = await getTeam(teamScope);
          if (!team) {
            throw new NotFoundError(
              `team not found: ${teamScope}`,
              "use `lebop teams` to see available team keys; or pass --workspace-only to skip team scoping",
            );
          }
        }
        const labels = await listLabels({
          team: teamScope,
          workspaceOnly: opts.workspaceOnly,
          all: opts.all,
        });

        if (opts.json) {
          const scope = opts.all
            ? { type: "all" as const, team: null }
            : opts.workspaceOnly
              ? { type: "workspace" as const, team: null }
              : { type: "team" as const, team: teamScope ?? null };
          process.stdout.write(
            `${JSON.stringify(
              envelope({
                scope,
                team: teamScope ?? null,
                count: labels.length,
                labels,
              }),
              null,
              2,
            )}\n`,
          );
          return;
        }

        if (labels.length === 0) {
          process.stdout.write("no labels\n");
          return;
        }
        const nameWidth = Math.max(...labels.map((l) => l.name.length));
        for (const l of labels) {
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
        const scope = opts.workspaceScoped
          ? {
              repoHash: currentRepoHash(),
              team: undefined,
              teamId: undefined,
            }
          : await resolveLabelCreateScope(opts.team);
        const teamId = scope.teamId;
        const created = await createLabel({
          name,
          teamId,
          color: opts.color,
          description: opts.description,
        });
        await invalidateTeamMetadata(scope.repoHash, scope.team);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(envelope({ label: created }), null, 2)}\n`);
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} created ${chalk.bold(created.name)} ${chalk.gray(`(${created.id})`)}\n`,
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
        if (!opts.yes) {
          throw new ValidationError(
            `refusing to delete label ${nameOrId} without --yes`,
            "re-run with --yes to confirm. This removes the label from every issue that uses it.",
          );
        }
        const scope = normalizeDeleteScope(opts.scope);
        const resolved = await resolveLabelSelectorToId(nameOrId, scope, opts.team);
        const id = resolved.id;
        // Round-8 / N2: discriminated union — narrow via `r.status`.
        const r = await tryIdempotentDelete(() => deleteLabel(id));
        if (r.status === "deleted") {
          await invalidateTeamMetadata(currentRepoHash(), resolved.team ?? undefined);
        }
        const succeeded = r.status === "deleted" && r.result;
        if (r.status === "deleted" && !r.result) process.exitCode = 1;
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(
              envelope({
                id,
                selector: nameOrId,
                scope: resolved.scope,
                team: resolved.team,
                status: r.status,
                success: succeeded,
              }),
              null,
              2,
            )}\n`,
          );
          return;
        }
        if (r.status === "already-absent") {
          process.stdout.write(`${chalk.gray("✓")} already absent: ${chalk.bold(id)} (no-op)\n`);
        } else if (r.result) {
          process.stdout.write(`${chalk.green("✓")} deleted ${chalk.bold(id)}\n`);
        } else {
          process.stdout.write(`${chalk.red("✗")} delete failed for ${id}\n`);
        }
      },
    );
}

function normalizeDeleteScope(scope: string | undefined): "team" | "workspace" {
  if (scope === undefined || scope === "team") return "team";
  if (scope === "workspace") return "workspace";
  throw new ValidationError(
    "label delete --scope must be team or workspace",
    "pass --scope team or --scope workspace",
  );
}

function currentRepoHash(): string {
  const repoRoot = findGitRoot(process.cwd());
  return repoRoot ? hashRepoRoot(repoRoot) : "_global";
}

async function resolveLabelCreateScope(team: string | undefined): Promise<{
  repoHash: string;
  team: string;
  teamId: string;
}> {
  const config = await resolveConfig({ teamOverride: team });
  return {
    repoHash: config.repoHash,
    team: config.team,
    teamId: (await getTeamMetadata(config.repoHash, config.team)).team_id,
  };
}
