import { type IssueMetadata, type ProjectMetadata, sha256 } from "./cache.ts";

export type IssueField = "title" | "description" | "state" | "priority" | "labels" | "assignee";

export interface IssueChange {
  field: IssueField;
  from: unknown;
  to: unknown;
}

export function diffIssueMetadata(metadata: IssueMetadata, description: string): IssueChange[] {
  const s = metadata._server;
  const changes: IssueChange[] = [];

  if (metadata.title !== s.title) {
    changes.push({ field: "title", from: s.title, to: metadata.title });
  }

  const localDescHash = sha256(description);
  if (localDescHash !== s.description_hash) {
    changes.push({ field: "description", from: "<unchanged>", to: "<edited>" });
  }

  if (metadata.state !== s.state_name) {
    changes.push({ field: "state", from: s.state_name, to: metadata.state });
  }

  if (metadata.priority !== s.priority) {
    changes.push({ field: "priority", from: s.priority, to: metadata.priority });
  }

  const localLabels = [...metadata.labels].sort();
  const remoteLabels = s.label_ids.map((l) => l.name).sort();
  if (!arraysEqual(localLabels, remoteLabels)) {
    changes.push({ field: "labels", from: remoteLabels, to: localLabels });
  }

  const localAssignee = metadata.assignee;
  const remoteAssignee = s.assignee_email ?? s.assignee_name;
  if ((localAssignee ?? null) !== (remoteAssignee ?? null)) {
    changes.push({ field: "assignee", from: remoteAssignee, to: localAssignee });
  }

  return changes;
}

export type ProjectField = "name" | "description" | "state" | "content";

export interface ProjectChange {
  field: ProjectField;
  from: unknown;
  to: unknown;
}

export function diffProjectMetadata(metadata: ProjectMetadata, content: string): ProjectChange[] {
  const s = metadata._server;
  const changes: ProjectChange[] = [];
  if (metadata.name !== s.name) changes.push({ field: "name", from: s.name, to: metadata.name });
  if (metadata.description !== s.description) {
    changes.push({ field: "description", from: s.description, to: metadata.description });
  }
  if (metadata.state !== s.state) {
    changes.push({ field: "state", from: s.state, to: metadata.state });
  }
  const localContentHash = sha256(content);
  if (localContentHash !== s.content_hash) {
    changes.push({ field: "content", from: "<unchanged>", to: "<edited>" });
  }
  return changes;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
