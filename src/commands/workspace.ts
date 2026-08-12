import chalk from "chalk";
import type { Command } from "commander";
import { wantsMachineOutput } from "../lib/encode.ts";
import { listNext } from "../lib/nextStubs.ts";
import { addMachineOutputOptions, writeMachineEnvelope } from "../lib/output.ts";
import { collectLinearRateLimitTelemetry, linearApiEnvelopeMeta } from "../lib/rateLimit.ts";
import { activeTeamOverride, activeWorkspaceOverride } from "../lib/requestContext.ts";
import type { ExploreLinearWorkspaceResult } from "../lib/workspaceExplore.ts";
import {
  buildExploreWorkspaceInputFromCli,
  buildFetchWorkspaceInputFromCli,
  executeExploreWorkspace,
  executeFetchWorkspace,
  parseWorkspaceExploreLimit,
  parseWorkspaceFetchDepth,
  parseWorkspaceFetchLimit,
} from "../surface/workspace.ts";

export function registerWorkspace(program: Command): void {
  const cmd = program
    .command("workspace")
    .description("explore and fetch Linear workspace context");

  const explore = cmd
    .command("explore [path]")
    .description("list Linear workspace paths or search Linear context")
    .option(
      "--query <text>",
      "search workspace context; issues search all teams unless --team is supplied",
    )
    .option("--team <key>", "team key for team-scoped listings/search")
    .option(
      "--kind <kind>",
      "repeatable/search kind: project, issue, initiative, document, cycle, milestone, agent-session",
      collect,
      [],
    )
    .option("--include-archived", "include archived records where the Linear surface supports it")
    .option("--limit <n>", "page size per listing/search kind (1-250)", parseWorkspaceExploreLimit)
    .option("--cursor <token>", "continue from a prior explore result's next_cursor");
  addMachineOutputOptions(explore);
  explore.action(
    async (
      path: string | undefined,
      opts: {
        query?: string;
        team?: string;
        kind?: string[];
        includeArchived?: boolean;
        limit?: number;
        cursor?: string;
        json?: boolean;
        format?: string;
        pretty?: boolean;
      },
    ) => {
      const input = buildExploreWorkspaceInputFromCli({
        path,
        opts,
        context: { rootTeam: activeTeamOverride() },
      });
      const { value: result, telemetry } = await collectLinearRateLimitTelemetry(() =>
        executeExploreWorkspace(input),
      );
      if (wantsMachineOutput(opts)) {
        writeMachineEnvelope(
          {
            ...result,
            next: listNext(Boolean(result.next_cursor), result.next_cursor, {
              show: "workspace fetch <target>",
              extra: ["list", "search --query …"],
            }),
          } as Record<string, unknown>,
          { json: true, format: opts.format, pretty: opts.pretty, shape: "nested" },
          linearApiEnvelopeMeta(telemetry),
        );
        return;
      }
      printExplore(result);
    },
  );

  const fetch = cmd
    .command("fetch <target>")
    .description(
      "materialize a Linear project, issue, initiative, agent session, document, cycle, milestone, or child collection dossier",
    )
    .option(
      "--include <items>",
      "comma-separated includes, e.g. issues,comments,agent_sessions,documents,document_details,project_documents,project_updates,project_milestones",
    )
    .option("--depth <depth>", "shallow or full", parseWorkspaceFetchDepth)
    .option(
      "--limit <n>",
      "child record limit per collection/parent/direction (1-1000)",
      parseWorkspaceFetchLimit,
    )
    .option("--cursor <token>", "continue from a prior workspace fetch continuation cursor")
    .option("--to <dir>", "write dossier to this directory instead of ~/.lebop/context");
  addMachineOutputOptions(fetch);
  fetch.action(
    async (
      target: string,
      opts: {
        include?: string;
        depth?: "shallow" | "full";
        limit?: number;
        cursor?: string;
        to?: string;
        json?: boolean;
        format?: string;
        pretty?: boolean;
      },
    ) => {
      const input = buildFetchWorkspaceInputFromCli({
        target,
        opts,
        context: {
          rootWorkspace: activeWorkspaceOverride(),
        },
      });
      const { value: result, telemetry } = await collectLinearRateLimitTelemetry(() =>
        executeFetchWorkspace(input),
      );
      if (wantsMachineOutput(opts)) {
        const cont =
          "next_cursor" in result &&
          typeof (result as { next_cursor?: string }).next_cursor === "string"
            ? (result as { next_cursor: string }).next_cursor
            : null;
        writeMachineEnvelope(
          {
            ...result,
            next: cont
              ? [`--cursor ${cont}`]
              : ["workspace explore /", "show <id>", "comment list <id>"],
          } as Record<string, unknown>,
          { json: true, format: opts.format, pretty: opts.pretty, shape: "nested" },
          linearApiEnvelopeMeta(telemetry),
        );
        return;
      }
      process.stdout.write(`${chalk.green("ok")} wrote ${chalk.cyan(result.root)}\n`);
      process.stdout.write(`index: ${chalk.cyan(result.index_file)}\n`);
      process.stdout.write(`manifest: ${chalk.cyan(result.manifest_file)}\n`);
    },
  );
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function printExplore(result: ExploreLinearWorkspaceResult): void {
  process.stdout.write(`${chalk.bold(result.path)}\n`);
  if (result.query) process.stdout.write(`query: ${result.query}\n`);
  if (result.items.length === 0) {
    process.stdout.write("no items\n");
  } else {
    for (const item of result.items) {
      const label = item.title ?? item.name ?? item.identifier ?? item.key ?? item.id ?? item.path;
      process.stdout.write(`${item.kind.padEnd(16)} ${label} ${chalk.gray(item.path)}\n`);
    }
  }
  if (result.next_paths.length > 0) {
    process.stdout.write("\nnext paths:\n");
    for (const p of result.next_paths) process.stdout.write(`  ${p}\n`);
  }
  if (result.next_cursor) {
    process.stdout.write(`\nnext cursor: ${chalk.gray(result.next_cursor)}\n`);
  }
}
