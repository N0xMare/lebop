import { getAgentSession, listAgentSessionsPage } from "./agentSessions.ts";
import { listAttachmentsPage } from "./attachments.ts";
import { listCommentsPage } from "./comments.ts";
import { getCycle, listCyclesPage } from "./cycles.ts";
import { getDocument, listDocumentsPage } from "./documents.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import {
  getInitiativeProjectsPage,
  listInitiativesPage,
  listInitiativeUpdatesPage,
} from "./initiatives.ts";
import { getIssue } from "./issues.ts";
import { listLabelsPage } from "./labels.ts";
import { listIssuesPage } from "./listIssues.ts";
import { getMilestone, listMilestonesPage } from "./milestones.ts";
import { paginateConnectionPage } from "./paginate.ts";
import { getProject, listProjectsPage, listProjectUpdatesPage } from "./projects.ts";
import { type ListedRelationsPage, listRelationsPage } from "./relations.ts";
import { linear } from "./sdk.ts";
import { listTeamMembersPage } from "./teamMembers.ts";
import { getTeam } from "./teams.ts";
import { listWorkflowStates } from "./workflowStates.ts";
import { childPaths, parseWorkspacePath } from "./workspacePaths.ts";

export interface ExploreLinearWorkspaceInput {
  path?: string;
  query?: string;
  team?: string;
  includeArchived?: boolean;
  kinds?: string[];
  limit?: number;
  cursor?: string;
}

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

export interface ExploreLinearWorkspaceResult {
  path: string;
  query: string | null;
  team: string | null;
  summary: Record<string, unknown> | null;
  count: number;
  items: LinearWorkspaceExploreItem[];
  next_paths: string[];
  cursor_identity: Record<string, unknown>;
  has_more: boolean;
  next_cursor: string | null;
  page: {
    has_more: boolean;
    next_cursor: string | null;
    limit: number;
    search?: Record<string, unknown>;
    bounded?: {
      returned: number;
      limit: number;
      may_have_more: boolean;
      continuation: "cursor" | "not_available";
      total_available?: number;
    };
  };
  truncated: boolean;
}

const DEFAULT_LIMIT = 25;
const DEFAULT_SEARCH_KINDS = [
  "agent_session",
  "cycle",
  "document",
  "initiative",
  "issue",
  "milestone",
  "project",
] as const;
const TEAM_FILTERABLE_COLLECTIONS = new Set(["projects", "issues", "cycles"]);
const TEAM_FILTERABLE_SEARCH_KINDS = new Set(["cycle", "issue", "project"]);

