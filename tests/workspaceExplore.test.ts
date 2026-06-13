import { beforeEach, describe, expect, it, vi } from "vitest";
import { exploreLinearWorkspace } from "../src/lib/workspaceExplore.ts";

const mocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  listDocuments: vi.fn(),
  listDocumentsPage: vi.fn(),
  getCycle: vi.fn(),
  listCycles: vi.fn(),
  listCyclesPage: vi.fn(),
  getMilestone: vi.fn(),
  listMilestones: vi.fn(),
  listMilestonesPage: vi.fn(),
  getProject: vi.fn(),
  listProjects: vi.fn(),
  listProjectsPage: vi.fn(),
  listProjectUpdates: vi.fn(),
  listProjectUpdatesPage: vi.fn(),
  getInitiative: vi.fn(),
  getInitiativeProjectsPage: vi.fn(),
  listInitiatives: vi.fn(),
  listInitiativesPage: vi.fn(),
  listInitiativeUpdates: vi.fn(),
  listInitiativeUpdatesPage: vi.fn(),
  getIssue: vi.fn(),
  listIssues: vi.fn(),
  listIssuesPage: vi.fn(),
  listLabelsPage: vi.fn(),
  listTeamMembersPage: vi.fn(),
  getTeam: vi.fn(),
  listWorkflowStates: vi.fn(),
  listComments: vi.fn(),
  listCommentsPage: vi.fn(),
  listRelations: vi.fn(),
  listRelationsPage: vi.fn(),
  listAttachments: vi.fn(),
  listAttachmentsPage: vi.fn(),
  getAgentSession: vi.fn(),
  listAgentSessionsPage: vi.fn(),
  resolveConfig: vi.fn(),
  linear: vi.fn(),
}));

vi.mock("../src/lib/documents.ts", () => ({
  getDocument: mocks.getDocument,
  listDocuments: mocks.listDocuments,
  listDocumentsPage: mocks.listDocumentsPage,
}));

vi.mock("../src/lib/cycles.ts", () => ({
  getCycle: mocks.getCycle,
  listCycles: mocks.listCycles,
  listCyclesPage: mocks.listCyclesPage,
}));

vi.mock("../src/lib/milestones.ts", () => ({
  getMilestone: mocks.getMilestone,
  listMilestones: mocks.listMilestones,
  listMilestonesPage: mocks.listMilestonesPage,
}));

vi.mock("../src/lib/projects.ts", () => ({
  getProject: mocks.getProject,
  listProjects: mocks.listProjects,
  listProjectsPage: mocks.listProjectsPage,
  listProjectUpdates: mocks.listProjectUpdates,
  listProjectUpdatesPage: mocks.listProjectUpdatesPage,
}));

vi.mock("../src/lib/initiatives.ts", () => ({
  getInitiative: mocks.getInitiative,
  getInitiativeProjectsPage: mocks.getInitiativeProjectsPage,
  listInitiatives: mocks.listInitiatives,
  listInitiativesPage: mocks.listInitiativesPage,
  listInitiativeUpdates: mocks.listInitiativeUpdates,
  listInitiativeUpdatesPage: mocks.listInitiativeUpdatesPage,
}));

vi.mock("../src/lib/listIssues.ts", () => ({
  listIssues: mocks.listIssues,
  listIssuesPage: mocks.listIssuesPage,
}));

vi.mock("../src/lib/labels.ts", () => ({
  listLabelsPage: mocks.listLabelsPage,
}));

vi.mock("../src/lib/teamMembers.ts", () => ({
  listTeamMembersPage: mocks.listTeamMembersPage,
}));

vi.mock("../src/lib/teams.ts", () => ({
  getTeam: mocks.getTeam,
}));

vi.mock("../src/lib/workflowStates.ts", () => ({
  listWorkflowStates: mocks.listWorkflowStates,
}));

vi.mock("../src/lib/issues.ts", () => ({
  getIssue: mocks.getIssue,
}));

vi.mock("../src/lib/comments.ts", () => ({
  listComments: mocks.listComments,
  listCommentsPage: mocks.listCommentsPage,
}));

vi.mock("../src/lib/relations.ts", () => ({
  listRelations: mocks.listRelations,
  listRelationsPage: mocks.listRelationsPage,
}));

vi.mock("../src/lib/attachments.ts", () => ({
  listAttachments: mocks.listAttachments,
  listAttachmentsPage: mocks.listAttachmentsPage,
}));

vi.mock("../src/lib/agentSessions.ts", () => ({
  getAgentSession: mocks.getAgentSession,
  listAgentSessionsPage: mocks.listAgentSessionsPage,
}));

vi.mock("../src/lib/config.ts", () => ({
  resolveConfig: mocks.resolveConfig,
}));

vi.mock("../src/lib/sdk.ts", () => ({
  linear: mocks.linear,
}));

function project(id: string) {
  return {
    id,
    name: `Project ${id}`,
    description: null,
    state: "started",
    url: `https://linear.app/test/project/${id}`,
    updated_at: "2026-06-04T00:00:00.000Z",
    archived_at: null,
  };
}

function initiative(id: string) {
  return {
    id,
    name: `Initiative ${id}`,
    description: null,
    status: "on_track",
    url: `https://linear.app/test/initiative/${id}`,
    archived_at: null,
  };
}

function issue(identifier: string) {
  return {
    identifier,
    title: `Issue ${identifier}`,
    state: "Todo",
    state_type: "unstarted",
    priority: 0,
    assignee: null,
    labels: [],
    updated_at: "2026-06-04T00:00:00.000Z",
    url: `https://linear.app/test/issue/${identifier}`,
  };
}

