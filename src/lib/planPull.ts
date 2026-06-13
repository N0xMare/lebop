import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { type TeamMetadata, writeAtomic } from "./cache.ts";
import { paginateRaw } from "./paginate.ts";
import type { IssueFile, LinkKey, ParsedPlan, ProjectFile } from "./planTypes.ts";
import { LINK_KEYS } from "./planTypes.ts";
import {
  buildPullIssuesQuery,
  type FetchedIssue,
  type FetchedProject,
  PULL_PROJECT_HEADER_QUERY,
} from "./pullQuery.ts";
import { type ListedRelationsPage, listRelations } from "./relations.ts";
import { labelNameById, priorityName } from "./resolve.ts";
import { linear, withClient } from "./sdk.ts";

type RemoteProjectIssue = { identifier: string; title: string };

export interface PullIssueResult {
  slug: string;
  path: string;
  linear_id?: string;
  status: "updated" | "unchanged" | "missing-remote" | "skipped-no-id" | "error";
  error?: string;
}

export interface PullResult {
  project: {
    name: string;
    linear_id?: string;
    status: "updated" | "unchanged" | "missing-remote" | "skipped-no-id" | "error";
    error?: string;
  };
  issues: PullIssueResult[];
  new_imports: { identifier: string; path: string; title: string }[]; // if --include-new
  new_import_errors: { identifier: string; title: string; error: string }[];
  skipped_new: { identifier: string; title: string }[]; // if NOT --include-new
  remote_scan_error?: string;
}

export interface PullOpts {
  includeNew?: boolean;
}