export async function exploreLinearWorkspace(
  input: ExploreLinearWorkspaceInput = {},
): Promise<ExploreLinearWorkspaceResult> {
  const limit = normalizeLimit(input.limit);
  const parsed = parseWorkspacePath(input.path);
  const query = input.query?.trim();
  const baseTeam = input.team?.toUpperCase() ?? null;
  validateExplicitTeamScope(parsed, baseTeam, Boolean(query));
  const searchScope = query ? resolveSearchScope(parsed, input.kinds, baseTeam) : null;
  const team = searchScope?.team ?? baseTeam;
  const allTeams = query
    ? searchScope?.allTeams === true
    : team === null &&
      [
        "root",
        "projects",
        "issues",
        "cycles",
        "documents",
        "milestones",
        "agent_sessions",
      ].includes(parsed.kind);
  const cursorKinds = searchScope?.kinds ?? null;
  const cursor = input.cursor ? decodeExploreCursor(input.cursor) : null;
  if (cursor) {
    assertCursorMatches(cursor, {
      path: parsed.path,
      query: query ?? null,
      team,
      allTeams,
      kinds: cursorKinds,
      includeArchived: input.includeArchived === true,
    });
  }

  if (query) {
    if (team) await assertTeamExists(team);
    const result = await searchWorkspace({
      ...input,
      query,
      path: parsed.path,
      limit,
      team: team ?? undefined,
      allTeams,
      kinds: cursorKinds ?? undefined,
      scope: searchScope?.scope,
      cursor,
    });
    return { ...result, path: parsed.path };
  }

  if (team && TEAM_FILTERABLE_COLLECTIONS.has(parsed.kind)) {
    await assertTeamExists(team);
  }

  const make = (
    items: LinearWorkspaceExploreItem[],
    summary: Record<string, unknown> | null = null,
    next_paths = childPaths(parsed),
    pageInfo?: { key: string; hasNextPage: boolean; endCursor: string | null },
    bounded?: ExploreLinearWorkspaceResult["page"]["bounded"],
  ): ExploreLinearWorkspaceResult => {
    const cursors = pageInfo
      ? pageCursorRecordOrThrow(parsed.path, pageInfo, cursor?.cursors[pageInfo.key], items.length)
      : {};
    const identity = cursorIdentity({
      path: parsed.path,
      query: null,
      team,
      allTeams,
      kinds: null,
      includeArchived: input.includeArchived === true,
      cursors,
    });
    const nextCursor = pageInfo
      ? makeNextCursor({
          v: 1,
          path: parsed.path,
          query: null,
          team,
          allTeams,
          kinds: null,
          includeArchived: input.includeArchived === true,
          cursors,
        })
      : null;
    return {
      path: parsed.path,
      query: null,
      team,
      summary: bounded && summary ? { ...summary, bounded } : summary,
      count: items.length,
      items,
      next_paths,
      cursor_identity: identity,
      ...pageFields(nextCursor, limit, Object.keys(cursors).length > 0, undefined, bounded),
    };
  };

  switch (parsed.kind) {
    case "root":
      return make([
        { kind: "path", name: "teams", path: "/teams", fetchable: false },
        { kind: "path", name: "projects", path: "/projects", fetchable: false },
        { kind: "path", name: "initiatives", path: "/initiatives", fetchable: false },
        { kind: "path", name: "issues", path: "/issues", fetchable: false },
        { kind: "path", name: "agent-sessions", path: "/agent-sessions", fetchable: false },
        { kind: "path", name: "documents", path: "/documents", fetchable: false },
        { kind: "path", name: "cycles", path: "/cycles", fetchable: false },
        { kind: "path", name: "milestones", path: "/milestones", fetchable: false },
      ]);
    case "teams": {
      const page = await listTeamsPage(limit, cursor?.cursors.main);
      return make(
        page.nodes.map((t) => ({
          kind: "team",
          fetchable: false,
          id: t.id,
          key: t.key,
          name: t.name,
          description: t.description,
          path: `/teams/${t.key}`,
        })),
        { kind: "teams", fetchable: false },
        [],
        { key: "main", hasNextPage: page.pageInfo.hasNextPage, endCursor: page.pageInfo.endCursor },
      );
    }
    case "team": {
      const t = await getTeam(parsed.team ?? "");
      if (!t) throw new NotFoundError(`team not found: ${parsed.team}`, "verify the team key");
      return make([], { kind: "team", ...t });
    }
    case "team_child":
      return exploreTeamChild(
        parsed.team ?? "",
        parsed.child ?? "",
        parsed.path,
        team,
        limit,
        input.includeArchived,
        cursor,
      );
    case "projects": {
      const page = await listProjectsPage({
        team: team ?? undefined,
        includeArchived: input.includeArchived,
        limit,
        after: cursor?.cursors.main,
      });
      return make(
        page.nodes.map((p) => ({
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
        })),
        { kind: "projects" },
        childPaths(parsed),
        { key: "main", hasNextPage: page.pageInfo.hasNextPage, endCursor: page.pageInfo.endCursor },
      );
    }
    case "project": {
      const project = await getProject(parsed.id ?? "");
      if (!project)
        throw new NotFoundError(`project not found: ${parsed.id}`, "verify the project UUID");
      return make([projectItem(project)], { kind: "project", ...project });
    }
    case "project_child":
      return exploreProjectChild(
        parsed.id ?? "",
        parsed.child ?? "",
        parsed.path,
        limit,
        input.includeArchived,
        cursor,
      );
    case "initiatives": {
      const page = await listInitiativesPage({
        includeArchived: input.includeArchived,
        limit,
        after: cursor?.cursors.main,
      });
      return make(
        page.nodes.map((i) => ({
          kind: "initiative",
          fetchable: true,
          id: i.id,
          name: i.name,
          description: i.description,
          state: i.status,
          url: i.url,
          archived_at: i.archived_at,
          path: `/initiatives/${i.id}`,
        })),
        { kind: "initiatives" },
        childPaths(parsed),
        { key: "main", hasNextPage: page.pageInfo.hasNextPage, endCursor: page.pageInfo.endCursor },
      );
    }
    case "initiative": {
      const page = await getInitiativeProjectsPage(parsed.id ?? "", {
        limit,
        after: cursor?.cursors.main,
      });
      if (!page)
        throw new NotFoundError(`initiative not found: ${parsed.id}`, "verify the initiative UUID");
      return make(
        page.projects.nodes.map((p) => ({
          kind: "project",
          fetchable: true,
          id: p.id,
          name: p.name,
          state: p.state,
          path: `/projects/${p.id}`,
        })),
        {
          kind: "initiative",
          ...page.initiative,
          projects: page.projects.nodes,
          project_count: page.projects.nodes.length,
        },
        childPaths(parsed),
        {
          key: "main",
          hasNextPage: page.projects.pageInfo.hasNextPage,
          endCursor: page.projects.pageInfo.endCursor,
        },
      );
    }
    case "initiative_child":
      return exploreInitiativeChild(parsed.id ?? "", parsed.child ?? "", limit, cursor);
    case "issues": {
      const resolvedTeam = team ?? undefined;
      const page = await listIssuesPage({
        resolvedTeam,
        team: resolvedTeam,
        allTeams: !resolvedTeam,
        limit,
        after: cursor?.cursors.main,
        includeArchived: input.includeArchived,
      });
      return make(
        page.nodes.map(issueItem),
        { kind: "issues", team: resolvedTeam ?? null, all_teams: !resolvedTeam },
        [],
        {
          key: "main",
          hasNextPage: page.pageInfo.hasNextPage,
          endCursor: page.pageInfo.endCursor,
        },
      );
    }
    case "issue": {
      const issue = await getIssue(parsed.id ?? "");
      if (!issue) throw new NotFoundError(`issue not found: ${parsed.id}`, "verify the issue id");
      return make([concreteIssueItem(issue)], { kind: "issue", ...issue });
    }
    case "issue_child":
      return exploreIssueChild(
        parsed.id ?? "",
        parsed.child ?? "",
        parsed.path,
        team,
        limit,
        cursor,
      );
    case "agent_sessions": {
      const page = await listAgentSessionsPage({ limit, after: cursor?.cursors.main });
      return make(
        page.nodes.map(agentSessionItem),
        { kind: "agent_sessions", fetchable: false },
        [],
        { key: "main", hasNextPage: page.pageInfo.hasNextPage, endCursor: page.pageInfo.endCursor },
      );
    }
    case "agent_session": {
      const session = await getAgentSession(parsed.id ?? "");
      if (!session)
        throw new NotFoundError(
          `agent session not found: ${parsed.id}`,
          "verify the agent session UUID",
        );
      return make([agentSessionItem(session)], { kind: "agent_session", ...session }, []);
    }
    case "documents": {
      const page = await listDocumentsPage({ limit, after: cursor?.cursors.main });
      return make(page.nodes.map(documentItem), { kind: "documents", fetchable: false }, [], {
        key: "main",
        hasNextPage: page.pageInfo.hasNextPage,
        endCursor: page.pageInfo.endCursor,
      });
    }
    case "document": {
      const document = await getDocument(parsed.id ?? "");
      if (!document)
        throw new NotFoundError(`document not found: ${parsed.id}`, "verify the document UUID");
      return make([documentItem(document)], { kind: "document", ...document }, []);
    }
    case "cycles": {
      const page = await listCyclesPage({
        team: team ?? undefined,
        limit,
        after: cursor?.cursors.main,
      });
      return make(page.nodes.map(cycleItem), { kind: "cycles", fetchable: false }, [], {
        key: "main",
        hasNextPage: page.pageInfo.hasNextPage,
        endCursor: page.pageInfo.endCursor,
      });
    }
    case "cycle": {
      const cycle = await getCycle(parsed.id ?? "");
      if (!cycle) throw new NotFoundError(`cycle not found: ${parsed.id}`, "verify the cycle UUID");
      return make([cycleItem(cycle)], { kind: "cycle", ...cycle });
    }
    case "cycle_child":
      return exploreCycleChild(
        parsed.id ?? "",
        parsed.child ?? "",
        parsed.path,
        team,
        limit,
        input.includeArchived,
        cursor,
      );
    case "milestones": {
      const page = await listMilestonesPage({
        includeArchived: input.includeArchived,
        limit,
        after: cursor?.cursors.main,
      });
      return make(page.nodes.map(milestoneItem), { kind: "milestones", fetchable: false }, [], {
        key: "main",
        hasNextPage: page.pageInfo.hasNextPage,
        endCursor: page.pageInfo.endCursor,
      });
    }
    case "milestone": {
      const milestone = await getMilestone(parsed.id ?? "");
      if (!milestone)
        throw new NotFoundError(`milestone not found: ${parsed.id}`, "verify the milestone UUID");
      return make([milestoneItem(milestone)], { kind: "milestone", ...milestone });
    }
    case "milestone_child":
      return exploreMilestoneChild(
        parsed.id ?? "",
        parsed.child ?? "",
        parsed.path,
        team,
        limit,
        input.includeArchived,
        cursor,
      );
  }
}

