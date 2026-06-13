import { readFile } from "node:fs/promises";
import { stringify as stringifyYaml } from "yaml";
import { buildIssueMetadata, buildProjectMetadata } from "./build.ts";
import { type TeamMetadata, writeAtomic } from "./cache.ts";
import { mapLimit } from "./concurrency.ts";
import { assertIconNotEmoji } from "./icons.ts";
import { lintContent } from "./lint.ts";
import { requireMutationEntity } from "./mutationResult.ts";
import { splitFrontmatter } from "./planParse.ts";
import type { IssueFile, LinkKey, ParsedPlan, ProjectFile } from "./planTypes.ts";
import { LINK_KEY_TO_SET_LINKS_KIND, LINK_KEYS } from "./planTypes.ts";
import { buildPullIssuesQuery, type FetchedIssue, type FetchedProject } from "./pullQuery.ts";
import {
  ISSUE_UPDATE_MUTATION,
  type IssueUpdateInput,
  PROJECT_UPDATE_MUTATION,
  type ProjectUpdateInput,
} from "./pushMutations.ts";
import type { LintContext } from "./quirks.ts";
import { analyzeRelationCreatePreflight, createLink, listRelations } from "./relations.ts";
import { resolveAssigneeId, resolveLabelIds, resolvePriority, resolveStateId } from "./resolve.ts";
import { linear, withClient } from "./sdk.ts";

// ---------- result types ----------

export interface ApplyIssueResult {
  slug: string;
  path: string;
  linearId?: string;
  status:
    | "created"
    | "created-writeback-failed"
    | "updated"
    | "updated-writeback-failed"
    | "unchanged"
    | "lint-blocked"
    | "error"
    | "dry-run";
  fields?: string[];
  error?: string;
}

export interface ApplyRelationResult {
  fromIdentifier: string;
  toIdentifier: string;
  kind: LinkKey;
  status: "created" | "unchanged" | "error" | "dry-run";
  error?: string;
}

export interface ApplyResult {
  project: {
    name: string;
    linearId?: string;
    status:
      | "created"
      | "created-writeback-failed"
      | "updated"
      | "updated-writeback-failed"
      | "unchanged"
      | "error"
      | "dry-run";
    error?: string;
  };
  issues: ApplyIssueResult[];
  relations: ApplyRelationResult[];
}

export interface ApplyOpts {
  dryRun?: boolean;
  force?: boolean;
  strict?: boolean;
  lintCtx?: LintContext;
}

export interface PlanApplyPreflightResult {
  ready: boolean;
  blockers: string[];
}

function issueWritebackFailed(result: ApplyIssueResult): boolean {
  return (
    result.status === "created-writeback-failed" || result.status === "updated-writeback-failed"
  );
}

function projectApplyFailed(result: ApplyResult["project"]): boolean {
  return (
    result.status === "error" ||
    result.status === "created-writeback-failed" ||
    result.status === "updated-writeback-failed"
  );
}

// ---------- project upsert ----------

const PROJECT_READ_QUERY = /* GraphQL */ `
  query ReadProject($id: String!) {
    project(id: $id) {
      id
      name
      description
      content
      icon
      state
      startDate
      targetDate
      url
      updatedAt
    }
  }
`;

const PROJECT_CREATE_MUTATION = /* GraphQL */ `
  mutation CreateProject($input: ProjectCreateInput!) {
    projectCreate(input: $input) {
      success
      project {
        id
        name
        description
            content
            icon
            state
            startDate
            targetDate
            url
            updatedAt
          }
    }
  }
`;

