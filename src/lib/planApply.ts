import { stringify as stringifyYaml } from "yaml";
import { buildIssueMetadata, buildProjectMetadata } from "./build.ts";
import type { TeamMetadata } from "./cache.ts";
import { lintContent } from "./lint.ts";
import type { IssueFile, LinkKey, ParsedPlan, ProjectFile } from "./planTypes.ts";
import { LINK_KEYS, LINK_KEY_TO_SET_LINKS_KIND } from "./planTypes.ts";
import { type FetchedIssue, type FetchedProject, buildPullIssuesQuery } from "./pullQuery.ts";
import {
  ISSUE_UPDATE_MUTATION,
  type IssueUpdateInput,
  PROJECT_UPDATE_MUTATION,
  type ProjectUpdateInput,
} from "./pushMutations.ts";
import { createLink } from "./relations.ts";
import { resolveAssigneeId, resolveLabelIds, resolvePriority, resolveStateId } from "./resolve.ts";
import { linear } from "./sdk.ts";

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
  status: "created" | "error" | "dry-run";
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
    const client = await linear();
    const fetched = (await client.client.rawRequest(PROJECT_READ_QUERY, {
      id: fm.linear_id,
    })) as { data: { project: FetchedProject | null } };
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

    const response = (await client.client.rawRequest(PROJECT_UPDATE_MUTATION, {
      id: fm.linear_id,
      input,
    })) as { data: { projectUpdate: { project: FetchedProject } } };
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
): Promise<ApplyIssueResult> {
  const fm = issue.frontmatter;

  // Lint the body; --strict blocks.
  const { warnings } = lintContent(issue.body);
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
      if (fm.labels?.length) input.labelIds = resolveLabelIds(teamMetadata, fm.labels);
      if (fm.assignee) input.assigneeId = await resolveAssigneeId(teamMetadata, fm.assignee);

      if (opts.dryRun) {
        return { slug: issue.slug, path: issue.path, status: "dry-run" };
      }

      const client = await linear();
      const response = (await client.client.rawRequest(ISSUE_CREATE_MUTATION, { input })) as {
        data: { issueCreate: { issue: FetchedIssue } };
      };
      const created = response.data.issueCreate.issue;
      fm.linear_id = created.identifier;
      await writeFrontmatterBack(issue.path, fm, issue.body);
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
    const client = await linear();
    const query = buildPullIssuesQuery([fm.linear_id], false);
    const fetched = (await client.client.rawRequest(query)) as {
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

    const response = (await client.client.rawRequest(ISSUE_UPDATE_MUTATION, {
      id: remote.id,
      input,
    })) as { data: { issueUpdate: { issue: FetchedIssue } } };
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
    if (mutated) {
      await writeFrontmatterBack(issue.path, issue.frontmatter, issue.body);
    }
  }
}

// ---------- relation application ----------

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
  const client = await linear();
  const uuidByIdentifier = new Map<string, string>();
  await Promise.all(
    Array.from(allIdentifiers).map(async (id) => {
      try {
        const iss = await client.issue(id);
        if (iss) uuidByIdentifier.set(id, iss.id);
      } catch {
        /* mark as unresolvable; relation call will error with clean message */
      }
    }),
  );

  for (const issue of plan.issues) {
    const fromId = issue.frontmatter.linear_id;
    if (!fromId) continue;
    const fromUuid = uuidByIdentifier.get(fromId);
    if (!fromUuid) continue;
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

  const issues: ApplyIssueResult[] = [];
  for (const issue of plan.issues) {
    issues.push(await upsertIssue(issue, teamMetadata, effectiveProjectId, opts));
  }

  // Rewrite slug → LinearID references in every issue file.
  if (!opts.dryRun) await rewriteLinkSlugs(plan);

  // Apply relations once every issue has an identifier (or would have, in dry-run).
  const relations = await applyRelations(plan, opts);

  return { project: projectResult, issues, relations };
}
