/**
 * Bulk operations. Today: `bulkUpdateIssues` — apply one identical patch to
 * a set of issues. Common workflow: "set state=Done on these 5 PR-merged
 * issues" — saves N round-trips.
 *
 * Linear's GraphQL surface: `issueBatchUpdate(ids: [String!]!, input:
 * IssueUpdateInput!): IssueBatchPayload`. We resolve all name → UUID lookups
 * ONCE up front (state, labels, assignee, project, milestone, cycle) and
 * then fire a single batch mutation against the resolved issue UUIDs.
 *
 * Returns a per-row result table: each input identifier maps to either
 * `{status: "updated", fields}` or `{status: "failed", error: {code, message,
 * hint}}`. Matches the existing `push_changes` per-row pattern so agents
 * have one mental model for partial-success across the codebase.
 */

import type { TeamMetadata } from "./cache.ts";
import { type IssueCacheRefreshSummary, summarizeIssueCacheRefresh } from "./cacheCoherence.ts";
import { refreshCachedIssueByIdentifier } from "./cacheRefresh.ts";
import { mapLimit } from "./concurrency.ts";
import { LebopError, mapSdkError, NotFoundError, ValidationError } from "./errors.ts";
import {
  deriveTeamFromIdentifiers,
  getTeamMetadata,
  ResolveError,
  resolveAssigneeId,
  resolveCycleIdByName,
  resolveLabelIds,
  resolveMilestoneIdByName,
  resolvePriority,
  resolveProjectIdByName,
  resolveStateId,
  withFreshMetadataOnMiss,
} from "./resolve.ts";
import { withClient } from "./sdk.ts";
import { isUuid } from "./uuid.ts";

export interface BulkUpdatePatch {
  state?: string;
  priority?: string | number;
  labels?: string[];
  assignee?: string | null;
  estimate?: number | null;
  project?: string | null;
  milestone?: string | null;
  cycle?: string | null;
}

export interface BulkUpdateInput {
  identifiers: string[];
  patch: BulkUpdatePatch;
  /** Override the derived team for state/labels/assignee resolution. */
  team?: string;
  dryRun?: boolean;
  repoHash?: string;
  repoRoot?: string | null;
}

export type BulkRowStatus = "updated" | "would_update" | "failed";

export interface BulkRowResult {
  identifier: string;
  status: BulkRowStatus;
  /** Fields applied (present on `updated` rows). */
  fields?: string[];
  /** Structured error (present on `failed` rows). */
  error?: { code: string; message: string; hint?: string };
}

export interface BulkUpdateResult {
  results: BulkRowResult[];
  summary: {
    updated: number;
    would_update: number;
    failed: number;
    total: number;
    dry_run: boolean;
  };
  cache: IssueCacheRefreshSummary;
}

const ISSUE_BATCH_UPDATE_MUTATION = /* GraphQL */ `
  mutation IssueBatchUpdate($ids: [UUID!]!, $input: IssueUpdateInput!) {
    issueBatchUpdate(ids: $ids, input: $input) {
      success
      issues { id identifier }
    }
  }
`;

const RESOLVE_ISSUE_ID_QUERY = /* GraphQL */ `
  query ResolveIssueId($id: String!) {
    issue(id: $id) { id identifier }
  }
`;

/**
 * Apply one patch uniformly to N issues. Returns a partial-success table
 * matching push_changes' per-row shape. Order:
 *   1. derive team from identifiers (or use the override)
 *   2. resolve patch extras ONCE against team metadata (state, labels,
 *      assignee, project, milestone, cycle)
 *   3. resolve every identifier → UUID via parallel issue(id) lookups
 *   4. fire `issueBatchUpdate` with the resolved UUIDs + input
 *   5. shape per-row results (any identifier missing from the read shows up
 *      as `failed: not_found`)
 *
 * Identifiers spanning multiple teams require the explicit `team` arg if any
 * team-scoped patch field (state/labels/assignee) is supplied — otherwise we
 * couldn't pick the right metadata cache. UUID-only fields (project,
 * milestone) work cross-team.
 */