async function upsertProject(
  project: ProjectFile,
  teamMetadata: TeamMetadata,
  opts: ApplyOpts,
): Promise<ApplyResult["project"]> {
  const fm = project.frontmatter;
  assertIconNotEmoji(fm.icon ?? undefined);

  // Create path.
  if (!fm.linear_id) {
    if (opts.dryRun) {
      return { name: fm.name, status: "dry-run" };
    }
    const input: Record<string, unknown> = {
      teamIds: [teamMetadata.team_id],
      name: fm.name,
    };
    if (fm.description) input.description = fm.description;
    if (fm.icon !== undefined && fm.icon !== null) input.icon = fm.icon;
    if (fm.start_date !== undefined && fm.start_date !== null) input.startDate = fm.start_date;
    if (fm.target_date !== undefined && fm.target_date !== null) input.targetDate = fm.target_date;
    if (project.body.trim() !== "") input.content = project.body;
    let created: FetchedProject;
    try {
      // projectCreate is NOT wrapped with retry — duplicate creation could
      // result if the first attempt succeeded but the response was lost.
      const client = await linear();
      const response = (await client.client.rawRequest(PROJECT_CREATE_MUTATION, { input })) as {
        data: { projectCreate: { success: boolean; project: FetchedProject } };
      };
      created = requireMutationEntity<FetchedProject>(
        "projectCreate",
        response.data.projectCreate as unknown as { success?: boolean } & Record<string, unknown>,
        "project",
      );
    } catch (err) {
      return { name: fm.name, status: "error", error: (err as Error).message };
    }
    fm.linear_id = created.id;
    rememberPlanRemoteSnapshot(fm, created.updatedAt);
    normalizeAppliedProjectFrontmatter(fm, created);
    try {
      await writeFrontmatterBack(project.path, fm, created.content ?? project.body);
      return { name: fm.name, linearId: created.id, status: "created" };
    } catch (err) {
      return {
        name: fm.name,
        linearId: created.id,
        status: "created-writeback-failed",
        error: `created in Linear but local writeback failed: ${(err as Error).message}`,
      };
    }
  }

  // Update path.
  try {
    const fetched = (await withClient((c) =>
      c.client.rawRequest(PROJECT_READ_QUERY, { id: fm.linear_id }),
    )) as { data: { project: FetchedProject | null } };
    const remote = fetched.data.project;
    if (!remote) {
      return { name: fm.name, status: "error", error: `project not found: ${fm.linear_id}` };
    }

    const input: ProjectUpdateInput = {};
    if (remote.name !== fm.name) input.name = fm.name;
    if ((remote.description ?? "") !== (fm.description ?? "")) {
      input.description = fm.description ?? "";
    }
    if (fm.icon !== undefined && (remote.icon ?? null) !== (fm.icon ?? null)) {
      input.icon = fm.icon;
    }
    if (fm.start_date !== undefined && (remote.startDate ?? null) !== (fm.start_date ?? null)) {
      input.startDate = fm.start_date ?? null;
    }
    if (fm.target_date !== undefined && (remote.targetDate ?? null) !== (fm.target_date ?? null)) {
      input.targetDate = fm.target_date ?? null;
    }
    if (fm.state && remote.state !== fm.state) input.state = fm.state;
    if ((remote.content ?? "") !== project.body) input.content = project.body;

    if (Object.keys(input).length === 0) {
      return { name: fm.name, linearId: fm.linear_id, status: "unchanged" };
    }
    const casBlocker = directApplyCasBlocker("project", fm.name, fm, remote.updatedAt, opts);
    if (casBlocker) {
      return { name: fm.name, linearId: fm.linear_id, status: "error", error: casBlocker };
    }
    if (opts.dryRun) {
      return { name: fm.name, linearId: fm.linear_id, status: "dry-run" };
    }

    const response = (await withClient((c) =>
      c.client.rawRequest(PROJECT_UPDATE_MUTATION, { id: fm.linear_id, input }),
    )) as { data: { projectUpdate: { success: boolean; project: FetchedProject } } };
    const updated = requireMutationEntity<FetchedProject>(
      "projectUpdate",
      response.data.projectUpdate as unknown as { success?: boolean } & Record<string, unknown>,
      "project",
    );
    const { metadata } = buildProjectMetadata(updated);
    rememberPlanRemoteSnapshot(fm, updated.updatedAt);
    normalizeAppliedProjectFrontmatter(fm, updated);
    // Write back server-normalized body to the plan file.
    try {
      await writeFrontmatterBack(project.path, fm, updated.content ?? project.body);
    } catch (err) {
      return {
        name: metadata.name,
        linearId: fm.linear_id,
        status: "updated-writeback-failed",
        error: `updated in Linear but local writeback failed: ${(err as Error).message}`,
      };
    }
    return { name: metadata.name, linearId: fm.linear_id, status: "updated" };
  } catch (err) {
    return {
      name: fm.name,
      linearId: fm.linear_id,
      status: "error",
      error: (err as Error).message,
    };
  }
}

// ---------- issue upsert ----------

const ISSUE_CREATE_MUTATION = /* GraphQL */ `
  mutation CreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id identifier title description priority url updatedAt
        state { id name type }
        assignee { id name email }
        project { id name }
        team { id key }
        labels { nodes { id name } }
      }
    }
  }
`;

const ISSUE_UPDATED_AT_QUERY = /* GraphQL */ `
  query PlanApplyIssueUpdatedAt($id: String!) {
    issue(id: $id) { identifier updatedAt }
  }
`;

