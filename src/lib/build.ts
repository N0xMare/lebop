import {
  type CachedComment,
  type IssueMetadata,
  type ProjectMetadata,
  type ServerSnapshot,
  sha256,
} from "./cache.ts";
import type { FetchedIssue, FetchedProject } from "./pullQuery.ts";

export function buildIssueMetadata(issue: FetchedIssue): {
  metadata: IssueMetadata;
  description: string;
} {
  const description = issue.description ?? "";
  const labelList = issue.labels.nodes.map((l) => ({ id: l.id, name: l.name }));
  const server: ServerSnapshot = {
    id: issue.id,
    identifier: issue.identifier,
    url: issue.url,
    state_id: issue.state.id,
    state_name: issue.state.name,
    state_type: issue.state.type,
    priority: issue.priority,
    estimate: issue.estimate ?? null,
    label_ids: labelList,
    assignee_id: issue.assignee?.id ?? null,
    assignee_name: issue.assignee?.name ?? null,
    assignee_email: issue.assignee?.email ?? null,
    title: issue.title,
    description_hash: sha256(description),
    project_id: issue.project?.id ?? null,
    project_name: issue.project?.name ?? null,
    parent_id: issue.parent?.id ?? null,
    parent_identifier: issue.parent?.identifier ?? null,
    updated_at: issue.updatedAt,
  };
  const metadata: IssueMetadata = {
    identifier: issue.identifier,
    title: issue.title,
    state: issue.state.name,
    priority: issue.priority,
    estimate: issue.estimate ?? null,
    labels: labelList.map((l) => l.name).sort(),
    assignee: issue.assignee?.email ?? null,
    project: issue.project?.name ?? null,
    parent: issue.parent?.identifier ?? null,
    _server: server,
  };
  return { metadata, description };
}

export function buildComments(issue: FetchedIssue): CachedComment[] {
  const nodes = issue.comments?.nodes ?? [];
  return nodes.map((c) => ({
    frontmatter: {
      id: c.id,
      author: c.user?.email ?? "unknown",
      author_name: c.user?.name ?? "unknown",
      created_at: c.createdAt,
      updated_at: c.updatedAt,
    },
    body: c.body,
  }));
}

export function buildProjectMetadata(project: FetchedProject): {
  metadata: ProjectMetadata;
  content: string;
} {
  const content = project.content ?? "";
  const metadata: ProjectMetadata = {
    name: project.name,
    description: project.description ?? "",
    state: project.state,
    _server: {
      id: project.id,
      url: project.url,
      state: project.state,
      name: project.name,
      description: project.description ?? "",
      content_hash: sha256(content),
      updated_at: project.updatedAt,
    },
  };
  return { metadata, content };
}