export async function bulkUpdateIssues(input: BulkUpdateInput): Promise<BulkUpdateResult> {
  const ids = input.identifiers;
  if (ids.length === 0) {
    return {
      results: [],
      summary: { updated: 0, would_update: 0, failed: 0, total: 0, dry_run: input.dryRun === true },
      cache: summarizeIssueCacheRefresh([]),
    };
  }
  const repoHash = input.repoHash ?? "_global";
  const upperIds = ids.map((id) => id.toUpperCase());

  // Derive team for state/labels/assignee resolution. Optional unless the
  // patch contains team-scoped names.
  const needsTeamScope =
    input.patch.state !== undefined ||
    input.patch.labels !== undefined ||
    (typeof input.patch.assignee === "string" &&
      input.patch.assignee !== "@me" &&
      input.patch.assignee !== "me");
  let derived: string | null = null;
  try {
    derived = deriveTeamFromIdentifiers(upperIds);
  } catch {
    // multi-team identifiers — derived stays null. We surface a clear error
    // below only if team scope is actually needed.
  }
  const teamKey = input.team ?? derived ?? undefined;
  if (needsTeamScope && !teamKey) {
    throw new ValidationError(
      "bulk_update_issues: identifiers span multiple teams, but patch needs team scope",
      "pass `team` explicitly, or split the call by team",
    );
  }

  // ---------- step 1: resolve patch extras ONCE up front ----------
  const fieldsApplied: string[] = [];
  const linearInput: Record<string, unknown> = {};

  if (input.patch.priority !== undefined) {
    linearInput.priority = resolvePriority(input.patch.priority);
    fieldsApplied.push("priority");
  }
  if (input.patch.estimate !== undefined) {
    linearInput.estimate = input.patch.estimate;
    fieldsApplied.push("estimate");
  }

  let projectId: string | null | undefined;
  if (input.patch.project === undefined) {
    projectId = undefined;
  } else if (input.patch.project === null) {
    projectId = null;
  } else if (isUuid(input.patch.project)) {
    projectId = input.patch.project;
  } else {
    projectId = await resolveProjectIdByName(input.patch.project, { teamKey: input.team });
  }
  if (projectId !== undefined) {
    linearInput.projectId = projectId;
    fieldsApplied.push("project");
  }

  let milestoneId: string | null | undefined;
  if (input.patch.milestone === undefined) {
    milestoneId = undefined;
  } else if (input.patch.milestone === null) {
    milestoneId = null;
  } else {
    const milestoneProjectId = projectId && typeof projectId === "string" ? projectId : undefined;
    if (!isUuid(input.patch.milestone) && !milestoneProjectId) {
      throw new ResolveError(
        `bulk_update_issues milestone name "${input.patch.milestone}" requires a target project scope`,
        "include project in the same patch, or use the milestone UUID instead",
      );
    }
    milestoneId = await resolveMilestoneIdByName(input.patch.milestone, {
      projectId: milestoneProjectId,
    });
  }
  if (milestoneId !== undefined) {
    linearInput.projectMilestoneId = milestoneId;
    fieldsApplied.push("milestone");
  }

  let cycleId: string | null | undefined;
  if (input.patch.cycle === undefined) {
    cycleId = undefined;
  } else if (input.patch.cycle === null) {
    cycleId = null;
  } else {
    cycleId = await resolveCycleIdByName(input.patch.cycle, teamKey);
  }
  if (cycleId !== undefined) {
    linearInput.cycleId = cycleId;
    fieldsApplied.push("cycle");
  }

  // Round-8 / R7-L2: hoist `@me`/`me` viewer resolution out of the
  // team-metadata closure (parity with round-7 / HIGH-1 in
  // src/lib/issues.ts:309-321). Pre-fix bulk_update_issues with
  // multi-team identifiers + `@me` would silently drop the assignee:
  // needsTeamScope=false (correctly excludes @me) AND teamKey=undefined
  // (multi-team) → closure skipped → assignee never resolved → linearInput
  // could end up empty ("patch is empty" error) or just drop the assignee
  // on a mixed patch.
  let viewerAssigneeId: string | undefined;
  if (
    typeof input.patch.assignee === "string" &&
    (input.patch.assignee === "@me" || input.patch.assignee === "me")
  ) {
    const viewer = await withClient((c) => c.viewer);
    viewerAssigneeId = viewer.id;
  }

  // Only fetch team metadata if there's actual team-scoped resolution work
  // to do — otherwise priority-only / project-only patches would still pay a
  // round-trip for the (unused) team cache. `@me`/`me` resolves via the
  // hoisted viewer query above and does NOT count as team-scoped.
  const hasTeamScopedField =
    input.patch.state !== undefined ||
    input.patch.labels !== undefined ||
    (typeof input.patch.assignee === "string" &&
      input.patch.assignee !== "@me" &&
      input.patch.assignee !== "me");
  if (teamKey && hasTeamScopedField) {
    await withFreshMetadataOnMiss(
      (o) => getTeamMetadata(repoHash, teamKey, o),
      async (md: TeamMetadata) => {
        if (input.patch.state !== undefined) {
          linearInput.stateId = resolveStateId(md, input.patch.state);
          fieldsApplied.push("state");
        }
        if (input.patch.labels !== undefined) {
          linearInput.labelIds = resolveLabelIds(md, input.patch.labels);
          fieldsApplied.push("labels");
        }
        if (
          typeof input.patch.assignee === "string" &&
          input.patch.assignee !== "@me" &&
          input.patch.assignee !== "me"
        ) {
          linearInput.assigneeId = await resolveAssigneeId(md, input.patch.assignee);
          fieldsApplied.push("assignee");
        }
      },
    );
  }
  // Round-8 / R7-L2: viewer-resolved `@me`/`me` (hoisted above) wins over
  // the closure's team-scoped resolution — closure won't set assignee for
  // these tokens anyway, but the precedence keeps the path explicit.
  if (viewerAssigneeId !== undefined) {
    linearInput.assigneeId = viewerAssigneeId;
    fieldsApplied.push("assignee");
  }
  // null-clear assignee works regardless of team scope.
  if (input.patch.assignee === null) {
    linearInput.assigneeId = null;
    fieldsApplied.push("assignee");
  }

  if (Object.keys(linearInput).length === 0) {
    throw new ValidationError(
      "bulk_update_issues: patch is empty",
      "pass at least one of state, priority, labels, assignee, estimate, project, milestone, cycle",
    );
  }

  // ---------- step 2: resolve every identifier → UUID in parallel ----------
  // Track per-id outcomes (resolved | not-found | other-error) so non-
  // NotFound failures (auth, rate-limit, network, etc.) don't get silently
  // flattened to `not_found` in the result table — that would contradict the
  // partial-success contract the tool description promises.
  type ResolveOutcome =
    | { kind: "resolved"; uuid: string }
    | { kind: "not_found" }
    | { kind: "error"; error: LebopError | Error };
  const outcomes = new Map<string, ResolveOutcome>();
  await mapLimit(upperIds, 8, async (id) => {
    try {
      const r = (await withClient((c) => c.client.rawRequest(RESOLVE_ISSUE_ID_QUERY, { id }))) as {
        data: { issue: { id: string; identifier: string } | null };
      };
      if (r.data.issue) {
        // Key by the caller's input `id` (not Linear's echoed identifier)
        // so every outcome branch — resolved / not_found / error — uses
        // a consistent key. Today the two are equivalent because Linear
        // echoes verbatim, but a future normalization could silently
        // diverge if we trust the echo.
        outcomes.set(id, {
          kind: "resolved",
          uuid: r.data.issue.id,
        });
      } else {
        outcomes.set(id, { kind: "not_found" });
      }
    } catch (err) {
      // The SDK boundary wraps rawRequest with mapSdkError, so caught
      // errors are already structured LebopError subtypes in practice.
      // Defensive mapSdkError call is idempotent (LebopError short-
      // circuits) — guards against any caller that bypassed the boundary.
      const mapped = (err instanceof LebopError ? err : mapSdkError(err)) as LebopError | Error;
      if (mapped instanceof NotFoundError) {
        outcomes.set(id, { kind: "not_found" });
      } else {
        outcomes.set(id, { kind: "error", error: mapped });
      }
    }
  });

  // ---------- step 3: fire issueBatchUpdate against resolved UUIDs ----------
  const resolvedIds: string[] = [];
  const resolvedPairs: { identifier: string; uuid: string }[] = [];
  const results: BulkRowResult[] = [];
  for (const id of upperIds) {
    const outcome = outcomes.get(id);
    if (outcome?.kind === "resolved") {
      resolvedIds.push(outcome.uuid);
      resolvedPairs.push({ identifier: id, uuid: outcome.uuid });
    } else if (outcome?.kind === "error") {
      const err = outcome.error;
      const code = err instanceof LebopError ? err.code : "unknown";
      const message =
        err instanceof LebopError ? err.message : ((err as Error).message ?? String(err));
      const hint = err instanceof LebopError ? err.hint : undefined;
      results.push({
        identifier: id,
        status: "failed",
        error: { code, message, ...(hint ? { hint } : {}) },
      });
    } else {
      // not_found, or outcome missing (shouldn't happen — every id was
      // processed by step 2's Promise.all — defensive fallback).
      results.push({
        identifier: id,
        status: "failed",
        error: {
          code: "not_found",
          message: `issue not found: ${id}`,
          hint: "verify the identifier (TEAM-NN) or your team scope",
        },
      });
    }
  }

  if (resolvedIds.length > 0) {
    if (input.dryRun === true) {
      for (const pair of resolvedPairs) {
        results.push({
          identifier: pair.identifier,
          status: "would_update",
          fields: fieldsApplied,
        });
      }
    } else {
      try {
        const batchResponse = (await withClient((client) =>
          client.client.rawRequest(ISSUE_BATCH_UPDATE_MUTATION, {
            ids: resolvedIds,
            input: linearInput,
          }),
        )) as {
          data: {
            issueBatchUpdate: { success: boolean; issues: { id: string; identifier: string }[] };
          };
        };
        // Match by UUID (the unambiguous handle), not by echoed identifier:
        // pair.identifier is the caller's input post-Nit-#3 fix while Linear's
        // batch echo carries the canonical identifier. They match in production
        // (Linear echoes verbatim) but tests with parallel-FIFO mocks can shuffle
        // the mapping. UUID match removes that dependency entirely.
        if (batchResponse.data.issueBatchUpdate.success !== true) {
          for (const pair of resolvedPairs) {
            results.push({
              identifier: pair.identifier,
              status: "failed",
              error: {
                code: "validation_error",
                message: "issueBatchUpdate failed",
                hint: "Linear returned success:false for issueBatchUpdate",
              },
            });
          }
        } else {
          const updatedUuids = new Set(batchResponse.data.issueBatchUpdate.issues.map((i) => i.id));
          for (const pair of resolvedPairs) {
            if (updatedUuids.has(pair.uuid)) {
              results.push({
                identifier: pair.identifier,
                status: "updated",
                fields: fieldsApplied,
              });
            } else {
              // The batch mutation succeeded overall but Linear didn't echo this
              // identifier back — treat as failed for observability.
              results.push({
                identifier: pair.identifier,
                status: "failed",
                error: {
                  code: "unknown",
                  message: "issueBatchUpdate did not echo this identifier",
                },
              });
            }
          }
        }
      } catch (err) {
        const code = err instanceof LebopError ? err.code : "unknown";
        const message =
          err instanceof LebopError ? err.message : ((err as Error).message ?? String(err));
        const hint = err instanceof LebopError ? err.hint : undefined;
        // Whole-batch failure — mark every resolved row as failed with the same
        // error. Pre-resolved not_found rows stay as-is.
        for (const pair of resolvedPairs) {
          results.push({
            identifier: pair.identifier,
            status: "failed",
            error: hint ? { code, message, hint } : { code, message },
          });
        }
      }
    }
  }

  // Sort results back into the caller's input order.
  const orderIndex = new Map(upperIds.map((id, i) => [id, i]));
  results.sort((a, b) => (orderIndex.get(a.identifier) ?? 0) - (orderIndex.get(b.identifier) ?? 0));
  const cacheRows = await mapLimit(
    input.dryRun === true
      ? []
      : results.filter((row) => row.status === "updated").map((row) => row.identifier),
    4,
    (identifier) =>
      refreshCachedIssueByIdentifier(identifier, {
        repoHash: input.repoHash,
        repoRoot: input.repoRoot,
      }),
  );

  return {
    results,
    summary: {
      updated: results.filter((r) => r.status === "updated").length,
      would_update: results.filter((r) => r.status === "would_update").length,
      failed: results.filter((r) => r.status === "failed").length,
      total: results.length,
      dry_run: input.dryRun === true,
    },
    cache: summarizeIssueCacheRefresh(cacheRows),
  };
}
