/**
 * Shared `buildIssueUpdateInput` helper used by both the CLI `push` command
 * and the MCP `push_changes` tool. Lives at lib-level so both surfaces apply
 * exactly the same field-resolution behavior — keeping push behavior
 * uniform across entry points was the wave-2 fix that prompted the extract.
 */

import type { IssueMetadata } from "./cache.ts";
import type { IssueChange } from "./diff.ts";
import { NotFoundError } from "./errors.ts";
import type { IssueUpdateInput } from "./pushMutations.ts";
import {
  type getTeamMetadata,
  resolveAssigneeId,
  resolveLabelIds,
  resolveStateId,
} from "./resolve.ts";
import { withClient } from "./sdk.ts";

/**
 * Shape required from a push plan: the metadata snapshot, the local
 * description, and the diff that selected the fields to touch. Kept here
 * (rather than imported from `src/commands/push.ts`) so the lib has no
 * dependency on a CLI-only module.
 */
export interface IssuePushPlan {
  identifier: string;
  metadata: IssueMetadata;
  description: string;
  changes: IssueChange[];
}

/**
 * Translate a diff'd issue plan into Linear's `IssueUpdateInput` shape.
 * Resolves state/label/assignee names against the cached team metadata and
 * looks up parent identifiers to UUIDs via `withClient`.
 *
 * Throws `ResolveError` (from `resolve.ts`) if a name lookup misses; the
 * caller decides whether to retry with refreshed metadata
 * (`withFreshMetadataOnMiss`) or bubble the error up.
 */
export async function buildIssueUpdateInput(
  plan: IssuePushPlan,
  teamMetadata: Awaited<ReturnType<typeof getTeamMetadata>>,
): Promise<IssueUpdateInput> {
  const input: IssueUpdateInput = {};
  for (const change of plan.changes) {
    switch (change.field) {
      case "title":
        input.title = plan.metadata.title;
        break;
      case "description":
        input.description = plan.description;
        break;
      case "state":
        input.stateId = resolveStateId(teamMetadata, plan.metadata.state);
        break;
      case "priority":
        input.priority = plan.metadata.priority;
        break;
      case "estimate":
        input.estimate = plan.metadata.estimate;
        break;
      case "labels":
        input.labelIds = resolveLabelIds(teamMetadata, plan.metadata.labels);
        break;
      case "assignee":
        input.assigneeId = plan.metadata.assignee
          ? await resolveAssigneeId(teamMetadata, plan.metadata.assignee)
          : null;
        break;
      case "parent": {
        // Linear's parentId wants a UUID, not the TEAM-NN identifier.
        // null clears the parent link.
        if (!plan.metadata.parent) {
          input.parentId = null;
        } else {
          const parent = await withClient((c) => c.issue(plan.metadata.parent ?? ""));
          if (!parent) {
            // Structured error so MCP clients see `code: "not_found"` instead
            // of the generic `code: "unknown"` the safe() wrapper falls back
            // to for raw Errors. Hint surfaces the identifier the caller
            // passed so the operator can correct their input directly.
            throw new NotFoundError(
              `parent issue not found: ${plan.metadata.parent}`,
              `verify '${plan.metadata.parent}' exists and is visible to your token`,
            );
          }
          input.parentId = parent.id;
        }
        break;
      }
    }
  }
  return input;
}
