import type { Command } from "commander";
import { resolveConfig } from "../lib/config.ts";
import { linear } from "../lib/sdk.ts";

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
      const config = await resolveConfig({ teamOverride: opts.team });
      const client = await linear();
      const teams = await client.teams({ filter: { key: { eq: config.team } } });
      const team = teams.nodes[0];
      if (!team) {
        process.stderr.write(`team not found: ${config.team}\n`);
        process.exitCode = 1;
        return;
      }

      const projects = await team.projects({ first: 250 });
      let records = projects.nodes.map((p) => ({
        id: p.id,
        name: p.name,
        state: p.state,
        description: p.description ?? null,
        url: p.url,
        updated_at: p.updatedAt.toISOString(),
      }));
      if (opts.state) {
        const needle = opts.state.toLowerCase();
        records = records.filter((p) => p.state.toLowerCase() === needle);
      }

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            { schema_version: 1, team: config.team, projects: records },
            null,
            2,
          )}\n`,
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
