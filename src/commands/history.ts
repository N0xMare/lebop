import type { Command } from "commander";
import { listNext } from "../lib/nextStubs.ts";
import { addMachineOutputOptions, writeMachineEnvelope } from "../lib/output.ts";
import {
  buildIssueHistoryListInputFromCli,
  executeIssueHistoryList,
  issueHistoryListPayload,
} from "../surface/coverage.ts";

export function registerHistory(program: Command): void {
  const cmd = program
    .command("history <id>")
    .description("issue field changelog (dense; not comments or agent activities)")
    .option("--since <iso>", "only rows at or after this timestamp")
    .option("--limit <n>", "page size (default 50)", "50")
    .option("--cursor <token>", "continue from next_cursor");
  addMachineOutputOptions(cmd);
  cmd.action(
    async (
      id: string,
      opts: {
        since?: string;
        limit?: string;
        cursor?: string;
        json?: boolean;
        format?: string;
        pretty?: boolean;
      },
    ) => {
      const result = await executeIssueHistoryList(buildIssueHistoryListInputFromCli({ id, opts }));
      const body = issueHistoryListPayload(result) as Record<string, unknown>;
      // Always machine-dense for history (control plane).
      writeMachineEnvelope(
        {
          ...body,
          next: listNext(Boolean(result.has_more), result.next_cursor, {
            show: "show <id>",
            extra: ["comment list <id>"],
          }),
        },
        { json: true, format: opts.format, pretty: opts.pretty },
        undefined,
      );
    },
  );
}
