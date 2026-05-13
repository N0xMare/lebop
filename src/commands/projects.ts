import type { Command } from "commander";
import { resolveConfig } from "../lib/config.ts";
import { envelope } from "../lib/envelope.ts";
import { listProjects } from "../lib/projects.ts";

export function registerProjects(program: Command): void {
  program
    .command("projects")
    .description("list projects in the team")
    .option("--team <key>", "override the resolved team")
    .option(
      "--state <state>",
      "filter by project state (backlog|planned|started|paused|completed|canceled)",
    )
    .option("--json", "emit structured project records")
    .action(async (opts: { team?: string; state?: string; json?: boolean }) => {
      // Round-8 / H4: route through the lib's `listProjects` (same as
      // `lebop project list`) so the two surfaces emit identical record
      // shapes — including `archived_at`, which the prior bespoke SDK call
      // in this file was missing (MED-1 only landed on the subcommand).
      // Also delegates team-not-found to the lib's NotFoundError so the
      // top-level catch in cli.ts emits the structured envelope under
      // `--json` (round-7 / Q4) instead of raw stderr prose.
      const config = await resolveConfig({ teamOverride: opts.team });
      const records = await listProjects({ team: config.team, state: opts.state });

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope({ team: config.team, count: records.length, projects: records }), null, 2)}\n`,
        );
        return;
      }

      if (records.length === 0) {
        process.stdout.write(`no projects in team ${config.team}\n`);
        return;
      }

      const stateWidth = Math.max(...records.map((r) => r.state.length));
      for (const r of records) {
        process.stdout.write(`[${r.state.padEnd(stateWidth)}]  ${r.name}\n`);
      }
    });
}
