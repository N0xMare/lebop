/** Pure explore row shape helpers (extracted from workspaceExplore). */

export interface LinearWorkspaceExploreItem {
  kind: string;
  path: string;
  fetchable?: boolean;
  id?: string;
  identifier?: string;
  key?: string;
  name?: string | null;
  title?: string;
  slug_id?: string;
  state?: string | null;
  state_type?: string | null;
  url?: string;
  updated_at?: string;
  created_at?: string;
  ended_at?: string | null;
  archived_at?: string | null;
  counts?: Record<string, number>;
  description?: string | null;
  project?: { id: string; name: string } | null;
  issue?: { id?: string; identifier: string; title?: string } | null;
  team?: { id?: string; key: string; name?: string } | null;
  creator?: { id?: string; name: string; email: string } | null;
}

export function issueItem(i: {
  identifier: string;
  title: string;
  state: string | null;
  state_type: string | null;
  priority: number;
  updated_at: string;
  url: string;
}): LinearWorkspaceExploreItem {
  return {
    kind: "issue",
    fetchable: true,
    identifier: i.identifier,
    title: i.title,
    state: i.state,
    state_type: i.state_type,
    updated_at: i.updated_at,
    url: i.url,
    path: `/issues/${i.identifier}`,
  };
}

export function concreteIssueItem(i: {
  id: string;
  identifier: string;
  title: string;
  state: { name: string; type: string };
  updatedAt: string;
  url: string;
}): LinearWorkspaceExploreItem {
  return {
    kind: "issue",
    fetchable: true,
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    state: i.state.name,
    state_type: i.state.type,
    updated_at: i.updatedAt,
    url: i.url,
    path: `/issues/${i.identifier}`,
  };
}

export function projectItem(p: {
  id: string;
  name: string;
  description: string | null;
  state: string;
  url: string;
  updated_at: string;
  archived_at: string | null;
}): LinearWorkspaceExploreItem {
  return {
    kind: "project",
    fetchable: true,
    id: p.id,
    name: p.name,
    description: p.description,
    state: p.state,
    url: p.url,
    updated_at: p.updated_at,
    archived_at: p.archived_at,
    path: `/projects/${p.id}`,
  };
}

export function documentItem(d: {
  id: string;
  title: string;
  slug_id?: string;
  url: string;
  archived_at: string | null;
  project?: { id: string; name: string } | null;
  issue?: { id: string; identifier: string; title: string } | null;
  creator?: { id: string; name: string; email: string } | null;
}): LinearWorkspaceExploreItem {
  return {
    kind: "document",
    fetchable: true,
    id: d.id,
    title: d.title,
    slug_id: d.slug_id,
    url: d.url,
    archived_at: d.archived_at,
    project: d.project ?? null,
    issue: d.issue ?? null,
    creator: d.creator ?? null,
    path: `/documents/${d.id}`,
  };
}

export function cycleItem(c: {
  id: string;
  name: string | null;
  number: number;
  team: { key: string };
  archived_at: string | null;
}): LinearWorkspaceExploreItem {
  return {
    kind: "cycle",
    fetchable: true,
    id: c.id,
    name: c.name ?? `Cycle ${c.number}`,
    archived_at: c.archived_at,
    team: c.team,
    path: `/cycles/${c.id}`,
  };
}

export function milestoneItem(m: {
  id: string;
  name: string;
  archived_at: string | null;
  project?: { id: string; name: string } | null;
}): LinearWorkspaceExploreItem {
  return {
    kind: "milestone",
    fetchable: true,
    id: m.id,
    name: m.name,
    archived_at: m.archived_at,
    project: m.project ?? null,
    path: `/milestones/${m.id}`,
  };
}

export function agentSessionItem(s: {
  id: string;
  status: string | null;
  type: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
  issue: { identifier: string; title: string } | null;
  creator: { name: string; email: string } | null;
}): LinearWorkspaceExploreItem {
  return {
    kind: "agent_session",
    fetchable: true,
    id: s.id,
    name: s.issue?.identifier ?? s.status ?? s.type ?? s.id,
    title: s.issue?.title,
    state: s.status,
    description: s.creator ? `${s.creator.name} <${s.creator.email}>` : null,
    created_at: s.created_at,
    updated_at: s.updated_at,
    ended_at: s.ended_at,
    issue: s.issue,
    creator: s.creator,
    path: `/agent-sessions/${s.id}`,
  };
}