/**
 * Issues-in-project listing for the new-on-remote import path.
 * Always paginated so projects with >250 issues work.
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

export async function pullPlan(
  plan: ParsedPlan,
  teamMetadata: TeamMetadata,
  opts: PullOpts,
): Promise<PullResult> {
  let preScannedRemoteIssues: RemoteProjectIssue[] | undefined;
  if (opts.includeNew && plan.project.frontmatter.linear_id) {
    try {
      preScannedRemoteIssues = await scanRemoteProjectIssues(plan.project.frontmatter.linear_id);
    } catch (err) {
      const message = (err as Error).message;
      return {
        project: {
          name: plan.project.frontmatter.name,
          linear_id: plan.project.frontmatter.linear_id,
          status: "error",
          error: `remote-only issue scan failed before pull: ${message}`,
        },
        issues: [],
        new_imports: [],
        new_import_errors: [],
        skipped_new: [],
        remote_scan_error: message,
      };
    }
  }

  const projectResult = await pullProject(plan.project);
  const issues: PullIssueResult[] = [];
  for (const issue of plan.issues) {
    issues.push(await pullIssue(issue, teamMetadata));
  }

  // New-on-remote issues: in the project but not in the plan.
  const newImports: { identifier: string; path: string; title: string }[] = [];
  const newImportErrors: { identifier: string; title: string; error: string }[] = [];
  const skippedNew: { identifier: string; title: string }[] = [];
  let remoteScanError: string | undefined;

  if (
    projectResult.linear_id &&
    projectResult.status !== "missing-remote" &&
    projectResult.status !== "error"
  ) {
    try {
      const remoteIssues =
        preScannedRemoteIssues ?? (await scanRemoteProjectIssues(projectResult.linear_id));
      const plannedIds = new Set(plan.issues.map((i) => i.frontmatter.linear_id).filter(Boolean));
      const existingSlugs = new Set(plan.issues.map((i) => i.slug));
      for (const node of remoteIssues) {
        if (plannedIds.has(node.identifier)) continue;
        if (opts.includeNew) {
          const result = await importNewIssue(plan, node.identifier, existingSlugs, teamMetadata);
          if (result.status === "imported") {
            newImports.push(result);
            existingSlugs.add(slugFromPath(result.path));
          } else {
            newImportErrors.push({
              identifier: node.identifier,
              title: node.title,
              error: result.error,
            });
          }
        } else {
          skippedNew.push({ identifier: node.identifier, title: node.title });
        }
      }
    } catch (err) {
      remoteScanError = (err as Error).message;
    }
  }

  return {
    project: projectResult,
    issues,
    new_imports: newImports,
    new_import_errors: newImportErrors,
    skipped_new: skippedNew,
    ...(remoteScanError ? { remote_scan_error: remoteScanError } : {}),
  };
}

async function scanRemoteProjectIssues(projectId: string): Promise<RemoteProjectIssue[]> {
  const client = await linear();
  return await paginateRaw<RemoteProjectIssue, ProjectIssuesResponse>(
    ({ first, after }) =>
      client.client.rawRequest(PROJECT_ISSUES_QUERY, {
        id: projectId,
        first,
        after,
      }) as Promise<ProjectIssuesResponse>,
    (response) => response.data.project?.issues ?? null,
    { pageSize: 250 },
  );
}

// ---------- project pull ----------

async function pullProject(project: ProjectFile): Promise<PullResult["project"]> {
  const fm = project.frontmatter;
  if (!fm.linear_id) {
    return { name: fm.name, status: "skipped-no-id" };
  }
  try {
    const resp = (await withClient((c) =>
      c.client.rawRequest(PULL_PROJECT_HEADER_QUERY, { id: fm.linear_id }),
    )) as { data: { project: Omit<FetchedProject, "issues"> | null } };
    const remote = resp.data.project;
    if (!remote) {
      return { name: fm.name, linear_id: fm.linear_id, status: "missing-remote" };
    }

    const before = JSON.stringify(fm) + project.body;
    fm.name = remote.name;
    fm.description = remote.description ?? "";
    fm.icon = remote.icon ?? null;
    fm.state = remote.state;
    fm.start_date = remote.startDate ?? null;
    fm.target_date = remote.targetDate ?? null;
    rememberPlanRemoteSnapshot(fm, remote.updatedAt);
    // linear_id and team preserved verbatim.
    const newBody = remote.content ?? "";
    const after = JSON.stringify(fm) + newBody;
    if (before === after) {
      return { name: fm.name, linear_id: fm.linear_id, status: "unchanged" };
    }
    await writeBack(project.path, fm, newBody);
    return { name: fm.name, linear_id: fm.linear_id, status: "updated" };
  } catch (err) {
    return {
      name: fm.name,
      linear_id: fm.linear_id,
      status: "error",
      error: (err as Error).message,
    };
  }
}

// ---------- issue pull ----------

async function pullIssue(issue: IssueFile, teamMetadata: TeamMetadata): Promise<PullIssueResult> {
  const fm = issue.frontmatter;
  if (!fm.linear_id) {
    return { slug: issue.slug, path: issue.path, status: "skipped-no-id" };
  }
  try {
    const query = buildPullIssuesQuery([fm.linear_id], false, false);
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
      };
    }

    const before = JSON.stringify(fm) + issue.body;
    rewriteFrontmatterFromRemote(fm, remote, teamMetadata, await listRelations(fm.linear_id));
    rememberPlanRemoteSnapshot(fm, remote.updatedAt);
    const newBody = remote.description ?? "";
    const after = JSON.stringify(fm) + newBody;
    if (before === after) {
      return { slug: issue.slug, path: issue.path, linear_id: fm.linear_id, status: "unchanged" };
    }
    await writeBack(issue.path, fm, newBody);
    return { slug: issue.slug, path: issue.path, linear_id: fm.linear_id, status: "updated" };
  } catch (err) {
    return {
      slug: issue.slug,
      path: issue.path,
      linear_id: fm.linear_id,
      status: "error",
      error: (err as Error).message,
    };
  }
}

// ---------- new-remote import ----------

async function importNewIssue(
  plan: ParsedPlan,
  identifier: string,
  existingSlugs: Set<string>,
  teamMetadata: TeamMetadata,
): Promise<
  | { status: "imported"; identifier: string; path: string; title: string }
  | { status: "error"; error: string }
> {
  try {
    const query = buildPullIssuesQuery([identifier], false, false);
    const resp = (await withClient((c) => c.client.rawRequest(query))) as {
      data: Record<string, FetchedIssue | null>;
    };
    const remote = resp.data.a0;
    if (!remote) return { status: "error", error: "remote issue disappeared during import" };

    const slugBase = slugify(remote.title) || remote.identifier.toLowerCase();
    const slug = uniqueSlug(slugBase, existingSlugs);
    const path = join(plan.dir, `${slug}.md`);
    const fm: Record<string, unknown> = {
      title: remote.title,
      linear_id: remote.identifier,
    };
    rewriteFrontmatterFromRemote(
      fm as IssueFile["frontmatter"],
      remote,
      teamMetadata,
      await listRelations(remote.identifier),
    );
    rememberPlanRemoteSnapshot(fm, remote.updatedAt);
    await writeBack(path, fm as IssueFile["frontmatter"], remote.description ?? "");
    return { status: "imported", identifier: remote.identifier, path, title: remote.title };
  } catch (err) {
    return { status: "error", error: (err as Error).message };
  }
}

// ---------- helpers ----------

function rewriteFrontmatterFromRemote(
  fm: IssueFile["frontmatter"],
  remote: FetchedIssue,
  teamMetadata: TeamMetadata,
  relations?: ListedRelationsPage,
): void {
  fm.title = remote.title;
  fm.state = remote.state.name;
  fm.priority = priorityName(remote.priority);
  if (remote.estimate !== null && remote.estimate !== undefined) fm.estimate = remote.estimate;
  else fm.estimate = undefined;
  if (remote.parent) fm.parent = remote.parent.identifier;
  else fm.parent = undefined;
  fm.labels = remote.labels.nodes.map((l) => labelNameById(teamMetadata, l.id) ?? l.name).sort();
  fm.assignee = remote.assignee?.email ?? null;

  // Relations: derive from outbound + inbound.
  const edges: Record<LinkKey, string[]> = {
    blocks: [],
    blocked_by: [],
    related: [],
    duplicates: [],
    duplicated_by: [],
  };
  for (const r of relations?.outbound ?? []) {
    const key: LinkKey =
      r.type === "blocks" ? "blocks" : r.type === "duplicate" ? "duplicates" : "related";
    edges[key].push(r.otherIdentifier);
  }
  for (const r of relations?.inbound ?? []) {
    if (r.type === "related") {
      // symmetric — already captured forward (avoid double)
      if (!edges.related.includes(r.otherIdentifier)) edges.related.push(r.otherIdentifier);
    } else if (r.type === "blocks") {
      edges.blocked_by.push(r.otherIdentifier);
    } else if (r.type === "duplicate") {
      edges.duplicated_by.push(r.otherIdentifier);
    }
  }
  for (const k of LINK_KEYS) {
    if (edges[k].length > 0) fm[k] = edges[k].sort();
    else delete fm[k];
  }
}

function rememberPlanRemoteSnapshot(frontmatter: Record<string, unknown>, updatedAt: string): void {
  const current =
    frontmatter._server &&
    typeof frontmatter._server === "object" &&
    !Array.isArray(frontmatter._server)
      ? (frontmatter._server as Record<string, unknown>)
      : {};
  frontmatter._server = { ...current, updated_at: updatedAt };
}

async function writeBack(
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<void> {
  // Filter undefined keys; serialize; preserve conventional blank line after closing `---`.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(frontmatter)) if (v !== undefined) clean[k] = v;
  const yaml = stringifyYaml(clean, { lineWidth: 0 });
  const bodySep = body.startsWith("\n") ? "" : "\n";
  const serialized = `---\n${yaml}---\n${bodySep}${body}`;
  await writeAtomic(path, serialized);
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function uniqueSlug(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const cand = `${base}-${i}`;
    if (!existing.has(cand)) return cand;
  }
  return `${base}-${Date.now()}`;
}

function slugFromPath(path: string): string {
  const base = path.substring(path.lastIndexOf("/") + 1);
  return base.replace(/\.md$/i, "");
}
