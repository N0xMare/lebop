/**
 * Shared `buildIssueUpdateInput` helper used by both the CLI `push` command
 * and the MCP `push_changes` tool. Lives at lib-level so both surfaces apply
 * exactly the same field-resolution behavior — keeping push behavior
 * uniform across entry points was the wave-2 fix that prompted the extract.
 */

import type { IssueMetadata, ProjectMetadata } from "./cache.ts";
import type { IssueChange, ProjectChange } from "./diff.ts";
import { NotFoundError } from "./errors.ts";
import type { IssueUpdateInput, ProjectUpdateInput } from "./pushMutations.ts";
import {
  type getTeamMetadata,
  ResolveError,
  resolveAssigneeId,
  resolveCycleIdByName,
  resolveLabelIds,
  resolveMilestoneIdByName,
  resolveProjectIdByName,
  resolveStateId,
} from "./resolve.ts";
import { withClient } from "./sdk.ts";
import { isUuid } from "./uuid.ts";

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

export interface ProjectPushPlan {
  metadata: ProjectMetadata;
  content: string;
  changes: ProjectChange[];
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
      case "project":
        input.projectId = await resolveIssueProjectId(plan, teamMetadata);
        break;
      case "milestone":
        input.projectMilestoneId = await resolveIssueMilestoneId(plan, input.projectId);
        break;
      case "cycle":
        input.cycleId = await resolveIssueCycleId(plan, teamMetadata);
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

async function resolveIssueProjectId(
  plan: IssuePushPlan,
  teamMetadata: Awaited<ReturnType<typeof getTeamMetadata>>,
): Promise<string | null> {
  const project = plan.metadata.project;
  if (!project) return null;
  if (project === plan.metadata._server.project_name && plan.metadata._server.project_id) {
    return plan.metadata._server.project_id;
  }
  return await resolveProjectIdByName(project, { teamKey: teamMetadata.team_key });
}

async function resolveIssueMilestoneId(
  plan: IssuePushPlan,
  resolvedProjectId: string | null | undefined,
): Promise<string | null> {
  const milestone = plan.metadata.milestone;
  if (!milestone) return null;
  if (
    milestone === plan.metadata._server.project_milestone_name &&
    plan.metadata._server.project_milestone_id
  ) {
    return plan.metadata._server.project_milestone_id;
  }
  const projectId =
    resolvedProjectId === null
      ? null
      : resolvedProjectId !== undefined
        ? resolvedProjectId
        : plan.metadata._server.project_id;
  if (!isUuid(milestone) && !projectId) {
    throw new ResolveError(
      `milestone name "${milestone}" requires a project scope`,
      "set project in metadata.yaml, keep the issue attached to a project, or use the milestone UUID",
    );
  }
  return await resolveMilestoneIdByName(milestone, { projectId });
}

async function resolveIssueCycleId(
  plan: IssuePushPlan,
  teamMetadata: Awaited<ReturnType<typeof getTeamMetadata>>,
): Promise<string | null> {
  const cycle = plan.metadata.cycle;
  if (!cycle) return null;
  if (cycle === plan.metadata._server.cycle_name && plan.metadata._server.cycle_id) {
    return plan.metadata._server.cycle_id;
  }
  return await resolveCycleIdByName(cycle, teamMetadata.team_key);
}

export function buildProjectUpdateInput(plan: ProjectPushPlan): ProjectUpdateInput {
  const input: ProjectUpdateInput = {};
  for (const change of plan.changes) {
    switch (change.field) {
      case "name":
        input.name = plan.metadata.name;
        break;
      case "description":
        input.description = plan.metadata.description;
        break;
      case "icon":
        input.icon = plan.metadata.icon ?? null;
        break;
      case "start_date":
        input.startDate = plan.metadata.start_date ?? null;
        break;
      case "target_date":
        input.targetDate = plan.metadata.target_date ?? null;
        break;
      case "state":
        input.state = plan.metadata.state;
        break;
      case "content":
        input.content = plan.content;
        break;
    }
  }
  return input;
}
