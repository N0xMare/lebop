import type { Command } from "commander";
import { listNext } from "../lib/nextStubs.ts";
import { addMachineOutputOptions, writeMachineEnvelope } from "../lib/output.ts";
import {
  buildNotificationsListInputFromCli,
  executeNotificationsList,
} from "../surface/notifications.ts";

export function registerNotifications(program: Command): void {
  const cmd = program
    .command("notifications")
    .description("list Linear inbox notifications (read)")
    .option("--limit <n>", "page size", "50")
    .option("--cursor <token>");
  addMachineOutputOptions(cmd);
  cmd.action(
    async (opts: {
      limit?: string;
      cursor?: string;
      json?: boolean;
      format?: string;
      pretty?: boolean;
    }) => {
      const result = await executeNotificationsList(buildNotificationsListInputFromCli({ opts }));
      writeMachineEnvelope(
        {
          ...(result as unknown as Record<string, unknown>),
          next: listNext(Boolean(result.has_more), result.next_cursor, {
            show: "show <id>",
          }),
        },
        {
          json: true,
          format: opts.format,
          pretty: opts.pretty,
        },
      );
    },
  );
}
