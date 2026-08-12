import { z } from "zod";
import { parseCliLimit } from "../lib/cliOptions.ts";
import { listNotifications, type NotificationsResult } from "../lib/notifications.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput } from "./schema.ts";

export interface NotificationsListInput {
  limit: number;
  after?: string;
}

export interface NotificationsListCliInput {
  opts: { limit?: string; cursor?: string };
}

const notificationsListCanonicalSchema = z
  .object({
    limit: z.number().int().positive(),
    after: z.string().optional(),
  })
  .strict();

export function buildNotificationsListInputFromCli(
  input: NotificationsListCliInput,
): NotificationsListInput {
  return parseSurfaceInput("notifications.list", notificationsListCanonicalSchema, {
    limit: parseCliLimit(input.opts.limit, { defaultValue: 50 }),
    after: input.opts.cursor,
  });
}

export async function executeNotificationsList(
  input: NotificationsListInput,
): Promise<NotificationsResult> {
  return listNotifications({ limit: input.limit, after: input.after });
}

export const notificationsListOperation = {
  id: "notifications.list",
  domain: "notifications",
  resource: "notification",
  action: "list",
  title: "List Linear inbox notifications",
  description: "List Linear inbox notifications (read).",
  cli: {
    command: "notifications",
    nonLiveReason:
      "CLI-only inbox read helper; no MCP dual today. Covered by ad-hoc / feature smoke when needed.",
  },
  mcp: undefined,
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  exception: {
    kind: "cli_only",
    reason: "CLI-only notifications inbox read (no MCP tool dual)",
  },
  fromCli: buildNotificationsListInputFromCli,
  execute: executeNotificationsList,
} satisfies SurfaceOperationContract<
  NotificationsListInput,
  NotificationsResult,
  NotificationsListCliInput,
  never
>;

export const NOTIFICATIONS_SURFACE_OPERATIONS = [notificationsListOperation] as const;