async function upsertIssue(
  issue: IssueFile,
  teamMetadata: TeamMetadata,
  projectLinearId: string | undefined,
  opts: ApplyOpts,
  slugToId: Map<string, string>,
  localIssueSlugs: Set<string>,
): Promise<ApplyIssueResult> {
  const fm = issue.frontmatter;

  // Lint the body; --strict blocks.
  const { warnings } = lintContent(issue.body, opts.lintCtx ?? {});
  if (opts.strict && warnings.length > 0) {
    return {
      slug: issue.slug,
      path: issue.path,
      linearId: fm.linear_id,
      status: "lint-blocked",
      error: `${warnings.length} lint warning(s) — fix or run without --strict`,
    };
  }

  // CREATE path.
  if (!fm.linear_id) {
    try {
      const input: Record<string, unknown> = {
        teamId: teamMetadata.team_id,
        title: fm.title,
      };
      if (issue.body !== "") input.description = issue.body;
      if (projectLinearId) input.projectId = projectLinearId;
      if (fm.state) input.stateId = resolveStateId(teamMetadata, fm.state);
      if (fm.priority !== undefined) input.priority = resolvePriority(fm.priority);
      if (fm.estimate !== undefined && fm.estimate !== null) input.estimate = fm.estimate;
      if (fm.labels?.length) input.labelIds = resolveLabelIds(teamMetadata, fm.labels);
      if (fm.assignee) input.assigneeId = await resolveAssigneeId(teamMetadata, fm.assignee);
      if (fm.parent) {
        const parentIsPendingLocal =
          opts.dryRun && localIssueSlugs.has(fm.parent) && !slugToId.has(fm.parent);
        const parentUuid = parentIsPendingLocal
          ? "pending-local-parent"
          : await resolveParentUuid(fm.parent, slugToId);
        if (!parentUuid) {
          return {
            slug: issue.slug,
            path: issue.path,
            status: "error",
            error: `parent not found: ${fm.parent}`,
          };
        }
        if (!opts.dryRun) input.parentId = parentUuid;
      }
      if (opts.dryRun) {
        return { slug: issue.slug, path: issue.path, status: "dry-run" };
      }

      // issueCreate is NOT wrapped with retry — duplicate creation could
      // result if the first attempt succeeded but the response was lost.
      const client = await linear();
      const response = (await client.client.rawRequest(ISSUE_CREATE_MUTATION, { input })) as {
        data: { issueCreate: { success: boolean; issue: FetchedIssue } };
      };
      const created = requireMutationEntity<FetchedIssue>(
        "issueCreate",
        response.data.issueCreate as unknown as { success?: boolean } & Record<string, unknown>,
        "issue",
      );
      fm.linear_id = created.identifier;
      rememberPlanRemoteSnapshot(fm, created.updatedAt);
      normalizeAppliedIssueFrontmatter(fm, created);
      // Write the server-normalized description so re-apply doesn't see spurious
      // drift (Linear may reflow markdown during create; mirrors the UPDATE path).
      try {
        await writeFrontmatterBack(issue.path, fm, created.description ?? issue.body);
      } catch (err) {
        return {
          slug: issue.slug,
          path: issue.path,
          linearId: created.identifier,
          status: "created-writeback-failed",
          error: `created in Linear but local writeback failed: ${(err as Error).message}`,
        };
      }
      return {
        slug: issue.slug,
        path: issue.path,
        linearId: created.identifier,
        status: "created",
      };
    } catch (err) {
      return {
        slug: issue.slug,
        path: issue.path,
        status: "error",
        error: (err as Error).message,
      };
    }
  }

  // UPDATE path.
  try {
    const query = buildPullIssuesQuery([fm.linear_id], false);
    const fetched = (await withClient((c) => c.client.rawRequest(query))) as {
      data: Record<string, FetchedIssue | null>;
    };
    const remote = fetched.data.a0;
    if (!remote) {
      return {
        slug: issue.slug,
        path: issue.path,
        linearId: fm.linear_id,
        status: "error",
        error: `issue not found: ${fm.linear_id}`,
      };
    }

    const input: IssueUpdateInput = {};
    const changed: string[] = [];

    if (remote.title !== fm.title) {
      input.title = fm.title;
      changed.push("title");
    }
    if ((remote.description ?? "") !== issue.body) {
      input.description = issue.body;
      changed.push("description");
    }
    if (fm.state && remote.state.name !== fm.state) {
      input.stateId = resolveStateId(teamMetadata, fm.state);
      changed.push("state");
    }
    if (fm.priority !== undefined) {
      const target = resolvePriority(fm.priority);
      if (remote.priority !== target) {
        input.priority = target;
        changed.push("priority");
      }
    }
    if (fm.estimate !== undefined) {
      const target = fm.estimate === null ? null : fm.estimate;
      if ((remote.estimate ?? null) !== target) {
        input.estimate = target;
        changed.push("estimate");
      }
    }
    if (fm.parent !== undefined) {
      const remoteParentIdentifier = remote.parent?.identifier ?? null;
      const wantParentIdentifier = typeof fm.parent === "string" ? fm.parent : null;
      // Compare by identifier where possible (avoids an extra UUID fetch for unchanged case).
      if (remoteParentIdentifier !== wantParentIdentifier) {
        if (!opts.dryRun) {
          const targetUuid =
            fm.parent === null ? null : await resolveParentUuid(fm.parent, slugToId);
          if (fm.parent !== null && !targetUuid) {
            return {
              slug: issue.slug,
              path: issue.path,
              linearId: fm.linear_id,
              status: "error",
              error: `parent not found: ${fm.parent}`,
            };
          }
          input.parentId = targetUuid;
        }
        changed.push("parent");
      }
    }
    if (fm.labels !== undefined) {
      const targetIds = resolveLabelIds(teamMetadata, fm.labels).sort();
      const remoteIds = remote.labels.nodes.map((l) => l.id).sort();
      if (JSON.stringify(targetIds) !== JSON.stringify(remoteIds)) {
        input.labelIds = targetIds;
        changed.push("labels");
      }
    }
    if (fm.assignee !== undefined) {
      const targetId = fm.assignee ? await resolveAssigneeId(teamMetadata, fm.assignee) : null;
      if ((remote.assignee?.id ?? null) !== targetId) {
        input.assigneeId = targetId;
        changed.push("assignee");
      }
    }

    if (changed.length === 0) {
      return { slug: issue.slug, path: issue.path, linearId: fm.linear_id, status: "unchanged" };
    }
    const casBlocker = directApplyCasBlocker("issue", fm.linear_id, fm, remote.updatedAt, opts);
    if (casBlocker) {
      return {
        slug: issue.slug,
        path: issue.path,
        linearId: fm.linear_id,
        status: "error",
        fields: changed,
        error: casBlocker,
      };
    }
    if (opts.dryRun) {
      return {
        slug: issue.slug,
        path: issue.path,
        linearId: fm.linear_id,
        status: "dry-run",
        fields: changed,
      };
    }

    const response = (await withClient((c) =>
      c.client.rawRequest(ISSUE_UPDATE_MUTATION, { id: remote.id, input }),
    )) as { data: { issueUpdate: { success: boolean; issue: FetchedIssue } } };
    const updated = requireMutationEntity<FetchedIssue>(
      "issueUpdate",
      response.data.issueUpdate as unknown as { success?: boolean } & Record<string, unknown>,
      "issue",
    );
    // Write back server-normalized body so subsequent applies don't see spurious diffs.
    const { metadata } = buildIssueMetadata(updated);
    rememberPlanRemoteSnapshot(fm, updated.updatedAt);
    normalizeAppliedIssueFrontmatter(fm, updated);
    try {
      await writeFrontmatterBack(issue.path, fm, updated.description ?? issue.body);
    } catch (err) {
      return {
        slug: issue.slug,
        path: issue.path,
        linearId: metadata.identifier,
        status: "updated-writeback-failed",
        fields: changed,
        error: `updated in Linear but local writeback failed: ${(err as Error).message}`,
      };
    }
    return {
      slug: issue.slug,
      path: issue.path,
      linearId: metadata.identifier,
      status: "updated",
      fields: changed,
    };
  } catch (err) {
    return {
      slug: issue.slug,
      path: issue.path,
      linearId: fm.linear_id,
      status: "error",
      error: (err as Error).message,
    };
  }
}

