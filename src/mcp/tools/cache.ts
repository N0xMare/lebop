import { envelope } from "../../lib/envelope.ts";
import {
  buildCacheDiffIssueInputFromMcp,
  buildCacheDiffIssueMcpInputSchema,
  buildCacheDiffProjectInputFromMcp,
  buildCacheDiffProjectMcpInputSchema,
  buildCacheGcInputFromMcp,
  buildCacheGcMcpInputSchema,
  buildCachePushInputFromMcp,
  buildCachePushMcpInputSchema,
  buildCacheStatusInputFromMcp,
  buildCacheStatusMcpInputSchema,
  type CacheDiffIssueMcpInput,
  type CacheDiffProjectMcpInput,
  type CacheGcMcpInput,
  type CachePushMcpInput,
  type CacheStatusMcpInput,
  cacheDiffIssueOperation,
  cacheDiffProjectOperation,
  cacheGcOperation,
  cacheGcPayload,
  cachePushOperation,
  cachePushPayload,
  cacheStatusOperation,
  cacheStatusPayload,
  executeCacheDiffIssue,
  executeCacheDiffProject,
  executeCacheGc,
  executeCachePush,
  executeCacheStatus,
} from "../../surface/cache.ts";
import { text } from "../response.ts";
import type { McpToolSpec } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface CacheToolDeps {
  workspaceParamDescription: string;
  requireConfirm: (args: { confirm?: boolean }, toolName: string) => void;
}

export function buildCacheToolSpecs(deps: CacheToolDeps): McpToolSpec[] {
  return [
    {
      name: "cache_status",
      config: mcpToolConfig(
        cacheStatusOperation,
        buildCacheStatusMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: CacheStatusMcpInput) => {
        return text(
          envelope({
            ...cacheStatusPayload(await executeCacheStatus(buildCacheStatusInputFromMcp(args))),
          }),
        );
      },
    },
    {
      name: "diff_issue",
      config: mcpToolConfig(
        cacheDiffIssueOperation,
        buildCacheDiffIssueMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: CacheDiffIssueMcpInput) => {
        return text(envelope(await executeCacheDiffIssue(buildCacheDiffIssueInputFromMcp(args))));
      },
    },
    {
      name: "diff_project",
      config: mcpToolConfig(
        cacheDiffProjectOperation,
        buildCacheDiffProjectMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: CacheDiffProjectMcpInput) => {
        return text(
          envelope(await executeCacheDiffProject(buildCacheDiffProjectInputFromMcp(args))),
        );
      },
    },
    {
      name: "push_changes",
      config: mcpToolConfig(
        cachePushOperation,
        buildCachePushMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: CachePushMcpInput) => {
        const dryRun = args.dry_run === true;
        const force = args.force === true;
        if (force && !dryRun) deps.requireConfirm(args, "push_changes force");
        return text(
          envelope(cachePushPayload(await executeCachePush(buildCachePushInputFromMcp(args)))),
        );
      },
    },
    {
      name: "cache_gc",
      config: mcpToolConfig(cacheGcOperation, buildCacheGcMcpInputSchema()),
      handler: async (args: CacheGcMcpInput) => {
        const dryRun = args.dry_run === undefined ? true : args.dry_run;
        if (!dryRun) deps.requireConfirm(args, "cache_gc");
        return text(envelope(cacheGcPayload(await executeCacheGc(buildCacheGcInputFromMcp(args)))));
      },
    },
  ];
}
