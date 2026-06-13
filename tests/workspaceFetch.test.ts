import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashRepoRoot } from "../src/lib/config.ts";
import { validateFetchPayloadContract } from "../src/lib/toolBehaviorContracts.ts";
import { markdownJsonBlock } from "../src/lib/workspaceContextWriter.ts";
import { fetchLinearWorkspace } from "../src/lib/workspaceFetch.ts";

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  listProjectUpdates: vi.fn(),
  getIssue: vi.fn(),
  listIssues: vi.fn(),
  listIssuesPage: vi.fn(),
  listComments: vi.fn(),
  listCommentsPage: vi.fn(),
  listRelations: vi.fn(),
  listRelationsPage: vi.fn(),
  listAttachments: vi.fn(),
  listAttachmentsPage: vi.fn(),
  getDocument: vi.fn(),
  listDocuments: vi.fn(),
  listDocumentsPage: vi.fn(),
  getCycle: vi.fn(),
  getMilestone: vi.fn(),
  listMilestones: vi.fn(),
  listMilestonesPage: vi.fn(),
  getInitiative: vi.fn(),
  getInitiativeProjectsPage: vi.fn(),
  listInitiativeUpdates: vi.fn(),
  listInitiativeUpdatesPage: vi.fn(),
  listProjectUpdatesPage: vi.fn(),
  getAgentSession: vi.fn(),
  listAgentSessionsPage: vi.fn(),
}));

vi.mock("../src/lib/projects.ts", () => ({
  getProject: mocks.getProject,
  listProjectUpdates: mocks.listProjectUpdates,
  listProjectUpdatesPage: mocks.listProjectUpdatesPage,
}));

vi.mock("../src/lib/issues.ts", () => ({
  getIssue: mocks.getIssue,
}));