/**
 * Resolve a `parent:` frontmatter value to a Linear UUID. Accepts either a local slug
 * (must be in `slugToId` — populated as sibling issues get created in topological order)
 * or a bare `UE-NN` identifier (needs a one-off `client.issue()` lookup).
 */
async function resolveParentUuid(
  parent: string,
  slugToId: Map<string, string>,
): Promise<string | null> {
  // Slug in plan → take its just-created identifier → convert to UUID via another fetch.
  // (linear_ids stored in slugToId are TEAM-NN identifiers, not UUIDs. Linear accepts
  // both for issue(id:) lookups, but `parentId` specifically wants the UUID.)
  const asSlug = slugToId.get(parent);
  const identOrId = asSlug ?? parent;
  try {
    const issue = await withClient((c) => c.issue(identOrId));
    return issue?.id ?? null;
  } catch {
    return null;
  }
}

export async function preflightPlanApply(plan: ParsedPlan): Promise<PlanApplyPreflightResult> {
  const blockers: string[] = [];
  const issuesBySlug = new Map(plan.issues.map((issue) => [issue.slug, issue]));
  const externalTargets = new Map<string, string[]>();

  const addExternal = (target: string, reason: string) => {
    const key = target.trim();
    if (!key || issuesBySlug.has(key)) return;
    const existing = externalTargets.get(key) ?? [];
    existing.push(reason);
    externalTargets.set(key, existing);
  };

  for (const issue of plan.issues) {
    const parent = issue.frontmatter.parent;
    if (typeof parent === "string") {
      addExternal(parent, `${issue.path}: parent not found: ${parent}`);
    }
    for (const key of LINK_KEYS) {
      const targets = issue.frontmatter[key] as string[] | undefined;
      if (!targets) continue;
      for (const target of targets) {
        addExternal(target, `${issue.path}: ${key} target not found: ${target}`);
      }
    }
  }

  await mapLimit(Array.from(externalTargets.entries()), 8, async ([target, reasons]) => {
    try {
      const issue = await withClient((c) => c.issue(target));
      if (!issue) blockers.push(...reasons);
    } catch {
      blockers.push(...reasons);
    }
  });

  return { ready: blockers.length === 0, blockers };
}

// ---------- file writeback ----------

function rememberPlanRemoteSnapshot(frontmatter: Record<string, unknown>, updatedAt: string): void {
  const current =
    frontmatter._server &&
    typeof frontmatter._server === "object" &&
    !Array.isArray(frontmatter._server)
      ? (frontmatter._server as Record<string, unknown>)
      : {};
  frontmatter._server = { ...current, updated_at: updatedAt };
}

function normalizeAppliedProjectFrontmatter(
  fm: ProjectFile["frontmatter"],
  project: Pick<FetchedProject, "startDate" | "targetDate">,
): void {
  if (fm.start_date !== undefined || project.startDate !== undefined) {
    fm.start_date = project.startDate ?? null;
  }
  if (fm.target_date !== undefined || project.targetDate !== undefined) {
    fm.target_date = project.targetDate ?? null;
  }
}

function normalizeAppliedIssueFrontmatter(
  frontmatter: Record<string, unknown>,
  issue: FetchedIssue,
): void {
  if (Object.hasOwn(frontmatter, "assignee")) {
    frontmatter.assignee = issue.assignee?.email ?? null;
  }
}

