import chalk from "chalk";
import type { Command } from "commander";
import { envelope } from "../lib/envelope.ts";
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
    .description("read-only access to Linear agent sessions");

  cmd
    .command("list")
    .description("list agent sessions; --status filters")
    .option("--status <name>", "filter by session status")
    .option("--issue-id <uuid>", "scope to one issue")
    .option("--limit <n>", "default 50; pass 0 for no limit", "50")
    .option("--json", "emit structured records")
    .action(async (opts: { status?: string; issueId?: string; limit?: string; json?: boolean }) => {
      const result = await executeAgentSessionList(buildAgentSessionListInputFromCli({ opts }));

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope(agentSessionListPayload(result)), null, 2)}\n`,
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
    });

  cmd
    .command("view <id>")
    .description("show one agent session by UUID")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { json?: boolean }) => {
      const session = await executeAgentSessionGet(
        buildAgentSessionGetInput(id),
        AGENT_SESSION_NOT_FOUND_HINT,
      );

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ agent_session: session }), null, 2)}\n`);
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
    });
}