vi.mock("../src/lib/listIssues.ts", () => ({
  listIssues: mocks.listIssues,
  listIssuesPage: mocks.listIssuesPage,
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

vi.mock("../src/lib/documents.ts", () => ({
  getDocument: mocks.getDocument,
  listDocuments: mocks.listDocuments,
  listDocumentsPage: mocks.listDocumentsPage,
}));

vi.mock("../src/lib/cycles.ts", () => ({
  getCycle: mocks.getCycle,
}));

vi.mock("../src/lib/milestones.ts", () => ({
  getMilestone: mocks.getMilestone,
  listMilestones: mocks.listMilestones,
  listMilestonesPage: mocks.listMilestonesPage,
}));

vi.mock("../src/lib/initiatives.ts", () => ({
  getInitiative: mocks.getInitiative,
  getInitiativeProjectsPage: mocks.getInitiativeProjectsPage,
  listInitiativeUpdates: mocks.listInitiativeUpdates,
  listInitiativeUpdatesPage: mocks.listInitiativeUpdatesPage,
}));

vi.mock("../src/lib/agentSessions.ts", () => ({
  getAgentSession: mocks.getAgentSession,
  listAgentSessionsPage: mocks.listAgentSessionsPage,
}));

const project = {
  id: "project-1",
  name: "Workspace Context Project",
  description: null,
  content: "Project body",
  icon: null,
  state: "started",
  url: "https://linear.app/test/project/project-1",
  updated_at: "2026-06-04T00:00:00.000Z",
  start_date: null,
  target_date: null,
  archived_at: null,
  teams: [{ id: "team-1", key: "NOX", name: "Noxor" }],
  lead: null,
};

const listedIssue = {
  identifier: "NOX-1",
  title: "Context issue",
  state: "Todo",
  state_type: "unstarted",
  priority: 2,
  assignee: null,
  labels: [],
  updated_at: "2026-06-04T00:00:00.000Z",
  url: "https://linear.app/test/issue/NOX-1",
};

const fullIssue = {
  ...listedIssue,
  id: "issue-1",
  description: "Full issue body",
  estimate: null,
  project: { id: "project-1", name: "Workspace Context Project" },
  team: { id: "team-1", key: "NOX" },
  parent: null,
};

const document = {
  id: "document-1",
  title: "Context document",
  slug_id: "context-document",
  icon: null,
  url: "https://linear.app/test/document/context-document",
  project: { id: "project-1", name: "Workspace Context Project" },
  issue: null,
  creator: null,
  archived_at: null,
  content: "Document body",
};

const initiative = {
  id: "initiative-1",
  name: "Context initiative",
  description: null,
  status: "Active",
  color: null,
  icon: null,
  url: "https://linear.app/test/initiative/context-initiative",
  target_date: null,
  archived_at: null,
  owner: null,
  projects: [
    { id: "project-1", name: "Project 1", state: "started" },
    { id: "project-2", name: "Project 2", state: "planned" },
  ],
};

const agentSession = {
  id: "session-1",
  status: "working",
  type: "assistant",
  created_at: "2026-06-04T00:00:00.000Z",
  updated_at: "2026-06-04T01:00:00.000Z",
  ended_at: null,
  issue: { id: "issue-1", identifier: "NOX-1", title: "Context issue" },
  creator: { id: "user-1", name: "Agent User", email: "agent@example.com" },
};

beforeEach(() => {
  vi.stubGlobal("Bun", { write: writeFile });
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getProject.mockResolvedValue(project);
  mocks.listProjectUpdates.mockResolvedValue([]);
  mocks.listProjectUpdatesPage.mockResolvedValue({
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  mocks.getIssue.mockResolvedValue(fullIssue);
  mocks.listIssues.mockResolvedValue([]);
  mocks.listIssuesPage.mockResolvedValue({
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
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
  mocks.getDocument.mockResolvedValue(document);
  mocks.listDocuments.mockResolvedValue([]);
  mocks.listDocumentsPage.mockResolvedValue({
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  mocks.listProjectUpdatesPage.mockResolvedValue({
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  mocks.getCycle.mockResolvedValue(null);
  mocks.getMilestone.mockResolvedValue(null);
  mocks.listMilestones.mockResolvedValue([]);
  mocks.listMilestonesPage.mockResolvedValue({
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  mocks.getInitiative.mockResolvedValue(null);
  mocks.getInitiativeProjectsPage.mockResolvedValue(null);
  mocks.listInitiativeUpdates.mockResolvedValue([]);
  mocks.listInitiativeUpdatesPage.mockResolvedValue({
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  mocks.getAgentSession.mockResolvedValue(agentSession);
  mocks.listAgentSessionsPage.mockResolvedValue({
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
    searchedCount: 0,
  });
});

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function decodeExploreCursor(cursor: string): { cursors: Record<string, string> } {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
    cursors: Record<string, string>;
  };
}

describe("fetchLinearWorkspace", () => {
  it("rejects unknown include names before fetching", async () => {
    await expect(
      fetchLinearWorkspace({ target: "/issues/NOX-1", include: ["comment"] }),
    ).rejects.toThrow("unknown issue include: comment");
    expect(mocks.getIssue).not.toHaveBeenCalled();
  });

  it("uses child paths to choose default includes", async () => {
    const out = await tempDir("lebop-workspace-project-docs-");
    mocks.listDocumentsPage.mockResolvedValue({
      nodes: [{ ...document, content: undefined }],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    const result = await fetchLinearWorkspace({
      target: "/projects/project-1/documents",
      to: out,
    });

    expect(result.counts.documents).toBe(1);
    expect(result.kind).toBe("project");
    expect(result.requested_path_kind).toBe("project_child");
    expect(result.focused_collection).toBe("documents");
    expect(result.selected_includes).toEqual(["document_details", "documents"]);
    expect(result.omitted).toContain("issues");
    expect(mocks.listDocumentsPage).toHaveBeenCalledWith({
      projectId: "project-1",
      limit: 100,
      after: undefined,
    });
    expect(mocks.listIssues).not.toHaveBeenCalled();
    expect(mocks.getDocument).toHaveBeenCalledWith("document-1");
    expect(result.counts.document_details).toBe(1);
    expect(result.recommended_reads).toContain("projects/project-1/documents.json");
    expect(result.recommended_reads).toContain(
      "projects/project-1/documents/document-1/document.md",
    );
    expect(
      await readFile(join(out, "projects/project-1/documents/document-1/document.md"), "utf8"),
    ).toContain("Document body");
    const index = await readFile(join(out, "index.md"), "utf8");
    expect(index).toContain("- projects/project-1/documents.json");
    expect(index).toContain("- projects/project-1/documents/document-1/document.md");
    expect(index).not.toContain("- projects/project-1/issues.json");
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      kind: "project",
      requested_path_kind: "project_child",
      focused_collection: "documents",
      selected_includes: ["document_details", "documents"],
    });
    expect(manifest.recommended_reads).toEqual(result.recommended_reads);
    expect(manifest.recommended_reads).toContain("projects/project-1/documents.json");
    expect(manifest.generated_file_metadata).toEqual(
      expect.arrayContaining([
        {
          path: "projects/project-1/documents.json",
          media_type: "application/json",
          role: "context",
          recommended: true,
        },
        {
          path: "manifest.json",
          media_type: "application/json",
          role: "manifest",
          recommended: true,
        },
      ]),
    );
    await rm(out, { recursive: true, force: true });
  });

  it("recommends only materialized project document detail files", async () => {
    const out = await tempDir("lebop-workspace-project-docs-recommended-");
    const missingDocument = { ...document, id: "document-missing", content: undefined };
    const materializedDocument = {
      ...document,
      id: "document-materialized",
      title: "Materialized document",
      content: undefined,
    };
    mocks.listDocumentsPage.mockResolvedValue({
      nodes: [missingDocument, materializedDocument],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    mocks.getDocument.mockImplementation((id: string) =>
      Promise.resolve(
        id === "document-materialized"
          ? { ...document, id: "document-materialized", title: "Materialized document" }
          : null,
      ),
    );

    const result = await fetchLinearWorkspace({
      target: "/projects/project-1/documents",
      to: out,
    });

    expect(result.recommended_reads).toContain(
      "projects/project-1/documents/document-materialized/document.md",
    );
    expect(result.recommended_reads).not.toContain(
      "projects/project-1/documents/document-missing/document.md",
    );
    expect(
      await readFile(
        join(out, "projects/project-1/documents/document-materialized/document.md"),
        "utf8",
      ),
    ).toContain("Materialized document");
    expect(result.completeness.document_details?.reason).toBe("not_available: document_missing");
    expect(validateFetchPayloadContract(result)).toEqual([]);
    await rm(out, { recursive: true, force: true });
  });

  it("fetches issue-scoped documents from issue child paths", async () => {
    const out = await tempDir("lebop-workspace-issue-docs-");
    const issueDocument = {
      ...document,
      id: "issue-document-1",
      title: "Issue document",
      project: null,
      issue: { id: "issue-1", identifier: "NOX-1", title: "Context issue" },
    };
    mocks.listDocumentsPage.mockResolvedValue({
      nodes: [{ ...issueDocument, content: undefined }],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    mocks.getDocument.mockResolvedValue({ ...issueDocument, content: "Issue document body" });

    const result = await fetchLinearWorkspace({
      target: "/issues/NOX-1/documents",
      to: out,
    });

    expect(result.counts.documents).toBe(1);
    expect(result.counts.document_details).toBe(1);
    expect(result.focused_collection).toBe("documents");
    expect(result.selected_includes).toEqual(["document_details", "documents"]);
    expect(mocks.listDocumentsPage).toHaveBeenCalledWith({
      issueId: "issue-1",
      limit: 100,
      after: undefined,
    });
    expect(result.recommended_reads).toContain("issues/NOX-1/documents.json");
    expect(result.recommended_reads).toContain(
      "issues/NOX-1/documents/issue-document-1/document.md",
    );
    await expect(readFile(join(out, "issues/NOX-1/documents.json"), "utf8")).resolves.toContain(
      "Issue document",
    );
    await expect(
      readFile(join(out, "issues/NOX-1/documents/issue-document-1/document.md"), "utf8"),
    ).resolves.toContain("Issue document body");
    await rm(out, { recursive: true, force: true });
  });

  it("normalizes dependent project issue includes before materializing context", async () => {
    const out = await tempDir("lebop-workspace-project-dependent-includes-");
    mocks.listIssuesPage.mockResolvedValue({
      nodes: [listedIssue],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    mocks.listCommentsPage.mockResolvedValue({
      comments: [{ id: "comment-1", body: "Dependent include comment" }],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    const result = await fetchLinearWorkspace({
      target: "/projects/project-1",
      include: ["comments"],
      to: out,
    });

    expect(result.selected_includes).toEqual(["comments", "issues"]);
    expect(result.counts.issues).toBe(1);
    expect(result.counts.issue_comments).toBe(1);
    expect(mocks.listIssuesPage).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1" }),
    );
    expect(await readFile(join(out, "issues/NOX-1/comments.md"), "utf8")).toContain(
      "Dependent include comment",
    );
    await rm(out, { recursive: true, force: true });
  });

  it("materializes project issue-scoped document details when requested", async () => {
    const out = await tempDir("lebop-workspace-project-issue-docs-");
    const issueDocument = {
      ...document,
      id: "project-issue-document-1",
      title: "Project issue document",
      project: null,
      issue: { id: "issue-1", identifier: "NOX-1", title: "Context issue" },
    };
    mocks.listIssuesPage.mockResolvedValue({
      nodes: [listedIssue],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    mocks.listDocumentsPage.mockResolvedValue({
      nodes: [{ ...issueDocument, content: undefined }],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    mocks.getDocument.mockResolvedValue({
      ...issueDocument,
      content: "Project issue document body",
    });

    const result = await fetchLinearWorkspace({
      target: "/projects/project-1",
      include: ["issue_document_details"],
      to: out,
    });

    expect(result.selected_includes).toEqual([
      "issue_document_details",
      "issue_documents",
      "issues",
    ]);
    expect(result.counts.issue_documents).toBe(1);
    expect(result.counts.issue_document_details).toBe(1);
    expect(result.recommended_reads).toContain("issues/NOX-1/documents.json");
    await expect(
      readFile(join(out, "issues/NOX-1/documents/project-issue-document-1/document.md"), "utf8"),
    ).resolves.toContain("Project issue document body");
    await rm(out, { recursive: true, force: true });
  });

  it("materializes project issue agent sessions when explicitly included", async () => {
    const out = await tempDir("lebop-workspace-project-agent-sessions-");
    mocks.listIssuesPage.mockResolvedValue({
      nodes: [listedIssue],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    mocks.listAgentSessionsPage.mockResolvedValue({
      nodes: [agentSession],
      pageInfo: { hasNextPage: true, endCursor: "issue-agent-session-cursor-1" },
      searchedCount: 1,
    });

    const result = await fetchLinearWorkspace({
      target: "/projects/project-1",
      include: ["agent_sessions"],
      limit: 1,
      to: out,
    });

    expect(result.selected_includes).toEqual(["agent_sessions", "issues"]);
    expect(result.counts).toMatchObject({
      issues: 1,
      issue_agent_sessions: 1,
    });
    expect(result.completeness.issue_agent_sessions).toMatchObject({
      returned: 1,
      limit: 1,
      complete: false,
      truncated: true,
      limit_semantics: "per_parent",
      reason: "cursor",
    });
    expect(mocks.getIssue).toHaveBeenCalledWith("NOX-1");
    expect(mocks.listAgentSessionsPage).toHaveBeenCalledWith({
      issueId: "issue-1",
      limit: 1,
    });
    expect(await readFile(join(out, "issues/NOX-1/agent-sessions.json"), "utf8")).toContain(
      "session-1",
    );
    expect(result.continuations).toEqual([
      expect.objectContaining({
        tool: "fetch_linear_workspace",
        args: {
          target: "/issues/NOX-1/agent-sessions",
          limit: 1,
          include: ["agent_sessions"],
          cursor: expect.any(String),
        },
      }),
    ]);
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    expect(manifest.completeness.issue_agent_sessions).toMatchObject({
      complete: false,
      truncated: true,
      reason: "cursor",
    });
    await rm(out, { recursive: true, force: true });
  });

  it("omits project issue agent sessions from default project dossiers", async () => {
    const out = await tempDir("lebop-workspace-project-no-default-agent-sessions-");
    mocks.listIssuesPage.mockResolvedValue({
      nodes: [listedIssue],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    const result = await fetchLinearWorkspace({
      target: "/projects/project-1",
      limit: 1,
      to: out,
    });

    expect(result.selected_includes).not.toContain("agent_sessions");
    expect(result.counts.issue_agent_sessions).toBeUndefined();
    expect(mocks.listAgentSessionsPage).not.toHaveBeenCalled();
    await expect(readFile(join(out, "issues/NOX-1/agent-sessions.json"), "utf8")).rejects.toThrow();
    await rm(out, { recursive: true, force: true });
  });

  it("normalizes initiative project issue includes before materializing context", async () => {
    const out = await tempDir("lebop-workspace-initiative-dependent-includes-");
    mocks.getInitiativeProjectsPage.mockResolvedValue({
      initiative,
      projects: {
        nodes: [{ id: "project-1", name: "Project 1", state: "started" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    mocks.listIssuesPage.mockResolvedValue({
      nodes: [listedIssue],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    const result = await fetchLinearWorkspace({
      target: "/initiatives/initiative-1",
      include: ["project_issues"],
      to: out,
    });

    expect(result.selected_includes).toEqual(["project_issues", "projects"]);
    expect(result.counts.projects).toBe(1);
    expect(result.counts.project_issues).toBe(1);
    expect(mocks.getProject).toHaveBeenCalledWith("project-1");
    expect(mocks.listIssuesPage).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1" }),
    );
    await rm(out, { recursive: true, force: true });
  });

  it("materializes initiative project issue agent sessions when explicitly included", async () => {
    const out = await tempDir("lebop-workspace-initiative-agent-sessions-");
    mocks.getInitiativeProjectsPage.mockResolvedValue({
      initiative,
      projects: {
        nodes: [{ id: "project-1", name: "Project 1", state: "started" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    mocks.listIssuesPage.mockResolvedValue({
      nodes: [listedIssue],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    mocks.listAgentSessionsPage.mockResolvedValue({
      nodes: [agentSession],
      pageInfo: { hasNextPage: true, endCursor: "initiative-issue-agent-session-cursor-1" },
      searchedCount: 1,
    });

    const result = await fetchLinearWorkspace({
      target: "/initiatives/initiative-1",
      include: ["agent_sessions"],
      limit: 1,
      to: out,
    });

    expect(result.selected_includes).toEqual(["agent_sessions", "project_issues", "projects"]);
    expect(result.counts).toMatchObject({
      projects: 1,
      project_issues: 1,
      issue_agent_sessions: 1,
    });
    expect(result.completeness.issue_agent_sessions).toMatchObject({
      returned: 1,
      limit: 1,
      complete: false,
      truncated: true,
      limit_semantics: "per_parent",
      reason: "cursor",
    });
    expect(mocks.getProject).toHaveBeenCalledWith("project-1");
    expect(mocks.listIssuesPage).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1" }),
    );
    expect(mocks.listAgentSessionsPage).toHaveBeenCalledWith({
      issueId: "issue-1",
      limit: 1,
    });
    expect(await readFile(join(out, "issues/NOX-1/agent-sessions.json"), "utf8")).toContain(
      "session-1",
    );
    expect(result.continuations).toEqual([
      expect.objectContaining({
        tool: "fetch_linear_workspace",
        args: {
          target: "/issues/NOX-1/agent-sessions",
          limit: 1,
          include: ["agent_sessions"],
          cursor: expect.any(String),
        },
      }),
    ]);
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    expect(manifest.selected_includes).toEqual(["agent_sessions", "project_issues", "projects"]);
    expect(manifest.completeness.issue_agent_sessions).toMatchObject({
      complete: false,
      truncated: true,
      reason: "cursor",
    });
    await rm(out, { recursive: true, force: true });
  });

  it("omits project issue agent sessions from default initiative dossiers", async () => {
    const out = await tempDir("lebop-workspace-initiative-no-default-agent-sessions-");
    mocks.getInitiativeProjectsPage.mockResolvedValue({
      initiative,
      projects: {
        nodes: [{ id: "project-1", name: "Project 1", state: "started" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    mocks.listIssuesPage.mockResolvedValue({
      nodes: [listedIssue],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    const result = await fetchLinearWorkspace({
      target: "/initiatives/initiative-1",
      limit: 1,
      to: out,
    });

    expect(result.selected_includes).not.toContain("agent_sessions");
    expect(result.counts.issue_agent_sessions).toBeUndefined();
    expect(mocks.listAgentSessionsPage).not.toHaveBeenCalled();
    await rm(out, { recursive: true, force: true });
  });

  it("marks missing requested issue details as incomplete shallow fallback data", async () => {
    const out = await tempDir("lebop-workspace-issue-details-missing-");
    mocks.listIssuesPage.mockResolvedValue({
      nodes: [listedIssue],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    mocks.getIssue.mockResolvedValue(null);

    const result = await fetchLinearWorkspace({
      target: "/projects/project-1",
      include: ["issues", "issue_details"],
      to: out,
    });

    expect(result.counts.issue_details).toBe(0);
    expect(result.completeness.issue_details).toMatchObject({
      returned: 0,
      total_available: 1,
      complete: false,
      truncated: true,
      reason: "not_available: issue_detail_missing",
    });
    expect(validateFetchPayloadContract(result)).toEqual([]);
    expect(await readFile(join(out, "issues/NOX-1/issue.md"), "utf8")).toContain(
      "This file contains shallow list data",
    );
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    expect(manifest.completeness.issue_details).toMatchObject({
      complete: false,
      truncated: true,
      reason: "not_available: issue_detail_missing",
    });
    await rm(out, { recursive: true, force: true });
  });

  it("materializes issue lists above Linear's single-page cap", async () => {
    const out = await tempDir("lebop-workspace-project-issues-multipage-");
    const firstPage = Array.from({ length: 250 }, (_, index) => ({
      ...listedIssue,
      identifier: `NOX-${index + 1}`,
      title: `Issue ${index + 1}`,
    }));
    const secondPage = Array.from({ length: 50 }, (_, index) => ({
      ...listedIssue,
      identifier: `NOX-${index + 251}`,
      title: `Issue ${index + 251}`,
    }));
    mocks.listIssuesPage.mockImplementation((opts: { after?: string; limit: number }) =>
      Promise.resolve(
        opts.after === "issue-cursor-250"
          ? {
              nodes: secondPage.slice(0, opts.limit),
              pageInfo: { hasNextPage: false, endCursor: null },
            }
          : {
              nodes: firstPage,
              pageInfo: { hasNextPage: true, endCursor: "issue-cursor-250" },
            },
      ),
    );

    const result = await fetchLinearWorkspace({
      target: "/projects/project-1",
      include: ["issues"],
      depth: "shallow",
      limit: 300,
      to: out,
    });

    expect(result.counts.issues).toBe(300);
    expect(result.completeness.issues).toMatchObject({
      returned: 300,
      limit: 300,
      complete: true,
      truncated: false,
    });
    expect(mocks.listIssuesPage).toHaveBeenCalledTimes(2);
    expect(mocks.listIssuesPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ limit: 50, after: "issue-cursor-250" }),
    );
    const issues = JSON.parse(await readFile(join(out, "projects/project-1/issues.json"), "utf8"));
    expect(issues).toHaveLength(300);
    await rm(out, { recursive: true, force: true });
  });

  it("uses fetch continuation cursors to materialize the next project issue page", async () => {
    const firstOut = await tempDir("lebop-workspace-project-issues-page-one-");
    const secondOut = await tempDir("lebop-workspace-project-issues-page-two-");
    mocks.listIssuesPage
      .mockResolvedValueOnce({
        nodes: [{ ...listedIssue, identifier: "NOX-1", title: "Page one issue" }],
        pageInfo: { hasNextPage: true, endCursor: "project-issues-cursor-1" },
      })
      .mockResolvedValueOnce({
        nodes: [{ ...listedIssue, identifier: "NOX-2", title: "Page two issue" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      });

    const first = await fetchLinearWorkspace({
      target: "/projects/project-1/issues",
      include: ["issues"],
      depth: "full",
      limit: 1,
      to: firstOut,
    });
    const continuation = first.continuations[0];
    expect(continuation).toMatchObject({
      tool: "fetch_linear_workspace",
      args: {
        target: "/projects/project-1/issues",
        limit: 1,
        depth: "full",
        include: ["issues"],
        cursor: expect.any(String),
      },
    });
    mocks.listCommentsPage.mockClear();
    mocks.listRelationsPage.mockClear();
    mocks.listAttachmentsPage.mockClear();
    mocks.listDocumentsPage.mockClear();

    const second = await fetchLinearWorkspace({
      target: continuation?.args.target as string,
      cursor: continuation?.args.cursor as string,
      include: continuation?.args.include as string[],
      depth: continuation?.args.depth as "full",
      limit: continuation?.args.limit as number,
      to: secondOut,
    });

    expect(second.counts.issues).toBe(1);
    expect(second.truncated).toBe(false);
    expect(mocks.listIssuesPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: "project-issues-cursor-1" }),
    );
    await expect(
      readFile(join(secondOut, "projects/project-1/issues.json"), "utf8"),
    ).resolves.toContain("Page two issue");
    expect(mocks.listCommentsPage).not.toHaveBeenCalled();
    expect(mocks.listRelationsPage).not.toHaveBeenCalled();
    expect(mocks.listAttachmentsPage).not.toHaveBeenCalled();
    expect(mocks.listDocumentsPage).not.toHaveBeenCalled();
    await rm(firstOut, { recursive: true, force: true });
    await rm(secondOut, { recursive: true, force: true });
  });

  it("projects issue-derived includes into project issue continuations", async () => {
    const out = await tempDir("lebop-workspace-project-comments-continuation-");
    mocks.listIssuesPage.mockResolvedValue({
      nodes: [listedIssue],
      pageInfo: { hasNextPage: true, endCursor: "project-issues-cursor-1" },
    });
    mocks.listCommentsPage.mockResolvedValue({
      comments: [{ id: "comment-1", body: "Comment one" }],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    const result = await fetchLinearWorkspace({
      target: "/projects/project-1",
      include: ["comments"],
      depth: "full",
      limit: 1,
      to: out,
    });

    expect(result.continuations[0]).toMatchObject({
      tool: "fetch_linear_workspace",
      args: {
        target: "/projects/project-1/issues",
        include: ["comments", "issues"],
      },
    });
    await rm(out, { recursive: true, force: true });
  });

  it("rejects generic fetch pages that advertise more data without returning records", async () => {
    const out = await tempDir("lebop-workspace-project-zero-progress-");
    mocks.listIssuesPage.mockResolvedValue({
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: "issue-cursor-empty" },
    });

    await expect(
      fetchLinearWorkspace({
        target: "/projects/project-1",
        include: ["issues"],
        depth: "shallow",
        limit: 2,
        to: out,
      }),
    ).rejects.toThrow(/made no progress/);
    await rm(out, { recursive: true, force: true });
  });

  it("includes workspace in returned and manifest continuation arguments", async () => {
    const out = await tempDir("lebop-workspace-continuation-workspace-");
    mocks.listIssuesPage.mockResolvedValue({
      nodes: [listedIssue],
      pageInfo: { hasNextPage: true, endCursor: "issue-cursor-1" },
    });

    const result = await fetchLinearWorkspace({
      target: "/projects/project-1",
      include: ["issues"],
      depth: "shallow",
      limit: 1,
      workspace: "noxor",
      to: out,
    });

    expect(result.continuations[0]?.args).toMatchObject({
      include: ["issues"],
      workspace: "noxor",
    });
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    expect(manifest.continuations[0]?.args).toMatchObject({
      include: ["issues"],
      workspace: "noxor",
    });
    await rm(out, { recursive: true, force: true });
  });

  it("treats explicit empty include as no optional child includes", async () => {
    const out = await tempDir("lebop-workspace-empty-include-");

    const result = await fetchLinearWorkspace({
      target: "/projects/project-1",
      include: [],
      to: out,
    });

    expect(result.counts).toEqual({ projects: 1 });
    expect(result.omitted).toEqual(expect.arrayContaining(["issues", "documents", "updates"]));
    expect(mocks.listIssues).not.toHaveBeenCalled();
    expect(mocks.listDocumentsPage).not.toHaveBeenCalled();
    expect(mocks.listProjectUpdates).not.toHaveBeenCalled();
    await rm(out, { recursive: true, force: true });
  });

  it("defaults initiative fetches to full depth from the shared library", async () => {
    const out = await tempDir("lebop-workspace-initiative-full-default-");
    mocks.getInitiativeProjectsPage.mockResolvedValue({
      initiative,
      projects: {
        nodes: initiative.projects,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    mocks.getProject.mockResolvedValue(project);
    mocks.listIssuesPage.mockResolvedValue({
      nodes: [listedIssue],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    const result = await fetchLinearWorkspace({
      target: "/initiatives/initiative-1",
      include: ["projects", "project_issues"],
      to: out,
    });

    expect(result.counts.project_issues).toBe(2);
    expect(mocks.getProject).toHaveBeenCalledWith("project-1");
    expect(mocks.getProject).toHaveBeenCalledWith("project-2");
    await rm(out, { recursive: true, force: true });
  });

  it("does not paginate initiative projects for updates-only initiative child fetches", async () => {
    const out = await tempDir("lebop-workspace-initiative-updates-only-");
    mocks.getInitiativeProjectsPage.mockResolvedValue({
      initiative,
      projects: {
        nodes: [initiative.projects[0]],
        pageInfo: { hasNextPage: true, endCursor: "initiative-project-cursor-1" },
      },
    });
    mocks.listInitiativeUpdatesPage.mockResolvedValue({
      nodes: [
        {
          id: "initiative-update-1",
          body: "Updates-only body",
          health: "onTrack",
          created_at: "2026-06-05T00:00:00.000Z",
          user: null,
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    const result = await fetchLinearWorkspace({
      target: "/initiatives/initiative-1/updates",
      to: out,
      limit: 100,
    });

    expect(result.counts).toMatchObject({ initiatives: 1, initiative_updates: 1 });
    expect(result.counts.projects).toBeUndefined();
    expect(mocks.getInitiativeProjectsPage).toHaveBeenCalledTimes(1);
    expect(mocks.getInitiativeProjectsPage).toHaveBeenCalledWith("initiative-1", { limit: 1 });
    expect(mocks.getProject).not.toHaveBeenCalled();
    expect(await readFile(join(out, "initiatives/initiative-1/updates.md"), "utf8")).toContain(
      "Updates-only body",
    );
    await rm(out, { recursive: true, force: true });
  });

  it("materializes initiative nested project documents, updates, and milestones", async () => {
    const out = await tempDir("lebop-workspace-initiative-project-context-");
    mocks.getInitiativeProjectsPage.mockResolvedValue({
      initiative,
      projects: {
        nodes: [{ id: "project-1", name: "Project 1", state: "started" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    mocks.listDocumentsPage.mockResolvedValue({
      nodes: [{ ...document, content: undefined }],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    mocks.getDocument.mockResolvedValue({ ...document, content: "Nested project document body" });
    mocks.listProjectUpdatesPage.mockResolvedValue({
      nodes: [
        {
          id: "project-update-1",
          body: "Nested project update",
          health: "onTrack",
          created_at: "2026-06-04T00:00:00.000Z",
          user: null,
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    mocks.listMilestonesPage.mockResolvedValue({
      nodes: [
        {
          id: "milestone-1",
          name: "Nested milestone",
          description: null,
          target_date: null,
          sort_order: 1,
          archived_at: null,
          project: { id: "project-1", name: "Project 1" },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    const result = await fetchLinearWorkspace({
      target: "/initiatives/initiative-1",
      include: [
        "project_documents",
        "project_document_details",
        "project_updates",
        "project_milestones",
      ],
      to: out,
    });

    expect(result.selected_includes).toEqual([
      "project_document_details",
      "project_documents",
      "project_milestones",
      "project_updates",
      "projects",
    ]);
    expect(result.counts).toMatchObject({
      projects: 1,
      project_documents: 1,
      project_document_details: 1,
      project_updates: 1,
      project_milestones: 1,
    });
    await expect(
      readFile(join(out, "projects/project-1/documents.json"), "utf8"),
    ).resolves.toContain("Context document");
    await expect(
      readFile(join(out, "projects/project-1/documents/document-1/document.md"), "utf8"),
    ).resolves.toContain("Nested project document body");
    await expect(readFile(join(out, "projects/project-1/updates.md"), "utf8")).resolves.toContain(
      "Nested project update",
    );
    await expect(
      readFile(join(out, "projects/project-1/milestones.json"), "utf8"),
    ).resolves.toContain("Nested milestone");
    await rm(out, { recursive: true, force: true });
  });

  it("rejects invalid depth strings at the shared library boundary", async () => {
    await expect(
      fetchLinearWorkspace({
        target: "/initiatives/initiative-1",
        depth: "deep" as "full",
      }),
    ).rejects.toThrow("fetch depth must be shallow or full");
    expect(mocks.getInitiativeProjectsPage).not.toHaveBeenCalled();
  });

  it("writes per-collection completeness metadata into fetch manifests", async () => {
    const out = await tempDir("lebop-workspace-completeness-");
    mocks.listIssuesPage.mockResolvedValue({
      nodes: [listedIssue],
      pageInfo: { hasNextPage: true, endCursor: "project-issues-cursor-1" },
    });
    const comments = [
      { id: "comment-1", body: "Comment 1", updated_at: "now" },
      { id: "comment-2", body: "Comment 2", updated_at: "now" },
    ];
    mocks.listCommentsPage.mockImplementation((_identifier, opts: { first: number }) =>
      Promise.resolve({
        comments: comments.slice(0, opts.first),
        pageInfo: { hasNextPage: comments.length > opts.first, endCursor: "comment-cursor-1" },
      }),
    );

    const result = await fetchLinearWorkspace({
      target: "/projects/project-1",
      to: out,
      limit: 1,
      workspace: "noxor",
    });

    expect(result.completeness).toMatchObject({
      issues: {
        returned: 1,
        limit: 1,
        complete: false,
        truncated: true,
        reason: "cursor",
      },
      issue_comments: {
        returned: 1,
        limit: 1,
        complete: false,
        truncated: true,
        limit_semantics: "per_parent",
      },
    });
    expect(result.continuations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "fetch_linear_workspace",
          args: {
            target: "/projects/project-1/issues",
            limit: 1,
            include: [
              "attachments",
              "comments",
              "issue_details",
              "issue_document_details",
              "issue_documents",
              "issues",
              "relations",
            ],
            cursor: expect.any(String),
            depth: "full",
            workspace: "noxor",
          },
        }),
        expect.objectContaining({
          tool: "fetch_linear_workspace",
          args: {
            target: "/issues/NOX-1/comments",
            limit: 1,
            include: ["comments"],
            cursor: expect.any(String),
            workspace: "noxor",
          },
        }),
      ]),
    );
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    expect(manifest.completeness.issue_comments).toMatchObject({
      returned: 1,
      complete: false,
    });
    await rm(out, { recursive: true, force: true });
  });

  it("marks issue relation completeness as truncated when Linear reports more relation pages", async () => {
    const out = await tempDir("lebop-workspace-relation-pages-");
    mocks.listRelationsPage.mockResolvedValue({
      outbound: [{ id: "relation-1", type: "blocks", otherIdentifier: "NOX-2" }],
      inbound: [],
      complete: false,
      pageInfo: {
        outbound: { hasNextPage: true, endCursor: "relation-cursor-1" },
        inbound: { hasNextPage: false, endCursor: null },
      },
    });

    const result = await fetchLinearWorkspace({
      target: "/issues/NOX-1",
      include: ["relations"],
      limit: 1,
      to: out,
    });

    expect(result.truncated).toBe(true);
    expect(result.completeness.relations).toMatchObject({
      returned: 1,
      limit: 1,
      complete: false,
      truncated: true,
      limit_semantics: "per_direction",
      reason: "relation_page_may_have_more",
    });
    expect(result.continuations).toEqual([
      expect.objectContaining({
        tool: "fetch_linear_workspace",
        args: {
          target: "/issues/NOX-1/relations",
          limit: 1,
          include: ["relations"],
          cursor: expect.any(String),
        },
      }),
    ]);
    await rm(out, { recursive: true, force: true });
  });

  it("rejects relation fetch pages that report more data without a cursor", async () => {
    const out = await tempDir("lebop-workspace-relation-missing-cursor-");
    mocks.listRelationsPage.mockResolvedValue({
      outbound: [{ id: "relation-1", type: "blocks", otherIdentifier: "NOX-2" }],
      inbound: [],
      complete: false,
      pageInfo: {
        outbound: { hasNextPage: true, endCursor: null },
        inbound: { hasNextPage: false, endCursor: null },
      },
    });

    await expect(
      fetchLinearWorkspace({
        target: "/issues/NOX-1",
        include: ["relations"],
        limit: 1,
        to: out,
      }),
    ).rejects.toThrow(/cannot continue outbound page/);
    await rm(out, { recursive: true, force: true });
  });

  it("rejects relation fetch pages whose cursor does not advance", async () => {
    const out = await tempDir("lebop-workspace-relation-repeat-cursor-");
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
        complete: false,
        pageInfo: {
          outbound: { hasNextPage: true, endCursor: "relation-cursor-1" },
          inbound: { hasNextPage: false, endCursor: null },
        },
      });

    await expect(
      fetchLinearWorkspace({
        target: "/issues/NOX-1",
        include: ["relations"],
        limit: 2,
        to: out,
      }),
    ).rejects.toThrow(/cursor did not advance/);
    await rm(out, { recursive: true, force: true });
  });

  it("rejects relation fetch pages that advertise more data without returning records", async () => {
    const out = await tempDir("lebop-workspace-relation-zero-progress-");
    mocks.listRelationsPage.mockResolvedValue({
      outbound: [],
      inbound: [],
      complete: false,
      pageInfo: {
        outbound: { hasNextPage: true, endCursor: "relation-cursor-empty" },
        inbound: { hasNextPage: false, endCursor: null },
      },
    });

    await expect(
      fetchLinearWorkspace({
        target: "/issues/NOX-1",
        include: ["relations"],
        limit: 2,
        to: out,
      }),
    ).rejects.toThrow(/made no progress/);
    await rm(out, { recursive: true, force: true });
  });

  it("does not advance relation continuations past unmaterialized directions", async () => {
    const out = await tempDir("lebop-workspace-relation-boundary-");
    mocks.listRelationsPage
      .mockResolvedValueOnce({
        outbound: [{ id: "outbound-1", type: "blocks", otherIdentifier: "NOX-2" }],
        inbound: [
          { id: "inbound-1", type: "related", otherIdentifier: "NOX-3" },
          { id: "inbound-2", type: "related", otherIdentifier: "NOX-4" },
        ],
        complete: false,
        pageInfo: {
          outbound: { hasNextPage: true, endCursor: "outbound-cursor-1" },
          inbound: { hasNextPage: true, endCursor: "inbound-cursor-2" },
        },
      })
      .mockResolvedValueOnce({
        outbound: [{ id: "outbound-2", type: "blocks", otherIdentifier: "NOX-5" }],
        inbound: [{ id: "inbound-3", type: "related", otherIdentifier: "NOX-6" }],
        complete: false,
        pageInfo: {
          outbound: { hasNextPage: false, endCursor: null },
          inbound: { hasNextPage: true, endCursor: "inbound-cursor-3" },
        },
      });

    const result = await fetchLinearWorkspace({
      target: "/issues/NOX-1",
      include: ["relations"],
      limit: 2,
      to: out,
    });

    const relationCursor = result.continuations[0]?.args.cursor as string;
    expect(decodeExploreCursor(relationCursor).cursors).toEqual({
      inbound: "inbound-cursor-2",
    });
    expect(mocks.listRelationsPage).toHaveBeenNthCalledWith(2, "NOX-1", {
      first: 1,
      outboundAfter: "outbound-cursor-1",
      includeOutbound: true,
      includeInbound: false,
    });
    const relations = JSON.parse(await readFile(join(out, "issues/NOX-1/relations.json"), "utf8"));
    expect(relations.inbound).toHaveLength(2);
    expect(relations.inbound).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "inbound-3" })]),
    );
    await rm(out, { recursive: true, force: true });
  });

  it("does not re-fetch outbound relation pages after outbound reaches the fetch limit", async () => {
    const out = await tempDir("lebop-workspace-relation-inactive-outbound-");
    mocks.listRelationsPage
      .mockResolvedValueOnce({
        outbound: [
          { id: "outbound-1", type: "blocks", otherIdentifier: "NOX-2" },
          { id: "outbound-2", type: "blocks", otherIdentifier: "NOX-3" },
        ],
        inbound: [{ id: "inbound-1", type: "related", otherIdentifier: "NOX-4" }],
        complete: false,
        pageInfo: {
          outbound: { hasNextPage: true, endCursor: "outbound-cursor-2" },
          inbound: { hasNextPage: true, endCursor: "inbound-cursor-1" },
        },
      })
      .mockResolvedValueOnce({
        outbound: [],
        inbound: [{ id: "inbound-2", type: "related", otherIdentifier: "NOX-5" }],
        complete: false,
        pageInfo: {
          outbound: { hasNextPage: false, endCursor: null },
          inbound: { hasNextPage: true, endCursor: "inbound-cursor-2" },
        },
      });

    const result = await fetchLinearWorkspace({
      target: "/issues/NOX-1",
      include: ["relations"],
      limit: 2,
      to: out,
    });

    expect(mocks.listRelationsPage).toHaveBeenNthCalledWith(2, "NOX-1", {
      first: 1,
      includeOutbound: false,
      inboundAfter: "inbound-cursor-1",
      includeInbound: true,
    });
    const relationCursor = result.continuations[0]?.args.cursor as string;
    expect(decodeExploreCursor(relationCursor).cursors).toEqual({
      outbound: "outbound-cursor-2",
      inbound: "inbound-cursor-2",
    });
    const relations = JSON.parse(await readFile(join(out, "issues/NOX-1/relations.json"), "utf8"));
    expect(relations.outbound).toHaveLength(2);
    expect(relations.inbound).toHaveLength(2);
    await rm(out, { recursive: true, force: true });
  });

  it("reports aggregate relation completeness with the caller limit per parent direction", async () => {
    const out = await tempDir("lebop-workspace-relation-aggregate-");
    mocks.listIssuesPage.mockResolvedValue({
      nodes: [listedIssue],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    mocks.listRelationsPage.mockResolvedValue({
      outbound: Array.from({ length: 7 }, (_, i) => ({
        id: `relation-${i + 1}`,
        type: "blocks",
        otherIdentifier: `NOX-${i + 2}`,
      })),
      inbound: [],
      complete: false,
      pageInfo: {
        outbound: { hasNextPage: true, endCursor: "relation-cursor-1" },
        inbound: { hasNextPage: false, endCursor: null },
      },
    });

    const result = await fetchLinearWorkspace({
      target: "/projects/project-1",
      include: ["issues", "relations"],
      limit: 7,
      to: out,
    });

    expect(result.completeness.issue_relations).toMatchObject({
      returned: 7,
      limit: 7,
      complete: false,
      truncated: true,
      limit_semantics: "per_parent_direction",
      reason: "relation_page_may_have_more",
    });
    await rm(out, { recursive: true, force: true });
  });

  it("points truncated cycle issues to the exact cursor-backed fetch child path", async () => {
    const out = await tempDir("lebop-workspace-cycle-issues-continuation-");
    mocks.getCycle.mockResolvedValue({
      id: "cycle-1",
      name: "Cycle 1",
      number: 1,
      archived_at: null,
      team: { id: "team-1", key: "NOX", name: "Noxor" },
    });
    mocks.listIssuesPage.mockResolvedValue({
      nodes: [listedIssue],
      pageInfo: { hasNextPage: true, endCursor: "cycle-issues-cursor-1" },
    });

    const result = await fetchLinearWorkspace({
      target: "/cycles/cycle-1",
      to: out,
      limit: 1,
    });

    expect(result.truncated).toBe(true);
    expect(result.continuations).toEqual([
      expect.objectContaining({
        tool: "fetch_linear_workspace",
        args: {
          target: "/cycles/cycle-1/issues",
          limit: 1,
          include: [
            "attachments",
            "comments",
            "issue_details",
            "issue_document_details",
            "issue_documents",
            "issues",
            "relations",
          ],
          cursor: expect.any(String),
          depth: "full",
        },
      }),
    ]);
    expect(await readFile(join(out, "issues/NOX-1/issue.md"), "utf8")).toContain("Full issue body");
    await rm(out, { recursive: true, force: true });
  });

  it("points truncated milestone issues to the exact cursor-backed fetch child path", async () => {
    const out = await tempDir("lebop-workspace-milestone-issues-continuation-");
    mocks.getMilestone.mockResolvedValue({
      id: "milestone-1",
      name: "Milestone 1",
      description: null,
      target_date: null,
      sort_order: 1,
      archived_at: null,
      project: { id: "project-1", name: "Project 1" },
    });
    mocks.listIssuesPage.mockResolvedValue({
      nodes: [listedIssue],
      pageInfo: { hasNextPage: true, endCursor: "milestone-issues-cursor-1" },
    });

    const result = await fetchLinearWorkspace({
      target: "/milestones/milestone-1",
      to: out,
      limit: 1,
    });

    expect(result.truncated).toBe(true);
    expect(result.continuations).toEqual([
      expect.objectContaining({
        tool: "fetch_linear_workspace",
        args: {
          target: "/milestones/milestone-1/issues",
          limit: 1,
          include: [
            "attachments",
            "comments",
            "issue_details",
            "issue_document_details",
            "issue_documents",
            "issues",
            "relations",
          ],
          cursor: expect.any(String),
          depth: "full",
        },
      }),
    ]);
    expect(await readFile(join(out, "issues/NOX-1/issue.md"), "utf8")).toContain("Full issue body");
    await rm(out, { recursive: true, force: true });
  });

  it("points truncated issue agent sessions to the exact cursor-backed fetch child path", async () => {
    const out = await tempDir("lebop-workspace-agent-session-continuation-");
    mocks.listAgentSessionsPage.mockResolvedValue({
      nodes: [agentSession],
      pageInfo: { hasNextPage: true, endCursor: "agent-session-cursor-1" },
      searchedCount: 1,
    });

    const result = await fetchLinearWorkspace({
      target: "/issues/NOX-1/agent-sessions",
      to: out,
      limit: 1,
    });

    expect(result.truncated).toBe(true);
    expect(result.completeness.agent_sessions).toMatchObject({
      returned: 1,
      limit: 1,
      complete: false,
      truncated: true,
      reason: "cursor",
    });
    expect(result.continuations).toEqual([
      expect.objectContaining({
        tool: "fetch_linear_workspace",
        args: {
          target: "/issues/NOX-1/agent-sessions",
          limit: 1,
          include: ["agent_sessions"],
          cursor: expect.any(String),
        },
      }),
    ]);
    await rm(out, { recursive: true, force: true });
  });

  it("reports exact initiative project completeness when fetch limit slices projects", async () => {
    const out = await tempDir("lebop-workspace-initiative-completeness-");
    mocks.getInitiativeProjectsPage.mockResolvedValue({
      initiative,
      projects: {
        nodes: [initiative.projects[0]],
        pageInfo: { hasNextPage: true, endCursor: "initiative-project-cursor-1" },
      },
    });

    const result = await fetchLinearWorkspace({
      target: "/initiatives/initiative-1",
      include: ["projects"],
      to: out,
      limit: 1,
    });

    expect(result.counts.projects).toBe(1);
    expect(result.completeness.projects).toMatchObject({
      returned: 1,
      limit: 1,
      complete: false,
      truncated: true,
      reason: "cursor",
    });
    expect(result.continuations).toEqual([
      expect.objectContaining({
        tool: "fetch_linear_workspace",
        args: {
          target: "/initiatives/initiative-1/projects",
          limit: 1,
          include: ["projects"],
          cursor: expect.any(String),
          depth: "full",
        },
      }),
    ]);
    const projects = JSON.parse(
      await readFile(join(out, "initiatives/initiative-1/projects.json"), "utf8"),
    );
    expect(projects).toHaveLength(1);
    await rm(out, { recursive: true, force: true });
  });

  it("rejects initiative project pages that advertise more data without returning records", async () => {
    const out = await tempDir("lebop-workspace-initiative-zero-progress-");
    mocks.getInitiativeProjectsPage
      .mockResolvedValueOnce({
        initiative,
        projects: {
          nodes: [initiative.projects[0]],
          pageInfo: { hasNextPage: true, endCursor: "initiative-project-cursor-1" },
        },
      })
      .mockResolvedValueOnce({
        initiative,
        projects: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: "initiative-project-cursor-2" },
        },
      });

    await expect(
      fetchLinearWorkspace({
        target: "/initiatives/initiative-1",
        include: ["projects"],
        to: out,
        limit: 2,
      }),
    ).rejects.toThrow(/made no progress/);
    await rm(out, { recursive: true, force: true });
  });

  it("writes richer bounded issue context for full project fetches", async () => {
    const out = await tempDir("lebop-workspace-project-full-");
    const issueDocument = {
      ...document,
      id: "project-full-issue-document-1",
      title: "Project full issue document",
      project: null,
      issue: { id: "issue-1", identifier: "NOX-1", title: "Context issue" },
      content: undefined,
    };
    mocks.listIssuesPage.mockResolvedValue({
      nodes: [listedIssue],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    mocks.listCommentsPage.mockResolvedValue({
      comments: [{ id: "comment-1", body: "Comment", updated_at: "now" }],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    mocks.listRelationsPage.mockResolvedValue({
      outbound: [{ id: "relation-1", type: "blocks", otherIdentifier: "NOX-2" }],
      inbound: [],
      complete: true,
      pageInfo: {
        outbound: { hasNextPage: false, endCursor: null },
        inbound: { hasNextPage: false, endCursor: null },
      },
    });
    mocks.listAttachmentsPage.mockResolvedValue({
      attachments: [{ id: "attachment-1", title: "Spec", url: "https://x" }],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    mocks.listDocumentsPage.mockImplementation((opts: { projectId?: string; issueId?: string }) => {
      if (opts.issueId === "issue-1") {
        return Promise.resolve({
          nodes: [issueDocument],
          pageInfo: { hasNextPage: false, endCursor: null },
        });
      }
      return Promise.resolve({
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      });
    });
    mocks.getDocument.mockImplementation((id: string) => {
      if (id === "project-full-issue-document-1") {
        return Promise.resolve({
          ...issueDocument,
          content: "Project full issue document body",
        });
      }
      return Promise.resolve(document);
    });

    const result = await fetchLinearWorkspace({ target: "/projects/project-1", to: out, limit: 5 });

    expect(result.counts.issues).toBe(1);
    expect(result.counts.issue_comments).toBe(1);
    expect(result.counts.issue_relations).toBe(1);
    expect(result.counts.issue_attachments).toBe(1);
    expect(result.counts.issue_documents).toBe(1);
    expect(result.counts.issue_document_details).toBe(1);
    expect(await readFile(join(out, "issues/NOX-1/issue.md"), "utf8")).toContain("Full issue body");
    expect(await readFile(join(out, "issues/NOX-1/comments.md"), "utf8")).toContain("Comment");
    expect(await readFile(join(out, "issues/NOX-1/relations.json"), "utf8")).toContain("NOX-2");
    expect(await readFile(join(out, "issues/NOX-1/attachments.json"), "utf8")).toContain("Spec");
    expect(await readFile(join(out, "issues/NOX-1/documents.json"), "utf8")).toContain(
      "Project full issue document",
    );
    expect(
      await readFile(
        join(out, "issues/NOX-1/documents/project-full-issue-document-1/document.md"),
        "utf8",
      ),
    ).toContain("Project full issue document body");
    await rm(out, { recursive: true, force: true });
  });

  it("keeps full issue dossier output order deterministic while reads run concurrently", async () => {
    const out = await tempDir("lebop-workspace-project-full-order-");
    const issueOne = { ...listedIssue, identifier: "NOX-1", title: "First issue" };
    const issueTwo = { ...listedIssue, identifier: "NOX-2", title: "Second issue" };
    mocks.listIssuesPage.mockResolvedValue({
      nodes: [issueOne, issueTwo],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
    mocks.getIssue.mockImplementation(
      (identifier: string) =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                ...fullIssue,
                identifier,
                title: identifier === "NOX-1" ? "First issue" : "Second issue",
                description: `${identifier} full body`,
              }),
            identifier === "NOX-1" ? 20 : 0,
          );
        }),
    );

    await fetchLinearWorkspace({
      target: "/projects/project-1",
      include: ["issues", "issue_details"],
      to: out,
      limit: 2,
    });

    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    const files = manifest.generated_files as string[];
    const metadata = manifest.generated_file_metadata as Array<{ path: string; role: string }>;
    expect(files.indexOf("issues/NOX-1/issue.md")).toBeLessThan(
      files.indexOf("issues/NOX-2/issue.md"),
    );
    expect(metadata.map((entry) => entry.path)).toEqual(files);
    expect(metadata.find((entry) => entry.path === "index.md")).toMatchObject({
      role: "index",
    });
    expect(await readFile(join(out, "issues/NOX-1/issue.md"), "utf8")).toContain("NOX-1 full body");
    expect(await readFile(join(out, "issues/NOX-2/issue.md"), "utf8")).toContain("NOX-2 full body");
    await rm(out, { recursive: true, force: true });
  });

  it("fetches concrete document dossiers", async () => {
    const out = await tempDir("lebop-workspace-document-");

    const result = await fetchLinearWorkspace({ target: "/documents/document-1", to: out });

    expect(result.kind).toBe("document");
    expect(result.counts.documents).toBe(1);
    expect(result.recommended_reads).toContain("documents/document-1/document.md");
    expect(await readFile(join(out, "documents/document-1/document.md"), "utf8")).toContain(
      "Document body",
    );
    await rm(out, { recursive: true, force: true });
  });

  it("fetches concrete agent-session dossiers", async () => {
    const out = await tempDir("lebop-workspace-agent-session-");

    const result = await fetchLinearWorkspace({ target: "/agent-sessions/session-1", to: out });

    expect(result.kind).toBe("agent_session");
    expect(result.requested_path_kind).toBe("agent_session");
    expect(result.focused_collection).toBeNull();
    expect(result.selected_includes).toEqual([]);
    expect(result.counts.agent_sessions).toBe(1);
    expect(result.recommended_reads).toContain("agent-sessions/session-1/agent-session.md");
    expect(
      await readFile(join(out, "agent-sessions/session-1/agent-session.md"), "utf8"),
    ).toContain("session-1");
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      kind: "agent_session",
      requested_path_kind: "agent_session",
      selected_includes: [],
    });
    await rm(out, { recursive: true, force: true });
  });

  it("returns cursor-backed continuations for truncated issue agent sessions", async () => {
    const out = await tempDir("lebop-workspace-issue-agent-sessions-");
    mocks.listAgentSessionsPage.mockResolvedValueOnce({
      nodes: [agentSession],
      pageInfo: { hasNextPage: true, endCursor: "issue-agent-session-cursor-1" },
      searchedCount: 1,
    });

    const result = await fetchLinearWorkspace({
      target: "/issues/NOX-1/agent-sessions",
      to: out,
      limit: 1,
    });

    expect(result.counts.agent_sessions).toBe(1);
    expect(result.completeness.agent_sessions).toMatchObject({
      complete: false,
      truncated: true,
      reason: "cursor",
    });
    expect(result.continuations).toEqual([
      expect.objectContaining({
        tool: "fetch_linear_workspace",
        args: {
          target: "/issues/NOX-1/agent-sessions",
          limit: 1,
          include: ["agent_sessions"],
          cursor: expect.any(String),
        },
      }),
    ]);
    expect(mocks.listAgentSessionsPage).toHaveBeenCalledWith({
      issueId: "issue-1",
      limit: 1,
    });
    await rm(out, { recursive: true, force: true });
  });

  it("omits document content from markdown, summary, and manifest when include is empty", async () => {
    const out = await tempDir("lebop-workspace-document-shell-");

    const result = await fetchLinearWorkspace({
      target: "/documents/document-1",
      include: [],
      to: out,
    });

    expect(result.omitted).toContain("content");
    const markdown = await readFile(join(out, "documents/document-1/document.md"), "utf8");
    const summary = await readFile(join(out, "summary.json"), "utf8");
    const manifest = await readFile(join(out, "manifest.json"), "utf8");
    expect(markdown).not.toContain("Document body");
    expect(summary).not.toContain("Document body");
    expect(manifest).not.toContain("Document body");
    expect(JSON.parse(summary).document).not.toHaveProperty("content");
    expect(JSON.parse(manifest).document).not.toHaveProperty("content");
    await rm(out, { recursive: true, force: true });
  });

  it("refuses to write into a non-empty unrelated explicit directory", async () => {
    const out = await tempDir("lebop-workspace-dirty-");
    await writeFile(join(out, "notes.txt"), "do not overwrite");

    await expect(
      fetchLinearWorkspace({ target: "/documents/document-1", to: out }),
    ).rejects.toThrow("refusing to write workspace context into non-empty directory");

    await rm(out, { recursive: true, force: true });
  });

  it("refuses an explicit output root that is already locked", async () => {
    const out = await tempDir("lebop-workspace-locked-");
    const lock = join(dirname(out), `.${basename(out)}.lebop-context.lock`);
    await mkdir(lock);

    await expect(
      fetchLinearWorkspace({ target: "/documents/document-1", to: out }),
    ).rejects.toThrow("workspace context output root is already locked");

    await rm(lock, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  });

  it("refuses an explicit output path that is an existing regular file", async () => {
    const out = join(await tempDir("lebop-workspace-file-parent-"), "context-file");
    await writeFile(out, "not a directory");

    await expect(
      fetchLinearWorkspace({ target: "/documents/document-1", to: out }),
    ).rejects.toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("non-directory --to path"),
      hint: "choose a directory for --to",
    });

    await rm(out, { force: true });
    await rm(dirname(out), { recursive: true, force: true });
  });

  it("rejects root-equivalent explicit output roots before fetching Linear data", async () => {
    await expect(
      fetchLinearWorkspace({ target: "/documents/document-1", to: "." }),
    ).rejects.toThrow("root-equivalent workspace context --to path");

    expect(mocks.getDocument).not.toHaveBeenCalled();
  });

  it("refuses a root-equivalent explicit output path before fetching remote data", async () => {
    await expect(
      fetchLinearWorkspace({ target: "/documents/document-1", to: dirname("/") }),
    ).rejects.toThrow("refusing to use root-equivalent workspace context --to path");
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });

  it("refuses a symlinked explicit output root", async () => {
    const target = await tempDir("lebop-workspace-real-root-");
    const link = join(tmpdir(), `lebop-workspace-link-${Date.now()}`);
    await symlink(target, link, "dir");

    await expect(
      fetchLinearWorkspace({ target: "/documents/document-1", to: link }),
    ).rejects.toThrow("refusing to write workspace context into symlinked directory");

    await rm(link, { force: true });
    await rm(target, { recursive: true, force: true });
  });

  it("refuses a missing explicit output root under a symlinked ancestor", async () => {
    const target = await tempDir("lebop-workspace-real-parent-");
    const link = join(tmpdir(), `lebop-workspace-parent-link-${Date.now()}`);
    await symlink(target, link, "dir");
    const out = join(link, "new-context-root");

    await expect(
      fetchLinearWorkspace({ target: "/documents/document-1", to: out }),
    ).rejects.toThrow("refusing to write workspace context through symlinked ancestor");

    await rm(link, { force: true });
    await rm(target, { recursive: true, force: true });
  });

  it("refuses an existing explicit output root under a symlinked ancestor", async () => {
    const target = await tempDir("lebop-workspace-real-existing-parent-");
    const link = join(tmpdir(), `lebop-workspace-existing-parent-link-${Date.now()}`);
    await symlink(target, link, "dir");
    const out = join(link, "existing-context-root");
    await mkdir(out, { recursive: true });

    await expect(
      fetchLinearWorkspace({ target: "/documents/document-1", to: out }),
    ).rejects.toThrow("refusing to write workspace context through symlinked ancestor");

    await rm(link, { force: true });
    await rm(target, { recursive: true, force: true });
  });

  it("rejects explicit repo_root paths outside a git repository", async () => {
    const repoRoot = await tempDir("lebop-workspace-not-a-git-repo-");
    const out = await tempDir("lebop-workspace-repo-root-reject-");

    await expect(
      fetchLinearWorkspace({
        target: "/documents/document-1",
        repoRoot,
        to: out,
      }),
    ).rejects.toThrow(/repo_root is not inside a git repository/);

    expect(mocks.getDocument).not.toHaveBeenCalled();
    await rm(out, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("hashes the containing git root for explicit repo_root paths", async () => {
    const repoRoot = await tempDir("lebop-workspace-git-root-");
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    const nested = join(repoRoot, "nested", "child");
    await mkdir(nested, { recursive: true });

    const result = await fetchLinearWorkspace({
      target: "/documents/document-1",
      repoRoot: nested,
    });

    expect(result.root).toContain(`/context/${hashRepoRoot(repoRoot)}/`);
    await rm(result.root, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("refuses to reuse a context directory with a symlinked generated parent", async () => {
    const out = await tempDir("lebop-workspace-symlink-parent-");
    await fetchLinearWorkspace({ target: "/documents/document-1", to: out });
    await rm(join(out, "documents"), { recursive: true, force: true });
    const outside = await tempDir("lebop-workspace-outside-");
    await mkdir(out, { recursive: true });
    await symlink(outside, join(out, "documents"), "dir");

    await expect(
      fetchLinearWorkspace({ target: "/documents/document-1", to: out }),
    ).rejects.toThrow("refusing to write workspace context through symlinked directory");

    await rm(out, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("refuses root-equivalent generated paths in a prior manifest", async () => {
    const out = await tempDir("lebop-workspace-root-manifest-");
    await fetchLinearWorkspace({ target: "/documents/document-1", to: out });
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    manifest.generated_files = ["."];
    await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(
      fetchLinearWorkspace({ target: "/documents/document-1", to: out }),
    ).rejects.toThrow("refusing to use root-equivalent workspace context path");
    await expect(readFile(join(out, "manifest.json"), "utf8")).resolves.toContain(
      "generated_files",
    );

    await rm(out, { recursive: true, force: true });
  });

  it("uses the normal markdown JSON fence when serialized content has no backtick runs", () => {
    const block = markdownJsonBlock({ count: 1 });

    expect(block.startsWith("\n\n```json\n")).toBe(true);
    expect(block.endsWith("\n```\n")).toBe(true);
  });

  it("uses a longer markdown JSON fence than embedded backtick runs", () => {
    const block = markdownJsonBlock({
      body: "payload containing ``` inside Linear content",
    });

    expect(block.startsWith("\n\n````json\n")).toBe(true);
    expect(block).toContain('"body": "payload containing ``` inside Linear content"');
    expect(block.endsWith("\n````\n")).toBe(true);
  });
});