async function searchWorkspace(input: {
  path: string;
  query: string;
  team?: string;
  allTeams: boolean;
  kinds?: string[];
  includeArchived?: boolean;
  limit: number;
  scope?: Record<string, unknown>;
  cursor: ExploreCursor | null;
}): Promise<ExploreLinearWorkspaceResult> {
  const selectedKinds = normalizeSearchKinds(input.kinds) ?? [...DEFAULT_SEARCH_KINDS];
  const kinds = new Set(selectedKinds);
  const items: LinearWorkspaceExploreItem[] = [];
  const take = Math.max(1, input.limit);
  const nextCursors: Record<string, string> = {};
  const completedKinds = new Set(input.cursor?.completed ?? []);
  const nextCompletedKinds = new Set(input.cursor?.completed ?? []);
  const searchMeta: Record<string, unknown> = {};

  if (kinds.has("project") && shouldSearchKind(input.cursor, completedKinds, "project")) {
    const projects = await listProjectsPage({
      team: input.team,
      search: input.query,
      includeArchived: input.includeArchived,
      limit: take,
      after: input.cursor?.cursors.project,
    });
    recordSearchPageCursor(
      "project",
      projects.pageInfo,
      input.cursor?.cursors.project,
      nextCursors,
      nextCompletedKinds,
      projects.nodes.length,
    );
    searchMeta.project = {
      mode: "server_filter",
      complete: !projects.pageInfo.hasNextPage,
      searched_count: projects.nodes.length,
    };
    items.push(
      ...projects.nodes.map((p) => ({
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
      })),
    );
  } else if (kinds.has("project")) {
    searchMeta.project = skippedSearchKindMeta();
  }

  if (kinds.has("initiative") && shouldSearchKind(input.cursor, completedKinds, "initiative")) {
    const initiatives = await listInitiativesPage({
      search: input.query,
      includeArchived: input.includeArchived,
      limit: take,
      after: input.cursor?.cursors.initiative,
    });
    recordSearchPageCursor(
      "initiative",
      initiatives.pageInfo,
      input.cursor?.cursors.initiative,
      nextCursors,
      nextCompletedKinds,
      initiatives.nodes.length,
    );
    searchMeta.initiative = {
      mode: "deterministic_filter",
      complete: !initiatives.pageInfo.hasNextPage,
      searched_count: initiatives.nodes.length,
      note: "Linear InitiativeFilter has no searchableContent field; search covers name and status.",
    };
    items.push(
      ...initiatives.nodes.map((i) => ({
        kind: "initiative",
        fetchable: true,
        id: i.id,
        name: i.name,
        description: i.description,
        state: i.status,
        url: i.url,
        archived_at: i.archived_at,
        path: `/initiatives/${i.id}`,
      })),
    );
  } else if (kinds.has("initiative")) {
    searchMeta.initiative = skippedSearchKindMeta();
  }

  if (kinds.has("document") && shouldSearchKind(input.cursor, completedKinds, "document")) {
    const documents = await listDocumentsPage({
      search: input.query,
      limit: take,
      after: input.cursor?.cursors.document,
    });
    recordSearchPageCursor(
      "document",
      documents.pageInfo,
      input.cursor?.cursors.document,
      nextCursors,
      nextCompletedKinds,
      documents.nodes.length,
    );
    searchMeta.document = serverSearchMeta(documents.pageInfo, documents.nodes.length, {
      note: "Search uses Linear DocumentFilter.title containsIgnoreCase.",
    });
    items.push(...documents.nodes.map(documentItem));
  } else if (kinds.has("document")) {
    searchMeta.document = skippedSearchKindMeta();
  }

  if (kinds.has("cycle") && shouldSearchKind(input.cursor, completedKinds, "cycle")) {
    const cycles = await listCyclesPage({
      team: input.team,
      search: input.query,
      limit: take,
      after: input.cursor?.cursors.cycle,
    });
    recordSearchPageCursor(
      "cycle",
      cycles.pageInfo,
      input.cursor?.cursors.cycle,
      nextCursors,
      nextCompletedKinds,
      cycles.nodes.length,
    );
    searchMeta.cycle = serverSearchMeta(cycles.pageInfo, cycles.nodes.length, {
      note: "Search uses Linear CycleFilter.name containsIgnoreCase.",
      team: input.team ?? null,
      scope: input.team ? "team" : "all_teams",
    });
    items.push(...cycles.nodes.map(cycleItem));
  } else if (kinds.has("cycle")) {
    searchMeta.cycle = skippedSearchKindMeta();
  }

  if (kinds.has("milestone") && shouldSearchKind(input.cursor, completedKinds, "milestone")) {
    const milestones = await listMilestonesPage({
      search: input.query,
      includeArchived: input.includeArchived,
      limit: take,
      after: input.cursor?.cursors.milestone,
    });
    recordSearchPageCursor(
      "milestone",
      milestones.pageInfo,
      input.cursor?.cursors.milestone,
      nextCursors,
      nextCompletedKinds,
      milestones.nodes.length,
    );
    searchMeta.milestone = serverSearchMeta(milestones.pageInfo, milestones.nodes.length, {
      note: "Search uses Linear ProjectMilestoneFilter.name containsIgnoreCase.",
    });
    items.push(...milestones.nodes.map(milestoneItem));
  } else if (kinds.has("milestone")) {
    searchMeta.milestone = skippedSearchKindMeta();
  }

  if (
    kinds.has("agent_session") &&
    shouldSearchKind(input.cursor, completedKinds, "agent_session")
  ) {
    const sessions = await listAgentSessionsPage({
      search: input.query,
      limit: take,
      after: input.cursor?.cursors.agent_session,
    });
    recordSearchPageCursor(
      "agent_session",
      sessions.pageInfo,
      input.cursor?.cursors.agent_session,
      nextCursors,
      nextCompletedKinds,
      sessions.searchedCount,
    );
    searchMeta.agent_session = serverSearchMeta(sessions.pageInfo, sessions.searchedCount, {
      mode: "page_client_filter",
      returned_count: sessions.nodes.length,
      note: "Linear removed server-side AgentSessionFilter; search scans raw agent-session pages client-side until the requested filtered page is filled or the raw connection is exhausted.",
    });
    items.push(...sessions.nodes.map(agentSessionItem));
  } else if (kinds.has("agent_session")) {
    searchMeta.agent_session = skippedSearchKindMeta();
  }

  if (kinds.has("issue") && shouldSearchKind(input.cursor, completedKinds, "issue")) {
    const resolvedTeam = input.allTeams ? undefined : input.team;
    const issues = await listIssuesPage({
      resolvedTeam,
      team: resolvedTeam,
      allTeams: input.allTeams,
      search: input.query,
      includeArchived: input.includeArchived,
      limit: take,
      after: input.cursor?.cursors.issue,
    });
    recordSearchPageCursor(
      "issue",
      issues.pageInfo,
      input.cursor?.cursors.issue,
      nextCursors,
      nextCompletedKinds,
      issues.nodes.length,
    );
    searchMeta.issue = {
      mode: "server_filter",
      scope: input.allTeams ? "all_teams" : "team",
      team: resolvedTeam ?? null,
      complete: !issues.pageInfo.hasNextPage,
      searched_count: issues.nodes.length,
    };
    items.push(...issues.nodes.map(issueItem));
  } else if (kinds.has("issue")) {
    searchMeta.issue = skippedSearchKindMeta();
  }

  const nextCursor = makeNextCursor({
    v: 1,
    path: input.path,
    query: input.query,
    team: input.team ?? null,
    allTeams: input.allTeams,
    kinds: selectedKinds,
    includeArchived: input.includeArchived === true,
    cursors: nextCursors,
    completed: [...nextCompletedKinds].sort(),
  });
  const hasMore = Object.keys(nextCursors).length > 0;
  const identity = cursorIdentity({
    path: input.path,
    query: input.query,
    team: input.team ?? null,
    allTeams: input.allTeams,
    kinds: selectedKinds,
    includeArchived: input.includeArchived === true,
    cursors: nextCursors,
    completed: [...nextCompletedKinds].sort(),
  });
  return {
    path: input.path,
    query: input.query,
    team: input.team ?? null,
    summary: {
      kind: "search",
      query: input.query,
      kinds: selectedKinds,
      limit_semantics: "per_kind",
      ...(input.scope ? { scope: { ...input.scope, all_teams: input.allTeams } } : {}),
      search: searchMeta,
    },
    count: items.length,
    items,
    next_paths: [],
    cursor_identity: identity,
    ...pageFields(nextCursor, take, hasMore, searchMeta),
  };
}

