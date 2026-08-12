import chalk from "chalk";
import type { Command } from "commander";
import { wantsMachineOutput } from "../lib/encode.ts";
import {
  agentSessionListPayload,
  buildAgentSessionGetInput,
  buildAgentSessionListInputFromCli,
  executeAgentSessionGet,
  executeAgentSessionList,
} from "../surface/agent-sessions.ts";

const AGENT_SESSION_NOT_FOUND_HINT =
  "verify the agent session UUID; run `lebop agent-session list` to discover ids";

export function registerAgentSession(program: Command): void {
  const cmd = program
    .command("agent-session")
    .description(
      "read-only Linear agent sessions (sessions created by other agents/tools in the workspace)",
    );

  cmd
    .command("list")
    .description("list agent sessions; --status filters")
    .option("--status <name>", "filter by session status")
    .option("--issue-id <uuid>", "scope to one issue")
    .option("--limit <n>", "default 50; pass 0 for no limit", "50")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (opts: {
        status?: string;
        issueId?: string;
        limit?: string;
        json?: boolean;
        format?: string;
        pretty?: boolean;
      }) => {
        const result = await executeAgentSessionList(buildAgentSessionListInputFromCli({ opts }));

        if (wantsMachineOutput(opts)) {
          const { writeMachineEnvelope } = await import("../lib/output.ts");
          writeMachineEnvelope(
            {
              ...agentSessionListPayload(result),
              next: ["agent-session view <id>", "show <id>"],
            },
            {
              json: true,
              format: opts.format,
              pretty: opts.pretty,
            },
          );
          return;
        }

        if (result.agent_sessions.length === 0) {
          process.stdout.write("no agent sessions\n");
          return;
        }
        for (const s of result.agent_sessions) {
          const status = s.status ? chalk.cyan(`[${s.status}]`) : "";
          const issue = s.issue ? chalk.bold(s.issue.identifier) : chalk.gray("(no issue)");
          const who = s.creator ? chalk.gray(s.creator.name) : "";
          process.stdout.write(`${chalk.dim(s.id.slice(0, 8))} ${status} ${issue} ${who}\n`);
        }
      },
    );

  cmd
    .command("view <id>")
    .description("show one agent session by UUID (includes recent activities by default)")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .option("--no-activities", "omit activity timeline")
    .action(
      async (
        id: string,
        opts: { json?: boolean; format?: string; pretty?: boolean; activities?: boolean },
      ) => {
        const session = await executeAgentSessionGet(
          buildAgentSessionGetInput(id),
          AGENT_SESSION_NOT_FOUND_HINT,
          { includeActivities: opts.activities !== false },
        );

        if (wantsMachineOutput(opts)) {
          const { writeMachineEnvelope } = await import("../lib/output.ts");
          writeMachineEnvelope(
            {
              agent_session: session,
              next: ["show <id>", "comment list <id>", "agent-session list"],
            },
            { json: true, format: opts.format, pretty: opts.pretty, shape: "nested" },
          );
          return;
        }
        process.stdout.write(`${chalk.bold(session.id)}\n`);
        if (session.status) process.stdout.write(`  status: ${chalk.cyan(session.status)}\n`);
        if (session.type) process.stdout.write(`  type: ${session.type}\n`);
        if (session.issue) {
          process.stdout.write(
            `  issue: ${chalk.bold(session.issue.identifier)} — ${session.issue.title}\n`,
          );
        }
        if (session.creator) {
          process.stdout.write(`  creator: ${session.creator.name} <${session.creator.email}>\n`);
        }
        process.stdout.write(`  created: ${session.created_at}\n`);
        process.stdout.write(`  updated: ${session.updated_at}\n`);
        if (session.ended_at) process.stdout.write(`  ended: ${session.ended_at}\n`);
        if (session.activities?.length) {
          process.stdout.write(`  activities (${session.activities.length}):\n`);
          for (const a of session.activities) {
            const t = typeof a.content?.type === "string" ? a.content.type : "activity";
            process.stdout.write(`    - ${chalk.dim(a.id.slice(0, 8))} [${t}] ${a.created_at}\n`);
          }
        }
      },
    );
}
