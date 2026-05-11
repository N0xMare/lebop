import { createTwoFilesPatch } from "diff";
import type { TeamMetadata } from "./cache.ts";
import { paginateRaw } from "./paginate.ts";
import type { IssueFile, LinkKey, ParsedPlan, ProjectFile } from "./planTypes.ts";
import { LINK_KEYS } from "./planTypes.ts";
import {
  buildPullIssuesQuery,
  type FetchedIssue,
  type FetchedProject,
  PULL_PROJECT_HEADER_QUERY,
} from "./pullQuery.ts";
import { resolveLabelIds, resolvePriority } from "./resolve.ts";
import { linear, withClient } from "./sdk.ts";

export interface FieldDiff {
  field: string;
  local: unknown;
  remote: unknown;
}

export interface RelationEdge {
  kind: LinkKey;
  target: string; // Linear identifier
}

export interface PlanIssueDiff {
  slug: string;
  path: string;
  linear_id?: string;
  status:
    | "unchanged"
    | "drift"
    | "not-yet-applied" // no linear_id yet
    | "missing-remote" // linear_id present but Linear returned null
    | "error";
  field_changes: FieldDiff[];
  body_patch?: string; // unified patch; empty when bodies match
  relations_missing_remote: RelationEdge[]; // in plan, not on remote
  relations_extra_remote: RelationEdge[]; // on remote, not in plan
  error?: string;
}

export interface PlanProjectDiff {
  name: string;
  linear_id?: string;
  status: "unchanged" | "drift" | "not-yet-applied" | "missing-remote" | "error";
  field_changes: FieldDiff[];
  content_patch?: string;
  error?: string;
}

export interface PlanDiffResult {
  project: PlanProjectDiff;
  issues: PlanIssueDiff[];
  extra_remote_issues: { identifier: string; title: string }[]; // in remote project, not in plan
  has_drift: boolean;
}

/**
 * Issues-in-project listing for diff/pull workflows. Just identifier + title;
 * the rest of the project metadata is read separately from the plan files.
 * Always paginated via `paginateRaw` so projects with >250 issues work.
 */