function shouldSearchKind(
  cursor: ExploreCursor | null,
  completedKinds: Set<string>,
  kind: string,
): boolean {
  if (!cursor) return true;
  return cursor.cursors[kind] !== undefined || !completedKinds.has(kind);
}

function skippedSearchKindMeta(): Record<string, unknown> {
  return {
    mode: "cursor_complete",
    complete: true,
    searched_count: 0,
  };
}

function recordSearchPageCursor(
  key: string,
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
  previousCursor: string | undefined,
  nextCursors: Record<string, string>,
  completedKinds: Set<string>,
  returned: number,
): void {
  const cursors = pageCursorRecordOrThrow(
    `search:${key}`,
    { key, ...pageInfo },
    previousCursor,
    returned,
  );
  const next = cursors[key];
  if (next) {
    nextCursors[key] = next;
  } else {
    completedKinds.add(key);
  }
}

function serverSearchMeta(
  pageInfo: { hasNextPage: boolean },
  searchedCount: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mode: "server_filter",
    complete: !pageInfo.hasNextPage,
    searched_count: searchedCount,
    ...extra,
  };
}

function pageCursorRecordOrThrow(
  context: string,
  pageInfo: { key: string; hasNextPage: boolean; endCursor: string | null },
  previousCursor?: string,
  returned?: number,
): Record<string, string> {
  if (!pageInfo.hasNextPage) return {};
  if (!pageInfo.endCursor) {
    throw new ValidationError(
      `explore page for ${context} cannot continue`,
      "Linear returned hasNextPage without endCursor",
    );
  }
  if (previousCursor && pageInfo.endCursor === previousCursor) {
    throw new ValidationError(
      `explore page for ${context} cursor did not advance`,
      "Linear returned the same endCursor on consecutive pages",
    );
  }
  if (returned === 0) {
    throw new ValidationError(
      `explore page for ${context} made no progress`,
      "Linear returned hasNextPage but no records for the requested page",
    );
  }
  return { [pageInfo.key]: pageInfo.endCursor };
}

function cursorIdentity(input: {
  path: string;
  query: string | null;
  team: string | null;
  allTeams: boolean;
  kinds: string[] | null;
  includeArchived: boolean;
  cursors?: Record<string, string>;
  completed?: string[];
}): Record<string, unknown> {
  return {
    path: input.path,
    query: input.query,
    team: input.team,
    all_teams: input.allTeams,
    kinds: input.kinds,
    include_archived: input.includeArchived,
    cursor_keys: Object.keys(input.cursors ?? {}).sort(),
    ...(input.completed ? { completed_kinds: input.completed } : {}),
  };
}

