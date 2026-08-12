import type { Command } from "commander";
import { resolveConfig } from "../lib/config.ts";
import { wantsMachineOutput } from "../lib/encode.ts";
import { listNext } from "../lib/nextStubs.ts";
import { addMachineOutputOptions, writeMachineEnvelope } from "../lib/output.ts";
import {
  buildProjectListInputFromCli,
  executeProjectList,
  projectListPayload,
} from "../surface/projects.ts";

export function registerProjects(program: Command): void {
  const cmd = program
    .command("projects")
    .description("list projects in the team")
    .option("--team <key>", "override the resolved team")
    .option("--all-teams", "list every project the token can see (no team filter)")
    .option(
      "--state <state>",
      "filter by project state (backlog|planned|started|paused|completed|canceled)",
    )
    .option("--include-archived", "include archived projects")
    .option("--limit <n>", "default 50; pass 0 for no limit", "50")
    .option("--cursor <token>", "continue from a previous JSON result's next_cursor");
  addMachineOutputOptions(cmd);
  cmd.action(
    async (opts: {
      team?: string;
      allTeams?: boolean;
      state?: string;
      includeArchived?: boolean;
      limit?: string;
      cursor?: string;
      json?: boolean;
      format?: string;
      pretty?: boolean;
    }) => {
      const result = await executeProjectList(buildProjectListInputFromCli({ opts }), {
        resolveTeam: async (team) => (await resolveConfig({ teamOverride: team })).team,
      });

      if (wantsMachineOutput(opts)) {
        const body = projectListPayload(result);
        writeMachineEnvelope(
          {
            ...body,
            next: listNext(Boolean(body.has_more), body.next_cursor, {
              show: "project view <id>",
              extra: ["list --project <name>"],
            }),
          } as Record<string, unknown>,
          {
            json: true,
            format: opts.format,
            pretty: opts.pretty,
          },
        );
        return;
      }

      if (result.records.length === 0) {
        process.stdout.write("no projects\n");
        return;
      }

      const stateWidth = Math.max(...result.records.map((r) => r.state.length));
      for (const r of result.records) {
        process.stdout.write(`[${r.state.padEnd(stateWidth)}]  ${r.name}\n`);
      }
      if (result.truncated) {
        process.stdout.write(
          `\nmore projects available; use --cursor ${result.next_cursor} with the same filters\n`,
        );
      }
    },
  );
}