function directApplyCasBlocker(
  kind: "issue" | "project",
  target: string,
  frontmatter: Record<string, unknown>,
  remoteUpdatedAt: string,
  opts: ApplyOpts,
): string | null {
  if (opts.force === true) return null;
  const server =
    frontmatter._server &&
    typeof frontmatter._server === "object" &&
    !Array.isArray(frontmatter._server)
      ? (frontmatter._server as Record<string, unknown>)
      : null;
  const localUpdatedAt = server?.updated_at;
  if (typeof localUpdatedAt !== "string" || localUpdatedAt.trim() === "") {
    return `${kind}/${target} missing plan _server.updated_at; run plan pull or publish review/apply before direct apply, or pass force:true with confirm:true / --force --yes after verifying remote state`;
  }
  const localTime = Date.parse(localUpdatedAt);
  const remoteTime = Date.parse(remoteUpdatedAt);
  if (!Number.isFinite(localTime) || !Number.isFinite(remoteTime)) {
    return `${kind}/${target} has invalid updatedAt stale-guard timestamp: local=${JSON.stringify(
      localUpdatedAt,
    )}, remote=${JSON.stringify(remoteUpdatedAt)}`;
  }
  if (remoteUpdatedAt !== localUpdatedAt) {
    return `${kind}/${target} changed on Linear after plan snapshot; run plan pull/review before direct apply, or pass force:true with confirm:true / --force --yes after verifying remote state`;
  }
  return null;
}

async function writeFrontmatterBack(
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<void> {
  // Filter out undefined keys for clean YAML.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v !== undefined) clean[k] = v;
  }
  const yaml = stringifyYaml(clean, { lineWidth: 0 });
  const bodySep = body.startsWith("\n") ? "" : "\n";
  const serialized = `---\n${yaml}---\n${bodySep}${body}`;
  await writeAtomic(path, serialized);
}

// ---------- slug → LinearID rewriting ----------

class LinkSlugRewriteError extends Error {
  readonly issue: IssueFile;

  constructor(issue: IssueFile, cause: unknown) {
    super(`local link slug rewrite failed for ${issue.path}: ${(cause as Error).message}`);
    this.name = "LinkSlugRewriteError";
    this.issue = issue;
  }
}

function markSlugRewriteFailure(result: ApplyIssueResult, error: string): ApplyIssueResult {
  if (result.status === "created") {
    return { ...result, status: "created-writeback-failed", error };
  }
  if (result.status === "updated") {
    return { ...result, status: "updated-writeback-failed", error };
  }
  if (
    result.status === "created-writeback-failed" ||
    result.status === "updated-writeback-failed"
  ) {
    return { ...result, error: `${result.error}; ${error}` };
  }
  return { ...result, status: "error", error };
}

async function rewriteLinkSlugs(plan: ParsedPlan): Promise<void> {
  const slugToId = new Map<string, string>();
  for (const issue of plan.issues) {
    if (issue.frontmatter.linear_id) {
      slugToId.set(issue.slug, issue.frontmatter.linear_id);
    }
  }
  for (const issue of plan.issues) {
    let mutated = false;
    for (const key of LINK_KEYS) {
      const targets = issue.frontmatter[key] as string[] | undefined;
      if (!targets) continue;
      const next = targets.map((t) => slugToId.get(t) ?? t);
      if (JSON.stringify(next) !== JSON.stringify(targets)) {
        issue.frontmatter[key] = next;
        mutated = true;
      }
    }
    // Also rewrite `parent:` slug → linear_id if needed.
    if (typeof issue.frontmatter.parent === "string") {
      const resolved = slugToId.get(issue.frontmatter.parent);
      if (resolved && resolved !== issue.frontmatter.parent) {
        issue.frontmatter.parent = resolved;
        mutated = true;
      }
    }
    if (mutated) {
      try {
        // Re-read the current body from disk — upsertIssue may have written a
        // server-normalized version that differs from the in-memory `issue.body` we
        // parsed at the start. Using the stale one would overwrite Linear's normalized
        // form and cause spurious drift on the next apply.
        const raw = await readFile(issue.path, "utf8");
        const { body } = splitFrontmatter(raw);
        const currentBody = body.replace(/^\r?\n/, "");
        await writeFrontmatterBack(issue.path, issue.frontmatter, currentBody);
      } catch (err) {
        throw new LinkSlugRewriteError(issue, err);
      }
    }
  }
}

// ---------- relation application ----------

/**
 * Map a plan-side `LinkKey` to the side/type pair we look up in a
 * `listRelations` response. `createLink` is server-side idempotent at the
 * `(issueId, relatedIssueId, type)` tuple — re-running with the same args
 * returns the existing relation rather than creating a duplicate. To report
 * `unchanged` (vs claiming `created`) on re-apply, we precompute the source
 * issue's existing edge-set and check membership before calling the mutation.
 *
 * Direction handling mirrors `LINK_KIND_TO_API` in `relations.ts`:
 *   - forward kinds (`blocks`, `duplicates`)        → outbound on source
 *   - inverse kinds (`blocked_by`, `duplicated_by`) → inbound  on source
 *   - `related` is symmetric → either side counts
 */
type ListRelationsResult = Awaited<ReturnType<typeof listRelations>>;
type RelationNode = ListRelationsResult["outbound"][number];

function relationExists(
  remote: ListRelationsResult,
  key: LinkKey,
  targetIdentifier: string,
): boolean {
  const match = (r: RelationNode, type: RelationNode["type"]): boolean =>
    r.type === type && r.otherIdentifier === targetIdentifier;
  switch (key) {
    case "blocks":
      return remote.outbound.some((r) => match(r, "blocks"));
    case "blocked_by":
      return remote.inbound.some((r) => match(r, "blocks"));
    case "duplicates":
      return remote.outbound.some((r) => match(r, "duplicate"));
    case "duplicated_by":
      return remote.inbound.some((r) => match(r, "duplicate"));
    case "related":
      // Symmetric — `issueRelationCreate` stores it on one side, Linear
      // surfaces it on both. Check both buckets.
      return (
        remote.outbound.some((r) => match(r, "related")) ||
        remote.inbound.some((r) => match(r, "related"))
      );
  }
}