async function exploreTeamChild(
  team: string,
  child: string,
  path: string,
  cursorTeam: string | null,
  limit: number,
  includeArchived?: boolean,
  cursor?: ExploreCursor | null,
): Promise<ExploreLinearWorkspaceResult> {
  const upperTeam = team.toUpperCase();
  await assertTeamExists(upperTeam);
  if (child === "issues") {
    const page = await listIssuesPage({
      resolvedTeam: upperTeam,
      team: upperTeam,
      includeArchived,
      limit,
      after: cursor?.cursors.main,
    });
    return explorePagedChildResult(
      path,
      upperTeam,
      page.nodes.map(issueItem),
      {
        kind: "team_issues",
        team: upperTeam,
      },
      limit,
      page.pageInfo,
      includeArchived,
      cursorTeam,
      cursor?.cursors.main,
    );
  }
  if (child === "projects") {
    const page = await listProjectsPage({
      team: upperTeam,
      includeArchived,
      limit,
      after: cursor?.cursors.main,
    });
    return explorePagedChildResult(
      path,
      upperTeam,
      page.nodes.map((p) => ({
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
      })),
      { kind: "team_projects", team: upperTeam },
      limit,
      page.pageInfo,
      includeArchived,
      cursorTeam,
      cursor?.cursors.main,
    );
  }
  if (child === "cycles") {
    const page = await listCyclesPage({
      team: upperTeam,
      limit,
      after: cursor?.cursors.main,
    });
    return explorePagedChildResult(
      `/teams/${upperTeam}/cycles`,
      upperTeam,
      page.nodes.map(cycleItem),
      {
        kind: "team_cycles",
        team: upperTeam,
      },
      limit,
      page.pageInfo,
      includeArchived,
      cursorTeam,
      cursor?.cursors.main,
    );
  }
  if (child === "labels") {
    const page = await listLabelsPage({ team: upperTeam, limit, after: cursor?.cursors.main });
    return explorePagedChildResult(
      `/teams/${upperTeam}/labels`,
      upperTeam,
      page.nodes.map((l) => ({
        kind: "label",
        id: l.id,
        name: l.name,
        description: l.description,
        path: `/teams/${upperTeam}/labels`,
      })),
      { kind: "team_labels", team: upperTeam },
      limit,
      page.pageInfo,
      undefined,
      cursorTeam,
      cursor?.cursors.main,
    );
  }
  if (child === "states") {
    const states = await listWorkflowStates(upperTeam);
    const allStates = states?.states ?? [];
    const items = allStates.slice(0, limit).map((s) => ({
      kind: "workflow_state",
      id: s.id,
      name: s.name,
      state_type: s.type,
      path: `/teams/${upperTeam}/states`,
    }));
    return exploreChildResult(
      `/teams/${upperTeam}/states`,
      upperTeam,
      items,
      { kind: "team_states", team: upperTeam },
      limit,
      boundedMetadata(items.length, limit, allStates.length),
    );
  }
  const page = await listTeamMembersPage({
    teamKey: upperTeam,
    limit,
    after: cursor?.cursors.main,
  });
  return explorePagedChildResult(
    `/teams/${upperTeam}/members`,
    upperTeam,
    page.nodes.map((m) => ({
      kind: "member",
      id: m.id,
      name: m.name,
      description: m.email,
      path: `/teams/${upperTeam}/members`,
    })),
    { kind: "team_members", team: upperTeam },
    limit,
    page.pageInfo,
    undefined,
    cursorTeam,
    cursor?.cursors.main,
  );
}

async function exploreProjectChild(
  id: string,
  child: string,
  path: string,
  limit: number,
  includeArchived?: boolean,
  cursor?: ExploreCursor | null,
): Promise<ExploreLinearWorkspaceResult> {
  if (child === "issues") {
    const page = await listIssuesPage({
      resolvedTeam: undefined,
      allTeams: true,
      projectId: id,
      includeArchived,
      limit,
      after: cursor?.cursors.main,
    });
    return explorePagedChildResult(
      path,
      null,
      page.nodes.map(issueItem),
      {
        kind: "project_issues",
        project_id: id,
      },
      limit,
      page.pageInfo,
      includeArchived,
      null,
      cursor?.cursors.main,
    );
  }
  if (child === "documents") {
    const page = await listDocumentsPage({ projectId: id, limit, after: cursor?.cursors.main });
    return explorePagedChildResult(
      `/projects/${id}/documents`,
      null,
      page.nodes.map(documentItem),
      {
        kind: "project_documents",
        project_id: id,
      },
      limit,
      page.pageInfo,
      undefined,
      null,
      cursor?.cursors.main,
    );
  }
  if (child === "updates") {
    const page = await listProjectUpdatesPage(id, { limit, after: cursor?.cursors.main });
    return explorePagedChildResult(
      `/projects/${id}/updates`,
      null,
      page.nodes.map((u) => ({
        kind: "project_update",
        id: u.id,
        description: u.body,
        state: u.health,
        updated_at: u.created_at,
        path: `/projects/${id}/updates`,
      })),
      { kind: "project_updates", project_id: id },
      limit,
      page.pageInfo,
      undefined,
      null,
      cursor?.cursors.main,
    );
  }
  const page = await listMilestonesPage({
    projectId: id,
    includeArchived,
    limit,
    after: cursor?.cursors.main,
  });
  return explorePagedChildResult(
    `/projects/${id}/milestones`,
    null,
    page.nodes.map(milestoneItem),
    {
      kind: "project_milestones",
      project_id: id,
    },
    limit,
    page.pageInfo,
    includeArchived,
    null,
    cursor?.cursors.main,
  );
}

async function exploreInitiativeChild(
  id: string,
  child: string,
  limit: number,
  cursor?: ExploreCursor | null,
): Promise<ExploreLinearWorkspaceResult> {
  if (child === "updates") {
    const page = await listInitiativeUpdatesPage(id, { limit, after: cursor?.cursors.main });
    return explorePagedChildResult(
      `/initiatives/${id}/updates`,
      null,
      page.nodes.map((u) => ({
        kind: "initiative_update",
        id: u.id,
        description: u.body,
        state: u.health,
        updated_at: u.created_at,
        path: `/initiatives/${id}/updates`,
      })),
      { kind: "initiative_updates", initiative_id: id },
      limit,
      page.pageInfo,
      undefined,
      undefined,
      cursor?.cursors.main,
    );
  }
  const page = await getInitiativeProjectsPage(id, { limit, after: cursor?.cursors.main });
  if (!page) throw new NotFoundError(`initiative not found: ${id}`, "verify the UUID");
  return explorePagedChildResult(
    `/initiatives/${id}/projects`,
    null,
    page.projects.nodes.map((p) => ({
      kind: "project",
      fetchable: true,
      id: p.id,
      name: p.name,
      state: p.state,
      path: `/projects/${p.id}`,
    })),
    { kind: "initiative_projects", initiative_id: id },
    limit,
    page.projects.pageInfo,
    undefined,
    undefined,
    cursor?.cursors.main,
  );
}

