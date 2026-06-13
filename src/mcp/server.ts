/**
 * lebop's MCP server. Exposes lib functions as MCP tools so non-CLI agents
 * (Cursor, Claude Desktop, Windsurf, IDE extensions) can drive Linear with
 * the same retry/stale-guard/lint guarantees the CLI provides.
 *
 * Auth: bearer-token via the existing `~/.lebop/auth.json` (multi-workspace).
 * Tool calls accept an optional `workspace` arg to target a specific
 * workspace; falls back to LEBOP_WORKSPACE env or the auth file's default.
 *
 * Transport: stdio. Right shape for binary distribution; HTTP+SSE comes in
 * a follow-up release.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getAgentSession, listAgentSessions } from "../lib/agentSessions.ts";
import {
  deleteAttachment,
  linkUrlAttachment,
  listAttachments,
  updateAttachment,
} from "../lib/attachments.ts";
import { addWorkspace, loadAuth, loadAuthForWorkspace, setDefaultWorkspace } from "../lib/auth.ts";
import { gcCache, invalidateTeamMetadata } from "../lib/cache.ts";
import { commentCacheNotRefreshed, issueCacheNotRefreshed } from "../lib/cacheCoherence.ts";
import { applyCachePushPlans, collectCachePushPlans } from "../lib/cachePush.ts";
import {
  type IssueCacheRefreshResult,
  refreshCachedIssueByIdentifier,
  refreshCachedProjectAfterUpdate,
} from "../lib/cacheRefresh.ts";
import { collectCacheStatus } from "../lib/cacheStatus.ts";
import { addComment, deleteComment, listComments, updateComment } from "../lib/comments.ts";
import { resolveConfig } from "../lib/config.ts";
import { setWorkspaceDefaultTeam } from "../lib/configWrite.ts";
import { getCycle, listCycles } from "../lib/cycles.ts";
import { diffIssueCacheVsRemote, diffProjectCacheVsRemote } from "../lib/diff.ts";
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
} from "../lib/documents.ts";
import { envelope } from "../lib/envelope.ts";
import { LebopError, NotFoundError, tryIdempotentDelete, ValidationError } from "../lib/errors.ts";
import {
  archiveInitiative,
  assertInitiativeUpdateBody,
  createInitiative,
  createInitiativeUpdate,
  deleteInitiative,
  getInitiative,
  type InitiativeHealth,
  initiativeAddProject,
  initiativeRemoveProject,
  listInitiatives,
  listInitiativeUpdates,
  resolveExistingInitiativeId,
  resolveInitiativeId,
  unarchiveInitiative,
  updateInitiative,
} from "../lib/initiatives.ts";
import { createLabel, deleteLabel, listLabels, resolveLabelSelectorToId } from "../lib/labels.ts";
import { applyFixesFixpoint, lintContent } from "../lib/lint.ts";
import { lintFiles } from "../lib/lintFiles.ts";
import { lookupStateByName, lookupUserByEmail } from "../lib/lookups.ts";
import {
  createMilestone,
  deleteMilestone,
  getMilestone,
  listMilestones,
  resolveExistingProjectId,
  resolveProjectId,
  updateMilestone,
} from "../lib/milestones.ts";
import { paginateConnection } from "../lib/paginate.ts";
import { AUTH_FILE_DISPLAY, AUTH_STORAGE_KIND } from "../lib/paths.ts";
import { applyPlan, preflightPlanApply } from "../lib/planApply.ts";
import { diffPlan } from "../lib/planDiff.ts";
import { countRemainingPlanLintWarnings, lintPlanFiles } from "../lib/planLint.ts";
import { parsePlan } from "../lib/planParse.ts";
import { pullPlan } from "../lib/planPull.ts";
import { validatePlanWithFreshTeamMetadata } from "../lib/planValidate.ts";
import {
  assertProjectUpdateBody,
  createProjectUpdate,
  listProjectUpdates,
  type ProjectHealth,
} from "../lib/projects.ts";
import {
  assertRawGraphQLOperationAllowed,
  assertRawGraphQLPaginateAllowed,
} from "../lib/rawGraphql.ts";
import { paginateRawQuery } from "../lib/rawPaginate.ts";
import {
  assertRelationCreateConfirmed,
  createLink,
  deleteLink,
  findLink,
  LINK_KINDS,
  type LinkDelta,
  type LinkKind,
  listRelations,
  parseLinkToken,
  preflightCreateLink,
  relationBatchAddsRequireConfirmation,
  relationDeltaKey,
  relationPairKey,
} from "../lib/relations.ts";
import { runWithRequestContext } from "../lib/requestContext.ts";
import { deriveTeamFromIdentifiers, getTeamMetadata } from "../lib/resolve.ts";
import { linear, withClient } from "../lib/sdk.ts";
import { listTeamMembers } from "../lib/teamMembers.ts";
import { getTeam } from "../lib/teams.ts";
import { LEBOP_VERSION } from "../lib/version.ts";
import { listWorkflowStates } from "../lib/workflowStates.ts";
import { safe } from "./adapter.ts";
import {
  requireConfirm,
  requireMcpEntity,
  resolveMcpRepoCacheContext,
  resolveTeamSelectorToId,
  WORKSPACE_PARAM_DESCRIPTION,
} from "./common.ts";
import { installEnvelopeValidator } from "./envelopeValidator.ts";
import { text } from "./response.ts";

export { formatToolError } from "./response.ts";

import { registerAllMcpTools } from "./tools/index.ts";
import type { McpServerLike, RegisteredMcpToolDefinition } from "./types.ts";

// Both the CLI/lib update path and MCP `update_issue` share the same milestone
// and cycle resolvers from ../lib/resolve.ts. The cycle resolver requires
// `teamKey` because cycle names are not unique across teams.

export function collectMcpToolDefinitions(): RegisteredMcpToolDefinition[] {
  const definitions: RegisteredMcpToolDefinition[] = [];
  const collector = {
    registerTool(
      name: string,
      config: RegisteredMcpToolDefinition["config"],
      handler: unknown,
    ): void {
      definitions.push({ name, config, handler });
    },
  };
  registerTools(collector);
  return definitions;
}

function relationWritebackFailed(cache: IssueCacheRefreshResult): boolean {
  return cache.present && !cache.refreshed && cache.error !== undefined;
}

function relationMutationStatus(
  base: "created" | "deleted",
  cache: IssueCacheRefreshResult,
): "created" | "deleted" | "created-writeback-failed" | "deleted-writeback-failed" {
  if (!relationWritebackFailed(cache)) return base;
  return base === "created" ? "created-writeback-failed" : "deleted-writeback-failed";
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "lebop",
    version: LEBOP_VERSION,
  });

  registerTools(server);
  installEnvelopeValidator(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // server.connect resolves when the transport closes; we just await it
  // implicitly by returning. Stay alive until stdin EOF / parent exit.
}

/** Register the MCP tools exposed through the stdio server. */
function registerTools(server: McpServerLike): void {
  registerAllMcpTools(
    server,
    {
      workspace: {
        workspaceParamDescription: WORKSPACE_PARAM_DESCRIPTION,
      },
      issues: {
        workspaceParamDescription: WORKSPACE_PARAM_DESCRIPTION,
        resolveTeam: async (team) => (await resolveConfig({ teamOverride: team })).team,
        getTeam: async (team) => getTeam(team),
        resolveConfig: async (options) => resolveConfig(options),
        resolveCacheContext: resolveMcpRepoCacheContext,
        requireConfirm,
        requireMcpEntity,
      },
      projects: {
        workspaceParamDescription: WORKSPACE_PARAM_DESCRIPTION,
        requireConfirm,
        resolveMcpRepoCacheContext,
        resolveTeamSelectorToId,
        resolveDefaultTeamKey: async () => (await resolveConfig()).team,
        resolveTeam: async (team) => (await resolveConfig({ teamOverride: team })).team,
        refreshCachedProjectAfterUpdate,
      },
      pull: {
        workspaceParamDescription: WORKSPACE_PARAM_DESCRIPTION,
        requireConfirm,
      },
      publish: {
        workspaceParamDescription: WORKSPACE_PARAM_DESCRIPTION,
      },
    },
    {
      afterIssueListBeforeProjects: registerLegacyMcpToolsAfterIssueListBeforeProjects,
      afterProjectsBeforeIssueLifecycle: registerLegacyMcpToolsAfterProjectsBeforeIssueLifecycle,
      afterIssueLifecycleBeforePull: registerLegacyMcpToolsAfterIssueLifecycleBeforePull,
      afterPullBeforePublish: registerLegacyMcpToolsAfterPullBeforePublish,
      afterPublishBeforeBulk: registerLegacyMcpToolsAfterPublishBeforeBulk,
      afterBulk: registerLegacyMcpToolsAfterBulk,
    },
  );

  // ---------- lint_files ----------
  server.registerTool(
    "lint_files",
    {
      title: "Lint local markdown files for Linear renderer quirks",
      description:
        "MCP parity with `lebop lint`: lint explicit local markdown paths, or omit paths to lint cached issue/project markdown for the resolved repo/team. Supports fix and strict like the CLI.",
      inputSchema: {
        paths: z
          .array(z.string())
          .optional()
          .describe("Local markdown file paths. Omit to lint cached issue/project markdown."),
        team: z.string().optional().describe("Override the resolved team for cache-mode config."),
        fix: z
          .boolean()
          .optional()
          .describe("Apply safe autofixes to files before returning results."),
        strict: z
          .boolean()
          .optional()
          .describe("Set strict_failed=true when remaining warnings exist."),
        repo_root: z
          .string()
          .optional()
          .describe("Repo root for config/cache resolution and relative path handling."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Lint local markdown files for Linear renderer quirks",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safe(async (args) => {
      const result = await lintFiles({
        paths: args.paths as string[] | undefined,
        team: args.team as string | undefined,
        fix: args.fix as boolean | undefined,
        strict: args.strict as boolean | undefined,
        repoRoot: args.repo_root as string | undefined,
      });
      return text(
        envelope({
          files: result.files,
          warning_count: result.warning_count,
          fixed_count: result.fixed_count,
          missing_count: result.missing_count,
          missing_paths: result.missing_paths,
          strict_failed: result.strict_failed,
          cache_mode: result.cache_mode,
        }),
      );
    }),
  );
}

function registerLegacyMcpToolsAfterIssueListBeforeProjects(server: McpServerLike): void {
  // ---------- add_relation ----------
  server.registerTool(
    "add_relation",
    {
      title: "Create a relation between two issues",
      description: `Add a Linear relation. Server-side idempotent at the (issueId, relatedIssueId, type) tuple — re-running with the same args returns the existing relation. Kinds: ${LINK_KINDS.join(" | ")}.`,
      inputSchema: {
        from: z.string().describe("Source issue identifier (e.g. 'TEAM-101')."),
        kind: z.enum(LINK_KINDS as readonly [LinkKind, ...LinkKind[]]),
        to: z.string().describe("Target issue identifier."),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Required true only when creating this relation would replace an existing pair relation or create a duplicate relation with workflow side effects.",
          ),
        repo_root: z
          .string()
          .optional()
          .describe("Repo root whose local cache should be refreshed after relation mutation."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Create a relation between two issues",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const upperFrom = args.from.toUpperCase();
      const upperTo = args.to.toUpperCase();
      const preflight = await preflightCreateLink(upperFrom, upperTo, args.kind);
      assertRelationCreateConfirmed(preflight, args.confirm === true);
      const [self, target] = await Promise.all([
        withClient((c) => c.issue(upperFrom)),
        withClient((c) => c.issue(upperTo)),
      ]);
      if (!self)
        throw new NotFoundError(
          `issue not found: ${upperFrom}`,
          `verify ${upperFrom} exists and is visible to your token`,
        );
      if (!target)
        throw new NotFoundError(
          `link target not found: ${upperTo}`,
          `verify ${upperTo} exists and is visible to your token`,
        );
      if (preflight.exact) {
        return text(
          envelope({
            from: self.identifier,
            requested_from: upperFrom,
            kind: args.kind,
            to: upperTo,
            status: "unchanged",
            relation_id: preflight.exact.id,
            relation_preflight: preflight,
            cache: {
              checked: false,
              present: false,
              refreshed: false,
              identifier: upperFrom,
            },
          }),
        );
      }
      const cacheContext = resolveMcpRepoCacheContext(args.repo_root as string | undefined);
      const result = await createLink(self.id, target.id, args.kind);
      const cache = await refreshCachedIssueByIdentifier(upperFrom, {
        repoHash: cacheContext.repoHash,
        repoRoot: cacheContext.repoRoot,
      });
      const status = relationMutationStatus("created", cache);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              envelope({
                from: self.identifier,
                requested_from: upperFrom,
                kind: args.kind,
                to: upperTo,
                status,
                relation_id: result.id,
                relation_preflight: preflight,
                cache,
              }),
              null,
              2,
            ),
          },
        ],
      };
    }),
  );

  server.registerTool(
    "update_relations",
    {
      title: "Apply relation deltas for one issue",
      description:
        "Batch equivalent of `lebop set links`: apply multiple add/remove relation deltas for one source issue in one MCP call. Removals require confirm:true. Adds require confirm:true only when preflight reports relation replacement or duplicate-state side effects.",
      inputSchema: {
        from: z.string().describe("Source issue identifier (e.g. 'TEAM-101')."),
        deltas: z
          .array(
            z.object({
              op: z.enum(["add", "remove", "+", "-"]),
              kind: z.enum(LINK_KINDS as readonly [LinkKind, ...LinkKind[]]),
              to: z.string().describe("Target issue identifier."),
            }),
          )
          .min(1)
          .describe("Relation deltas to apply in order."),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Required true when any delta removes a relation, or when an add preflight reports replacement/duplicate side effects.",
          ),
        repo_root: z
          .string()
          .optional()
          .describe("Repo root whose local cache should be refreshed after relation mutations."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Apply relation deltas for one issue",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const upperFrom = (args.from as string).toUpperCase();
      const deltas = ((args.deltas as Array<{ op: string; kind: LinkKind; to: string }>) ?? []).map(
        (delta): LinkDelta =>
          parseLinkToken(
            `${delta.op === "add" || delta.op === "+" ? "+" : "-"}${delta.kind}:${delta.to}`,
          ),
      );
      if (
        deltas.some((delta) => delta.op === "-") ||
        relationBatchAddsRequireConfirmation(deltas)
      ) {
        requireConfirm(args, "update_relations");
      }

      const self = await withClient((c) => c.issue(upperFrom));
      if (!self) {
        throw new NotFoundError(
          `issue not found: ${upperFrom}`,
          `verify ${upperFrom} exists and is visible to your token`,
        );
      }

      const uniqueTargets = [...new Set(deltas.map((delta) => delta.target))];
      const targetMap = new Map<string, string>();
      await Promise.all(
        uniqueTargets.map(async (targetIdentifier) => {
          const target = await withClient((c) => c.issue(targetIdentifier));
          if (!target) {
            throw new NotFoundError(
              `link target not found: ${targetIdentifier}`,
              `verify ${targetIdentifier} exists and is visible to your token`,
            );
          }
          targetMap.set(targetIdentifier, target.id);
        }),
      );

      const confirmed = args.confirm === true;
      const createPreflights = new Map<string, Awaited<ReturnType<typeof preflightCreateLink>>>();
      for (const delta of deltas.filter((entry) => entry.op === "+")) {
        const key = relationDeltaKey(delta);
        if (createPreflights.has(key)) continue;
        const preflight = await preflightCreateLink(self.identifier, delta.target, delta.kind);
        assertRelationCreateConfirmed(preflight, confirmed);
        createPreflights.set(key, preflight);
      }

      const results: Array<{
        op: "+" | "-";
        kind: LinkKind;
        to: string;
        status:
          | "created"
          | "deleted"
          | "unchanged"
          | "already-absent"
          | "created-writeback-failed"
          | "deleted-writeback-failed"
          | "error";
        relation_id?: string;
        relation_preflight?: Awaited<ReturnType<typeof preflightCreateLink>>;
        error?: string;
      }> = [];

      const dirtyPairs = new Set<string>();
      for (const delta of deltas) {
        try {
          if (delta.op === "+") {
            const pairKey = relationPairKey(delta.target);
            const preflight = dirtyPairs.has(pairKey)
              ? await preflightCreateLink(self.identifier, delta.target, delta.kind)
              : createPreflights.get(relationDeltaKey(delta));
            if (preflight) assertRelationCreateConfirmed(preflight, confirmed);
            if (preflight?.exact) {
              results.push({
                op: "+",
                kind: delta.kind,
                to: delta.target,
                status: "unchanged",
                relation_id: preflight.exact.id,
                relation_preflight: preflight,
              });
              continue;
            }
            const targetId = targetMap.get(delta.target);
            if (!targetId) throw new NotFoundError(`link target not found: ${delta.target}`);
            const created = await createLink(self.id, targetId, delta.kind);
            dirtyPairs.add(pairKey);
            results.push({
              op: "+",
              kind: delta.kind,
              to: delta.target,
              status: "created",
              relation_id: created.id,
              ...(preflight ? { relation_preflight: preflight } : {}),
            });
          } else {
            const relationId = await findLink(self.identifier, delta.target, delta.kind);
            if (!relationId) {
              results.push({
                op: "-",
                kind: delta.kind,
                to: delta.target,
                status: "already-absent",
              });
              continue;
            }
            await deleteLink(relationId);
            dirtyPairs.add(relationPairKey(delta.target));
            results.push({
              op: "-",
              kind: delta.kind,
              to: delta.target,
              status: "deleted",
              relation_id: relationId,
            });
          }
        } catch (err) {
          results.push({
            op: delta.op,
            kind: delta.kind,
            to: delta.target,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const cacheContext = resolveMcpRepoCacheContext(args.repo_root as string | undefined);
      const cache = await refreshCachedIssueByIdentifier(self.identifier, {
        repoHash: cacheContext.repoHash,
        repoRoot: cacheContext.repoRoot,
      });
      if (relationWritebackFailed(cache)) {
        for (const result of results) {
          if (result.status === "created") result.status = "created-writeback-failed";
          if (result.status === "deleted") result.status = "deleted-writeback-failed";
        }
      }

      return text(
        envelope({
          from: self.identifier,
          requested_from: upperFrom,
          results,
          cache,
        }),
      );
    }),
  );

  // ---------- list_relations ----------
  server.registerTool(
    "list_relations",
    {
      title: "List relations for an issue",
      description: "Return outbound + inbound relations for one issue. Pure read.",
      inputSchema: {
        identifier: z.string().describe("Issue identifier (e.g. 'TEAM-101')."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List relations for an issue",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const upper = args.identifier.toUpperCase();
      const result = await listRelations(upper);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(envelope({ identifier: upper, ...result }), null, 2),
          },
        ],
      };
    }),
  );

  server.registerTool(
    "delete_relation",
    {
      title: "Delete a relation between two issues",
      description:
        "Remove a Linear relation. Idempotent at the pair level: returns status='already-absent' when no matching relation exists.",
      inputSchema: {
        from: z.string().describe("Source issue identifier (e.g. 'TEAM-101')."),
        kind: z.enum(LINK_KINDS as readonly [LinkKind, ...LinkKind[]]),
        to: z.string().describe("Target issue identifier."),
        confirm: z.boolean().optional().describe("Required true for deletion."),
        repo_root: z
          .string()
          .optional()
          .describe("Repo root whose local cache should be refreshed after relation mutation."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Delete a relation between two issues",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      requireConfirm(args, "delete_relation");
      const upperFrom = (args.from as string).toUpperCase();
      const upperTo = (args.to as string).toUpperCase();
      const kind = args.kind as LinkKind;
      const relationId = await findLink(upperFrom, upperTo, kind);
      if (!relationId) {
        return text(
          envelope({
            op: "delete",
            from: upperFrom,
            kind,
            to: upperTo,
            status: "already-absent",
          }),
        );
      }
      const cacheContext = resolveMcpRepoCacheContext(args.repo_root as string | undefined);
      await deleteLink(relationId);
      const cache = await refreshCachedIssueByIdentifier(upperFrom, {
        repoHash: cacheContext.repoHash,
        repoRoot: cacheContext.repoRoot,
      });
      return text(
        envelope({
          op: "delete",
          from: upperFrom,
          kind,
          to: upperTo,
          status: relationMutationStatus("deleted", cache),
          relation_id: relationId,
          cache,
        }),
      );
    }),
  );

  // ---------- labels ----------
  server.registerTool(
    "list_labels",
    {
      title: "List Linear labels",
      description: "List labels in a team, workspace-only, or all visible.",
      inputSchema: {
        team: z
          .string()
          .optional()
          .describe(
            "Team key. Omit to use the configured default team; pass all=true for every visible label or workspace_only=true for workspace labels.",
          ),
        workspace_only: z.boolean().optional(),
        all: z.boolean().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List Linear labels",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const resolvedTeam =
        args.workspace_only || args.all
          ? undefined
          : (await resolveConfig({ teamOverride: args.team as string | undefined })).team;
      // When a `team` arg is passed without `workspace_only`/`all`, validate
      // it exists so callers get `code: not_found` instead of workspace-wide
      // labels from the partially workspace-scoped label API.
      if (!args.workspace_only && !args.all && resolvedTeam) {
        const t = await getTeam(resolvedTeam);
        if (!t) {
          throw new NotFoundError(
            `team not found: ${resolvedTeam}`,
            "use `lebop teams` to see available team keys; or pass `workspace_only: true` to skip team scoping",
          );
        }
      }
      const labels = await listLabels({
        team: resolvedTeam,
        workspaceOnly: args.workspace_only,
        all: args.all,
      });
      const scope = args.all
        ? { type: "all" as const, team: null }
        : args.workspace_only
          ? { type: "workspace" as const, team: null }
          : { type: "team" as const, team: resolvedTeam ?? null };
      return text(envelope({ scope, team: resolvedTeam ?? null, count: labels.length, labels }));
    }),
  );

  server.registerTool(
    "create_label",
    {
      title: "Create a Linear label",
      description:
        'Create a team-scoped or workspace-scoped label. Pass `scope: "team"` with `team` (key) or `team_id` (UUID) for a team label, or `scope: "workspace"` for a workspace-wide label. NOT retry-wrapped (would duplicate).',
      inputSchema: {
        name: z.string(),
        scope: z
          .enum(["team", "workspace"])
          .optional()
          .describe(
            "Discriminator: 'team' uses team/team_id or the configured default team; 'workspace' forbids both. Defaults to team scope for CLI parity.",
          ),
        team: z
          .string()
          .optional()
          .describe("Team key, e.g. NOX. Mutually exclusive with team_id."),
        team_id: z.string().optional().describe("Team UUID. Mutually exclusive with team."),
        color: z.string().optional().describe("Hex color (e.g. '#ff0000')."),
        description: z.string().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Create a Linear label",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const scope: "team" | "workspace" =
        (args.scope as "team" | "workspace" | undefined) ?? "team";
      if (args.team && args.team_id) {
        throw new ValidationError(
          "create_label accepts either team or team_id, not both",
          "pass team for a key selector, or team_id for a UUID selector",
        );
      }
      if (scope === "workspace" && (args.team || args.team_id)) {
        throw new ValidationError(
          "scope='workspace' forbids team and team_id",
          "drop team/team_id, or set scope='team' to scope the label to that team",
        );
      }
      const config =
        scope === "team" && !args.team_id ? await resolveConfig({ teamOverride: args.team }) : null;
      const teamId =
        scope === "team"
          ? (args.team_id ?? (await resolveTeamSelectorToId(config?.team as string)))
          : undefined;
      const label = await createLabel({
        name: args.name,
        teamId,
        color: args.color,
        description: args.description,
      });
      await invalidateTeamMetadata(
        config?.repoHash ?? resolveMcpRepoCacheContext(undefined).repoHash,
        scope === "team" ? (label.team?.key ?? config?.team) : undefined,
      );
      return text(
        envelope({
          label,
          scope,
          team: scope === "team" ? (label.team?.key ?? config?.team ?? null) : null,
          team_id: teamId ?? null,
        }),
      );
    }),
  );

  server.registerTool(
    "delete_label",
    {
      title: "Delete a Linear label",
      description:
        "Delete by UUID or exact label name. Requires confirm:true. Idempotent — re-deleting an already-absent UUID returns `{status: 'already-absent'}` without error.",
      inputSchema: {
        id: z.string().optional().describe("Label UUID. Preserved for backward compatibility."),
        name_or_id: z
          .string()
          .optional()
          .describe("Label name or UUID. When a name is passed, team can scope lookup."),
        scope: z
          .enum(["team", "workspace"])
          .optional()
          .describe(
            "Name lookup scope. Defaults to team scope using team or configured default team.",
          ),
        team: z.string().optional().describe("Team key for name lookup."),
        confirm: z.boolean().optional().describe("Required true for deletion."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Delete a Linear label",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      requireConfirm(args, "delete_label");
      if (args.id && args.name_or_id) {
        throw new ValidationError(
          "delete_label accepts either id or name_or_id, not both",
          "pass id for UUID deletion, or name_or_id with optional team for name lookup",
        );
      }
      const selector = args.id ?? args.name_or_id;
      if (!selector) {
        throw new ValidationError(
          "delete_label requires id or name_or_id",
          "pass id for UUID deletion, or name_or_id with optional team for name lookup",
        );
      }
      const scope = (args.scope as "team" | "workspace" | undefined) ?? "team";
      if (scope === "workspace" && args.team) {
        throw new ValidationError(
          "scope='workspace' forbids team",
          "drop team, or set scope='team' to delete a team-scoped label",
        );
      }
      const resolved = await resolveLabelSelectorToId(selector, scope, args.team);
      const id = resolved.id;
      const { status } = await tryIdempotentDelete(() => deleteLabel(id));
      if (status === "deleted") {
        await invalidateTeamMetadata(
          resolveMcpRepoCacheContext(undefined).repoHash,
          resolved.team ?? undefined,
        );
      }
      return text(
        envelope({
          id,
          selector,
          scope: resolved.scope,
          team: resolved.team,
          status,
          success: status === "deleted",
        }),
      );
    }),
  );

  server.registerTool(
    "lookup_label_by_name",
    {
      title: "Resolve a label name to a UUID",
      description:
        "Returns the matching label in the same scope semantics used by delete_label. Defaults to team scope.",
      inputSchema: {
        name: z.string(),
        scope: z
          .enum(["team", "workspace"])
          .optional()
          .describe("Lookup scope. Defaults to team scope using team or configured default team."),
        team: z.string().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Resolve a label name to a UUID",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const scope = (args.scope as "team" | "workspace" | undefined) ?? "team";
      try {
        const resolved = await resolveLabelSelectorToId(args.name, scope, args.team);
        return text(
          envelope({
            label: resolved.label,
            scope: resolved.scope,
            team: resolved.team,
          }),
        );
      } catch (err) {
        if (err instanceof NotFoundError) {
          return text(envelope({ label: null, scope, team: args.team ?? null }));
        }
        throw err;
      }
    }),
  );

  // ---------- milestones ----------
  server.registerTool(
    "list_milestones",
    {
      title: "List project milestones",
      description:
        "List milestones; pass project to filter to one project (name or UUID). Each milestone includes `archived_at` (string | null). Defaults to live milestones only — pass `include_archived: true` to also surface cascade-archived rows (parent-project archived).",
      inputSchema: {
        project: z.string().optional().describe("Project name or UUID."),
        include_archived: z
          .boolean()
          .optional()
          .describe("Include cascade-archived milestones in the result. Defaults to false."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List project milestones",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      let projectId: string | undefined;
      if (args.project) {
        const resolved = await resolveExistingProjectId(args.project);
        if (!resolved)
          throw new NotFoundError(
            `project not found: ${args.project}`,
            "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
          );
        projectId = resolved;
      }
      const milestones = await listMilestones({
        projectId,
        includeArchived: Boolean(args.include_archived),
      });
      return text(envelope({ count: milestones.length, milestones }));
    }),
  );

  server.registerTool(
    "get_milestone",
    {
      title: "Get one milestone by UUID",
      description:
        "Returns one milestone. Missing ids surface as structured not_found errors, matching `lebop milestone view --json`. Cascade-archived milestones (parent-project archived) are surfaced — distinguish via `archived_at`. Uses an archive-resilient list-shape query (the single-record `projectMilestone(id:)` getter silently drops cascade-archived rows; see docs/spec.md §12.1).",
      inputSchema: {
        id: z.string(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Get one milestone by UUID",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const milestone = requireMcpEntity(
        await getMilestone(args.id),
        "milestone",
        args.id,
        "verify the milestone UUID; run list_milestones to discover ids",
      );
      return text(envelope({ milestone }));
    }),
  );

  server.registerTool(
    "create_milestone",
    {
      title: "Create a project milestone",
      description: "Create within a project (name or UUID). NOT retry-wrapped.",
      inputSchema: {
        name: z.string(),
        project: z.string().describe("Project name or UUID."),
        description: z.string().optional(),
        target_date: z.string().optional().describe("ISO date, e.g. 2026-12-31."),
        sort_order: z.number().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Create a project milestone",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const projectId = await resolveExistingProjectId(args.project);
      if (!projectId)
        throw new NotFoundError(
          `project not found: ${args.project}`,
          "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
        );
      const milestone = await createMilestone({
        name: args.name,
        projectId,
        description: args.description,
        targetDate: args.target_date,
        sortOrder: args.sort_order,
      });
      return text(envelope({ milestone }));
    }),
  );

  server.registerTool(
    "update_milestone",
    {
      title: "Update a milestone",
      description: "Idempotent at the value level — safe to retry.",
      inputSchema: {
        id: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        target_date: z
          .union([z.string(), z.null()])
          .optional()
          .describe("ISO date or null to clear."),
        sort_order: z.number().optional(),
        project: z.string().optional().describe("Move to a different project (name or UUID)."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Update a milestone",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const input: Parameters<typeof updateMilestone>[1] = {};
      if (args.name !== undefined) input.name = args.name;
      if (args.description !== undefined) input.description = args.description;
      if (args.target_date !== undefined) input.targetDate = args.target_date;
      if (args.sort_order !== undefined) input.sortOrder = args.sort_order;
      if (args.project) {
        const projectId = await resolveProjectId(args.project);
        if (!projectId)
          throw new NotFoundError(
            `project not found: ${args.project}`,
            "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
          );
        input.projectId = projectId;
      }
      if (Object.keys(input).length === 0) {
        throw new ValidationError(
          "nothing to update — pass at least one field",
          "pass at least one of the optional update fields",
        );
      }
      const milestone = await updateMilestone(args.id, input);
      return text(envelope({ milestone }));
    }),
  );

  server.registerTool(
    "delete_milestone",
    {
      title: "Delete a milestone",
      description:
        "Delete a milestone by UUID. Idempotent — re-deleting an already-absent milestone returns `{status: 'already-absent'}`.",
      inputSchema: {
        id: z.string(),
        confirm: z.boolean().optional().describe("Required true for deletion."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Delete a milestone",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      requireConfirm(args, "delete_milestone");
      const { status } = await tryIdempotentDelete(() => deleteMilestone(args.id));
      return text(envelope({ id: args.id, status, success: status === "deleted" }));
    }),
  );
}

function registerLegacyMcpToolsAfterProjectsBeforeIssueLifecycle(server: McpServerLike): void {
  // ---------- project updates (with health) ----------
  server.registerTool(
    "list_project_updates",
    {
      title: "List project status updates",
      description: "Chronological status posts for one project.",
      inputSchema: {
        project: z.string().describe("Project name or UUID."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List project status updates",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const projectId = await resolveProjectId(args.project);
      if (!projectId)
        throw new NotFoundError(
          `project not found: ${args.project}`,
          "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
        );
      const updates = await listProjectUpdates(projectId);
      return text(envelope({ project_id: projectId, count: updates.length, updates }));
    }),
  );

  server.registerTool(
    "create_project_update",
    {
      title: "Post a project status update",
      description:
        "Optionally tagged with health (onTrack | atRisk | offTrack). NOT retry-wrapped.",
      inputSchema: {
        project: z.string().describe("Project name or UUID."),
        body: z.string(),
        health: z.enum(["onTrack", "atRisk", "offTrack"]).optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Post a project status update",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      assertProjectUpdateBody(args.body);
      const projectId = await resolveProjectId(args.project);
      if (!projectId)
        throw new NotFoundError(
          `project not found: ${args.project}`,
          "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
        );
      const update = await createProjectUpdate({
        projectId,
        body: args.body,
        health: args.health as ProjectHealth | undefined,
      });
      return text(envelope({ project_update: update }));
    }),
  );

  // ---------- initiatives ----------
  server.registerTool(
    "list_initiatives",
    {
      title: "List Linear initiatives",
      description: "Org-level planning units that group projects.",
      inputSchema: {
        status: z.string().optional(),
        owner_id: z.string().optional(),
        include_archived: z.boolean().optional(),
        limit: z.number().int().min(0).optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List Linear initiatives",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const limit = args.limit ?? 50;
      const max = limit === 0 ? Number.POSITIVE_INFINITY : limit;
      const initiatives = await listInitiatives({
        status: args.status,
        ownerId: args.owner_id,
        includeArchived: args.include_archived,
        max,
      });
      return text(envelope({ count: initiatives.length, initiatives }));
    }),
  );

  server.registerTool(
    "get_initiative",
    {
      title: "Get one initiative (with linked projects)",
      description:
        "Returns one initiative. Missing ids/names surface as structured not_found errors, matching `lebop initiative view --json`. `id` accepts UUID or initiative name.",
      inputSchema: {
        id: z
          .string()
          .describe("Initiative UUID OR exact name (resolved via `resolveInitiativeId`)."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Get one initiative (with linked projects)",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const resolved = await resolveInitiativeId(args.id as string);
      if (!resolved) {
        throw new NotFoundError(
          `initiative not found: ${args.id}`,
          "verify the initiative UUID/name; run list_initiatives to discover ids",
        );
      }
      const initiative = await getInitiative(resolved);
      return text(
        envelope({
          initiative: requireMcpEntity(
            initiative,
            "initiative",
            args.id as string,
            "verify the initiative UUID/name; run list_initiatives to discover ids",
          ),
        }),
      );
    }),
  );

  server.registerTool(
    "create_initiative",
    {
      title: "Create an initiative",
      description: "NOT retry-wrapped (would duplicate).",
      inputSchema: {
        name: z.string(),
        description: z.string().optional(),
        status: z.string().optional(),
        owner_id: z.string().optional(),
        target_date: z.string().optional(),
        color: z.string().optional(),
        icon: z
          .string()
          .optional()
          .describe(
            "Linear internal icon name (PascalCase, e.g. 'BarChart', 'Rocket', 'Target'). Emoji are rejected locally; invalid non-emoji names may be rejected by Linear. Omit if unsure.",
          ),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Create an initiative",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const initiative = await createInitiative({
        name: args.name,
        description: args.description,
        status: args.status,
        ownerId: args.owner_id,
        targetDate: args.target_date,
        color: args.color,
        icon: args.icon,
      });
      return text(envelope({ initiative }));
    }),
  );

  server.registerTool(
    "update_initiative",
    {
      title: "Update an initiative",
      description:
        "Idempotent at the value level — safe to retry. The `id` field accepts a UUID OR an initiative name (resolved via `resolveInitiativeId`, matching the behavior of `get_initiative` and `archive_initiative`).",
      inputSchema: {
        // Keep initiative lookup parity with sibling tools: UUIDs and exact
        // initiative names both route through `resolveInitiativeId`.
        id: z.string().describe("Initiative UUID OR name (resolved server-side)."),
        name: z.string().optional(),
        description: z.string().optional(),
        status: z.string().optional(),
        owner_id: z.union([z.string(), z.null()]).optional(),
        target_date: z.union([z.string(), z.null()]).optional(),
        color: z.string().optional(),
        icon: z
          .string()
          .optional()
          .describe(
            "Linear internal icon name (PascalCase, e.g. 'BarChart', 'Rocket', 'Target'). Emoji are rejected locally; invalid non-emoji names may be rejected by Linear. Omit if unsure.",
          ),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Update an initiative",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const input: Parameters<typeof updateInitiative>[1] = {};
      if (args.name !== undefined) input.name = args.name;
      if (args.description !== undefined) input.description = args.description;
      if (args.status !== undefined) input.status = args.status;
      if (args.owner_id !== undefined) input.ownerId = args.owner_id;
      if (args.target_date !== undefined) input.targetDate = args.target_date;
      if (args.color !== undefined) input.color = args.color;
      if (args.icon !== undefined) input.icon = args.icon;
      if (Object.keys(input).length === 0)
        throw new ValidationError(
          "nothing to update — pass at least one field",
          "pass at least one of the optional update fields",
        );
      // Accept name OR UUID, matching the sibling initiative tools.
      const initiativeId = await resolveInitiativeId(args.id as string);
      if (!initiativeId) {
        throw new NotFoundError(
          `initiative not found: ${args.id}`,
          "pass a UUID, or a name that matches an existing initiative (case-sensitive)",
        );
      }
      const initiative = await updateInitiative(initiativeId, input);
      return text(envelope({ initiative }));
    }),
  );

  server.registerTool(
    "archive_initiative",
    {
      title: "Archive an initiative (reversible)",
      description: "NOT retry-wrapped. `id` accepts UUID or initiative name.",
      inputSchema: {
        id: z
          .string()
          .describe("Initiative UUID OR exact name (resolved via `resolveInitiativeId`)."),
        confirm: z.boolean().optional().describe("Required true for destructive execution."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Archive an initiative (reversible)",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      requireConfirm(args as { confirm?: boolean }, "archive_initiative");
      const initiativeId = await resolveInitiativeId(args.id);
      if (!initiativeId) throw new NotFoundError(`initiative not found: ${args.id}`);
      const success = await archiveInitiative(initiativeId);
      return text(envelope({ id: initiativeId, success }));
    }),
  );

  server.registerTool(
    "unarchive_initiative",
    {
      title: "Unarchive an initiative",
      description: "NOT retry-wrapped. `id` accepts UUID or initiative name.",
      inputSchema: {
        id: z
          .string()
          .describe("Initiative UUID OR exact name (resolved via `resolveInitiativeId`)."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Unarchive an initiative",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const initiativeId = await resolveInitiativeId(args.id);
      if (!initiativeId) throw new NotFoundError(`initiative not found: ${args.id}`);
      const success = await unarchiveInitiative(initiativeId);
      return text(envelope({ id: initiativeId, success }));
    }),
  );

  server.registerTool(
    "delete_initiative",
    {
      title: "Delete an initiative permanently",
      description:
        "Delete an initiative by UUID or exact name. Soft delete server-side (sets `archived_at`); not user-restorable via Linear's standard UI flows. Idempotent — re-deleting an already-soft-deleted initiative returns `{status: 'already-absent'}`.",
      inputSchema: {
        id: z
          .string()
          .describe("Initiative UUID OR exact name (resolved via `resolveInitiativeId`)."),
        confirm: z.boolean().optional().describe("Required true for deletion."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Delete an initiative permanently",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      requireConfirm(args as { confirm?: boolean }, "delete_initiative");
      // Keep the envelope shape stable when name lookup fails: `id` is null
      // and `query` carries the original lookup token.
      const initiativeId = await resolveInitiativeId(args.id);
      if (!initiativeId)
        return text(
          envelope({ id: null, query: args.id, status: "already-absent", success: false }),
        );
      const { status } = await tryIdempotentDelete(() => deleteInitiative(initiativeId));
      return text(
        envelope({ id: initiativeId, query: args.id, status, success: status === "deleted" }),
      );
    }),
  );

  server.registerTool(
    "initiative_add_project",
    {
      title: "Link a project to an initiative",
      description: "Server-side idempotent at the (initiative, project) tuple.",
      inputSchema: {
        initiative: z.string().describe("Initiative name or UUID."),
        project: z.string().describe("Project name or UUID."),
        sort_order: z.number().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Link a project to an initiative",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const initiativeId = await resolveExistingInitiativeId(args.initiative);
      if (!initiativeId)
        throw new NotFoundError(
          `initiative not found: ${args.initiative}`,
          "pass the initiative name or UUID; run list_initiatives to discover ids",
        );
      const projectId = await resolveProjectId(args.project);
      if (!projectId)
        throw new NotFoundError(
          `project not found: ${args.project}`,
          "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
        );
      const result = await initiativeAddProject({
        initiativeId,
        projectId,
        sortOrder: args.sort_order,
      });
      return text(envelope({ edge_id: result.id }));
    }),
  );

  server.registerTool(
    "initiative_remove_project",
    {
      title: "Unlink a project from an initiative",
      description:
        "Removes the link between a project and an initiative. " +
        "Returns { removed: boolean, reason?, message? }. " +
        "When `removed` is false, `reason` disambiguates the cause: " +
        "`absent` (no such link existed — already-removed or never-linked), " +
        "`archived` (the initiative is archived and refuses mutations — " +
        "unarchive_initiative first), or `other` (server-side rejection; " +
        "see `message`). When `removed` is true, no `reason` is set.",
      inputSchema: {
        initiative: z.string(),
        project: z.string(),
        confirm: z.boolean().optional().describe("Required true for destructive execution."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Unlink a project from an initiative",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      requireConfirm(args as { confirm?: boolean }, "initiative_remove_project");
      const initiativeId = await resolveInitiativeId(args.initiative);
      if (!initiativeId)
        throw new NotFoundError(
          `initiative not found: ${args.initiative}`,
          "pass the initiative name or UUID; run list_initiatives to discover ids",
        );
      const projectId = await resolveProjectId(args.project);
      if (!projectId)
        throw new NotFoundError(
          `project not found: ${args.project}`,
          "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
        );
      const result = await initiativeRemoveProject({ initiativeId, projectId });
      return text(envelope({ ...result }));
    }),
  );

  server.registerTool(
    "list_initiative_updates",
    {
      title: "List initiative status updates",
      description: "Chronological status posts for one initiative.",
      inputSchema: {
        initiative: z.string().describe("Initiative name or UUID."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List initiative status updates",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const initiativeId = await resolveInitiativeId(args.initiative);
      if (!initiativeId)
        throw new NotFoundError(
          `initiative not found: ${args.initiative}`,
          "pass the initiative name or UUID; run list_initiatives to discover ids",
        );
      const updates = await listInitiativeUpdates(initiativeId);
      return text(
        envelope({
          initiative_id: initiativeId,
          count: updates.length,
          updates,
        }),
      );
    }),
  );

  server.registerTool(
    "create_initiative_update",
    {
      title: "Post an initiative status update (with health)",
      description: "NOT retry-wrapped (would duplicate).",
      inputSchema: {
        initiative: z.string(),
        body: z.string(),
        health: z.enum(["onTrack", "atRisk", "offTrack"]).optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Post an initiative status update (with health)",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      assertInitiativeUpdateBody(args.body);
      const initiativeId = await resolveInitiativeId(args.initiative);
      if (!initiativeId)
        throw new NotFoundError(
          `initiative not found: ${args.initiative}`,
          "pass the initiative name or UUID; run list_initiatives to discover ids",
        );
      const update = await createInitiativeUpdate({
        initiativeId,
        body: args.body,
        health: args.health as InitiativeHealth | undefined,
      });
      return text(envelope({ initiative_update: update }));
    }),
  );

  // ---------- cycles ----------
  server.registerTool(
    "list_cycles",
    {
      title: "List cycles for a team (or all teams)",
      description: "Cycles are read-only via lebop — manage in the Linear UI.",
      inputSchema: {
        team: z.string().optional().describe("Team key. Omit to use the configured default team."),
        all_teams: z
          .boolean()
          .optional()
          .describe("Drop the team filter for workspace-wide cycle listing."),
        limit: z.number().int().min(0).optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List cycles for a team (or all teams)",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const limit = args.limit ?? 50;
      const max = limit === 0 ? Number.POSITIVE_INFINITY : limit;
      const team = args.all_teams
        ? undefined
        : (await resolveConfig({ teamOverride: args.team as string | undefined })).team;
      if (!args.all_teams && team) {
        const resolvedTeam = await getTeam(team);
        if (!resolvedTeam) {
          throw new NotFoundError(
            `team not found: ${team}`,
            "use list_teams to see available team keys, or pass all_teams: true to skip team scoping",
          );
        }
      }
      const cycles = await listCycles({ team, max });
      return text(envelope({ team: args.all_teams ? "*" : team, count: cycles.length, cycles }));
    }),
  );

  server.registerTool(
    "get_cycle",
    {
      title: "Get one cycle by UUID",
      description:
        "Returns one cycle. Missing ids surface as structured not_found errors, matching `lebop cycle view --json`.",
      inputSchema: {
        id: z.string(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Get one cycle by UUID",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const cycle = requireMcpEntity(
        await getCycle(args.id),
        "cycle",
        args.id,
        "verify the cycle UUID; run list_cycles to discover ids",
      );
      return text(envelope({ cycle }));
    }),
  );

  // ---------- documents ----------
  server.registerTool(
    "list_documents",
    {
      title: "List Linear documents",
      description: "Pass project (name or UUID) to filter to one project's docs.",
      inputSchema: {
        project: z.string().optional(),
        limit: z.number().int().min(0).optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List Linear documents",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      let projectId: string | undefined;
      if (args.project) {
        const resolved = await resolveExistingProjectId(args.project);
        if (!resolved)
          throw new NotFoundError(
            `project not found: ${args.project}`,
            "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
          );
        projectId = resolved;
      }
      const limit = args.limit ?? 50;
      const max = limit === 0 ? Number.POSITIVE_INFINITY : limit;
      const documents = await listDocuments({ projectId, max });
      return text(envelope({ count: documents.length, documents }));
    }),
  );

  server.registerTool(
    "get_document",
    {
      title: "Get one document by UUID (with content)",
      description:
        "Returns one document with content. Missing ids surface as structured not_found errors, matching `lebop document view --json`.",
      inputSchema: {
        id: z.string(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Get one document by UUID (with content)",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const document = requireMcpEntity(
        await getDocument(args.id),
        "document",
        args.id,
        "verify the document UUID; run list_documents to discover ids",
      );
      return text(envelope({ document }));
    }),
  );

  server.registerTool(
    "create_document",
    {
      title: "Create a document",
      description: "Must be attached to a project. NOT retry-wrapped.",
      inputSchema: {
        title: z.string(),
        project: z.string().describe("Project name or UUID."),
        content: z.string().optional(),
        icon: z
          .string()
          .optional()
          .describe(
            "Linear internal icon name (PascalCase, e.g. 'BarChart', 'Rocket', 'Target'). Emoji are rejected locally; invalid non-emoji names may be rejected by Linear. Omit if unsure.",
          ),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Create a document",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const projectId = await resolveProjectId(args.project);
      if (!projectId)
        throw new NotFoundError(
          `project not found: ${args.project}`,
          "pass the project name (case-sensitive) or UUID; run list_projects to discover ids",
        );
      const document = await createDocument({
        title: args.title,
        projectId,
        content: args.content,
        icon: args.icon,
      });
      return text(envelope({ document }));
    }),
  );

  server.registerTool(
    "update_document",
    {
      title: "Update a document",
      description: "Idempotent at the value level — safe to retry.",
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        content: z.string().optional(),
        icon: z.string().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Update a document",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const input: Parameters<typeof updateDocument>[1] = {};
      if (args.title !== undefined) input.title = args.title;
      if (args.content !== undefined) input.content = args.content;
      if (args.icon !== undefined) input.icon = args.icon;
      if (Object.keys(input).length === 0)
        throw new ValidationError(
          "nothing to update — pass at least one field",
          "pass at least one of the optional update fields",
        );
      const document = await updateDocument(args.id, input);
      return text(envelope({ document }));
    }),
  );

  server.registerTool(
    "delete_document",
    {
      title: "Delete a document permanently",
      description:
        "Delete a document by UUID. Soft delete server-side (sets `archived_at`); not user-restorable via Linear's standard UI flows. Idempotent — re-deleting an already-soft-deleted document returns `{status: 'already-absent'}`.",
      inputSchema: {
        id: z.string(),
        confirm: z.boolean().optional().describe("Required true for deletion."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Delete a document permanently",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      requireConfirm(args as { confirm?: boolean }, "delete_document");
      const { status } = await tryIdempotentDelete(() => deleteDocument(args.id));
      return text(envelope({ id: args.id, status, success: status === "deleted" }));
    }),
  );

  // ---------- agent sessions ----------
  server.registerTool(
    "list_agent_sessions",
    {
      title: "List Linear agent sessions",
      description: "Read-only. Filter by status or scope to one issue.",
      inputSchema: {
        status: z.string().optional(),
        issue_id: z.string().optional().describe("Issue UUID."),
        limit: z.number().int().min(0).optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List Linear agent sessions",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const limit = args.limit ?? 50;
      const max = limit === 0 ? Number.POSITIVE_INFINITY : limit;
      const sessions = await listAgentSessions({
        status: args.status,
        issueId: args.issue_id,
        max,
      });
      return text(envelope({ count: sessions.length, agent_sessions: sessions }));
    }),
  );

  server.registerTool(
    "get_agent_session",
    {
      title: "Get one agent session by UUID",
      description:
        "Returns one agent session. Missing ids surface as structured not_found errors, matching `lebop agent-session view --json`.",
      inputSchema: {
        id: z.string(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Get one agent session by UUID",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const session = requireMcpEntity(
        await getAgentSession(args.id),
        "agent session",
        args.id,
        "verify the agent session UUID; run list_agent_sessions to discover ids",
      );
      return text(envelope({ agent_session: session }));
    }),
  );

  // ---------- team members ----------
  server.registerTool(
    "list_team_members",
    {
      title: "List members of a team",
      description: "Pass include_inactive=true to see deactivated users.",
      inputSchema: {
        // Renamed from `team_key` → `team` in v0.0.2 for consistency with
        // every other tool that takes a team identifier. The lib still
        // calls the value a `teamKey` internally; the MCP boundary
        // normalizes naming. RELEASE NOTE BREAKING CHANGE: MCP clients
        // wiring up list_team_members must rename `team_key` → `team`.
        team: z
          .string()
          .optional()
          .describe("Team key (e.g. 'NOX'). Omit to use the configured default team."),
        include_inactive: z.boolean().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List members of a team",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const config = await resolveConfig({ teamOverride: args.team as string | undefined });
      const members = await listTeamMembers({
        teamKey: config.team,
        includeInactive: args.include_inactive as boolean | undefined,
      });
      return text(envelope({ team: config.team, count: members.length, members }));
    }),
  );

  // ---------- lint_text ----------
  // Differentiator tool — neither linear-cli nor Linear's MCP has this.
  server.registerTool(
    "lint_text",
    {
      title: "Lint markdown for Linear renderer quirks",
      description:
        "Run lebop's in-memory Linear renderer lint rules (L001, L002, L003, L005, L006) against text content. Catches table-cell ordered-list markers, setext H2 from `text\\n---`, etc. Pass fix=true to also return fixed_content and remaining warnings after in-memory autofixes. NOTE: this tool takes a content string, NOT a file path. Repo-scoped rules such as L004/R001/R002 require config/path context and run through the CLI/file lint surfaces instead.",
      inputSchema: {
        content: z.string().describe("Markdown content to lint."),
        fix: z.boolean().optional().describe("Return fixed_content after applying safe autofixes."),
      },
      annotations: {
        title: "Lint markdown for Linear renderer quirks",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safe(async (args) => {
      const { warnings } = lintContent(args.content, {});
      const fixed = args.fix === true ? applyFixesFixpoint(args.content as string, {}) : undefined;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              envelope({
                warning_count: warnings.length,
                warnings: warnings.map((w) => ({
                  rule: w.rule,
                  severity: w.severity,
                  message: w.message,
                  line: w.line,
                })),
                ...(fixed
                  ? {
                      fixed: fixed.content !== args.content,
                      fixed_content: fixed.content,
                      fix_passes: fixed.passes,
                      remaining_warning_count: fixed.warnings.length,
                      remaining_warnings: fixed.warnings.map((w) => ({
                        rule: w.rule,
                        severity: w.severity,
                        message: w.message,
                        line: w.line,
                      })),
                    }
                  : {}),
              }),
              null,
              2,
            ),
          },
        ],
      };
    }),
  );
}

function registerLegacyMcpToolsAfterIssueLifecycleBeforePull(server: McpServerLike): void {
  // ==========================================================================
  // Comments (4 tools): list / add / update / delete
  // ==========================================================================

  server.registerTool(
    "list_comments",
    {
      title: "List comments on an issue",
      description: "Returns all comments on the given issue, chronologically.",
      inputSchema: {
        identifier: z.string().describe("Issue identifier (TEAM-NN)."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List comments on an issue",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const comments = await listComments(args.identifier as string);
      return text(
        envelope({
          identifier: args.identifier,
          count: comments.length,
          comments,
        }),
      );
    }),
  );

  server.registerTool(
    "add_comment",
    {
      title: "Add a comment to an issue",
      description: "Posts one comment. NOT retry-wrapped — would post a duplicate.",
      inputSchema: {
        identifier: z.string().describe("Issue identifier (TEAM-NN)."),
        body: z.string(),
        parent_id: z.string().optional().describe("UUID of parent comment when replying."),
        repo_root: z
          .string()
          .optional()
          .describe("Override cwd-derived repo root for cache-coherence reporting."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Add a comment to an issue",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const cacheContext = resolveMcpRepoCacheContext(args.repo_root as string | undefined);
      const result = await addComment({
        identifier: args.identifier as string,
        body: args.body as string,
        parentId: args.parent_id as string | undefined,
      });
      return text(
        envelope({
          identifier: args.identifier,
          comment: result,
          cache: issueCacheNotRefreshed({
            identifiers: [(args.identifier as string).toUpperCase()],
            reason: "comment add does not rewrite the cached issue comment collection in place",
            repairHint: `call pull_issues with identifiers=[${JSON.stringify((args.identifier as string).toUpperCase())}], refresh=true, confirm=true to refresh cached comments after verifying local cache overwrite is intended`,
            repoHash: cacheContext.repoHash,
            repoRoot: cacheContext.repoRoot,
          }),
        }),
      );
    }),
  );

  server.registerTool(
    "update_comment",
    {
      title: "Update an existing comment",
      description: "Idempotent at the value level — safe to retry.",
      inputSchema: {
        id: z.string().describe("Comment UUID (visible in list_comments)."),
        body: z.string(),
        repo_root: z
          .string()
          .optional()
          .describe("Override cwd-derived repo root for cache-coherence reporting."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Update an existing comment",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const cacheContext = resolveMcpRepoCacheContext(args.repo_root as string | undefined);
      const result = await updateComment(args.id as string, args.body as string);
      return text(
        envelope({
          comment: result,
          cache: commentCacheNotRefreshed({
            commentIds: [args.id as string],
            reason:
              "comment update receives only a comment UUID and does not know which cached issue comment collection to refresh",
            repairHint:
              "call pull_issues with the parent issue identifier, refresh=true, confirm=true before relying on cached comments, after verifying local cache overwrite is intended",
            repoHash: cacheContext.repoHash,
            repoRoot: cacheContext.repoRoot,
          }),
        }),
      );
    }),
  );

  server.registerTool(
    "delete_comment",
    {
      title: "Delete a comment by UUID",
      description:
        "Delete a comment by UUID. Idempotent — re-deleting an already-absent comment returns `{status: 'already-absent'}`.",
      inputSchema: {
        id: z.string().describe("Comment UUID."),
        confirm: z.boolean().optional().describe("Required true for deletion."),
        repo_root: z
          .string()
          .optional()
          .describe("Override cwd-derived repo root for cache-coherence reporting."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Delete a comment by UUID",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      requireConfirm(args, "delete_comment");
      const cacheContext = resolveMcpRepoCacheContext(args.repo_root as string | undefined);
      const { status } = await tryIdempotentDelete(() => deleteComment(args.id as string));
      return text(
        envelope({
          id: args.id,
          status,
          success: status === "deleted",
          cache: commentCacheNotRefreshed({
            commentIds: [args.id as string],
            reason:
              "comment delete receives only a comment UUID and does not know which cached issue comment collection to refresh",
            repairHint:
              "call pull_issues with the parent issue identifier, refresh=true, confirm=true before relying on cached comments, after verifying local cache overwrite is intended",
            repoHash: cacheContext.repoHash,
            repoRoot: cacheContext.repoRoot,
          }),
        }),
      );
    }),
  );

  // ==========================================================================
  // Cache loop pre-pull tools: cache_status / diff_issue / diff_project
  // ==========================================================================

  server.registerTool(
    "cache_status",
    {
      title: "git-like status for the local lebop cache",
      description:
        "Returns modified / clean / stale entries in the cache. `stale` means the remote `updatedAt` is newer than the local `_server.updated_at` snapshot — call pull_issues or pull_project with refresh=true and confirm=true to update after verifying local cache overwrite is intended.",
      inputSchema: {
        repo_root: z
          .string()
          .optional()
          .describe(
            "Override the cwd-derived repo root. When omitted, uses the MCP server's cwd → git root.",
          ),
        team: z.string().optional(),
        check_remote: z
          .boolean()
          .optional()
          .describe("Run the remote-staleness check. Defaults to true."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "git-like status for the local lebop cache",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const config = await resolveConfig({
        cwd: args.repo_root as string | undefined,
        teamOverride: args.team as string | undefined,
        requireGitRoot: Boolean(args.repo_root),
      });
      return text(
        envelope({
          ...(await collectCacheStatus({
            team: config.team,
            repoRoot: config.repoRoot,
            repoHash: config.repoHash,
            checkRemote: args.check_remote !== false,
          })),
        }),
      );
    }),
  );

  server.registerTool(
    "diff_issue",
    {
      title: "unified diff: local cache vs live remote (one issue)",
      description:
        "Field-level diff + description unified-patch for a single cached issue. Returns null patch if no description drift.",
      inputSchema: {
        identifier: z.string(),
        repo_root: z.string().optional(),
        team: z.string().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "unified diff: local cache vs live remote (one issue)",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      return text(
        envelope(
          await diffIssueCacheVsRemote(args.identifier as string, {
            repoRoot: args.repo_root as string | undefined,
            team: args.team as string | undefined,
          }),
        ),
      );
    }),
  );

  server.registerTool(
    "diff_project",
    {
      title: "unified diff: local cache vs live remote (one project)",
      description:
        "Field-level diff + content unified-patch for a single cached project. Returns null patch if no content drift.",
      inputSchema: {
        project_id: z.string().describe("Project UUID cached by pull_project."),
        repo_root: z.string().optional(),
        team: z.string().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "unified diff: local cache vs live remote (one project)",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      return text(
        envelope(
          await diffProjectCacheVsRemote(args.project_id as string, {
            repoRoot: args.repo_root as string | undefined,
            team: args.team as string | undefined,
          }),
        ),
      );
    }),
  );
}

function registerLegacyMcpToolsAfterPullBeforePublish(server: McpServerLike): void {
  server.registerTool(
    "push_changes",
    {
      title: "Push locally-modified cache entries back to Linear (stale-guarded)",
      description:
        "Reads the local cache, computes per-issue/project field diffs, and applies updates as Linear mutations. Uses the cached _server.updated_at snapshot plus a just-in-time remote recheck as a stale guard; pass force=true to bypass. dry_run=true previews without writing.",
      inputSchema: {
        identifiers: z
          .array(z.string())
          .optional()
          .describe("Restrict to these identifiers; defaults to every modified cached issue."),
        project_ids: z
          .array(z.string())
          .optional()
          .describe(
            "Restrict project cache pushes to these project UUIDs. Defaults to modified cached projects when identifiers is omitted.",
          ),
        repo_root: z.string().optional(),
        team: z.string().optional(),
        dry_run: z.boolean().optional(),
        force: z.boolean().optional().describe("Bypass the updatedAt stale guard."),
        confirm: z
          .boolean()
          .optional()
          .describe("Required true when force=true because stale protection is bypassed."),
        strict: z.boolean().optional().describe("Block pushes with lint warnings."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Push locally-modified cache entries back to Linear (stale-guarded)",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const requested = args.identifiers as string[] | undefined;
      const requestedProjects = args.project_ids as string[] | undefined;
      const teamOverride =
        (args.team as string | undefined) ??
        (requested && requested.length > 0
          ? (deriveTeamFromIdentifiers(requested) ?? undefined)
          : undefined);
      const config = await resolveConfig({
        cwd: args.repo_root as string | undefined,
        teamOverride,
        requireGitRoot: Boolean(args.repo_root),
      });
      const dryRun = args.dry_run === true;
      const force = args.force === true;
      if (force && !dryRun) requireConfirm(args as { confirm?: boolean }, "push_changes force");
      const strict = args.strict === true;
      const lintCtx = {
        repoConfig: config.repoConfig,
        workspaceUrlPrefix: config.workspaceUrlPrefix,
      };
      const plans = await collectCachePushPlans(config.repoHash, {
        identifiers: requested,
        projectIds: requestedProjects,
        includeUnchanged: Boolean(requested?.length || requestedProjects?.length),
      });
      const { results, summary } = await applyCachePushPlans({
        repoHash: config.repoHash,
        team: config.team,
        plans,
        lintCtx,
        dryRun,
        force,
        strict,
      });

      return text(
        envelope({
          team: config.team,
          repo_hash: config.repoHash,
          mode: "cache" as const,
          results,
          summary,
          notes: dryRun ? "dry-run: nothing was written" : undefined,
        }),
      );
    }),
  );
}

function registerLegacyMcpToolsAfterPublishBeforeBulk(server: McpServerLike): void {
  // ==========================================================================
  // Plan workflow (4 tools): validate / apply / diff / pull
  // ==========================================================================

  server.registerTool(
    "plan_validate",
    {
      title: "Validate a plan directory (no Linear writes)",
      description:
        "Parses + validates a directory of plan markdown files (frontmatter + body). Reports errors (must-fix) and warnings (renderer quirks, relation-pair conflicts, slug shadows, etc.). Pass team to enable network-dependent semantic checks (state/label/assignee resolution).",
      inputSchema: {
        dir: z.string().describe("Plan directory path (absolute or relative to MCP server cwd)."),
        team: z
          .string()
          .optional()
          .describe("Team key — if provided, runs full semantic checks against team metadata."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Validate a plan directory (no Linear writes)",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const dir = args.dir as string;
      const plan = await parsePlan(dir);
      const teamKey = (args.team as string | undefined) ?? plan.project.frontmatter.team;
      const config = await resolveConfig({ teamOverride: teamKey });
      const { validation: result } = await validatePlanWithFreshTeamMetadata(plan, {
        repoHash: config.repoHash,
        team: config.team,
        lintCtx: {
          repoConfig: config.repoConfig,
          workspaceUrlPrefix: config.workspaceUrlPrefix,
        },
      });
      // Match the CLI's richer plan-parse summary shape
      // (project.name/project.linear_id plus per-issue slug/title/linear_id)
      // so agents can enumerate slugs without a second parse round-trip.
      return text(
        envelope({
          dir,
          project: {
            name: plan.project.frontmatter.name,
            linear_id: plan.project.frontmatter.linear_id ?? null,
          },
          issues: plan.issues.map((i) => ({
            slug: i.slug,
            title: i.frontmatter.title,
            linear_id: i.frontmatter.linear_id ?? null,
          })),
          errors: result.errors,
          warnings: result.warnings,
        }),
      );
    }),
  );

  server.registerTool(
    "plan_lint",
    {
      title: "Lint every markdown body in a plan directory",
      description:
        "MCP parity with `lebop plan lint`: lints _project.md plus issue files, optionally applying safe fixes in-place. strict=true reports strict_failed when warnings remain.",
      inputSchema: {
        dir: z.string(),
        fix: z.boolean().optional(),
        strict: z.boolean().optional(),
        team: z.string().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Lint every markdown body in a plan directory",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const dir = args.dir as string;
      const plan = await parsePlan(dir);
      const teamKey = (args.team as string | undefined) ?? plan.project.frontmatter.team;
      const config = await resolveConfig({ teamOverride: teamKey });
      const fix = args.fix === true;
      const files = await lintPlanFiles(plan, {
        fix,
        lintCtx: {
          repoConfig: config.repoConfig,
          workspaceUrlPrefix: config.workspaceUrlPrefix,
        },
      });
      const remaining = countRemainingPlanLintWarnings(files, fix);
      return text(
        envelope({
          dir,
          files,
          remaining_warnings: remaining,
          strict_failed: args.strict === true && remaining > 0,
        }),
      );
    }),
  );

  server.registerTool(
    "plan_apply",
    {
      title: "Realize a plan as a Linear project + issues + relations",
      description:
        "Writes back `linear_id:` to each file on first apply; re-running after successful writeback is a no-op. Do not auto-retry failed creates before writeback. Set dry_run=true to preview. strict=true blocks on lint warnings.",
      inputSchema: {
        dir: z.string(),
        dry_run: z.boolean().optional(),
        force: z
          .boolean()
          .optional()
          .describe(
            "Apply existing Linear updates even when plan updatedAt snapshots are missing/stale.",
          ),
        confirm: z
          .boolean()
          .optional()
          .describe("Required true when force=true because plan stale protection is bypassed."),
        strict: z.boolean().optional(),
        team: z
          .string()
          .optional()
          .describe("Override the resolved team (defaults to project frontmatter team)."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Realize a plan as a Linear project + issues + relations",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const dir = args.dir as string;
      const plan = await parsePlan(dir);
      const teamKey = (args.team as string | undefined) ?? plan.project.frontmatter.team;
      const config = await resolveConfig({ teamOverride: teamKey });
      const dryRun = args.dry_run === true;
      if (args.force === true && !dryRun) {
        requireConfirm(args as { confirm?: boolean }, "plan_apply force");
      }
      const lintCtx = {
        repoConfig: config.repoConfig,
        workspaceUrlPrefix: config.workspaceUrlPrefix,
      };
      const { teamMetadata, validation } = await validatePlanWithFreshTeamMetadata(plan, {
        repoHash: config.repoHash,
        team: config.team,
        lintCtx,
      });
      if (validation.errors.length > 0) {
        return text(envelope({ dir, validation }));
      }
      const preflight = await preflightPlanApply(plan);
      if (!preflight.ready) {
        return text(envelope({ dir, dry_run: dryRun, preflight }));
      }
      const result = await applyPlan(plan, teamMetadata, {
        dryRun,
        force: args.force === true,
        strict: args.strict === true,
        lintCtx,
      });
      // Include `dry_run` in the output envelope to match
      // `lebop plan apply --json`; agents can distinguish a real apply from a
      // preview without re-checking the request args.
      return text(envelope({ dir, dry_run: dryRun, ...result }));
    }),
  );

  server.registerTool(
    "plan_diff",
    {
      title: "Local-vs-remote drift for a plan directory",
      description:
        "Computes per-entity drift between the plan files and Linear's current state. Output mirrors `lebop plan diff`.",
      inputSchema: {
        dir: z.string(),
        team: z.string().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Local-vs-remote drift for a plan directory",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const dir = args.dir as string;
      const plan = await parsePlan(dir);
      const teamKey = (args.team as string | undefined) ?? plan.project.frontmatter.team;
      const config = await resolveConfig({ teamOverride: teamKey });
      const teamMetadata = await getTeamMetadata(config.repoHash, config.team);
      const result = await diffPlan(plan, teamMetadata);
      return text(envelope({ dir, ...result }));
    }),
  );

  server.registerTool(
    "plan_pull",
    {
      title: "Overwrite plan files with current remote state",
      description:
        "Reverse of plan_apply for the local files: rewrites each plan file's frontmatter + body to match Linear. Refuses to overwrite locally-modified files unless force=true.",
      inputSchema: {
        dir: z.string(),
        force: z.boolean().optional(),
        confirm: z
          .boolean()
          .optional()
          .describe("Required true when force=true because local plan files may be overwritten."),
        include_new: z
          .boolean()
          .optional()
          .describe("Also import remote issues that don't have a corresponding plan file."),
        team: z.string().optional(),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Overwrite plan files with current remote state",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const dir = args.dir as string;
      const plan = await parsePlan(dir);
      const teamKey = (args.team as string | undefined) ?? plan.project.frontmatter.team;
      const config = await resolveConfig({ teamOverride: teamKey });
      if (args.force === true) requireConfirm(args as { confirm?: boolean }, "plan_pull force");
      const teamMetadata = await getTeamMetadata(config.repoHash, config.team);
      if (args.force !== true) {
        const preDiff = await diffPlan(plan, teamMetadata);
        if (preDiff.has_drift || preDiff.has_blockers || preDiff.has_incomplete_scan) {
          throw new ValidationError(
            preDiff.has_incomplete_scan
              ? "refusing to pull: plan diff scan incomplete"
              : preDiff.has_blockers
                ? "refusing to pull: plan diff has blockers"
                : "refusing to pull: local plan has drift",
            "call plan_diff to inspect, then retry with force=true and confirm=true after verifying local file overwrite is intended",
          );
        }
      }
      const result = await pullPlan(plan, teamMetadata, {
        includeNew: args.include_new === true,
      });
      return text(envelope({ dir, ...result }));
    }),
  );

  // ==========================================================================
  // Misc: link / raw / list_workspaces / set_default_workspace / whoami / refresh_whoami
  // ==========================================================================

  server.registerTool(
    "link_url_to_issue",
    {
      title: "Attach a URL to an issue (e.g. PR, design doc)",
      description:
        "Creates a Linear Attachment whose target is a URL. Useful for linking PRs. Idempotent at the (issue, url) pair — re-calling with the same url returns the existing attachment with `status: 'already-linked'` (parity with CLI `lebop link`).",
      inputSchema: {
        identifier: z.string(),
        url: z.string(),
        title: z.string().optional().describe("Display title; defaults to the URL itself."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Attach a URL to an issue (e.g. PR, design doc)",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const upperId = (args.identifier as string).toUpperCase();
      const title = (args.title as string | undefined) ?? (args.url as string);
      const result = await linkUrlAttachment(upperId, args.url as string, title);
      return text(
        envelope({ identifier: upperId, attachment: result.attachment, status: result.status }),
      );
    }),
  );

  server.registerTool(
    "raw_graphql",
    {
      title: "GraphQL escape hatch — execute an arbitrary query/mutation",
      description:
        "Executes arbitrary Linear GraphQL. Use only when no first-class tool covers the operation. Queries run directly; mutations require allow_mutation=true and confirm=true and are never retry-wrapped. Returns `{schema_version, data}` (the standard MCP envelope wrapping Linear's raw response.data). Pass paginate=true to walk a top-level connection. The matching CLI tool `lebop raw` intentionally emits unwrapped `data` (no envelope) for jq-pipe ergonomics; see docs/spec.md §15.6.",
      inputSchema: {
        query: z.string().describe("GraphQL document (query or mutation)."),
        variables: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Variables object for the query."),
        paginate: z
          .boolean()
          .optional()
          .describe(
            "If the query has a top-level connection, walks pageInfo.hasNextPage and merges nodes.",
          ),
        allow_mutation: z
          .boolean()
          .optional()
          .describe("Required true to execute GraphQL mutation operations."),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Required true when executing a GraphQL mutation because raw mutations bypass first-class review/validation.",
          ),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "GraphQL escape hatch — execute an arbitrary query/mutation",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const query = args.query as string;
      const variables = (args.variables as Record<string, unknown> | undefined) ?? {};
      const workspace = args.workspace as string | undefined;
      if (args.paginate) assertRawGraphQLPaginateAllowed(query);
      const operationKind = assertRawGraphQLOperationAllowed(query, {
        allowMutation: args.allow_mutation === true,
        mutationMessage: "raw_graphql mutation requires allow_mutation=true",
        mutationHint:
          "prefer first-class lebop write tools; if raw mutation is intentional, re-send with allow_mutation:true",
        surface: "raw_graphql",
      });
      if (operationKind === "mutation") {
        requireConfirm(args as { confirm?: boolean }, "raw_graphql mutation");
      }
      // Map GraphQL syntax and validation errors to the structured taxonomy.
      // Linear's GraphQL endpoint surfaces these as `Syntax Error:`,
      // `Cannot query field`, or `Argument Validation Error` messages; wrap
      // them so clients can branch on a stable error code.
      const wrapGqlErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
        try {
          return await fn();
        } catch (err) {
          if (err instanceof LebopError) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          if (
            /^Syntax Error/.test(msg) ||
            /Cannot query field/.test(msg) ||
            /^Argument Validation Error/.test(msg) ||
            /^Unknown argument/.test(msg) ||
            /^Field .* of type .* must have a selection of subfields/.test(msg)
          ) {
            throw new ValidationError(
              `raw_graphql query failed: ${msg}`,
              "the query is structurally invalid — fix the syntax or schema mismatch and re-send",
            );
          }
          throw err;
        }
      };
      if (!args.paginate) {
        const response = await wrapGqlErrors(async () =>
          operationKind === "mutation"
            ? ((await (await linear(workspace)).client.rawRequest(query, variables)) as {
                data: unknown;
              })
            : ((await withClient((c) => c.client.rawRequest(query, variables), workspace)) as {
                data: unknown;
              }),
        );
        // Intentional CLI/MCP asymmetry: MCP always wraps in the standard
        // {schema_version, data} envelope. The CLI's `lebop raw` emits raw
        // `data` for jq-pipe ergonomics (documented in docs/spec.md §15.6).
        return text(envelope({ data: response.data }));
      }
      const accumulated = await paginateRawQuery(variables, async (vars) =>
        wrapGqlErrors(
          async () =>
            (await withClient((c) => c.client.rawRequest(query, vars), workspace)) as {
              data: Record<string, unknown>;
            },
        ),
      );
      return text(envelope({ data: accumulated }));
    }),
  );

  server.registerTool(
    "list_workspaces",
    {
      title: "List configured Linear workspaces",
      description:
        "Returns ALL workspaces stored in ~/.lebop/auth.json (slug, name, viewer email, default flag). This tool is meta — it lists every workspace lebop knows about and intentionally does NOT accept a `workspace` filter param (unlike every other tool). To inspect a single workspace's viewer / cached profile, call `whoami` with `for_workspace=<slug>` instead.",
      inputSchema: {},
      annotations: {
        title: "List configured Linear workspaces",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async () => {
      const stored = await loadAuth();
      if (!stored) {
        return text(
          envelope({
            auth_file: AUTH_FILE_DISPLAY,
            auth_storage: AUTH_STORAGE_KIND,
            workspaces: [],
            default: null,
          }),
        );
      }
      const slugs = Object.keys(stored.workspaces);
      const workspaces = slugs.map((s) => {
        const ws = stored.workspaces[s];
        return ws
          ? {
              slug: ws.slug,
              name: ws.name,
              url_key: ws.url_key,
              viewer: ws.viewer,
              created_at: ws.created_at,
              is_default: stored.default === s,
            }
          : null;
      });
      return text(
        envelope({
          auth_file: AUTH_FILE_DISPLAY,
          auth_storage: AUTH_STORAGE_KIND,
          default: stored.default ?? null,
          workspaces: workspaces.filter(Boolean),
        }),
      );
    }),
  );

  server.registerTool(
    "list_teams",
    {
      title: "List teams in the Linear workspace",
      description:
        "MCP parity with `lebop teams`: returns accessible teams with key, name, id, and description.",
      inputSchema: {
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List teams in the Linear workspace",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async () => {
      const teams = await withClient((client) =>
        paginateConnection(({ first, after }) => client.teams({ first, after })),
      );
      return text(
        envelope({
          teams: teams.map((team) => ({
            key: team.key,
            name: team.name,
            id: team.id,
            description: team.description ?? null,
          })),
        }),
      );
    }),
  );

  server.registerTool(
    "set_default_workspace",
    {
      title: "Set the default workspace for tool calls without an explicit workspace arg",
      description: "Updates ~/.lebop/auth.json's `default` field.",
      inputSchema: {
        slug: z.string().describe("Workspace slug — must be one already configured."),
      },
      annotations: {
        title: "Set the default workspace for tool calls without an explicit workspace arg",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safe(async (args) => {
      await setDefaultWorkspace(args.slug as string);
      return text(envelope({ default: args.slug }));
    }),
  );

  server.registerTool(
    "whoami",
    {
      title: "Current viewer for a workspace",
      description:
        "Returns the cached viewer for `for_workspace` (which auth slug to read) or the current default without network I/O. Use refresh_whoami to re-validate and persist updated auth metadata. Two distinct args: `for_workspace` chooses *which auth slug to read*; `workspace` is the universal API-target selector that sets LEBOP_WORKSPACE for this call. Usually they match; the split lets you query one slug while authenticated against another.",
      inputSchema: {
        for_workspace: z
          .string()
          .optional()
          .describe(
            "Auth slug whose cached viewer to return. Defaults to the current default workspace. Renamed from `slug` for clarity vs. the standard `workspace` param.",
          ),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Current viewer for a workspace",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const ws = await loadAuthForWorkspace(args.for_workspace as string | undefined);
      const fullAuth = await loadAuth();
      const isDefault = fullAuth?.default === ws.slug;
      return text(
        envelope({
          workspace: ws.slug,
          workspace_name: ws.name,
          is_default: isDefault,
          viewer: ws.viewer,
          auth_file: AUTH_FILE_DISPLAY,
          auth_storage: AUTH_STORAGE_KIND,
          refreshed: false,
          created_at: ws.created_at,
        }),
      );
    }),
  );

  server.registerTool(
    "refresh_whoami",
    {
      title: "Refresh cached viewer for a workspace",
      description:
        "Re-validates the stored token for `for_workspace` against Linear, persists the refreshed viewer/workspace metadata to the auth file, and returns the updated viewer. Use whoami for a read-only cached lookup.",
      inputSchema: {
        for_workspace: z
          .string()
          .optional()
          .describe("Auth slug to refresh. Defaults to the current default workspace."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Refresh cached viewer for a workspace",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const ws = await loadAuthForWorkspace(args.for_workspace as string | undefined);
      const refreshed = await addWorkspace(ws.token);
      const fullAuth = await loadAuth();
      const isDefault = fullAuth?.default === refreshed.slug;
      return text(
        envelope({
          workspace: refreshed.slug,
          workspace_name: refreshed.name,
          is_default: isDefault,
          viewer: refreshed.viewer,
          auth_file: AUTH_FILE_DISPLAY,
          auth_storage: AUTH_STORAGE_KIND,
          refreshed: true,
          created_at: refreshed.created_at,
        }),
      );
    }),
  );

  // ---------- cache_gc ----------
  server.registerTool(
    "cache_gc",
    {
      title: "Garbage-collect stale per-repo cache directories",
      description:
        "Scan ~/.lebop/cache/ for per-repo subdirs and report (or remove) stale ones. Defaults to dry-run + preserving the cwd's repo cache. Mirrors `lebop cache gc`.",
      inputSchema: {
        max_age_days: z
          .number()
          .min(0)
          .optional()
          .describe("Evict repos whose newest file is older than N days (default 30)."),
        max_size_mb: z
          .number()
          .min(0)
          .optional()
          .describe("Trim oldest repos until total cache size is below the limit (default 500)."),
        hash: z
          .string()
          .optional()
          .describe("Evict only the named hash; bypasses age/size selection."),
        dry_run: z
          .boolean()
          .optional()
          .describe("Report candidates without removing. Defaults to true."),
        confirm: z
          .boolean()
          .optional()
          .describe("Required true when dry_run:false will remove local cache directories."),
        preserve_cwd_repo: z
          .boolean()
          .optional()
          .describe("Skip the cwd's repo cache even if it qualifies. Defaults to true."),
      },
      annotations: {
        title: "Garbage-collect stale per-repo cache directories",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        // cache_gc is purely local-filesystem (~/.lebop/cache) — no Linear
        // API call, no external system touched. `openWorldHint: false` is
        // accurate; `destructiveHint: true` still warns hosts that this
        // tool removes data, and `idempotentHint: false` since each run
        // can evict a different selection (age-based + size-based).
        openWorldHint: false,
      },
    },
    safe(async (args) => {
      const dryRun = args.dry_run === undefined ? true : (args.dry_run as boolean);
      if (!dryRun) requireConfirm(args as { confirm?: boolean }, "cache_gc");
      const result = await gcCache({
        maxAgeDays: args.max_age_days as number | undefined,
        maxSizeMb: args.max_size_mb as number | undefined,
        hash: args.hash as string | undefined,
        dryRun,
        preserveCwdRepo:
          args.preserve_cwd_repo === undefined ? true : (args.preserve_cwd_repo as boolean),
      });
      return text(envelope({ dry_run: dryRun, ...result }));
    }),
  );

  // ==========================================================================
  // Attachments, team get, lookups, bulk, workflow states
  // ==========================================================================

  // ---------- attachments ----------
  server.registerTool(
    "list_attachments",
    {
      title: "List attachments on an issue",
      description:
        "Returns all Linear Attachments on one issue (URL links, integration-created references, etc.). Pure read; paginated server-side.",
      inputSchema: {
        identifier: z.string().describe("Issue identifier, e.g. 'NOX-321'."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List attachments on an issue",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const upperId = (args.identifier as string).toUpperCase();
      const attachments = await listAttachments(upperId);
      return text(
        envelope({
          identifier: upperId,
          count: attachments.length,
          attachments,
        }),
      );
    }),
  );

  server.registerTool(
    "update_attachment",
    {
      title: "Update an attachment's title",
      description:
        "Update an attachment's title. Linear does not support URL edits on existing attachments; delete and relink to change the URL.",
      inputSchema: {
        id: z.string().describe("Attachment UUID."),
        title: z.string().optional(),
        url: z
          .string()
          .optional()
          .describe("Unsupported by Linear; kept to return a structured validation error."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Update an attachment's title",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const input: { title?: string; url?: string } = {};
      if (args.title !== undefined) input.title = args.title as string;
      if (args.url !== undefined) input.url = args.url as string;
      if (Object.keys(input).length === 0) {
        throw new ValidationError(
          "nothing to update — pass at least one of title, url",
          "pass title and/or url",
        );
      }
      const attachment = await updateAttachment(args.id as string, input);
      return text(envelope({ attachment }));
    }),
  );

  server.registerTool(
    "delete_attachment",
    {
      title: "Delete an attachment",
      description:
        "Delete an attachment by UUID. Idempotent — re-deleting an already-absent attachment returns `{status: 'already-absent'}`.",
      inputSchema: {
        id: z.string().describe("Attachment UUID."),
        confirm: z.boolean().optional().describe("Required true for deletion."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Delete an attachment",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      requireConfirm(args, "delete_attachment");
      const { status } = await tryIdempotentDelete(() => deleteAttachment(args.id as string));
      return text(envelope({ id: args.id, status, success: status === "deleted" }));
    }),
  );

  // ---------- get_team ----------
  server.registerTool(
    "get_team",
    {
      title: "Get one team by key or UUID",
      description:
        "Returns one team (with default-state). Missing ids/keys surface as structured not_found errors, matching `lebop team get --json`. Wires the team-key → UUID gap that bites create_label and create_project. `id` accepts a team key (e.g. 'ENG') OR a UUID.",
      inputSchema: {
        id: z.string().describe("Team key (e.g. 'ENG') OR UUID."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Get one team by key or UUID",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const team = requireMcpEntity(
        await getTeam(args.id as string),
        "team",
        args.id as string,
        "verify the team key/UUID; run list_teams to discover teams",
      );
      return text(envelope({ team }));
    }),
  );

  // ---------- lookups ----------
  server.registerTool(
    "lookup_state_by_name",
    {
      title: "Resolve a workflow state name to a UUID",
      description:
        "Team-scoped exact-name lookup against the Linear workflowStates connection. Case-sensitive. Returns null if not found.",
      inputSchema: {
        team: z.string().describe("Team key (state lookup is team-scoped)."),
        name: z.string().describe("Workflow state name (e.g. 'In Progress'). Case-sensitive."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Resolve a workflow state name to a UUID",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const state = await lookupStateByName(args.team as string, args.name as string);
      return text(envelope({ state }));
    }),
  );

  server.registerTool(
    "lookup_user_by_email",
    {
      title: "Resolve a workspace user by email",
      description: "Returns the user record or null. Useful before assignee=<uuid> updates.",
      inputSchema: {
        email: z.string().describe("Workspace user email. Returns null if not found."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "Resolve a workspace user by email",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const user = await lookupUserByEmail(args.email as string);
      return text(envelope({ user }));
    }),
  );

  // ---------- set_workspace_default_team ----------
  server.registerTool(
    "set_workspace_default_team",
    {
      title: "Set the default team for a workspace",
      description:
        "Updates `workspace_team_defaults[<slug>]` in ~/.lebop/config.yaml. Pairs with set_default_workspace. Idempotent at the value level.",
      inputSchema: {
        workspace_slug: z.string().describe("Workspace slug to set the default team for."),
        // Use `team` for consistency with every other tool that takes a team
        // identifier (`list_issues`, `list_projects`, `list_team_members`,
        // etc.).
        team: z.string().describe("Team key (e.g. 'NOX')."),
      },
      annotations: {
        title: "Set the default team for a workspace",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safe(async (args) => {
      // Validate that the team exists inside the target workspace before
      // writing to config. This tool uses `workspace_slug`, not the standard
      // per-tool `workspace` argument, so it sets request context explicitly.
      const team = await runWithRequestContext({ workspace: args.workspace_slug as string }, () =>
        getTeam(args.team as string),
      );
      if (!team) {
        throw new NotFoundError(
          `team not found: ${args.team}`,
          `run \`lebop teams --workspace ${args.workspace_slug}\` to list valid keys`,
        );
      }
      await setWorkspaceDefaultTeam(args.workspace_slug as string, args.team as string);
      return text(
        envelope({
          workspace_slug: args.workspace_slug,
          // Response envelope also uses `team` (not `team_key`) — same
          // consistency principle. BREAKING for any caller that read
          // response.team_key; the wire-level rename is the whole point.
          team: args.team,
        }),
      );
    }),
  );
}

function registerLegacyMcpToolsAfterBulk(server: McpServerLike): void {
  // ---------- list_workflow_states ----------
  server.registerTool(
    "list_workflow_states",
    {
      title: "List workflow states for a team",
      description:
        "Per-team workflow states (Backlog, Todo, In Progress, Done, Cancelled — varies per team setup). Thin wrapper over the team-metadata cache + a live states() fetch for color + default flag.",
      inputSchema: {
        team: z.string().optional().describe("Team key. Omit to use the configured default team."),
        workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
      },
      annotations: {
        title: "List workflow states for a team",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const config = await resolveConfig({ teamOverride: args.team as string | undefined });
      const result = await listWorkflowStates(config.team);
      if (!result) {
        throw new NotFoundError(
          `team not found: ${config.team}`,
          "verify the team key (e.g. 'NOX')",
        );
      }
      return text(
        envelope({ team: result.team, count: result.states.length, states: result.states }),
      );
    }),
  );
}