function hasPlanRemoteSnapshot(issue: IssueFile): boolean {
  const server = issue.frontmatter._server;
  return (
    server !== undefined &&
    typeof server === "object" &&
    !Array.isArray(server) &&
    typeof server.updated_at === "string" &&
    server.updated_at.trim() !== ""
  );
}

function relationEndpointError(
  sourceError: string | undefined,
  targetError: string | undefined,
): string | undefined {
  if (sourceError && targetError) return `${sourceError}; ${targetError}`;
  return sourceError ?? targetError;
}

async function applyRelations(plan: ParsedPlan, opts: ApplyOpts): Promise<ApplyRelationResult[]> {
  const results: ApplyRelationResult[] = [];
  const slugToId = new Map<string, string>();
  const issueById = new Map<string, IssueFile>();
  for (const issue of plan.issues) {
    if (issue.frontmatter.linear_id) {
      slugToId.set(issue.slug, issue.frontmatter.linear_id);
      issueById.set(issue.frontmatter.linear_id, issue);
    }
  }

  // CAS-check and pre-fetch existing relations per source issue that has any
  // declared link. This lets us distinguish a real `created` from a server-
  // deduped no-op and prevents relation-only direct apply from bypassing the
  // same stale-plan protection used by scalar/body updates.
  const remoteEdgesByFromId = new Map<string, ListRelationsResult>();
  const sourceErrors = new Map<string, string>();
  const sourcesWithLinks = plan.issues.filter((i) => {
    if (!i.frontmatter.linear_id) return false;
    return LINK_KEYS.some((k) => {
      const v = i.frontmatter[k] as string[] | undefined;
      return Array.isArray(v) && v.length > 0;
    });
  });
  await mapLimit(sourcesWithLinks, 8, async (issue) => {
    const fromId = issue.frontmatter.linear_id;
    if (!fromId) return;
    try {
      const fetched = (await withClient((c) =>
        c.client.rawRequest(ISSUE_UPDATED_AT_QUERY, { id: fromId }),
      )) as { data: { issue: { identifier: string; updatedAt: string } | null } };
      const remote = fetched.data.issue;
      if (!remote) {
        sourceErrors.set(fromId, `source issue not found: ${fromId}`);
        return;
      }
      const casBlocker = directApplyCasBlocker(
        "issue",
        fromId,
        issue.frontmatter,
        remote.updatedAt,
        opts,
      );
      if (casBlocker) {
        sourceErrors.set(fromId, casBlocker);
        return;
      }
      const remoteEdges = await listRelations(fromId);
      if (remoteEdges.issueMissing) {
        sourceErrors.set(fromId, `source issue not found: ${fromId}`);
        return;
      }
      remoteEdgesByFromId.set(fromId, remoteEdges);
    } catch (err) {
      sourceErrors.set(fromId, `relation preflight failed: ${(err as Error).message}`);
    }
  });

  const targetErrors = new Map<string, string>();
  const localTargetsWithSnapshots = new Map<string, IssueFile>();
  for (const issue of sourcesWithLinks) {
    for (const key of LINK_KEYS) {
      const targets = issue.frontmatter[key] as string[] | undefined;
      if (!targets) continue;
      for (const raw of targets) {
        const resolvedTarget = slugToId.get(raw) ?? raw;
        const targetIssue = issueById.get(resolvedTarget);
        if (targetIssue && hasPlanRemoteSnapshot(targetIssue)) {
          localTargetsWithSnapshots.set(resolvedTarget, targetIssue);
        }
      }
    }
  }
  await mapLimit(Array.from(localTargetsWithSnapshots.entries()), 8, async ([targetId, issue]) => {
    try {
      const fetched = (await withClient((c) =>
        c.client.rawRequest(ISSUE_UPDATED_AT_QUERY, { id: targetId }),
      )) as { data: { issue: { identifier: string; updatedAt: string } | null } };
      const remote = fetched.data.issue;
      if (!remote) {
        targetErrors.set(targetId, `target issue not found: ${targetId}`);
        return;
      }
      const casBlocker = directApplyCasBlocker(
        "issue",
        targetId,
        issue.frontmatter,
        remote.updatedAt,
        opts,
      );
      if (casBlocker) targetErrors.set(targetId, casBlocker);
    } catch (err) {
      targetErrors.set(targetId, `target freshness check failed: ${(err as Error).message}`);
    }
  });

  if (opts.dryRun) {
    for (const issue of plan.issues) {
      const fromLabel = issue.frontmatter.linear_id ?? issue.slug;
      const sourceError = issue.frontmatter.linear_id
        ? sourceErrors.get(issue.frontmatter.linear_id)
        : undefined;
      for (const key of LINK_KEYS) {
        const targets = issue.frontmatter[key] as string[] | undefined;
        if (!targets) continue;
        const kind = LINK_KEY_TO_SET_LINKS_KIND[key];
        const remoteEdges = issue.frontmatter.linear_id
          ? remoteEdgesByFromId.get(issue.frontmatter.linear_id)
          : undefined;
        for (const raw of targets) {
          const resolvedTarget = slugToId.get(raw) ?? raw;
          const endpointError = relationEndpointError(
            sourceError,
            targetErrors.get(resolvedTarget),
          );
          const relationPreflight =
            remoteEdges && issue.frontmatter.linear_id
              ? analyzeRelationCreatePreflight(
                  remoteEdges,
                  issue.frontmatter.linear_id,
                  resolvedTarget,
                  kind,
                )
              : null;
          if (relationPreflight?.exact) {
            results.push({
              fromIdentifier: fromLabel,
              toIdentifier: resolvedTarget,
              kind: key,
              status: "unchanged",
              ...(endpointError ? { error: endpointError } : {}),
            });
            continue;
          }
          if (relationPreflight?.wouldReplace || relationPreflight?.duplicateSideEffect) {
            const reasons: string[] = [];
            if (relationPreflight.wouldReplace) {
              reasons.push(
                `relation would replace existing pair relation(s): ${relationPreflight.conflicts
                  .map((r) => `${r.direction} ${r.type} ${r.otherIdentifier}`)
                  .join(", ")}`,
              );
            }
            if (relationPreflight.duplicateSideEffect) {
              reasons.push(
                "duplicate relations can move involved issues to Linear's Duplicate state",
              );
            }
            results.push({
              fromIdentifier: fromLabel,
              toIdentifier: resolvedTarget,
              kind: key,
              status: "error",
              error: reasons.join("; "),
            });
            continue;
          }
          results.push({
            fromIdentifier: fromLabel,
            toIdentifier: resolvedTarget,
            kind: key,
            status: endpointError ? "error" : "dry-run",
            ...(endpointError ? { error: endpointError } : {}),
          });
        }
      }
    }
    return results;
  }

  // Resolve identifier → UUID for every known target.
  const allIdentifiers = new Set<string>();
  for (const issue of plan.issues) {
    if (issue.frontmatter.linear_id) allIdentifiers.add(issue.frontmatter.linear_id);
    for (const key of LINK_KEYS) {
      const targets = issue.frontmatter[key] as string[] | undefined;
      if (!targets) continue;
      for (const t of targets) {
        const resolved = slugToId.get(t) ?? t;
        allIdentifiers.add(resolved);
      }
    }
  }
  const uuidByIdentifier = new Map<string, string>();
  const identifierResolutionErrors = new Map<string, string>();
  await mapLimit(Array.from(allIdentifiers), 8, async (id) => {
    try {
      const iss = await withClient((c) => c.issue(id));
      if (iss) {
        uuidByIdentifier.set(id, iss.id);
      } else {
        identifierResolutionErrors.set(id, `issue not resolved: ${id}`);
      }
    } catch (err) {
      identifierResolutionErrors.set(
        id,
        `issue resolution failed for ${id}: ${(err as Error).message}`,
      );
    }
  });

  for (const issue of plan.issues) {
    const fromId = issue.frontmatter.linear_id;
    if (!fromId) continue;
    const fromUuid = uuidByIdentifier.get(fromId);
    const sourceError = sourceErrors.get(fromId);
    const sourceResolutionError =
      sourceError ??
      (fromUuid
        ? undefined
        : `source ${identifierResolutionErrors.get(fromId) ?? `issue not resolved: ${fromId}`}`);
    if (sourceResolutionError) {
      for (const key of LINK_KEYS) {
        const targets = issue.frontmatter[key] as string[] | undefined;
        if (!targets) continue;
        for (const raw of targets) {
          results.push({
            fromIdentifier: fromId,
            toIdentifier: slugToId.get(raw) ?? raw,
            kind: key,
            status: "error",
            error: sourceResolutionError,
          });
        }
      }
      continue;
    }
    if (!fromUuid) continue;
    const remoteEdges = remoteEdgesByFromId.get(fromId);
    for (const key of LINK_KEYS) {
      const targets = issue.frontmatter[key] as string[] | undefined;
      if (!targets) continue;
      const kind = LINK_KEY_TO_SET_LINKS_KIND[key];
      for (const raw of targets) {
        const resolvedTarget = slugToId.get(raw) ?? raw;
        const targetUuid = uuidByIdentifier.get(resolvedTarget);
        if (!targetUuid) {
          results.push({
            fromIdentifier: fromId,
            toIdentifier: resolvedTarget,
            kind: key,
            status: "error",
            error:
              identifierResolutionErrors.get(resolvedTarget) ??
              `target not found: ${resolvedTarget}`,
          });
          continue;
        }
        const relationPreflight = remoteEdges
          ? analyzeRelationCreatePreflight(remoteEdges, fromId, resolvedTarget, kind)
          : null;
        const relationAlreadyExists = relationPreflight
          ? relationPreflight.exact !== undefined
          : remoteEdges
            ? relationExists(remoteEdges, key, resolvedTarget)
            : false;
        if (relationAlreadyExists) {
          // Server-side idempotent: a second `createLink` call would return
          // the same UUID without creating anything. Report the no-op.
          results.push({
            fromIdentifier: fromId,
            toIdentifier: resolvedTarget,
            kind: key,
            status: "unchanged",
          });
          continue;
        }
        if (relationPreflight?.wouldReplace) {
          results.push({
            fromIdentifier: fromId,
            toIdentifier: resolvedTarget,
            kind: key,
            status: "error",
            error: `relation would replace existing pair relation(s): ${relationPreflight.conflicts
              .map((r) => `${r.direction} ${r.type} ${r.otherIdentifier}`)
              .join(", ")}`,
          });
          continue;
        }
        if (relationPreflight?.duplicateSideEffect) {
          results.push({
            fromIdentifier: fromId,
            toIdentifier: resolvedTarget,
            kind: key,
            status: "error",
            error: "duplicate relations can move involved issues to Linear's Duplicate state",
          });
          continue;
        }
        const targetError = targetErrors.get(resolvedTarget);
        if (targetError) {
          results.push({
            fromIdentifier: fromId,
            toIdentifier: resolvedTarget,
            kind: key,
            status: "error",
            error: targetError,
          });
          continue;
        }
        try {
          await createLink(fromUuid, targetUuid, kind);
          results.push({
            fromIdentifier: fromId,
            toIdentifier: resolvedTarget,
            kind: key,
            status: "created",
          });
        } catch (err) {
          results.push({
            fromIdentifier: fromId,
            toIdentifier: resolvedTarget,
            kind: key,
            status: "error",
            error: (err as Error).message,
          });
        }
      }
    }
  }
  return results;
}