async function exploreIssueChild(
  id: string,
  child: string,
  path: string,
  cursorTeam: string | null,
  limit: number,
  cursor?: ExploreCursor | null,
): Promise<ExploreLinearWorkspaceResult> {
  if (child === "comments") {
    const page = await listCommentsPage(id, { first: limit, after: cursor?.cursors.main });
    return explorePagedChildResult(
      path,
      cursorTeam,
      page.comments.map((c) => ({
        kind: "comment",
        id: c.id,
        description: c.body,
        updated_at: c.updated_at,
        path: `/issues/${id}/comments`,
      })),
      { kind: "issue_comments", identifier: id },
      limit,
      page.pageInfo,
      undefined,
      cursorTeam,
      cursor?.cursors.main,
    );
  }
  if (child === "relations") {
    const relations = await listRelationsPage(id, {
      first: limit,
      outboundAfter: cursor?.cursors.outbound,
      inboundAfter: cursor?.cursors.inbound,
    });
    const nextCursors = relationNextCursorsOrThrow(id, relations, cursor);
    const allRelations = [...relations.outbound, ...relations.inbound];
    const items = allRelations.map((r) => ({
      kind: "relation",
      id: r.id,
      name: r.type,
      identifier: r.otherIdentifier,
      path: `/issues/${r.otherIdentifier}`,
    }));
    const nextCursor = encodeExploreCursor({
      v: 1,
      path,
      query: null,
      team: cursorTeam,
      allTeams: false,
      kinds: null,
      includeArchived: false,
      cursors: nextCursors,
    });
    return {
      path,
      query: null,
      team: cursorTeam,
      summary: {
        kind: "issue_relations",
        identifier: id,
        complete: relations.complete,
        pageInfo: relations.pageInfo,
        limit_semantics: "per_direction",
      },
      count: items.length,
      items,
      next_paths: [],
      cursor_identity: cursorIdentity({
        path,
        query: null,
        team: cursorTeam,
        allTeams: false,
        kinds: null,
        includeArchived: false,
        cursors: nextCursors,
      }),
      ...pageFields(nextCursor, limit, relations.complete === false),
    };
  }
  if (child === "agent-sessions") {
    const issue = await getIssue(id);
    if (!issue) throw new NotFoundError(`issue not found: ${id}`, "verify the issue id");
    const page = await listAgentSessionsPage({
      issueId: issue.id,
      limit,
      after: cursor?.cursors.main,
    });
    return explorePagedChildResult(
      path,
      cursorTeam,
      page.nodes.map(agentSessionItem),
      { kind: "issue_agent_sessions", identifier: id },
      limit,
      page.pageInfo,
      undefined,
      cursorTeam,
      cursor?.cursors.main,
    );
  }
  if (child === "documents") {
    const issue = await getIssue(id);
    if (!issue) throw new NotFoundError(`issue not found: ${id}`, "verify the issue id");
    const page = await listDocumentsPage({
      issueId: issue.id,
      limit,
      after: cursor?.cursors.main,
    });
    return explorePagedChildResult(
      path,
      cursorTeam,
      page.nodes.map(documentItem),
      { kind: "issue_documents", identifier: id },
      limit,
      page.pageInfo,
      undefined,
      cursorTeam,
      cursor?.cursors.main,
    );
  }
  const page = await listAttachmentsPage(id, { first: limit, after: cursor?.cursors.main });
  return explorePagedChildResult(
    path,
    cursorTeam,
    page.attachments.map((a) => ({
      kind: "attachment",
      id: a.id,
      name: a.title,
      url: a.url,
      path: `/issues/${id}/attachments`,
    })),
    { kind: "issue_attachments", identifier: id },
    limit,
    page.pageInfo,
    undefined,
    cursorTeam,
    cursor?.cursors.main,
  );
}

function relationNextCursors(relations: ListedRelationsPage): Record<string, string> {
  const cursors: Record<string, string> = {};
  if (relations.pageInfo.outbound.hasNextPage && relations.pageInfo.outbound.endCursor) {
    cursors.outbound = relations.pageInfo.outbound.endCursor;
  }
  if (relations.pageInfo.inbound.hasNextPage && relations.pageInfo.inbound.endCursor) {
    cursors.inbound = relations.pageInfo.inbound.endCursor;
  }
  return cursors;
}

function relationNextCursorsOrThrow(
  identifier: string,
  relations: ListedRelationsPage,
  cursor?: ExploreCursor | null,
): Record<string, string> {
  if (relations.pageInfo.outbound.hasNextPage && !relations.pageInfo.outbound.endCursor) {
    throw new ValidationError(
      `issue relation explore for ${identifier} cannot continue outbound page`,
      "Linear returned hasNextPage without endCursor",
    );
  }
  if (relations.pageInfo.inbound.hasNextPage && !relations.pageInfo.inbound.endCursor) {
    throw new ValidationError(
      `issue relation explore for ${identifier} cannot continue inbound page`,
      "Linear returned hasNextPage without endCursor",
    );
  }
  if (
    relations.pageInfo.outbound.hasNextPage &&
    relations.pageInfo.outbound.endCursor === cursor?.cursors.outbound
  ) {
    throw new ValidationError(
      `issue relation explore for ${identifier} outbound cursor did not advance`,
      "Linear returned the same outbound endCursor on consecutive pages",
    );
  }
  if (
    relations.pageInfo.inbound.hasNextPage &&
    relations.pageInfo.inbound.endCursor === cursor?.cursors.inbound
  ) {
    throw new ValidationError(
      `issue relation explore for ${identifier} inbound cursor did not advance`,
      "Linear returned the same inbound endCursor on consecutive pages",
    );
  }
  return relationNextCursors(relations);
}

async function exploreCycleChild(
  id: string,
  child: string,
  path: string,
  cursorTeam: string | null,
  limit: number,
  includeArchived?: boolean,
  cursor?: ExploreCursor | null,
): Promise<ExploreLinearWorkspaceResult> {
  if (child !== "issues") {
    throw new ValidationError(`unsupported cycle child path: ${child}`, "use /cycles/<id>/issues");
  }
  const cycle = await getCycle(id);
  if (!cycle) throw new NotFoundError(`cycle not found: ${id}`, "verify the cycle UUID");
  const team = cycle.team.key.toUpperCase();
  const page = await listIssuesPage({
    resolvedTeam: team,
    team,
    cycle: id,
    includeArchived,
    limit,
    after: cursor?.cursors.main,
  });
  return explorePagedChildResult(
    path,
    team,
    page.nodes.map(issueItem),
    {
      kind: "cycle_issues",
      cycle_id: id,
      team,
    },
    limit,
    page.pageInfo,
    includeArchived,
    cursorTeam,
    cursor?.cursors.main,
  );
}

async function exploreMilestoneChild(
  id: string,
  child: string,
  path: string,
  cursorTeam: string | null,
  limit: number,
  includeArchived?: boolean,
  cursor?: ExploreCursor | null,
): Promise<ExploreLinearWorkspaceResult> {
  if (child !== "issues") {
    throw new ValidationError(
      `unsupported milestone child path: ${child}`,
      "use /milestones/<id>/issues",
    );
  }
  const milestone = await getMilestone(id);
  if (!milestone)
    throw new NotFoundError(`milestone not found: ${id}`, "verify the milestone UUID");
  const page = await listIssuesPage({
    resolvedTeam: undefined,
    allTeams: true,
    milestone: id,
    includeArchived,
    limit,
    after: cursor?.cursors.main,
  });
  return explorePagedChildResult(
    path,
    null,
    page.nodes.map(issueItem),
    {
      kind: "milestone_issues",
      milestone_id: id,
    },
    limit,
    page.pageInfo,
    includeArchived,
    cursorTeam,
    cursor?.cursors.main,
  );
}

