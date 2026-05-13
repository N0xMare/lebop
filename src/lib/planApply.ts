import { readFile } from "node:fs/promises";
import { stringify as stringifyYaml } from "yaml";
import { buildIssueMetadata, buildProjectMetadata } from "./build.ts";
import type { TeamMetadata } from "./cache.ts";
import { lintContent } from "./lint.ts";
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
import { createLink, listRelations } from "./relations.ts";
import { resolveAssigneeId, resolveLabelIds, resolvePriority, resolveStateId } from "./resolve.ts";
import { linear, withClient } from "./sdk.ts";

// ---------- result types ----------

export interface ApplyIssueResult {
  slug: string;
  path: string;
  linearId?: string;
  status: "created" | "updated" | "unchanged" | "lint-blocked" | "error" | "dry-run";
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
    status: "created" | "updated" | "unchanged" | "error" | "dry-run";
    error?: string;
  };
  issues: ApplyIssueResult[];
  relations: ApplyRelationResult[];
}

export interface ApplyOpts {
  dryRun?: boolean;
  strict?: boolean;
  lintCtx?: LintContext;
}

// ---------- project upsert ----------

const PROJECT_READ_QUERY = /* GraphQL */ `
  query ReadProject($id: String!) {
    project(id: $id) {
      id
      name
      description
      content
      state
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
        state
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
    if (project.body.trim() !== "") input.content = project.body;
    try {
      // projectCreate is NOT wrapped with retry — duplicate creation could
      // result if the first attempt succeeded but the response was lost.
      const client = await linear();
      const response = (await client.client.rawRequest(PROJECT_CREATE_MUTATION, { input })) as {
        data: { projectCreate: { project: FetchedProject } };
      };
      const created = response.data.projectCreate.project;
      fm.linear_id = created.id;
      await writeFrontmatterBack(project.path, fm, created.content ?? project.body);
      return { name: fm.name, linearId: created.id, status: "created" };
    } catch (err) {
      return { name: fm.name, status: "error", error: (err as Error).message };
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
    if (fm.state && remote.state !== fm.state) input.state = fm.state;
    if ((remote.content ?? "") !== project.body) input.content = project.body;

    if (Object.keys(input).length === 0) {
      return { name: fm.name, linearId: fm.linear_id, status: "unchanged" };
    }
    if (opts.dryRun) {
      return { name: fm.name, linearId: fm.linear_id, status: "dry-run" };
    }

    const response = (await withClient((c) =>
      c.client.rawRequest(PROJECT_UPDATE_MUTATION, { id: fm.linear_id, input }),
    )) as { data: { projectUpdate: { project: FetchedProject } } };
    const updated = response.data.projectUpdate.project;
    const { metadata } = buildProjectMetadata(updated);
    // Write back server-normalized body to the plan file.
    await writeFrontmatterBack(project.path, fm, updated.content ?? project.body);
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

async function upsertIssue(
  issue: IssueFile,
  teamMetadata: TeamMetadata,
  projectLinearId: string | undefined,
  opts: ApplyOpts,
  slugToId: Map<string, string>,
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
        const parentUuid = await resolveParentUuid(fm.parent, slugToId);
        if (parentUuid) input.parentId = parentUuid;
      }

      if (opts.dryRun) {
        return { slug: issue.slug, path: issue.path, status: "dry-run" };
      }

      // issueCreate is NOT wrapped with retry — duplicate creation could
      // result if the first attempt succeeded but the response was lost.
      const client = await linear();
      const response = (await client.client.rawRequest(ISSUE_CREATE_MUTATION, { input })) as {
        data: { issueCreate: { issue: FetchedIssue } };
      };
      const created = response.data.issueCreate.issue;
      fm.linear_id = created.identifier;
      // Write the server-normalized description so re-apply doesn't see spurious
      // drift (Linear may reflow markdown during create; mirrors the UPDATE path).
      await writeFrontmatterBack(issue.path, fm, created.description ?? issue.body);
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
      const targetUuid = fm.parent === null ? null : await resolveParentUuid(fm.parent, slugToId);
      const remoteParentIdentifier = remote.parent?.identifier ?? null;
      const wantParentIdentifier = typeof fm.parent === "string" ? fm.parent : null;
      // Compare by identifier where possible (avoids an extra UUID fetch for unchanged case).
      if (remoteParentIdentifier !== wantParentIdentifier) {
        input.parentId = targetUuid;
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
    )) as { data: { issueUpdate: { issue: FetchedIssue } } };
    const updated = response.data.issueUpdate.issue;
    // Write back server-normalized body so subsequent applies don't see spurious diffs.
    const { metadata } = buildIssueMetadata(updated);
    await writeFrontmatterBack(issue.path, fm, updated.description ?? issue.body);
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

// ---------- file writeback ----------

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
  await Bun.write(path, serialized);
}

// ---------- slug → LinearID rewriting ----------

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
      // Re-read the current body from disk — upsertIssue may have written a
      // server-normalized version that differs from the in-memory `issue.body` we
      // parsed at the start. Using the stale one would overwrite Linear's normalized
      // form and cause spurious drift on the next apply.
      const raw = await readFile(issue.path, "utf8");
      const { body } = splitFrontmatter(raw);
      const currentBody = body.replace(/^\r?\n/, "");
      await writeFrontmatterBack(issue.path, issue.frontmatter, currentBody);
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

async function applyRelations(plan: ParsedPlan, opts: ApplyOpts): Promise<ApplyRelationResult[]> {
  const results: ApplyRelationResult[] = [];
  const slugToId = new Map<string, string>();
  for (const issue of plan.issues) {
    if (issue.frontmatter.linear_id) slugToId.set(issue.slug, issue.frontmatter.linear_id);
  }

  // Dry-run: show the planned graph using slugs/identifiers as-is; no lookups, no mutations.
  if (opts.dryRun) {
    for (const issue of plan.issues) {
      const fromLabel = issue.frontmatter.linear_id ?? issue.slug;
      for (const key of LINK_KEYS) {
        const targets = issue.frontmatter[key] as string[] | undefined;
        if (!targets) continue;
        for (const raw of targets) {
          const resolved = slugToId.get(raw) ?? raw;
          results.push({
            fromIdentifier: fromLabel,
            toIdentifier: resolved,
            kind: key,
            status: "dry-run",
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
  await Promise.all(
    Array.from(allIdentifiers).map(async (id) => {
      try {
        const iss = await withClient((c) => c.issue(id));
        if (iss) uuidByIdentifier.set(id, iss.id);
      } catch {
        /* mark as unresolvable; relation call will error with clean message */
      }
    }),
  );

  // Pre-fetch existing relations per source issue that has any declared link.
  // This lets us distinguish a real `created` from a server-deduped no-op so
  // re-apply reports `unchanged` (mirroring how `upsertIssue` reads remote
  // state before deciding update/unchanged). One `listRelations` call per
  // source issue — same shape as the per-issue read in `upsertIssue`.
  const remoteEdgesByFromId = new Map<string, ListRelationsResult>();
  const sourcesWithLinks = plan.issues.filter((i) => {
    if (!i.frontmatter.linear_id) return false;
    return LINK_KEYS.some((k) => {
      const v = i.frontmatter[k] as string[] | undefined;
      return Array.isArray(v) && v.length > 0;
    });
  });
  await Promise.all(
    sourcesWithLinks.map(async (issue) => {
      const fromId = issue.frontmatter.linear_id;
      if (!fromId) return;
      try {
        remoteEdgesByFromId.set(fromId, await listRelations(fromId));
      } catch {
        /* fall through — uncached source treated as "no known edges" so we
           preserve prior behaviour (report `created`) rather than mask errors */
      }
    }),
  );

  for (const issue of plan.issues) {
    const fromId = issue.frontmatter.linear_id;
    if (!fromId) continue;
    const fromUuid = uuidByIdentifier.get(fromId);
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
            error: `target not found: ${resolvedTarget}`,
          });
          continue;
        }
        if (opts.dryRun) {
          results.push({
            fromIdentifier: fromId,
            toIdentifier: resolvedTarget,
            kind: key,
            status: "dry-run",
          });
          continue;
        }
        if (remoteEdges && relationExists(remoteEdges, key, resolvedTarget)) {
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
  // Slug → linear_id map, populated as we go so children can set parentId.
  const slugToId = new Map<string, string>();
  for (const i of plan.issues) {
    if (i.frontmatter.linear_id) slugToId.set(i.slug, i.frontmatter.linear_id);
  }

  const issues: ApplyIssueResult[] = [];
  for (const issue of ordered) {
    const result = await upsertIssue(issue, teamMetadata, effectiveProjectId, opts, slugToId);
    issues.push(result);
    if (result.linearId) slugToId.set(issue.slug, result.linearId);
  }

  // Rewrite slug → LinearID references in every issue file.
  if (!opts.dryRun) await rewriteLinkSlugs(plan);

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
