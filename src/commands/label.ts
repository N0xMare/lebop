import chalk from "chalk";
import type { Command } from "commander";
import { resolveConfig } from "../lib/config.ts";
import { envelope } from "../lib/envelope.ts";
import { NotFoundError, tryIdempotentDelete } from "../lib/errors.ts";
import { createLabel, deleteLabel, listLabels, resolveLabelByName } from "../lib/labels.ts";
import { getTeamMetadata } from "../lib/resolve.ts";
import { isUuid } from "../lib/uuid.ts";

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
        const config = await resolveConfig({ teamOverride: opts.team });
        const labels = await listLabels({
          team: opts.workspaceOnly || opts.all ? undefined : config.team,
          workspaceOnly: opts.workspaceOnly,
          all: opts.all,
        });

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(
              envelope({
                scope: opts.all ? "all" : opts.workspaceOnly ? "workspace" : config.team,
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
        const config = await resolveConfig({ teamOverride: opts.team });
        const teamId = opts.workspaceScoped
          ? undefined
          : (await getTeamMetadata(config.repoHash, config.team)).team_id;
        const created = await createLabel({
          name,
          teamId,
          color: opts.color,
          description: opts.description,
        });
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
    .option("--yes", "confirm destructive operation (required)")
    .option("--json", "emit structured result")
    .action(async (nameOrId: string, opts: { team?: string; yes?: boolean; json?: boolean }) => {
      if (!opts.yes) {
        process.stderr.write(
          `${chalk.red("error:")} refusing to delete label ${chalk.bold(nameOrId)} without --yes\n` +
            `  ${chalk.cyan("hint:")} re-run with --yes to confirm. This removes the label from every issue that uses it.\n`,
        );
        process.exitCode = 1;
        return;
      }
      let id = nameOrId;
      if (!isUuid(nameOrId)) {
        const config = await resolveConfig({ teamOverride: opts.team });
        const resolved = await resolveLabelByName(nameOrId, config.team);
        if (!resolved) {
          throw new NotFoundError(`label not found: ${nameOrId}`);
        }
        id = resolved.id;
      }
      // Round-8 / N2: discriminated union — narrow via `r.status`.
      const r = await tryIdempotentDelete(() => deleteLabel(id));
      const succeeded = r.status === "deleted" && r.result;
      if (r.status === "deleted" && !r.result) process.exitCode = 1;
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope({ id, status: r.status, success: succeeded }), null, 2)}\n`,
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
    });
}