function exploreChildResult(
  path: string,
  team: string | null,
  items: LinearWorkspaceExploreItem[],
  summary: Record<string, unknown>,
  limit = items.length,
  boundedOverride?: NonNullable<ExploreLinearWorkspaceResult["page"]["bounded"]>,
): ExploreLinearWorkspaceResult {
  const bounded = boundedOverride ?? boundedMetadata(items.length, limit);
  return {
    path,
    query: null,
    team,
    summary: { ...summary, bounded },
    count: items.length,
    items,
    next_paths: [],
    cursor_identity: cursorIdentity({
      path,
      query: null,
      team,
      allTeams: false,
      kinds: null,
      includeArchived: false,
    }),
    ...pageFields(null, limit, false, undefined, bounded),
  };
}

function explorePagedChildResult(
  path: string,
  team: string | null,
  items: LinearWorkspaceExploreItem[],
  summary: Record<string, unknown>,
  limit: number,
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
  includeArchived?: boolean,
  cursorTeam = team,
  previousCursor?: string,
): ExploreLinearWorkspaceResult {
  const cursors = pageCursorRecordOrThrow(
    path,
    { key: "main", ...pageInfo },
    previousCursor,
    items.length,
  );
  const nextCursor = makeNextCursor({
    v: 1,
    path,
    query: null,
    team: cursorTeam,
    allTeams: false,
    kinds: null,
    includeArchived: includeArchived === true,
    cursors,
  });
  return {
    path,
    query: null,
    team,
    summary,
    count: items.length,
    items,
    next_paths: [],
    cursor_identity: cursorIdentity({
      path,
      query: null,
      team: cursorTeam,
      allTeams: false,
      kinds: null,
      includeArchived: includeArchived === true,
      cursors,
    }),
    ...pageFields(nextCursor, limit, Object.keys(cursors).length > 0),
  };
}

async function listTeamsPage(
  limit: number,
  after?: string,
): Promise<{
  nodes: {
    id: string;
    key: string;
    name: string;
    description: string | null;
  }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}> {
  const client = await linear();
  const page = await paginateConnectionPage(({ first, after }) => client.teams({ first, after }), {
    limit,
    after,
  });
  return {
    nodes: page.nodes.map((t) => ({
      id: t.id,
      key: t.key,
      name: t.name,
      description: t.description ?? null,
    })),
    pageInfo: page.pageInfo,
  };
}

