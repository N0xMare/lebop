import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { TeamMetadata } from "./cache.ts";
import { paginateRaw } from "./paginate.ts";
import type { IssueFile, LinkKey, ParsedPlan, ProjectFile } from "./planTypes.ts";
import { LINK_KEYS } from "./planTypes.ts";
import {
  type FetchedIssue,
  type FetchedProject,
  PULL_PROJECT_HEADER_QUERY,
  buildPullIssuesQuery,
} from "./pullQuery.ts";
import { labelNameById, priorityName } from "./resolve.ts";
import { linear, withClient } from "./sdk.ts";

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
  skipped_new: { identifier: string; title: string }[]; // if NOT --include-new
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
  const projectResult = await pullProject(plan.project);
  const issues: PullIssueResult[] = [];
  for (const issue of plan.issues) {
    issues.push(await pullIssue(issue, teamMetadata));
  }

  // New-on-remote issues: in the project but not in the plan.
  const newImports: { identifier: string; path: string; title: string }[] = [];
  const skippedNew: { identifier: string; title: string }[] = [];

  if (
    projectResult.linear_id &&
    projectResult.status !== "missing-remote" &&
    projectResult.status !== "error"
  ) {
    try {
      const client = await linear();
      const linearId = projectResult.linear_id;
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
      const plannedIds = new Set(plan.issues.map((i) => i.frontmatter.linear_id).filter(Boolean));
      const existingSlugs = new Set(plan.issues.map((i) => i.slug));
      for (const node of remoteIssues) {
        if (plannedIds.has(node.identifier)) continue;
        if (opts.includeNew) {
          const result = await importNewIssue(plan, node.identifier, existingSlugs, teamMetadata);
          if (result) {
            newImports.push(result);
            existingSlugs.add(slugFromPath(result.path));
          }
        } else {
          skippedNew.push({ identifier: node.identifier, title: node.title });
        }
      }
    } catch {
      /* best-effort */
    }
  }

  return { project: projectResult, issues, new_imports: newImports, skipped_new: skippedNew };
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
    fm.state = remote.state;
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
      };
    }

    const before = JSON.stringify(fm) + issue.body;
    rewriteFrontmatterFromRemote(fm, remote, teamMetadata);
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
): Promise<{ identifier: string; path: string; title: string } | null> {
  try {
    const query = buildPullIssuesQuery([identifier], false, true);
    const resp = (await withClient((c) => c.client.rawRequest(query))) as {
      data: Record<string, FetchedIssue | null>;
    };
    const remote = resp.data.a0;
    if (!remote) return null;

    const slug = uniqueSlug(slugify(remote.title), existingSlugs);
    const path = join(plan.dir, `${slug}.md`);
    const fm: Record<string, unknown> = {
      title: remote.title,
      linear_id: remote.identifier,
    };
    rewriteFrontmatterFromRemote(fm as IssueFile["frontmatter"], remote, teamMetadata);
    await writeBack(path, fm as IssueFile["frontmatter"], remote.description ?? "");
    return { identifier: remote.identifier, path, title: remote.title };
  } catch {
    return null;
  }
}

// ---------- helpers ----------

function rewriteFrontmatterFromRemote(
  fm: IssueFile["frontmatter"],
  remote: FetchedIssue,
  teamMetadata: TeamMetadata,
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
  for (const r of remote.relations?.nodes ?? []) {
    if (r.type === "similar") continue;
    const key: LinkKey =
      r.type === "blocks" ? "blocks" : r.type === "duplicate" ? "duplicates" : "related";
    edges[key].push(r.relatedIssue.identifier);
  }
  for (const r of remote.inverseRelations?.nodes ?? []) {
    if (r.type === "similar") continue;
    if (r.type === "related") {
      // symmetric — already captured forward (avoid double)
      if (!edges.related.includes(r.issue.identifier)) edges.related.push(r.issue.identifier);
    } else if (r.type === "blocks") {
      edges.blocked_by.push(r.issue.identifier);
    } else if (r.type === "duplicate") {
      edges.duplicated_by.push(r.issue.identifier);
    }
  }
  for (const k of LINK_KEYS) {
    if (edges[k].length > 0) fm[k] = edges[k].sort();
    else delete fm[k];
  }
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
  await Bun.write(path, serialized);
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