// ---------- public entrypoint ----------

export async function applyPlan(
  plan: ParsedPlan,
  teamMetadata: TeamMetadata,
  opts: ApplyOpts,
): Promise<ApplyResult> {
  const projectLinearIdAtStart = plan.project.frontmatter.linear_id;
  const projectResult = await upsertProject(plan.project, teamMetadata, opts);
  const effectiveProjectId =
    projectLinearIdAtStart ?? plan.project.frontmatter.linear_id ?? projectResult.linearId;

  // Topological order: parents created before children so parentId resolution works.
  const ordered = topologicalSort(plan.issues);
  if (projectApplyFailed(projectResult)) {
    const reason = projectResult.error ?? "project apply failed";
    return {
      project: projectResult,
      issues: ordered.map((issue) => ({
        slug: issue.slug,
        path: issue.path,
        linearId: issue.frontmatter.linear_id,
        status: "error",
        error: `skipped because project apply failed: ${reason}`,
      })),
      relations: [],
    };
  }
  // Slug → linear_id map, populated as we go so children can set parentId.
  const slugToId = new Map<string, string>();
  const localIssueSlugs = new Set(plan.issues.map((issue) => issue.slug));
  for (const i of plan.issues) {
    if (i.frontmatter.linear_id) slugToId.set(i.slug, i.frontmatter.linear_id);
  }

  const issues: ApplyIssueResult[] = [];
  for (const [index, issue] of ordered.entries()) {
    const result = await upsertIssue(
      issue,
      teamMetadata,
      effectiveProjectId,
      opts,
      slugToId,
      localIssueSlugs,
    );
    issues.push(result);
    if (!opts.dryRun && issueWritebackFailed(result)) {
      const reason = result.error ?? "local issue writeback failed";
      return {
        project: projectResult,
        issues: [
          ...issues,
          ...ordered.slice(index + 1).map((remaining) => ({
            slug: remaining.slug,
            path: remaining.path,
            linearId: remaining.frontmatter.linear_id,
            status: "error" as const,
            error: `skipped because issue writeback failed: ${reason}`,
          })),
        ],
        relations: [],
      };
    }
    if (result.linearId) slugToId.set(issue.slug, result.linearId);
  }

  // Rewrite slug → LinearID references in every issue file.
  if (!opts.dryRun) {
    try {
      await rewriteLinkSlugs(plan);
    } catch (err) {
      const error = (err as Error).message;
      const failedSlug = err instanceof LinkSlugRewriteError ? err.issue.slug : null;
      return {
        project: projectResult,
        issues: issues.map((issue) =>
          failedSlug === null || issue.slug === failedSlug
            ? markSlugRewriteFailure(issue, error)
            : issue,
        ),
        relations: [],
      };
    }
  }

  // Apply relations once every issue has an identifier (or would have, in dry-run).
  const relations = await applyRelations(plan, opts);

  return { project: projectResult, issues, relations };
}

/**
 * Return issues sorted so each parent precedes its children. Issues with no parent (or
 * whose parent is external / outside the plan) come first in original order. Items with
 * unresolvable parent refs fall through to end (apply will error, matching validator).
 */
function topologicalSort(issues: IssueFile[]): IssueFile[] {
  const bySlug = new Map<string, IssueFile>();
  for (const i of issues) bySlug.set(i.slug, i);

  const visited = new Set<string>();
  const result: IssueFile[] = [];

  const visit = (issue: IssueFile, stack: Set<string>): void => {
    if (visited.has(issue.slug)) return;
    if (stack.has(issue.slug)) return; // cycle — validator already caught; skip silently
    stack.add(issue.slug);
    const p = typeof issue.frontmatter.parent === "string" ? issue.frontmatter.parent : undefined;
    if (p && bySlug.has(p)) {
      const parentIssue = bySlug.get(p);
      if (parentIssue) visit(parentIssue, stack);
    }
    stack.delete(issue.slug);
    visited.add(issue.slug);
    result.push(issue);
  };

  for (const i of issues) visit(i, new Set());
  return result;
}