function issueItem(i: {
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

function concreteIssueItem(i: {
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

function projectItem(p: {
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

function documentItem(d: {
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

function cycleItem(c: {
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

function milestoneItem(m: {
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

function agentSessionItem(s: {
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

function normalizeLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const normalized = Math.floor(limit);
  if (normalized < 1 || normalized > 250) {
    throw new ValidationError(
      `explore limit must be between 1 and 250, got ${limit}`,
      "pass a limit in the same range accepted by the MCP explore_linear_workspace schema",
    );
  }
  return normalized;
}

export interface ExploreCursor {
  v: 1;
  path: string;
  query: string | null;
  team: string | null;
  allTeams: boolean;
  kinds: string[] | null;
  includeArchived: boolean;
  cursors: Record<string, string>;
  completed?: string[];
}

function makeNextCursor(input: ExploreCursor): string | null {
  return encodeExploreCursor(input);
}

export function encodeExploreCursor(input: ExploreCursor): string | null {
  if (Object.keys(input.cursors).length === 0) return null;
  return Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
}

export function decodeExploreCursor(cursor: string): ExploreCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ValidationError(
      "invalid explore cursor",
      "use the exact next_cursor returned by explore_linear_workspace",
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { v?: unknown }).v !== 1 ||
    typeof (parsed as { path?: unknown }).path !== "string" ||
    !isNullableString((parsed as { query?: unknown }).query) ||
    !isNullableString((parsed as { team?: unknown }).team) ||
    ((parsed as { allTeams?: unknown }).allTeams !== undefined &&
      typeof (parsed as { allTeams?: unknown }).allTeams !== "boolean") ||
    typeof (parsed as { includeArchived?: unknown }).includeArchived !== "boolean" ||
    !isStringArrayOrNull((parsed as { kinds?: unknown }).kinds) ||
    !isStringRecord((parsed as { cursors?: unknown }).cursors) ||
    !isOptionalStringArray((parsed as { completed?: unknown }).completed)
  ) {
    throw new ValidationError(
      "invalid explore cursor",
      "use the exact next_cursor returned by explore_linear_workspace",
    );
  }
  return { ...(parsed as ExploreCursor), allTeams: Boolean((parsed as ExploreCursor).allTeams) };
}

function assertCursorMatches(
  cursor: ExploreCursor,
  expected: Omit<ExploreCursor, "v" | "cursors" | "completed">,
): void {
  if (
    cursor.path !== expected.path ||
    cursor.query !== expected.query ||
    cursor.team !== expected.team ||
    cursor.allTeams !== expected.allTeams ||
    cursor.includeArchived !== expected.includeArchived ||
    JSON.stringify(cursor.kinds) !== JSON.stringify(expected.kinds)
  ) {
    throw new ValidationError(
      "explore cursor does not match this request",
      "reuse the cursor with the same path, query, team/all-teams scope, kinds, and includeArchived settings",
    );
  }
}

function pageFields(
  nextCursor: string | null,
  limit: number,
  hasMore = nextCursor !== null,
  search?: Record<string, unknown>,
  bounded?: ExploreLinearWorkspaceResult["page"]["bounded"],
): Pick<ExploreLinearWorkspaceResult, "has_more" | "next_cursor" | "page" | "truncated"> {
  const continuable = hasMore && nextCursor !== null;
  return {
    has_more: continuable,
    next_cursor: nextCursor,
    page: {
      has_more: continuable,
      next_cursor: nextCursor,
      limit,
      ...(search ? { search } : {}),
      ...(bounded ? { bounded } : {}),
    },
    truncated: continuable || bounded?.may_have_more === true,
  };
}

function boundedMetadata(
  returned: number,
  limit: number,
  totalAvailable?: number,
): NonNullable<ExploreLinearWorkspaceResult["page"]["bounded"]> & { total_available?: number } {
  const mayHaveMore =
    totalAvailable === undefined ? returned >= limit && limit > 0 : totalAvailable > returned;
  return {
    returned,
    limit,
    may_have_more: mayHaveMore,
    continuation: "not_available",
    ...(totalAvailable === undefined ? {} : { total_available: totalAvailable }),
  };
}

function resolveSearchScope(
  parsed: ReturnType<typeof parseWorkspacePath>,
  requestedKinds: string[] | undefined,
  explicitTeam: string | null,
): { kinds: string[]; team: string | null; allTeams: boolean; scope: Record<string, unknown> } {
  const requested = normalizeSearchKinds(requestedKinds);
  const searchableHint =
    "search paths supported today: /, /projects, /issues, /initiatives, /documents, /cycles, /milestones, /agent-sessions, /teams/<key>/projects, /teams/<key>/issues, /teams/<key>/cycles";

  const scoped = (
    pathKinds: readonly string[],
    team: string | null,
    allTeams: boolean,
    scope: Record<string, unknown>,
  ) => {
    const kinds = requested ?? [...pathKinds];
    const unsupported = kinds.filter((kind) => !pathKinds.includes(kind));
    if (unsupported.length > 0) {
      throw new ValidationError(
        `search kind ${unsupported.join(", ")} is not supported for ${parsed.path}`,
        `use ${pathKinds.join(", ")} for this path, or search / for multiple kinds`,
      );
    }
    if (team) {
      const teamIgnored = kinds.filter((kind) => !TEAM_FILTERABLE_SEARCH_KINDS.has(kind));
      if (teamIgnored.length > 0) {
        throw new ValidationError(
          `team cannot be applied to ${teamIgnored.join(", ")} search for ${parsed.path}`,
          "omit team, or restrict kinds to project, issue, and cycle where Linear supports team filtering",
        );
      }
    }
    return { kinds, team, allTeams, scope };
  };

  switch (parsed.kind) {
    case "root":
      return scoped(DEFAULT_SEARCH_KINDS, explicitTeam, explicitTeam === null, {
        path: "/",
        team: explicitTeam,
      });
    case "projects":
      return scoped(["project"], explicitTeam, explicitTeam === null, {
        path: "/projects",
        team: explicitTeam,
      });
    case "issues":
      return scoped(["issue"], explicitTeam, explicitTeam === null, {
        path: "/issues",
        team: explicitTeam,
      });
    case "initiatives":
      return scoped(["initiative"], explicitTeam, explicitTeam === null, {
        path: "/initiatives",
        team: explicitTeam,
      });
    case "documents":
      return scoped(["document"], explicitTeam, explicitTeam === null, {
        path: "/documents",
        team: explicitTeam,
      });
    case "cycles":
      return scoped(["cycle"], explicitTeam, explicitTeam === null, {
        path: "/cycles",
        team: explicitTeam,
      });
    case "milestones":
      return scoped(["milestone"], explicitTeam, explicitTeam === null, {
        path: "/milestones",
        team: explicitTeam,
      });
    case "agent_sessions":
      return scoped(["agent_session"], explicitTeam, explicitTeam === null, {
        path: "/agent-sessions",
        team: explicitTeam,
      });
    case "team_child": {
      const pathTeam = parsed.team?.toUpperCase() ?? null;
      if (explicitTeam && explicitTeam !== pathTeam) {
        throw new ValidationError(
          `team search path ${parsed.path} conflicts with --team ${explicitTeam}`,
          "omit --team or use the same team key as the path",
        );
      }
      if (parsed.child === "projects") {
        return scoped(["project"], pathTeam, false, { path: parsed.path, team: pathTeam });
      }
      if (parsed.child === "issues") {
        return scoped(["issue"], pathTeam, false, { path: parsed.path, team: pathTeam });
      }
      if (parsed.child === "cycles") {
        return scoped(["cycle"], pathTeam, false, { path: parsed.path, team: pathTeam });
      }
      break;
    }
  }

  throw new ValidationError(`query search is not supported for ${parsed.path}`, searchableHint);
}

function validateExplicitTeamScope(
  parsed: ReturnType<typeof parseWorkspacePath>,
  explicitTeam: string | null,
  isSearch: boolean,
): void {
  if (!explicitTeam) return;
  if (parsed.kind === "team" || parsed.kind === "team_child") {
    const pathTeam = parsed.team?.toUpperCase();
    if (pathTeam && explicitTeam !== pathTeam) {
      throw new ValidationError(
        `team path ${parsed.path} conflicts with team ${explicitTeam}`,
        "omit team or use the same team key as the /teams/<key> path",
      );
    }
    return;
  }
  if (isSearch) return;
  if (TEAM_FILTERABLE_COLLECTIONS.has(parsed.kind)) return;
  throw new ValidationError(
    `team cannot be applied to ${parsed.path}`,
    "omit team for workspace-wide or concrete paths where Linear does not support a team filter",
  );
}

async function assertTeamExists(team: string): Promise<void> {
  const upper = team.toUpperCase();
  const resolved = await getTeam(upper);
  if (!resolved) {
    throw new NotFoundError(
      `team not found: ${upper}`,
      "use /teams to discover available team keys, then retry with a valid team",
    );
  }
}

function normalizeSearchKinds(kinds: string[] | undefined): string[] | null {
  if (!kinds || kinds.length === 0) return null;
  const normalized: string[] = [];
  const aliases: Record<string, string> = {
    initiative: "initiative",
    initiatives: "initiative",
    document: "document",
    documents: "document",
    issue: "issue",
    issues: "issue",
    cycle: "cycle",
    cycles: "cycle",
    milestone: "milestone",
    milestones: "milestone",
    project: "project",
    projects: "project",
    "agent-session": "agent_session",
    "agent-sessions": "agent_session",
    agent_session: "agent_session",
    agent_sessions: "agent_session",
  };
  for (const kind of kinds) {
    const trimmed = kind.trim().toLowerCase();
    if (!trimmed) continue;
    const canonical = aliases[trimmed];
    if (!canonical) {
      throw new ValidationError(
        `unsupported search kind: ${kind}`,
        "use project, issue, initiative, document, cycle, milestone, or agent_session",
      );
    }
    normalized.push(canonical);
  }
  return [...new Set(normalized)].sort();
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArrayOrNull(value: unknown): value is string[] | null {
  return value === null || (Array.isArray(value) && value.every((v) => typeof v === "string"));
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every((v) => typeof v === "string"));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}