const PROJECT_ISSUES_QUERY = /* GraphQL */ `
  query PlanProjectIssues($id: String!, $first: Int!, $after: String) {
    project(id: $id) {
      issues(first: $first, after: $after) {
        nodes { identifier title }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

interface ProjectIssuesResponse {
  data: {
    project: {
      issues: {
        nodes: { identifier: string; title: string }[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
  };
}

// ---------- public entry ----------

export async function diffPlan(
  plan: ParsedPlan,
  teamMetadata: TeamMetadata,
): Promise<PlanDiffResult> {
  const project = await diffProject(plan.project);
  const planEdges = computeAllPlanEdges(plan);
  const issues: PlanIssueDiff[] = [];
  for (const issue of plan.issues) {
    const fromKey = issue.frontmatter.linear_id ?? issue.slug;
    issues.push(await diffIssue(issue, teamMetadata, planEdges.get(fromKey) ?? new Set()));
  }

  // Detect remote-only issues in the project (warning, not drift).
  const extraRemote: { identifier: string; title: string }[] = [];
  if (project.linear_id && project.status !== "missing-remote" && project.status !== "error") {
    try {
      // paginateRaw wraps each page with withRetry internally; don't double-wrap
      // the inner call site with withClient (would compound retries on
      // exhaustion).
      const client = await linear();
      const linearId = project.linear_id;
      const remoteIssues = await paginateRaw<
        { identifier: string; title: string },
        ProjectIssuesResponse
      >(
        ({ first, after }) =>
          client.client.rawRequest(PROJECT_ISSUES_QUERY, {
            id: linearId,
            first,
            after,
          }) as Promise<ProjectIssuesResponse>,
        (response) => response.data.project?.issues ?? null,
        { pageSize: 250 },
      );
      const planned = new Set(plan.issues.map((i) => i.frontmatter.linear_id).filter(Boolean));
      for (const node of remoteIssues) {
        if (!planned.has(node.identifier)) {
          extraRemote.push({ identifier: node.identifier, title: node.title });
        }
      }
    } catch {
      /* non-fatal — extra-remote detection is best-effort */
    }
  }

  // `has_drift` = any in-plan entity differs from remote (i.e. pulling would overwrite
  // local edits). Extra-remote issues are tracked separately — they don't cause
  // overwrites, so `--include-new` can always import them even when has_drift=false.
  const hasDrift =
    project.status === "drift" ||
    issues.some((i) => i.status === "drift" || i.status === "not-yet-applied");

  return { project, issues, extra_remote_issues: extraRemote, has_drift: hasDrift };
}

// ---------- project ----------

async function diffProject(project: ProjectFile): Promise<PlanProjectDiff> {
  const fm = project.frontmatter;
  if (!fm.linear_id) {
    return {
      name: fm.name,
      status: "not-yet-applied",
      field_changes: [],
    };
  }
  try {
    const response = (await withClient((c) =>
      c.client.rawRequest(PULL_PROJECT_HEADER_QUERY, { id: fm.linear_id }),
    )) as { data: { project: Omit<FetchedProject, "issues"> | null } };
    const remote = response.data.project;
    if (!remote) {
      return {
        name: fm.name,
        linear_id: fm.linear_id,
        status: "missing-remote",
        field_changes: [],
      };
    }

    const fields: FieldDiff[] = [];
    if (remote.name !== fm.name) {
      fields.push({ field: "name", local: fm.name, remote: remote.name });
    }
    if ((remote.description ?? "") !== (fm.description ?? "")) {
      fields.push({
        field: "description",
        local: fm.description ?? "",
        remote: remote.description ?? "",
      });
    }
    if (fm.state && remote.state !== fm.state) {
      fields.push({ field: "state", local: fm.state, remote: remote.state });
    }

    const remoteContent = remote.content ?? "";
    const localContentNorm = project.body.replace(/\s+$/, "");
    const remoteContentNorm = remoteContent.replace(/\s+$/, "");
    const patch = createTwoFilesPatch(
      `a/${fm.name}/content.md`,
      `b/${fm.name}/content.md`,
      remoteContentNorm,
      localContentNorm,
      "remote",
      "local",
      { context: 3 },
    );
    const contentChanged = patchHasChanges(patch);

    const status: PlanProjectDiff["status"] =
      fields.length > 0 || contentChanged ? "drift" : "unchanged";

    return {
      name: fm.name,
      linear_id: fm.linear_id,
      status,
      field_changes: fields,
      content_patch: contentChanged ? patch : undefined,
    };
  } catch (err) {
    return {
      name: fm.name,
      linear_id: fm.linear_id,
      status: "error",
      field_changes: [],
      error: (err as Error).message,
    };
  }
}

// ---------- issue ----------

async function diffIssue(
  issue: IssueFile,
  teamMetadata: TeamMetadata,
  planEdges: Set<string>,
): Promise<PlanIssueDiff> {
  const fm = issue.frontmatter;
  if (!fm.linear_id) {
    return {
      slug: issue.slug,
      path: issue.path,
      status: "not-yet-applied",
      field_changes: [],
      relations_missing_remote: [],
      relations_extra_remote: [],
    };
  }

  try {
    const query = buildPullIssuesQuery([fm.linear_id], false, true);
    const resp = (await withClient((c) => c.client.rawRequest(query))) as {
      data: Record<string, FetchedIssue | null>;
    };
    const remote = resp.data.a0;
    if (!remote) {
      return {
        slug: issue.slug,
        path: issue.path,
        linear_id: fm.linear_id,
        status: "missing-remote",
        field_changes: [],
        relations_missing_remote: [],
        relations_extra_remote: [],
      };
    }

    const fields: FieldDiff[] = [];
    if (remote.title !== fm.title) {
      fields.push({ field: "title", local: fm.title, remote: remote.title });
    }
    if (fm.state && remote.state.name !== fm.state) {
      fields.push({ field: "state", local: fm.state, remote: remote.state.name });
    }
    if (fm.priority !== undefined) {
      const localPrio = resolvePriority(fm.priority);
      if (remote.priority !== localPrio) {
        fields.push({ field: "priority", local: localPrio, remote: remote.priority });
      }
    }
    if (fm.estimate !== undefined) {
      if ((remote.estimate ?? null) !== (fm.estimate ?? null)) {
        fields.push({ field: "estimate", local: fm.estimate, remote: remote.estimate });
      }
    }
    if (fm.parent !== undefined) {
      const remoteParent = remote.parent?.identifier ?? null;
      const localParent = typeof fm.parent === "string" ? fm.parent : null;
      if (remoteParent !== localParent) {
        fields.push({ field: "parent", local: localParent, remote: remoteParent });
      }
    }
    if (fm.labels) {
      const localIds = resolveLabelIds(teamMetadata, fm.labels).sort();
      const remoteIds = remote.labels.nodes.map((l) => l.id).sort();
      if (JSON.stringify(localIds) !== JSON.stringify(remoteIds)) {
        fields.push({
          field: "labels",
          local: fm.labels.sort(),
          remote: remote.labels.nodes.map((l) => l.name).sort(),
        });
      }
    }
    if (fm.assignee !== undefined) {
      const remoteAssignee = remote.assignee?.email ?? null;
      const localAssignee = fm.assignee ?? null;
      if (remoteAssignee !== localAssignee) {
        fields.push({ field: "assignee", local: localAssignee, remote: remoteAssignee });
      }
    }

    const remoteBody = remote.description ?? "";
    // Normalize trailing whitespace on both sides — Linear's renderer strips trailing
    // newlines but our writer conventionally adds one. The difference is cosmetic and
    // not meaningful to diff.
    const localBodyNorm = issue.body.replace(/\s+$/, "");
    const remoteBodyNorm = remoteBody.replace(/\s+$/, "");
    const patch = createTwoFilesPatch(
      `a/${fm.linear_id}/description.md`,
      `b/${fm.linear_id}/description.md`,
      remoteBodyNorm,
      localBodyNorm,
      "remote",
      "local",
      { context: 3 },
    );
    const bodyChanged = patchHasChanges(patch);

    // Relations diff: planEdges comes pre-computed with inverse/symmetric normalization.
    const remoteEdges = remoteEdgeSet(remote);
    const missing: RelationEdge[] = [];
    const extra: RelationEdge[] = [];
    for (const e of planEdges) if (!remoteEdges.has(e)) missing.push(parseEdge(e));
    for (const e of remoteEdges) if (!planEdges.has(e)) extra.push(parseEdge(e));

    const hasDrift = fields.length > 0 || bodyChanged || missing.length > 0 || extra.length > 0;
    const status: PlanIssueDiff["status"] = hasDrift ? "drift" : "unchanged";

    return {
      slug: issue.slug,
      path: issue.path,
      linear_id: fm.linear_id,
      status,
      field_changes: fields,
      body_patch: bodyChanged ? patch : undefined,
      relations_missing_remote: missing,
      relations_extra_remote: extra,
    };
  } catch (err) {
    return {
      slug: issue.slug,
      path: issue.path,
      linear_id: fm.linear_id,
      status: "error",
      field_changes: [],
      relations_missing_remote: [],
      relations_extra_remote: [],
      error: (err as Error).message,
    };
  }
}

// ---------- relation edge helpers ----------

/**
 * Build the plan's complete edge graph. For each declared link, record BOTH directions:
 * the explicit forward edge AND the implied inverse edge on the target. This matches
 * Linear's single-record-per-pair semantics — declaring `A blocks: [B]` in the plan
 * implies `B blocked_by: [A]` is also true on the remote, even if the plan file for B
 * doesn't mention it. Similarly `related` is symmetric and propagates both ways.
 *
 * Returns Map keyed by each node's linear_id-or-slug; value is the edge set
 * (`"{kind}:{otherIdentifier}"`).
 */
function computeAllPlanEdges(plan: ParsedPlan): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  const add = (from: string, edge: string): void => {
    if (!edges.has(from)) edges.set(from, new Set());
    const set = edges.get(from);
    if (set) set.add(edge);
  };

  // Map slug → linear_id so we can resolve local references to their Linear identity.
  const slugToId = new Map<string, string>();
  for (const issue of plan.issues) {
    if (issue.frontmatter.linear_id) slugToId.set(issue.slug, issue.frontmatter.linear_id);
  }
  const resolve = (raw: string): string => slugToId.get(raw) ?? raw;

  for (const issue of plan.issues) {
    const fromKey = issue.frontmatter.linear_id ?? issue.slug;
    for (const key of LINK_KEYS) {
      const targets = issue.frontmatter[key] as string[] | undefined;
      if (!targets) continue;
      for (const t of targets) {
        const resolved = resolve(t);
        add(fromKey, `${key}:${resolved}`);
        // Inverse-ish side: only propagate if the target is in the plan (we know its
        // identifier). External targets (UE-### outside the plan) can't have their
        // files updated anyway.
        add(resolved, `${invertKind(key)}:${fromKey}`);
      }
    }
  }
  return edges;
}

function invertKind(k: LinkKey): LinkKey {
  switch (k) {
    case "blocks":
      return "blocked_by";
    case "blocked_by":
      return "blocks";
    case "duplicates":
      return "duplicated_by";
    case "duplicated_by":
      return "duplicates";
    case "related":
      return "related"; // symmetric
  }
}

/** Remote edges for an issue, encoded same way. */
function remoteEdgeSet(issue: FetchedIssue): Set<string> {
  const set = new Set<string>();
  for (const r of issue.relations?.nodes ?? []) {
    const key: LinkKey =
      r.type === "blocks" ? "blocks" : r.type === "duplicate" ? "duplicates" : "related";
    if (r.type === "similar") continue;
    set.add(`${key}:${r.relatedIssue.identifier}`);
  }
  for (const r of issue.inverseRelations?.nodes ?? []) {
    if (r.type === "similar") continue;
    const key: LinkKey =
      r.type === "blocks" ? "blocked_by" : r.type === "duplicate" ? "duplicated_by" : "related"; // symmetric — same key as forward
    set.add(`${key}:${r.issue.identifier}`);
  }
  return set;
}

function parseEdge(s: string): RelationEdge {
  const colon = s.indexOf(":");
  return { kind: s.slice(0, colon) as LinkKey, target: s.slice(colon + 1) };
}

function patchHasChanges(patch: string): boolean {
  return patch
    .split("\n")
    .some(
      (l) =>
        (l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---")),
    );
}