function agentSession(id: string) {
  return {
    id,
    status: "working",
    type: "assistant",
    created_at: "2026-06-04T00:00:00.000Z",
    updated_at: "2026-06-04T01:00:00.000Z",
    ended_at: null,
    issue: { id: "issue-1", identifier: "NOX-1", title: "Issue NOX-1" },
    creator: { id: "user-1", name: "Agent User", email: "agent@example.com" },
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getDocument.mockResolvedValue({
    id: "document-1",
    title: "Context document",
    slug_id: "context-document",
    icon: null,
    url: "https://linear.app/test/document/context-document",
    project: null,
    issue: null,
    creator: null,
    archived_at: null,
    content: "Document body",
  });
  mocks.getCycle.mockResolvedValue({
    id: "cycle-1",
    name: "Cycle 1",
    number: 1,
    starts_at: "2026-06-01",
    ends_at: "2026-06-15",
    completed_at: null,
    archived_at: null,
    team: { id: "team-1", key: "NOX", name: "Noxor" },
  });
  mocks.getMilestone.mockResolvedValue({
    id: "milestone-1",
    name: "Milestone 1",
    description: null,
    target_date: null,
    sort_order: 1,
    archived_at: null,
    project: { id: "project-1", name: "Project 1" },
  });
  mocks.getProject.mockResolvedValue({
    id: "project-1",
    name: "Project 1",
    description: "Project description",
    content: "Project content",
    icon: null,
    state: "started",
    url: "https://linear.app/test/project/project-1",
    updated_at: "2026-06-04T00:00:00.000Z",
    start_date: null,
    target_date: null,
    archived_at: null,
    teams: [{ id: "team-1", key: "NOX", name: "Noxor" }],
    lead: null,
  });
  mocks.getIssue.mockResolvedValue({
    id: "issue-uuid-1",
    identifier: "NOX-1",
    title: "Issue NOX-1",
    description: "Issue body",
    priority: 0,
    estimate: null,
    url: "https://linear.app/test/issue/NOX-1",
    updatedAt: "2026-06-04T00:00:00.000Z",
    state: { id: "state-1", name: "Todo", type: "unstarted" },
    assignee: null,
    project: null,
    team: { id: "team-1", key: "NOX" },
    parent: null,
    labels: { nodes: [] },
  });
  mocks.resolveConfig.mockResolvedValue({ team: "NOX" });
  mocks.listProjectsPage.mockResolvedValue({
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  mocks.listDocumentsPage.mockResolvedValue({
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  mocks.listCyclesPage.mockResolvedValue({
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  mocks.listMilestonesPage.mockResolvedValue({
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  mocks.listProjectUpdatesPage.mockResolvedValue({
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  mocks.listInitiativesPage.mockResolvedValue({
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  mocks.listInitiativeUpdatesPage.mockResolvedValue({
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  mocks.getInitiativeProjectsPage.mockResolvedValue(null);
  mocks.listIssuesPage.mockResolvedValue({
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  mocks.listLabelsPage.mockResolvedValue({
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  mocks.listTeamMembersPage.mockResolvedValue({
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  mocks.getTeam.mockResolvedValue({
    id: "team-1",
    key: "NOX",
    name: "Noxor",
    description: null,
    default_state_id: "state-1",
    default_state_name: "Todo",
  });
  mocks.listWorkflowStates.mockResolvedValue({
    team: "NOX",
    states: [],
  });
  mocks.listComments.mockResolvedValue([]);
  mocks.listCommentsPage.mockResolvedValue({
    comments: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  mocks.listRelations.mockResolvedValue({
    outbound: [],
    inbound: [],
    complete: true,
    pageInfo: {
      outbound: { hasNextPage: false, endCursor: null },
      inbound: { hasNextPage: false, endCursor: null },
    },
  });
  mocks.listRelationsPage.mockResolvedValue({
    outbound: [],
    inbound: [],
    complete: true,
    pageInfo: {
      outbound: { hasNextPage: false, endCursor: null },
      inbound: { hasNextPage: false, endCursor: null },
    },
  });
  mocks.listAttachments.mockResolvedValue([]);
  mocks.listAttachmentsPage.mockResolvedValue({
    attachments: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  mocks.getAgentSession.mockResolvedValue(agentSession("session-1"));
  mocks.listAgentSessionsPage.mockResolvedValue({
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
    searchedCount: 0,
  });
  mocks.linear.mockResolvedValue({
    teams: vi.fn().mockResolvedValue({
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    }),
  });
});

describe("exploreLinearWorkspace concrete paths", () => {
  it("loads document metadata for concrete document paths", async () => {
    const result = await exploreLinearWorkspace({ path: "/documents/document-1" });

    expect(mocks.getDocument).toHaveBeenCalledWith("document-1");
    expect(result.summary).toMatchObject({ kind: "document", title: "Context document" });
    expect(result.items).toEqual([
      expect.objectContaining({
        kind: "document",
        path: "/documents/document-1",
        title: "Context document",
        project: null,
        issue: null,
        creator: null,
      }),
    ]);
  });

  it("loads cycle metadata for concrete cycle paths", async () => {
    const result = await exploreLinearWorkspace({ path: "/cycles/cycle-1" });

    expect(mocks.getCycle).toHaveBeenCalledWith("cycle-1");
    expect(result.summary).toMatchObject({ kind: "cycle", name: "Cycle 1" });
    expect(result.items[0]).toMatchObject({
      kind: "cycle",
      path: "/cycles/cycle-1",
      team: { key: "NOX", name: "Noxor" },
    });
    expect(result.next_paths).toEqual(["/cycles/cycle-1/issues"]);
  });

  it("loads milestone metadata for concrete milestone paths", async () => {
    const result = await exploreLinearWorkspace({ path: "/milestones/milestone-1" });

    expect(mocks.getMilestone).toHaveBeenCalledWith("milestone-1");
    expect(result.summary).toMatchObject({ kind: "milestone", name: "Milestone 1" });
    expect(result.items[0]).toMatchObject({
      kind: "milestone",
      path: "/milestones/milestone-1",
      project: { id: "project-1", name: "Project 1" },
    });
    expect(result.next_paths).toEqual(["/milestones/milestone-1/issues"]);
  });

  it("loads project metadata as a concrete fetchable item", async () => {
    const result = await exploreLinearWorkspace({ path: "/projects/project-1" });

    expect(mocks.getProject).toHaveBeenCalledWith("project-1");
    expect(result.summary).toMatchObject({ kind: "project", name: "Project 1" });
    expect(result.items).toEqual([
      expect.objectContaining({
        kind: "project",
        fetchable: true,
        id: "project-1",
        path: "/projects/project-1",
      }),
    ]);
    expect(result.next_paths).toContain("/projects/project-1/issues");
  });

  it("loads issue metadata as a concrete fetchable item", async () => {
    const result = await exploreLinearWorkspace({ path: "/issues/NOX-1" });

    expect(mocks.getIssue).toHaveBeenCalledWith("NOX-1");
    expect(result.summary).toMatchObject({ kind: "issue", identifier: "NOX-1" });
    expect(result.items).toEqual([
      expect.objectContaining({
        kind: "issue",
        fetchable: true,
        identifier: "NOX-1",
        path: "/issues/NOX-1",
      }),
    ]);
    expect(result.next_paths).toContain("/issues/NOX-1/comments");
  });

  it("lists and loads agent-session workspace paths", async () => {
    mocks.listAgentSessionsPage.mockResolvedValueOnce({
      nodes: [agentSession("session-1")],
      pageInfo: { hasNextPage: true, endCursor: "session-cursor-1" },
    });

    const list = await exploreLinearWorkspace({ path: "/agent-sessions", limit: 1 });
    const one = await exploreLinearWorkspace({ path: "/agent-sessions/session-1" });

    expect(list.items).toEqual([
      expect.objectContaining({
        kind: "agent_session",
        path: "/agent-sessions/session-1",
        state: "working",
        created_at: "2026-06-04T00:00:00.000Z",
        issue: expect.objectContaining({ identifier: "NOX-1", title: "Issue NOX-1" }),
        creator: expect.objectContaining({ name: "Agent User", email: "agent@example.com" }),
      }),
    ]);
    expect(list.next_cursor).toEqual(expect.any(String));
    expect(list.cursor_identity).toMatchObject({
      path: "/agent-sessions",
      all_teams: true,
      cursor_keys: ["main"],
    });
    expect(one.summary).toMatchObject({ kind: "agent_session", id: "session-1" });
    expect(mocks.getAgentSession).toHaveBeenCalledWith("session-1");
  });

  it("lists issue-scoped agent sessions with cursor support", async () => {
    mocks.getIssue.mockResolvedValueOnce({ id: "issue-uuid-1", identifier: "NOX-1" });
    mocks.listAgentSessionsPage.mockResolvedValueOnce({
      nodes: [agentSession("session-1")],
      pageInfo: { hasNextPage: true, endCursor: "issue-session-cursor-1" },
    });

    const result = await exploreLinearWorkspace({
      path: "/issues/NOX-1/agent-sessions",
      limit: 1,
    });

    expect(result.items[0]).toMatchObject({
      kind: "agent_session",
      id: "session-1",
      issue: { identifier: "NOX-1" },
      creator: { email: "agent@example.com" },
    });
    expect(result.next_cursor).toEqual(expect.any(String));
    expect(mocks.listAgentSessionsPage).toHaveBeenCalledWith({
      issueId: "issue-uuid-1",
      limit: 1,
      after: undefined,
    });
  });

  it("lists issue-scoped documents with cursor support", async () => {
    mocks.getIssue.mockResolvedValueOnce({ id: "issue-uuid-1", identifier: "NOX-1" });
    mocks.listDocumentsPage.mockResolvedValueOnce({
      nodes: [
        {
          id: "issue-document-1",
          title: "Issue document",
          slug_id: "issue-document",
          icon: null,
          url: "https://linear.app/test/document/issue-document",
          project: null,
          issue: { id: "issue-uuid-1", identifier: "NOX-1", title: "Issue NOX-1" },
          creator: null,
          archived_at: null,
        },
      ],
      pageInfo: { hasNextPage: true, endCursor: "issue-doc-cursor-1" },
    });

    const result = await exploreLinearWorkspace({
      path: "/issues/NOX-1/documents",
      limit: 1,
    });

    expect(result.items[0]).toMatchObject({
      kind: "document",
      id: "issue-document-1",
      path: "/documents/issue-document-1",
      issue: { identifier: "NOX-1", title: "Issue NOX-1" },
    });
    expect(result.summary).toMatchObject({ kind: "issue_documents", identifier: "NOX-1" });
    expect(result.next_cursor).toEqual(expect.any(String));
    expect(mocks.listDocumentsPage).toHaveBeenCalledWith({
      issueId: "issue-uuid-1",
      limit: 1,
      after: undefined,
    });
  });
});

describe("exploreLinearWorkspace pagination", () => {
  it("returns an opaque continuation cursor for paginated project lists", async () => {
    mocks.listProjectsPage.mockResolvedValueOnce({
      nodes: [
        {
          id: "project-1",
          name: "Project 1",
          description: "Desc",
          state: "started",
          url: "https://linear.app/test/project/project-1",
          updated_at: "2026-06-04T00:00:00.000Z",
          archived_at: null,
        },
      ],
      pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
    });

    const result = await exploreLinearWorkspace({ path: "/projects", limit: 1 });

    expect(result.has_more).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.next_cursor).toEqual(expect.any(String));
    expect(result.page.next_cursor).toBe(result.next_cursor);
  });

  it("passes a matching continuation cursor as Linear after", async () => {
    mocks.listProjectsPage
      .mockResolvedValueOnce({
        nodes: [
          {
            id: "project-1",
            name: "Project 1",
            description: "Desc",
            state: "started",
            url: "https://linear.app/test/project/project-1",
            updated_at: "2026-06-04T00:00:00.000Z",
            archived_at: null,
          },
        ],
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
      })
      .mockResolvedValueOnce({
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      });

    const first = await exploreLinearWorkspace({ path: "/projects", limit: 1 });
    await exploreLinearWorkspace({ path: "/projects", limit: 1, cursor: first.next_cursor ?? "" });

    expect(mocks.listProjectsPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: "cursor-1" }),
    );
  });

  it("paginates team issue child paths and preserves includeArchived in the cursor identity", async () => {
    mocks.listIssuesPage
      .mockResolvedValueOnce({
        nodes: [issue("NOX-1")],
        pageInfo: { hasNextPage: true, endCursor: "team-issues-cursor-1" },
      })
      .mockResolvedValueOnce({
        nodes: [issue("NOX-2")],
        pageInfo: { hasNextPage: false, endCursor: null },
      });

    const first = await exploreLinearWorkspace({
      path: "/teams/NOX/issues",
      includeArchived: true,
      limit: 1,
    });
    const second = await exploreLinearWorkspace({
      path: "/teams/NOX/issues",
      includeArchived: true,
      limit: 1,
      cursor: first.next_cursor ?? "",
    });

    expect(first.next_cursor).toEqual(expect.any(String));
    expect(second.items[0]).toMatchObject({ identifier: "NOX-2" });
    expect(mocks.listIssuesPage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        resolvedTeam: "NOX",
        team: "NOX",
        includeArchived: true,
        after: undefined,
      }),
    );
    expect(mocks.getTeam).toHaveBeenCalledWith("NOX");
    expect(mocks.listIssuesPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        includeArchived: true,
        after: "team-issues-cursor-1",
      }),
    );
  });

  it("rejects list pages that advertise more data without returning records", async () => {
    mocks.listProjectsPage.mockResolvedValueOnce({
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: "project-empty-cursor" },
    });

    await expect(exploreLinearWorkspace({ path: "/projects", limit: 1 })).rejects.toThrow(
      /made no progress/,
    );
  });

  it("rejects unknown team child paths before listing children", async () => {
    mocks.getTeam.mockResolvedValueOnce(null);

    await expect(exploreLinearWorkspace({ path: "/teams/ghost/issues" })).rejects.toThrow(
      /team not found: GHOST/,
    );
    expect(mocks.listIssuesPage).not.toHaveBeenCalled();
  });

  it("rejects explicit team filters on team-irrelevant project child paths", async () => {
    await expect(
      exploreLinearWorkspace({ path: "/projects/project-1/documents", team: "NOX" }),
    ).rejects.toThrow(/team cannot be applied to \/projects\/project-1\/documents/);
    expect(mocks.listDocumentsPage).not.toHaveBeenCalled();
  });

  it("paginates project issue child paths", async () => {
    mocks.listIssuesPage.mockResolvedValueOnce({
      nodes: [issue("NOX-1")],
      pageInfo: { hasNextPage: true, endCursor: "project-issues-cursor-1" },
    });

    const result = await exploreLinearWorkspace({ path: "/projects/project-1/issues", limit: 1 });

    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toEqual(expect.any(String));
    expect(mocks.listIssuesPage).toHaveBeenCalledWith(
      expect.objectContaining({
        allTeams: true,
        projectId: "project-1",
        limit: 1,
      }),
    );
    expect(mocks.listIssues).not.toHaveBeenCalled();
  });

  it("rejects repeated cursors on child collection continuations", async () => {
    mocks.listIssuesPage
      .mockResolvedValueOnce({
        nodes: [issue("NOX-1")],
        pageInfo: { hasNextPage: true, endCursor: "project-issues-cursor-1" },
      })
      .mockResolvedValueOnce({
        nodes: [issue("NOX-2")],
        pageInfo: { hasNextPage: true, endCursor: "project-issues-cursor-1" },
      });

    const first = await exploreLinearWorkspace({ path: "/projects/project-1/issues", limit: 1 });

    await expect(
      exploreLinearWorkspace({
        path: "/projects/project-1/issues",
        limit: 1,
        cursor: first.next_cursor ?? "",
      }),
    ).rejects.toThrow(/cursor did not advance/);
    expect(mocks.listIssuesPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: "project-issues-cursor-1" }),
    );
  });

  it("paginates team label child paths", async () => {
    mocks.listLabelsPage.mockResolvedValueOnce({
      nodes: [
        {
          id: "label-1",
          name: "Backend",
          color: "#00ff00",
          description: "Backend work",
          team: { id: "team-1", key: "NOX", name: "Noxor" },
        },
      ],
      pageInfo: { hasNextPage: true, endCursor: "label-cursor-1" },
    });

    const result = await exploreLinearWorkspace({ path: "/teams/NOX/labels", limit: 1 });

    expect(result.items[0]).toMatchObject({ kind: "label", id: "label-1", name: "Backend" });
    expect(result.next_cursor).toEqual(expect.any(String));
    expect(mocks.listLabelsPage).toHaveBeenCalledWith({
      team: "NOX",
      limit: 1,
      after: undefined,
    });
  });

  it("paginates team member child paths", async () => {
    mocks.listTeamMembersPage.mockResolvedValueOnce({
      nodes: [
        {
          id: "user-1",
          name: "Agent User",
          email: "agent@example.com",
          display_name: null,
          is_owner: false,
          active: true,
          team: { id: "team-1", key: "NOX", name: "Noxor" },
        },
      ],
      pageInfo: { hasNextPage: true, endCursor: "member-cursor-1" },
    });

    const result = await exploreLinearWorkspace({ path: "/teams/NOX/members", limit: 1 });

    expect(result.items[0]).toMatchObject({ kind: "member", id: "user-1", name: "Agent User" });
    expect(result.next_cursor).toEqual(expect.any(String));
    expect(mocks.listTeamMembersPage).toHaveBeenCalledWith({
      teamKey: "NOX",
      limit: 1,
      after: undefined,
    });
  });

  it("paginates cycle issue child paths with the cycle team", async () => {
    mocks.listIssuesPage
      .mockResolvedValueOnce({
        nodes: [issue("NOX-1")],
        pageInfo: { hasNextPage: true, endCursor: "cycle-issues-cursor-1" },
      })
      .mockResolvedValueOnce({
        nodes: [issue("NOX-2")],
        pageInfo: { hasNextPage: false, endCursor: null },
      });

    const first = await exploreLinearWorkspace({
      path: "/cycles/cycle-1/issues",
      includeArchived: true,
      limit: 1,
    });
    const second = await exploreLinearWorkspace({
      path: "/cycles/cycle-1/issues",
      includeArchived: true,
      limit: 1,
      cursor: first.next_cursor ?? "",
    });

    expect(first.has_more).toBe(true);
    expect(second.items[0]).toMatchObject({ identifier: "NOX-2" });
    expect(mocks.getCycle).toHaveBeenCalledWith("cycle-1");
    expect(mocks.listIssuesPage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        resolvedTeam: "NOX",
        team: "NOX",
        cycle: "cycle-1",
        includeArchived: true,
        after: undefined,
      }),
    );
    expect(mocks.listIssuesPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cycle: "cycle-1",
        after: "cycle-issues-cursor-1",
      }),
    );
  });

  it("paginates milestone issue child paths across teams", async () => {
    mocks.listIssuesPage.mockResolvedValueOnce({
      nodes: [issue("NOX-1")],
      pageInfo: { hasNextPage: true, endCursor: "milestone-issues-cursor-1" },
    });

    const result = await exploreLinearWorkspace({
      path: "/milestones/milestone-1/issues",
      limit: 1,
    });

    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toEqual(expect.any(String));
    expect(mocks.getMilestone).toHaveBeenCalledWith("milestone-1");
    expect(mocks.listIssuesPage).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedTeam: undefined,
        allTeams: true,
        milestone: "milestone-1",
        limit: 1,
      }),
    );
  });

  it("passes includeArchived through top-level issues explore", async () => {
    await exploreLinearWorkspace({ path: "/issues", includeArchived: true, limit: 5 });

    expect(mocks.listIssuesPage).toHaveBeenCalledWith(
      expect.objectContaining({ includeArchived: true }),
    );
  });

  it("rejects cursor reuse for a different path", async () => {
    mocks.listProjectsPage.mockResolvedValueOnce({
      nodes: [project("project-1")],
      pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
    });
    const first = await exploreLinearWorkspace({ path: "/projects", limit: 1 });

    await expect(
      exploreLinearWorkspace({ path: "/initiatives", limit: 1, cursor: first.next_cursor ?? "" }),
    ).rejects.toThrow(/cursor does not match/);
  });
});

describe("exploreLinearWorkspace search", () => {
  it("uses limit per selected kind so fetched rows are not skipped by aggregate slicing", async () => {
    mocks.listProjectsPage.mockResolvedValueOnce({
      nodes: [project("project-1")],
      pageInfo: { hasNextPage: true, endCursor: "project-cursor-1" },
    });
    mocks.listInitiativesPage.mockResolvedValueOnce({
      nodes: [initiative("initiative-1")],
      pageInfo: { hasNextPage: true, endCursor: "initiative-cursor-1" },
    });
    mocks.listIssuesPage.mockResolvedValueOnce({
      nodes: [issue("NOX-1")],
      pageInfo: { hasNextPage: true, endCursor: "issue-cursor-1" },
    });

    const result = await exploreLinearWorkspace({
      query: "alpha",
      kinds: ["project", "initiative", "issue"],
      limit: 1,
    });

    expect(result.items.map((item) => item.kind)).toEqual(["project", "initiative", "issue"]);
    expect(result.count).toBe(3);
    expect(result.summary).toMatchObject({
      kind: "search",
      limit_semantics: "per_kind",
      kinds: ["initiative", "issue", "project"],
    });
    expect(result.next_cursor).toEqual(expect.any(String));
    expect(mocks.listProjectsPage).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
    expect(mocks.listInitiativesPage).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
    expect(mocks.listIssuesPage).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
  });

  it("searches issues across all visible teams unless a team is supplied", async () => {
    mocks.listIssuesPage.mockResolvedValueOnce({
      nodes: [issue("NOX-1")],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    const result = await exploreLinearWorkspace({ query: "alpha", kinds: ["issue"], limit: 5 });

    expect(result.summary).toMatchObject({
      scope: { path: "/", team: null, all_teams: true },
      search: { issue: { scope: "all_teams", team: null } },
    });
    expect(result.cursor_identity).toMatchObject({
      path: "/",
      query: "alpha",
      team: null,
      all_teams: true,
      kinds: ["issue"],
    });
    expect(mocks.resolveConfig).not.toHaveBeenCalled();
    expect(mocks.listIssuesPage).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedTeam: undefined,
        team: undefined,
        allTeams: true,
        search: "alpha",
      }),
    );
  });

  it("does not re-query completed search kinds when resuming a multi-kind cursor", async () => {
    mocks.listProjectsPage.mockResolvedValueOnce({
      nodes: [project("project-1")],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    mocks.listIssuesPage
      .mockResolvedValueOnce({
        nodes: [issue("NOX-1")],
        pageInfo: { hasNextPage: true, endCursor: "issue-cursor-1" },
      })
      .mockResolvedValueOnce({
        nodes: [issue("NOX-2")],
        pageInfo: { hasNextPage: false, endCursor: null },
      });

    const first = await exploreLinearWorkspace({
      query: "alpha",
      kinds: ["project", "issue"],
      limit: 1,
    });
    const second = await exploreLinearWorkspace({
      query: "alpha",
      kinds: ["project", "issue"],
      limit: 1,
      cursor: first.next_cursor ?? "",
    });

    expect(mocks.listProjectsPage).toHaveBeenCalledOnce();
    expect(mocks.listIssuesPage).toHaveBeenCalledTimes(2);
    expect(mocks.listIssuesPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: "issue-cursor-1" }),
    );
    expect(second.items).toEqual([expect.objectContaining({ kind: "issue", identifier: "NOX-2" })]);
    expect(second.summary).toMatchObject({
      search: {
        project: { mode: "cursor_complete", complete: true, searched_count: 0 },
      },
    });
  });

  it("accepts common plural search kinds and canonicalizes them for cursor identity", async () => {
    mocks.listProjectsPage.mockResolvedValueOnce({
      nodes: [project("project-1")],
      pageInfo: { hasNextPage: true, endCursor: "project-cursor-1" },
    });

    const result = await exploreLinearWorkspace({
      query: "alpha",
      kinds: ["projects", "project"],
      limit: 1,
    });

    expect(result.summary).toMatchObject({ kinds: ["project"] });
    expect(mocks.listProjectsPage).toHaveBeenCalledOnce();
    expect(mocks.listInitiativesPage).not.toHaveBeenCalled();
    expect(mocks.listIssuesPage).not.toHaveBeenCalled();
  });

  it("narrows query search to the supplied collection path", async () => {
    mocks.listProjectsPage.mockResolvedValueOnce({
      nodes: [project("project-1")],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    const result = await exploreLinearWorkspace({ path: "/projects", query: "alpha", limit: 5 });

    expect(result.summary).toMatchObject({
      kinds: ["project"],
      scope: { path: "/projects" },
    });
    expect(result.items).toHaveLength(1);
    expect(mocks.listProjectsPage).toHaveBeenCalledWith(
      expect.objectContaining({ search: "alpha", limit: 5 }),
    );
    expect(mocks.listInitiativesPage).not.toHaveBeenCalled();
    expect(mocks.listIssuesPage).not.toHaveBeenCalled();
  });

  it("uses the team from team child search paths", async () => {
    mocks.listIssuesPage.mockResolvedValueOnce({
      nodes: [issue("NOX-1")],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    const result = await exploreLinearWorkspace({
      path: "/teams/nox/issues",
      query: "alpha",
      limit: 5,
    });

    expect(result.team).toBe("NOX");
    expect(result.summary).toMatchObject({
      kinds: ["issue"],
      scope: { path: "/teams/nox/issues", team: "NOX" },
    });
    expect(mocks.listIssuesPage).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedTeam: "NOX", team: "NOX", search: "alpha" }),
    );
    expect(mocks.getTeam).toHaveBeenCalledWith("NOX");
  });

  it("searches team cycle child paths", async () => {
    mocks.listCyclesPage.mockResolvedValueOnce({
      nodes: [
        {
          id: "cycle-1",
          name: "Alpha Cycle",
          number: 1,
          starts_at: "2026-06-01",
          ends_at: "2026-06-15",
          completed_at: null,
          archived_at: null,
          team: { id: "team-1", key: "NOX", name: "Noxor" },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    const result = await exploreLinearWorkspace({
      path: "/teams/nox/cycles",
      query: "alpha",
      limit: 5,
    });

    expect(result.team).toBe("NOX");
    expect(result.summary).toMatchObject({
      kinds: ["cycle"],
      scope: { path: "/teams/nox/cycles", team: "NOX" },
    });
    expect(result.items).toEqual([expect.objectContaining({ kind: "cycle", name: "Alpha Cycle" })]);
    expect(mocks.listCyclesPage).toHaveBeenCalledWith(
      expect.objectContaining({ team: "NOX", search: "alpha", limit: 5 }),
    );
    expect(mocks.getTeam).toHaveBeenCalledWith("NOX");
  });

  it("rejects unknown team-scoped search paths before searching", async () => {
    mocks.getTeam.mockResolvedValueOnce(null);

    await expect(
      exploreLinearWorkspace({
        path: "/teams/ghost/issues",
        query: "alpha",
      }),
    ).rejects.toThrow(/team not found: GHOST/);
    expect(mocks.listIssuesPage).not.toHaveBeenCalled();
  });

  it("searches document collection paths directly", async () => {
    mocks.listDocumentsPage.mockResolvedValueOnce({
      nodes: [
        {
          id: "document-1",
          title: "Alpha document",
          slug_id: "alpha-document",
          icon: null,
          url: "https://linear.app/test/document/alpha-document",
          project: null,
          creator: null,
          archived_at: null,
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    const result = await exploreLinearWorkspace({ path: "/documents", query: "alpha", limit: 5 });

    expect(result.summary).toMatchObject({
      kinds: ["document"],
      scope: { path: "/documents", team: null },
    });
    expect(result.items).toEqual([
      expect.objectContaining({ kind: "document", title: "Alpha document" }),
    ]);
    expect(mocks.listDocumentsPage).toHaveBeenCalledWith(
      expect.objectContaining({ search: "alpha", limit: 5 }),
    );
    expect(mocks.listProjectsPage).not.toHaveBeenCalled();
    expect(mocks.listInitiativesPage).not.toHaveBeenCalled();
    expect(mocks.listIssuesPage).not.toHaveBeenCalled();
  });

  it("rejects explicit team filters for workspace-wide collection explore and search", async () => {
    await expect(exploreLinearWorkspace({ path: "/documents", team: "NOX" })).rejects.toThrow(
      /team cannot be applied to \/documents/,
    );
    await expect(
      exploreLinearWorkspace({ path: "/documents", query: "alpha", team: "NOX" }),
    ).rejects.toThrow(/team cannot be applied to document search/);
    await expect(exploreLinearWorkspace({ query: "alpha", team: "NOX" })).rejects.toThrow(
      /team cannot be applied to .* search for \//,
    );

    expect(mocks.listDocumentsPage).not.toHaveBeenCalled();
    expect(mocks.listIssuesPage).not.toHaveBeenCalled();
  });

  it("allows explicit team search when all requested kinds support team filtering", async () => {
    mocks.listIssuesPage.mockResolvedValueOnce({
      nodes: [issue("NOX-1")],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    mocks.listCyclesPage.mockResolvedValueOnce({
      nodes: [
        {
          id: "cycle-1",
          name: "Cycle 1",
          number: 1,
          archived_at: null,
          team: { key: "NOX" },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    const result = await exploreLinearWorkspace({
      query: "alpha",
      team: "NOX",
      kinds: ["issue", "cycle"],
    });

    expect(result.cursor_identity).toMatchObject({
      path: "/",
      query: "alpha",
      team: "NOX",
      all_teams: false,
      kinds: ["cycle", "issue"],
    });
    expect(mocks.getTeam).toHaveBeenCalledWith("NOX");
    expect(mocks.listIssuesPage).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedTeam: "NOX", team: "NOX", allTeams: false }),
    );
    expect(mocks.listCyclesPage).toHaveBeenCalledWith(
      expect.objectContaining({ team: "NOX", search: "alpha" }),
    );
  });

  it("rejects kinds that conflict with the searched path", async () => {
    await expect(
      exploreLinearWorkspace({ path: "/projects", query: "alpha", kinds: ["issues"] }),
    ).rejects.toThrow(/is not supported for \/projects/);
    expect(mocks.listProjectsPage).not.toHaveBeenCalled();
    expect(mocks.listIssuesPage).not.toHaveBeenCalled();
  });

  it("rejects unsupported search kinds in the library", async () => {
    await expect(exploreLinearWorkspace({ query: "alpha", kinds: ["users"] })).rejects.toThrow(
      /unsupported search kind/,
    );
  });

  it("rejects search cursor reuse for a different query", async () => {
    mocks.listProjectsPage.mockResolvedValueOnce({
      nodes: [project("project-1")],
      pageInfo: { hasNextPage: true, endCursor: "project-cursor-1" },
    });
    const first = await exploreLinearWorkspace({ query: "alpha", kinds: ["project"], limit: 1 });

    await expect(
      exploreLinearWorkspace({
        query: "beta",
        kinds: ["project"],
        limit: 1,
        cursor: first.next_cursor ?? "",
      }),
    ).rejects.toThrow(/cursor does not match/);
  });

  it("rejects search cursor reuse for a different team", async () => {
    mocks.listProjectsPage.mockResolvedValueOnce({
      nodes: [project("project-1")],
      pageInfo: { hasNextPage: true, endCursor: "project-cursor-1" },
    });
    const first = await exploreLinearWorkspace({
      query: "alpha",
      team: "NOX",
      kinds: ["project"],
      limit: 1,
    });

    await expect(
      exploreLinearWorkspace({
        query: "alpha",
        team: "ENG",
        kinds: ["project"],
        limit: 1,
        cursor: first.next_cursor ?? "",
      }),
    ).rejects.toThrow(/cursor does not match/);
  });

  it("rejects search cursor reuse for different kinds", async () => {
    mocks.listProjectsPage.mockResolvedValueOnce({
      nodes: [project("project-1")],
      pageInfo: { hasNextPage: true, endCursor: "project-cursor-1" },
    });
    const first = await exploreLinearWorkspace({ query: "alpha", kinds: ["projects"], limit: 1 });

    await expect(
      exploreLinearWorkspace({
        query: "alpha",
        kinds: ["issues"],
        limit: 1,
        cursor: first.next_cursor ?? "",
      }),
    ).rejects.toThrow(/cursor does not match/);
  });

  it("rejects search cursor reuse for a different includeArchived setting", async () => {
    mocks.listProjectsPage.mockResolvedValueOnce({
      nodes: [project("project-1")],
      pageInfo: { hasNextPage: true, endCursor: "project-cursor-1" },
    });
    const first = await exploreLinearWorkspace({
      query: "alpha",
      kinds: ["project"],
      includeArchived: true,
      limit: 1,
    });

    await expect(
      exploreLinearWorkspace({
        query: "alpha",
        kinds: ["project"],
        includeArchived: false,
        limit: 1,
        cursor: first.next_cursor ?? "",
      }),
    ).rejects.toThrow(/cursor does not match/);
  });

  it("rejects search pages that report more data without a cursor", async () => {
    mocks.listProjectsPage.mockResolvedValueOnce({
      nodes: [project("project-1")],
      pageInfo: { hasNextPage: true, endCursor: null },
    });

    await expect(
      exploreLinearWorkspace({ query: "alpha", kinds: ["project"], limit: 1 }),
    ).rejects.toThrow(/cannot continue/);
  });

  it("rejects search pages whose cursor does not advance", async () => {
    mocks.listProjectsPage
      .mockResolvedValueOnce({
        nodes: [project("project-1")],
        pageInfo: { hasNextPage: true, endCursor: "project-cursor-1" },
      })
      .mockResolvedValueOnce({
        nodes: [project("project-2")],
        pageInfo: { hasNextPage: true, endCursor: "project-cursor-1" },
      });

    const first = await exploreLinearWorkspace({ query: "alpha", kinds: ["project"], limit: 1 });

    await expect(
      exploreLinearWorkspace({
        query: "alpha",
        kinds: ["project"],
        limit: 1,
        cursor: first.next_cursor ?? "",
      }),
    ).rejects.toThrow(/cursor did not advance/);
  });
});

describe("exploreLinearWorkspace child bounded metadata", () => {
  it("returns cursor-backed root collection caps", async () => {
    const teams = vi
      .fn()
      .mockResolvedValueOnce({
        nodes: [{ id: "team-1", key: "NOX", name: "Noxor", description: null }],
        pageInfo: { hasNextPage: true, endCursor: "team-cursor-1" },
      })
      .mockResolvedValueOnce({
        nodes: [{ id: "team-2", key: "ENG", name: "Engineering", description: null }],
        pageInfo: { hasNextPage: false, endCursor: null },
      });
    mocks.linear.mockResolvedValue({ teams });
    mocks.listDocumentsPage.mockResolvedValueOnce({
      nodes: [
        {
          id: "document-1",
          title: "Document 1",
          url: "https://linear.app/test/document/document-1",
          archived_at: null,
        },
      ],
      pageInfo: { hasNextPage: true, endCursor: "document-cursor-1" },
    });
    mocks.listCyclesPage.mockResolvedValueOnce({
      nodes: [
        {
          id: "cycle-1",
          name: "Cycle 1",
          number: 1,
          archived_at: null,
          team: { key: "NOX" },
        },
      ],
      pageInfo: { hasNextPage: true, endCursor: "cycle-cursor-1" },
    });
    mocks.listMilestonesPage.mockResolvedValueOnce({
      nodes: [
        {
          id: "milestone-1",
          name: "Milestone 1",
          archived_at: null,
        },
      ],
      pageInfo: { hasNextPage: true, endCursor: "milestone-cursor-1" },
    });

    const firstTeams = await exploreLinearWorkspace({ path: "/teams", limit: 1 });
    const secondTeams = await exploreLinearWorkspace({
      path: "/teams",
      limit: 1,
      cursor: firstTeams.next_cursor ?? "",
    });
    const documents = await exploreLinearWorkspace({ path: "/documents", limit: 1 });
    const cycles = await exploreLinearWorkspace({ path: "/cycles", limit: 1 });
    const milestones = await exploreLinearWorkspace({ path: "/milestones", limit: 1 });

    expect(firstTeams.has_more).toBe(true);
    expect(firstTeams.next_cursor).toEqual(expect.any(String));
    expect(firstTeams.truncated).toBe(true);
    expect(firstTeams.page.bounded).toBeUndefined();
    expect(firstTeams.summary).toMatchObject({ fetchable: false });
    expect(firstTeams.summary).not.toHaveProperty("bounded");
    expect(secondTeams.items[0]).toMatchObject({ kind: "team", key: "ENG" });
    expect(teams).toHaveBeenNthCalledWith(1, { first: 1 });
    expect(teams).toHaveBeenNthCalledWith(2, { first: 1, after: "team-cursor-1" });

    for (const result of [documents, cycles, milestones]) {
      expect(result.has_more).toBe(true);
      expect(result.next_cursor).toEqual(expect.any(String));
      expect(result.truncated).toBe(true);
      expect(result.page.bounded).toBeUndefined();
    }
    expect(firstTeams.items[0]).toMatchObject({ kind: "team", fetchable: false });
    expect(documents.items[0]).toMatchObject({ kind: "document", fetchable: true });
  });

  it("does not report exact-limit workflow states as truncated", async () => {
    mocks.listWorkflowStates.mockResolvedValueOnce({
      team: "NOX",
      states: [
        { id: "state-1", name: "Todo", type: "unstarted", color: null, default: true },
        { id: "state-2", name: "Done", type: "completed", color: null, default: false },
      ],
    });

    const result = await exploreLinearWorkspace({ path: "/teams/NOX/states", limit: 2 });

    expect(result.items).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.page.bounded).toEqual({
      returned: 2,
      limit: 2,
      may_have_more: false,
      continuation: "not_available",
      total_available: 2,
    });
    expect(result.summary).toMatchObject({
      bounded: {
        returned: 2,
        total_available: 2,
        may_have_more: false,
      },
    });
  });

  it("reports workflow states as bounded when the full list exceeds the limit", async () => {
    mocks.listWorkflowStates.mockResolvedValueOnce({
      team: "NOX",
      states: [
        { id: "state-1", name: "Todo", type: "unstarted", color: null, default: true },
        { id: "state-2", name: "In Progress", type: "started", color: null, default: false },
        { id: "state-3", name: "Done", type: "completed", color: null, default: false },
      ],
    });

    const result = await exploreLinearWorkspace({ path: "/teams/NOX/states", limit: 2 });

    expect(result.items.map((item) => item.id)).toEqual(["state-1", "state-2"]);
    expect(result.truncated).toBe(true);
    expect(result.page.bounded).toMatchObject({
      returned: 2,
      limit: 2,
      may_have_more: true,
      total_available: 3,
    });
  });

  it("returns cursor-backed initiative project pages for concrete initiative paths", async () => {
    mocks.getInitiativeProjectsPage.mockResolvedValueOnce({
      initiative: initiative("initiative-1"),
      projects: {
        nodes: [{ id: "project-1", name: "Project 1", state: "started" }],
        pageInfo: { hasNextPage: true, endCursor: "initiative-project-cursor-1" },
      },
    });

    const result = await exploreLinearWorkspace({ path: "/initiatives/initiative-1", limit: 1 });

    expect(result.items).toHaveLength(1);
    expect(result.next_cursor).toEqual(expect.any(String));
    expect(result.page.bounded).toBeUndefined();
    expect(result.summary).toMatchObject({
      project_count: 1,
      projects: [{ id: "project-1", name: "Project 1", state: "started" }],
    });
  });

  it("returns cursor-backed project document pages", async () => {
    mocks.listDocumentsPage
      .mockResolvedValueOnce({
        nodes: [
          {
            id: "document-1",
            title: "Document 1",
            url: "https://linear.app/test/document/document-1",
            archived_at: null,
          },
        ],
        pageInfo: { hasNextPage: true, endCursor: "project-document-cursor-1" },
      })
      .mockResolvedValueOnce({
        nodes: [
          {
            id: "document-2",
            title: "Document 2",
            url: "https://linear.app/test/document/document-2",
            archived_at: null,
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      });

    const first = await exploreLinearWorkspace({
      path: "/projects/project-1/documents",
      limit: 1,
    });
    const second = await exploreLinearWorkspace({
      path: "/projects/project-1/documents",
      limit: 1,
      cursor: first.next_cursor ?? "",
    });

    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(first.truncated).toBe(true);
    expect(first.page.bounded).toBeUndefined();
    expect(first.cursor_identity).toMatchObject({ team: null });
    expect(first.summary).toMatchObject({
      kind: "project_documents",
      project_id: "project-1",
    });
    expect(second.items[0]).toMatchObject({ id: "document-2" });
    expect(mocks.listDocumentsPage).toHaveBeenLastCalledWith({
      projectId: "project-1",
      limit: 1,
      after: "project-document-cursor-1",
    });
  });

  it("returns cursor-backed project update pages", async () => {
    mocks.listProjectUpdatesPage
      .mockResolvedValueOnce({
        nodes: [
          {
            id: "project-update-1",
            body: "First update",
            health: "onTrack",
            created_at: "2026-06-04T00:00:00.000Z",
            user: null,
          },
        ],
        pageInfo: { hasNextPage: true, endCursor: "project-update-cursor-1" },
      })
      .mockResolvedValueOnce({
        nodes: [
          {
            id: "project-update-2",
            body: "Second update",
            health: "atRisk",
            created_at: "2026-06-05T00:00:00.000Z",
            user: null,
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      });

    const first = await exploreLinearWorkspace({ path: "/projects/project-1/updates", limit: 1 });
    const second = await exploreLinearWorkspace({
      path: "/projects/project-1/updates",
      limit: 1,
      cursor: first.next_cursor ?? "",
    });

    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(second.has_more).toBe(false);
    expect(second.items[0]).toMatchObject({
      kind: "project_update",
      id: "project-update-2",
      description: "Second update",
    });
    expect(mocks.listProjectUpdatesPage).toHaveBeenLastCalledWith("project-1", {
      limit: 1,
      after: "project-update-cursor-1",
    });
  });

  it("returns cursor-backed issue relation continuations", async () => {
    mocks.listRelationsPage
      .mockResolvedValueOnce({
        outbound: [{ id: "relation-1", type: "blocks", otherIdentifier: "NOX-2" }],
        inbound: [],
        complete: false,
        pageInfo: {
          outbound: { hasNextPage: true, endCursor: "relation-cursor-1" },
          inbound: { hasNextPage: false, endCursor: null },
        },
      })
      .mockResolvedValueOnce({
        outbound: [{ id: "relation-2", type: "related", otherIdentifier: "NOX-3" }],
        inbound: [],
        complete: true,
        pageInfo: {
          outbound: { hasNextPage: false, endCursor: null },
          inbound: { hasNextPage: false, endCursor: null },
        },
      });

    const first = await exploreLinearWorkspace({ path: "/issues/NOX-1/relations", limit: 10 });

    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(first.truncated).toBe(true);
    expect(first.summary).toMatchObject({
      complete: false,
      pageInfo: { outbound: { hasNextPage: true, endCursor: "relation-cursor-1" } },
    });

    const second = await exploreLinearWorkspace({
      path: "/issues/NOX-1/relations",
      limit: 10,
      cursor: first.next_cursor ?? "",
    });

    expect(second.has_more).toBe(false);
    expect(mocks.listRelationsPage).toHaveBeenLastCalledWith("NOX-1", {
      first: 10,
      outboundAfter: "relation-cursor-1",
      inboundAfter: undefined,
    });
  });

  it("rejects issue relation pages that report more data without a cursor", async () => {
    mocks.listRelationsPage.mockResolvedValueOnce({
      outbound: [{ id: "relation-1", type: "blocks", otherIdentifier: "NOX-2" }],
      inbound: [],
      complete: false,
      pageInfo: {
        outbound: { hasNextPage: true, endCursor: null },
        inbound: { hasNextPage: false, endCursor: null },
      },
    });

    await expect(
      exploreLinearWorkspace({ path: "/issues/NOX-1/relations", limit: 10 }),
    ).rejects.toThrow("cannot continue outbound page");
  });

  it("returns cursor-backed issue comment and attachment continuations", async () => {
    mocks.listCommentsPage
      .mockResolvedValueOnce({
        comments: [{ id: "comment-1", body: "Comment", updated_at: "now" }],
        pageInfo: { hasNextPage: true, endCursor: "comment-cursor-1" },
      })
      .mockResolvedValueOnce({
        comments: [{ id: "comment-2", body: "Next", updated_at: "later" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      });
    mocks.listAttachmentsPage
      .mockResolvedValueOnce({
        attachments: [{ id: "attachment-1", title: "Spec", url: "https://example.test/spec" }],
        pageInfo: { hasNextPage: true, endCursor: "attachment-cursor-1" },
      })
      .mockResolvedValueOnce({
        attachments: [{ id: "attachment-2", title: "Design", url: "https://example.test/design" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      });

    const comments = await exploreLinearWorkspace({ path: "/issues/NOX-1/comments", limit: 1 });
    await exploreLinearWorkspace({
      path: "/issues/NOX-1/comments",
      limit: 1,
      cursor: comments.next_cursor ?? "",
    });

    expect(mocks.listCommentsPage).toHaveBeenLastCalledWith("NOX-1", {
      first: 1,
      after: "comment-cursor-1",
    });

    const attachments = await exploreLinearWorkspace({
      path: "/issues/NOX-1/attachments",
      limit: 1,
    });
    await exploreLinearWorkspace({
      path: "/issues/NOX-1/attachments",
      limit: 1,
      cursor: attachments.next_cursor ?? "",
    });

    expect(mocks.listAttachmentsPage).toHaveBeenLastCalledWith("NOX-1", {
      first: 1,
      after: "attachment-cursor-1",
    });
  });

  it("rejects malformed percent-encoded paths as structured validation errors", async () => {
    await expect(exploreLinearWorkspace({ path: "/issues/%E0%A4%A/comments" })).rejects.toThrow(
      "invalid percent encoding in Linear workspace path",
    );
  });
});
