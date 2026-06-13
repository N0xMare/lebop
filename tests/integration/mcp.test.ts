/**
 * MCP integration tests. Spawns `bin/lebop mcp` and drives it over JSON-RPC
 * stdio against the same in-process mock Linear GraphQL server used by
 * `cli.test.ts`. Each `describe` block owns its own MCP child so a hung tool
 * call can't poison a sibling test.
 *
 * Coverage targets one representative per surface (read / create / update /
 * archive / delete / cache / plan / lint / raw / error shapes) plus an
 * explicit regression lock for the wave-2 `update_issue` extras-only path,
 * which had zero MCP-level coverage before this file.
 *
 * NOTE on tool selection: the SDK-typed Linear calls (`client.issues()`,
 * `client.issue(identifier)`) trigger huge field fragments and instantiate
 * SDK classes (e.g. `new IssueSharedAccess(data.sharedAccess)`) that throw
 * if the mock isn't a complete-shape Issue. Reproducing that shape would
 * be brittle test infrastructure — a single SDK upgrade changing the
 * fragment breaks every test. We exercise the raw-GraphQL-path siblings
 * instead:
 *   - `get_issue` (raw buildPullIssuesQuery) stands in for the "read" surface
 *   - `create_label` (raw issueLabelCreate) for the "create" surface
 *   - `archive_initiative` (raw initiativeArchive) for the "lifecycle" surface
 * These hit identical handler boundaries (safe() wrapper, error mapping,
 * workspace selection) — only the underlying GraphQL operation differs.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { findGitRoot, hashRepoRoot } from "../../src/lib/config.ts";
import { CAS_QUERY_BATCH_SIZE } from "../../src/lib/pushMutations.ts";
import {
  CONDITIONAL_MCP_CONFIRM_TOOLS,
  REQUIRED_MCP_CONFIRM_TOOLS,
} from "../../src/lib/toolSurfaceManifest.ts";
import { LEBOP_VERSION } from "../../src/lib/version.ts";
import {
  type McpClient,
  type MockServer,
  makeAuthFile,
  startMcpClient,
  startMockLinear,
} from "./harness.ts";

let mock: MockServer;
let lebopHome: string;
let env: Record<string, string>;

beforeAll(async () => {
  mock = await startMockLinear();
  lebopHome = await makeAuthFile("lin_api_test_mcp");
  env = {
    LEBOP_HOME: lebopHome,
    LEBOP_API_URL: mock.url,
    // Pin the workspace so a `workspace` arg isn't needed on every tool call.
    LEBOP_WORKSPACE: "test-workspace",
  };
});

afterAll(async () => {
  await mock.stop();
  await rm(lebopHome, { recursive: true, force: true });
});

afterEach(() => {
  try {
    mock.assertNoPendingResponses();
  } finally {
    mock.reset({ allowPendingResponses: true });
  }
});

/**
 * Bring up an MCP child, handshake, and return the client. Centralized so
 * each test pays the spawn cost only once even if it makes several calls.
 */
async function bootClient(): Promise<McpClient> {
  const client = await startMcpClient(env);
  const init = await client.initialize();
  expect(init.protocolVersion).toBe("2024-11-05");
  await client.notifyInitialized();
  return client;
}

function mcpProjectNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-uuid-icon",
    name: "MCP Icon Project",
    description: null,
    content: null,
    icon: null,
    state: "backlog",
    url: "https://linear.app/test/project/mcp-icon-project",
    updatedAt: "2026-06-04T00:00:00.000Z",
    startDate: null,
    targetDate: null,
    archivedAt: null,
    teams: { nodes: [{ id: "team-uuid-nox", key: "NOX", name: "Noxor" }] },
    lead: null,
    ...overrides,
  };
}

function mcpSdkIssuePayload(
  id: string,
  identifier: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    identifier,
    title: identifier,
    description: "",
    priority: 0,
    estimate: null,
    url: `https://linear.app/test/issue/${identifier}`,
    updatedAt: "2026-06-05T00:00:00.000Z",
    state: { id: "state-backlog", name: "Backlog", type: "backlog" },
    assignee: null,
    project: null,
    team: { id: "team-nox", key: "NOX" },
    parent: null,
    labels: { nodes: [] },
    reactions: [],
    sharedAccess: {
      isShared: false,
      disallowedIssueFields: [],
      sharedWithCount: 0,
      sharedWithUsers: [],
      viewerHasOnlySharedAccess: false,
    },
    labelIds: [],
    previousIdentifiers: [],
    priorityLabel: "No priority",
    branchName: "",
    customerTicketCount: 0,
    trashed: false,
    archivedAt: null,
    createdAt: "2026-06-05T00:00:00.000Z",
    ...overrides,
  };
}

function pageInfo() {
  return {
    hasNextPage: false,
    hasPreviousPage: false,
    startCursor: null,
    endCursor: null,
  };
}

function teamLookupResponse(id = "team-uuid-nox", key = "NOX", name = "Noxor") {
  return {
    data: {
      teams: {
        nodes: [
          {
            id,
            key,
            name,
            description: null,
            defaultIssueState: null,
          },
        ],
      },
    },
  };
}

async function writeCachedIssueFixture(
  home: string,
  identifier: string,
  description: string,
  repoRoot?: string,
) {
  const gitRoot = repoRoot ? findGitRoot(repoRoot) : findGitRoot(process.cwd());
  const repoHash = gitRoot ? hashRepoRoot(gitRoot) : "_global";
  const dir = join(home, "cache", repoHash, "issues", identifier);
  await mkdir(dir, { recursive: true });
  const descriptionHash = createHash("sha256").update(description).digest("hex");
  await writeFile(join(dir, "description.md"), description);
  await writeFile(
    join(dir, "metadata.yaml"),
    [
      `identifier: ${identifier}`,
      "title: Cached title",
      "state: Todo",
      "priority: 0",
      "estimate: null",
      "labels: []",
      "assignee: null",
      "project: null",
      "parent: null",
      "_server:",
      "  id: issue-uuid-eng-99",
      `  identifier: ${identifier}`,
      `  url: https://linear.app/test/issue/${identifier}`,
      "  state_id: state-old",
      "  state_name: Todo",
      "  state_type: unstarted",
      "  priority: 0",
      "  estimate: null",
      "  label_ids: []",
      "  assignee_id: null",
      "  assignee_name: null",
      "  assignee_email: null",
      "  title: Cached title",
      `  description_hash: ${descriptionHash}`,
      "  project_id: null",
      "  project_name: null",
      "  parent_id: null",
      "  parent_identifier: null",
      "  updated_at: 2026-05-01T00:00:00.000Z",
      "",
    ].join("\n"),
  );
  return { repoHash, descriptionPath: join(dir, "description.md") };
}

async function writeCachedProjectFixture(home: string, projectId: string, repoRoot: string) {
  const gitRoot = findGitRoot(repoRoot);
  const repoHash = gitRoot ? hashRepoRoot(gitRoot) : "_global";
  const dir = join(home, "cache", repoHash, "projects", projectId);
  const content = "before content";
  const contentHash = createHash("sha256").update(content).digest("hex");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "metadata.yaml"),
    [
      "name: Cached Project Before",
      "description: before description",
      "icon: Rocket",
      "start_date: null",
      "target_date: null",
      "state: backlog",
      "_server:",
      `  id: ${projectId}`,
      "  url: https://linear.app/test/project/cached-project",
      "  state: backlog",
      "  name: Cached Project Before",
      "  description: before description",
      "  icon: Rocket",
      "  start_date: null",
      "  target_date: null",
      `  content_hash: ${contentHash}`,
      "  updated_at: 2026-06-04T10:00:00.000Z",
      "",
    ].join("\n"),
  );
  await writeFile(join(dir, "content.md"), content);
  return { repoHash, cachePath: dir };
}

function queueTeamMetadataResponses(teamKey = "ENG", labels: { id: string; name: string }[] = []) {
  const teamId = `team-${teamKey.toLowerCase()}`;
  const teamConnections = {
    states: {
      nodes: [
        { id: "state-backlog", name: "Backlog", type: "backlog" },
        { id: "state-todo", name: "Todo", type: "unstarted" },
      ],
      pageInfo: pageInfo(),
    },
    labels: { nodes: labels, pageInfo: pageInfo() },
    members: { nodes: [], pageInfo: pageInfo() },
    projects: { nodes: [], pageInfo: pageInfo() },
  };
  mock.respond({
    data: {
      teams: {
        nodes: [{ id: teamId, key: teamKey, name: "Engineering", description: null }],
        pageInfo: pageInfo(),
      },
    },
  });
  mock.respond({
    data: {
      team: teamConnections,
    },
  });
  mock.respond({
    data: {
      team: teamConnections,
    },
  });
  mock.respond({
    data: {
      team: teamConnections,
    },
  });
  mock.respond({
    data: {
      team: teamConnections,
    },
  });
}

async function makeHomeWithDefaultTeam(team = "NOX"): Promise<string> {
  const home = await makeAuthFile(`lin_api_test_mcp_default_${team.toLowerCase()}`);
  await writeFile(
    join(home, "config.yaml"),
    ["workspace_team_defaults:", `  test-workspace: ${team}`, ""].join("\n"),
  );
  return home;
}

async function bootClientWithHome(home: string): Promise<McpClient> {
  const client = await startMcpClient({ ...env, LEBOP_HOME: home });
  const init = await client.initialize();
  expect(init.protocolVersion).toBe("2024-11-05");
  await client.notifyInitialized();
  return client;
}

const REQUIRED_MCP_CONFIRM_ARGS: Record<string, Record<string, unknown>> = {
  archive_initiative: { id: "11111111-2222-3333-4444-555555555555" },
  archive_issue: { identifiers: ["NOX-1"] },
  delete_attachment: { id: "11111111-2222-3333-4444-555555555555" },
  delete_comment: { id: "11111111-2222-3333-4444-555555555555" },
  delete_document: { id: "11111111-2222-3333-4444-555555555555" },
  delete_initiative: { id: "11111111-2222-3333-4444-555555555555" },
  delete_label: { id: "11111111-2222-3333-4444-555555555555" },
  delete_milestone: { id: "11111111-2222-3333-4444-555555555555" },
  delete_project: { id: "11111111-2222-3333-4444-555555555555" },
  delete_relation: { from: "NOX-1", kind: "related", to: "NOX-2" },
  initiative_remove_project: {
    initiative: "11111111-2222-3333-4444-555555555555",
    project: "22222222-3333-4444-5555-666666666666",
  },
};

function inputSchemaProperties(tool: { inputSchema?: Record<string, unknown> }) {
  const properties = tool.inputSchema?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return {};
  return properties as Record<string, unknown>;
}

describe("mcp: handshake + tools/list", () => {
  let client: McpClient;

  beforeAll(async () => {
    client = await startMcpClient(env);
  });

  afterAll(async () => {
    await client.close();
  });

  it("initialize advertises the 2024-11-05 protocol", async () => {
    const init = await client.initialize();
    expect(init.protocolVersion).toBe("2024-11-05");
    expect(init.serverInfo).toBeDefined();
    expect(init.serverInfo?.version).toBe(LEBOP_VERSION);
    await client.notifyInitialized();
  });

  it("tools/list returns all 85 tools with stable names", async () => {
    const { tools } = await client.listTools();
    // Lock the count so future tool additions are intentional. If you add
    // or remove a tool, bump this number AND verify the new tool has an
    // MCP-level test (not just a lib test).
    expect(tools).toHaveLength(85);

    // Sample-check a representative across surfaces — this is the same set
    // the canary workflow asserts on, so the two stay in sync.
    const names = new Set(tools.map((t) => t.name));
    for (const expected of [
      "list_issues",
      "create_issue",
      "update_issue",
      "archive_issue",
      "delete_label",
      "pull_issues",
      "pull_project",
      "plan_validate",
      "plan_lint",
      "lint_files",
      "lint_text",
      "raw_graphql",
      "list_workspaces",
      "whoami",
      "cache_status",
      "diff_issue",
      "diff_project",
      "get_issue",
      "list_comments",
      "list_documents",
      "list_attachments",
      "update_attachment",
      "delete_attachment",
      "get_team",
      "lookup_state_by_name",
      "lookup_user_by_email",
      "set_workspace_default_team",
      "bulk_update_issues",
      "list_workflow_states",
      "list_teams",
      "delete_relation",
      "update_relations",
      "explore_linear_workspace",
      "fetch_linear_workspace",
      "review_linear_changes",
      "publish_linear_changes",
      "refresh_whoami",
    ]) {
      expect(names.has(expected), `tools/list missing "${expected}"`).toBe(true);
    }
  });

  it("tools/list advertises confirm input for every manifest-required destructive tool", async () => {
    expect(Object.keys(REQUIRED_MCP_CONFIRM_ARGS).toSorted()).toEqual(
      [...REQUIRED_MCP_CONFIRM_TOOLS].toSorted(),
    );

    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of [...REQUIRED_MCP_CONFIRM_TOOLS, ...CONDITIONAL_MCP_CONFIRM_TOOLS]) {
      const tool = byName.get(name);
      expect(tool, `${name} missing from tools/list`).toBeDefined();
      const properties = inputSchemaProperties(tool ?? {});
      expect(properties, `${name} missing confirm input schema`).toHaveProperty("confirm");
    }
  });
});

describe("mcp: list surface parity with CLI defaults", () => {
  async function makeDefaultTeamHome(): Promise<string> {
    const home = await makeAuthFile("lin_api_test_mcp_default_team");
    await writeFile(
      join(home, "config.yaml"),
      ["workspace_team_defaults:", "  test-workspace: NOX", ""].join("\n"),
    );
    return home;
  }

  function queueTeamLookup(key = "NOX") {
    mock.respond({
      data: {
        teams: {
          nodes: [
            {
              id: `team-${key.toLowerCase()}`,
              key,
              name: "Noxor",
              description: null,
              defaultIssueState: null,
            },
          ],
        },
      },
    });
  }

  function queueEmptyIssues() {
    mock.respond({
      data: {
        issues: {
          nodes: [],
          pageInfo: pageInfo(),
        },
      },
    });
  }

  it("list_issues resolves the configured default team when team is omitted", async () => {
    const home = await makeDefaultTeamHome();
    const client = await startMcpClient({
      LEBOP_HOME: home,
      LEBOP_API_URL: mock.url,
      LEBOP_WORKSPACE: "test-workspace",
    });
    try {
      await client.initialize();
      await client.notifyInitialized();
      queueTeamLookup("NOX");
      queueEmptyIssues();

      const r = await client.callTool("list_issues", { limit: 1 });
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      expect(r.parsed).toMatchObject({
        scope: { type: "team", team: "NOX" },
        team: "NOX",
        all_teams: false,
        count: 0,
        limit: 1,
        has_more: false,
        next_cursor: null,
        truncated: false,
      });
      expect(mock.requestAt(0)?.variables).toMatchObject({ key: "NOX" });
      expect(mock.requestAt(1)?.variables.filter).toMatchObject({
        team: { key: { eq: "NOX" } },
      });
    } finally {
      await client.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("list_issues keeps the explicit all_teams escape hatch workspace-wide", async () => {
    const home = await makeDefaultTeamHome();
    const client = await startMcpClient({
      LEBOP_HOME: home,
      LEBOP_API_URL: mock.url,
      LEBOP_WORKSPACE: "test-workspace",
    });
    try {
      await client.initialize();
      await client.notifyInitialized();
      queueEmptyIssues();

      const r = await client.callTool("list_issues", { all_teams: true, limit: 1 });
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      expect(r.parsed).toMatchObject({
        scope: { type: "all", team: null },
        team: null,
        all_teams: true,
      });
      const variables = mock.requestAt(0)?.variables as { filter?: { team?: unknown } } | undefined;
      expect(variables?.filter?.team).toBeUndefined();
    } finally {
      await client.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("list_issues forwards continuation cursors", async () => {
    const home = await makeDefaultTeamHome();
    const client = await startMcpClient({
      LEBOP_HOME: home,
      LEBOP_API_URL: mock.url,
      LEBOP_WORKSPACE: "test-workspace",
    });
    try {
      await client.initialize();
      await client.notifyInitialized();
      queueEmptyIssues();

      const r = await client.callTool("list_issues", {
        all_teams: true,
        limit: 1,
        cursor: "cursor-1",
      });
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      expect(r.parsed).toMatchObject({ count: 0, has_more: false, next_cursor: null });
      expect(mock.requestAt(0)?.variables).toMatchObject({ after: "cursor-1" });
    } finally {
      await client.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("list_issues can express CLI mine active-work semantics in one call", async () => {
    const client = await bootClient();
    try {
      queueTeamLookup("NOX");
      mock.respond({
        data: {
          viewer: {
            id: "viewer-id",
            name: "Test Viewer",
            email: "viewer@example.com",
          },
        },
      });
      queueEmptyIssues();

      const r = await client.callTool("list_issues", {
        team: "NOX",
        assignee: "me",
        active_only: true,
        limit: 1,
      });
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      expect(mock.requestAt(2)?.variables.filter).toMatchObject({
        assignee: { id: { eq: "viewer-id" } },
        state: { type: { in: ["triage", "backlog", "unstarted", "started"] } },
        team: { key: { eq: "NOX" } },
      });
    } finally {
      await client.close();
    }
  });

  it("list_cycles resolves the configured default team and preserves all_teams", async () => {
    const home = await makeDefaultTeamHome();
    const client = await startMcpClient({
      LEBOP_HOME: home,
      LEBOP_API_URL: mock.url,
      LEBOP_WORKSPACE: "test-workspace",
    });
    try {
      await client.initialize();
      await client.notifyInitialized();
      mock.respond({
        data: {
          teams: {
            nodes: [
              {
                id: "team-nox",
                key: "NOX",
                name: "Noxor",
                description: null,
                defaultIssueState: null,
              },
            ],
          },
        },
      });
      mock.respond({
        data: {
          cycles: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });

      let r = await client.callTool("list_cycles", { limit: 1 });
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      expect(mock.requestAt(1)?.variables.filter).toMatchObject({
        team: { key: { eq: "NOX" } },
      });

      mock.reset();
      mock.respond({
        data: {
          cycles: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
      r = await client.callTool("list_cycles", { all_teams: true, limit: 1 });
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      expect(mock.requestAt(0)?.variables.filter).toBeUndefined();
    } finally {
      await client.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("list_projects resolves the configured default team and preserves all_teams", async () => {
    const home = await makeDefaultTeamHome();
    const client = await startMcpClient({
      LEBOP_HOME: home,
      LEBOP_API_URL: mock.url,
      LEBOP_WORKSPACE: "test-workspace",
    });
    try {
      await client.initialize();
      await client.notifyInitialized();
      mock.respond({
        data: {
          teams: {
            nodes: [{ id: "team-nox", key: "NOX", name: "Noxor", description: null }],
            pageInfo: pageInfo(),
          },
        },
      });
      mock.respond({
        data: {
          team: {
            projects: {
              nodes: [],
              pageInfo: pageInfo(),
            },
          },
        },
      });

      let r = await client.callTool("list_projects", { include_archived: true, limit: 1 });
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      expect(r.parsed).toMatchObject({
        team: "NOX",
        count: 0,
        limit: 1,
        has_more: false,
        next_cursor: null,
        truncated: false,
        projects: [],
      });
      expect(mock.requestAt(0)?.variables.filter).toMatchObject({
        key: { eq: "NOX" },
      });
      expect(mock.requestAt(1)?.variables).toMatchObject({
        id: "team-nox",
        includeArchived: true,
      });

      mock.reset();
      mock.respond({
        data: {
          projects: {
            nodes: [],
            pageInfo: pageInfo(),
          },
        },
      });
      r = await client.callTool("list_projects", {
        all_teams: true,
        include_archived: true,
        limit: 1,
        cursor: "project-cursor-prev",
      });
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      expect(r.parsed).toMatchObject({
        team: "*",
        count: 0,
        limit: 1,
        has_more: false,
        next_cursor: null,
        truncated: false,
        projects: [],
      });
      expect(mock.requestAt(0)?.variables).toMatchObject({
        after: "project-cursor-prev",
        includeArchived: true,
      });
      expect(mock.requestAt(0)?.variables.filter).toBeUndefined();
    } finally {
      await client.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("list_labels resolves the configured default team and returns explicit scope", async () => {
    const home = await makeDefaultTeamHome();
    const client = await startMcpClient({
      LEBOP_HOME: home,
      LEBOP_API_URL: mock.url,
      LEBOP_WORKSPACE: "test-workspace",
    });
    try {
      await client.initialize();
      await client.notifyInitialized();
      queueTeamLookup("NOX");
      mock.respond({
        data: {
          issueLabels: {
            nodes: [
              {
                id: "label-team",
                name: "Team Label",
                color: "#ff0000",
                description: null,
                team: { id: "team-nox", key: "NOX", name: "Noxor" },
              },
            ],
            pageInfo: pageInfo(),
          },
        },
      });

      let r = await client.callTool("list_labels", {});
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      expect(r.parsed).toMatchObject({
        scope: { type: "team", team: "NOX" },
        team: "NOX",
        count: 1,
      });
      expect(mock.requestAt(0)?.variables).toMatchObject({ key: "NOX" });
      expect(mock.requestAt(1)?.variables.filter).toMatchObject({
        or: [{ team: { key: { eq: "NOX" } } }, { team: { null: true } }],
      });

      mock.reset();
      mock.respond({
        data: {
          issueLabels: {
            nodes: [],
            pageInfo: pageInfo(),
          },
        },
      });
      r = await client.callTool("list_labels", { all: true });
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      expect(r.parsed).toMatchObject({ scope: { type: "all", team: null }, team: null });
      expect(mock.requestAt(0)?.variables.filter).toBeUndefined();

      mock.reset();
      mock.respond({
        data: {
          issueLabels: {
            nodes: [],
            pageInfo: pageInfo(),
          },
        },
      });
      r = await client.callTool("list_labels", { workspace_only: true });
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      expect(r.parsed).toMatchObject({
        scope: { type: "workspace", team: null },
        team: null,
      });
      expect(mock.requestAt(0)?.variables.filter).toMatchObject({ team: { null: true } });
    } finally {
      await client.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("list_initiatives forwards owner_id like CLI initiative list --owner-id", async () => {
    const client = await bootClient();
    try {
      mock.respond({
        data: {
          initiatives: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });

      const r = await client.callTool("list_initiatives", { owner_id: "user-1", limit: 1 });
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      expect(mock.requestAt(0)?.variables.filter).toMatchObject({
        owner: { id: { eq: "user-1" } },
      });
    } finally {
      await client.close();
    }
  });
});

describe("mcp: read surface (get_issue + list_workspaces)", () => {
  let client: McpClient;

  beforeAll(async () => {
    client = await bootClient();
  });

  afterAll(async () => {
    await client.close();
  });

  it("get_issue returns a structured envelope with the issue payload", async () => {
    // getIssue uses the lebop-owned buildPullIssuesQuery (multi-alias). We
    // get to define the exact shape Linear "returns" — no SDK class
    // reconstruction in the way.
    mock.respond({
      data: {
        a0: {
          id: "issue-uuid-eng-1",
          identifier: "ENG-1",
          title: "First issue",
          description: "body",
          priority: 2,
          estimate: null,
          url: "https://linear.app/test/issue/ENG-1",
          updatedAt: "2026-05-01T00:00:00.000Z",
          state: { id: "state-1", name: "Todo", type: "unstarted" },
          assignee: null,
          project: null,
          team: { id: "team-eng", key: "ENG" },
          parent: null,
          labels: { nodes: [] },
        },
      },
    });

    const r = await client.callTool("get_issue", { identifier: "ENG-1" });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      schema_version: number;
      issue: {
        metadata: { identifier: string; title: string };
        description: string;
        comments: unknown[];
        relations: { outbound: unknown[]; inbound: unknown[] };
      };
    };
    expect(body.schema_version).toBe(1);
    expect(body.issue.metadata.identifier).toBe("ENG-1");
    expect(body.issue.metadata.title).toBe("First issue");
    expect(body.issue.description).toBe("body");
    expect(body.issue.comments).toEqual([]);
    expect(body.issue.relations).toEqual({ outbound: [], inbound: [] });
    expect(body.issue).toMatchObject({
      completeness: {
        comments: { complete: true, has_more: false, count: 0 },
        relations: { complete: true, has_more: false, outbound_count: 0, inbound_count: 0 },
      },
    });
  });

  it("get_issue completes comment overflow and marks relation overflow", async () => {
    mock.respond({
      data: {
        a0: {
          id: "issue-uuid-eng-2",
          identifier: "ENG-2",
          title: "Overflow issue",
          description: "body",
          priority: 2,
          estimate: null,
          url: "https://linear.app/test/issue/ENG-2",
          updatedAt: "2026-05-01T00:00:00.000Z",
          state: { id: "state-1", name: "Todo", type: "unstarted" },
          assignee: null,
          project: null,
          team: { id: "team-eng", key: "ENG" },
          parent: null,
          labels: { nodes: [] },
          comments: {
            nodes: [
              {
                id: "c-1",
                body: "inline comment",
                createdAt: "2026-05-01T01:00:00.000Z",
                updatedAt: "2026-05-01T01:00:00.000Z",
                user: null,
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: "comment-cursor-1" },
          },
          relations: {
            nodes: [
              {
                id: "rel-1",
                type: "blocks",
                relatedIssue: { id: "issue-3", identifier: "ENG-3", title: "Blocked" },
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: "relation-cursor-1" },
          },
          inverseRelations: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
    mock.respond({
      data: {
        issue: {
          comments: {
            nodes: [
              {
                id: "c-2",
                body: "overflow comment",
                createdAt: "2026-05-01T02:00:00.000Z",
                updatedAt: "2026-05-01T02:00:00.000Z",
                user: null,
              },
            ],
            pageInfo: pageInfo(),
          },
        },
      },
    });

    const r = await client.callTool("get_issue", { identifier: "ENG-2" });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      issue: {
        comments: { frontmatter: { id: string } }[];
        completeness: {
          comments: { complete: boolean; count: number; next_cursor: string | null };
          relations: {
            complete: boolean;
            has_more: boolean;
            next_cursor: { outbound: string | null; inbound: string | null };
            continuation?: {
              tool: string;
              arguments: { identifier: string };
              reason: string;
            };
          };
        };
      };
    };
    expect(body.issue.comments.map((c) => c.frontmatter.id)).toEqual(["c-1", "c-2"]);
    expect(body.issue.completeness.comments).toMatchObject({
      complete: true,
      count: 2,
      next_cursor: null,
    });
    expect(body.issue.completeness.relations).toMatchObject({
      complete: false,
      has_more: true,
      next_cursor: { outbound: "relation-cursor-1", inbound: null },
      continuation: {
        tool: "list_relations",
        arguments: { identifier: "ENG-2" },
      },
    });
    expect(body.issue.completeness.relations.continuation?.reason).toContain(
      "complete relation graph",
    );
    expect(mock.requestAt(1)?.variables).toMatchObject({
      id: "ENG-2",
      first: 250,
      after: "comment-cursor-1",
    });
  });

  it("list_workspaces (pure-local) returns the configured workspace", async () => {
    // Pure-local tool — exercises the safe() wrapper + envelope shape
    // without any network mocking. Belt-and-braces coverage that the
    // stdio transport survives a no-Linear call cleanly.
    const r = await client.callTool("list_workspaces", {});
    expect(r.isError).toBeFalsy();
    const body = r.parsed as {
      auth_file: string;
      auth_storage: string;
      default: string;
      workspaces: { slug: string; is_default: boolean }[];
    };
    expect(body.auth_file).toBe("LEBOP_HOME/auth.json");
    expect(body.auth_storage).toBe("lebop-home-auth-json");
    expect(body.auth_file).not.toContain(lebopHome);
    expect(body.default).toBe("test-workspace");
    expect(body.workspaces.some((w) => w.slug === "test-workspace" && w.is_default)).toBe(true);
  });

  it("list_workspaces accepts omitted MCP arguments", async () => {
    const r = await client.callToolOmittingArguments("list_workspaces");
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { schema_version: number; default: string };
    expect(body.schema_version).toBe(1);
    expect(body.default).toBe("test-workspace");
  });

  it("list_teams returns a compact team index", async () => {
    mock.respond({
      data: {
        teams: {
          nodes: [{ id: "team-eng", key: "ENG", name: "Engineering", description: null }],
          pageInfo: pageInfo(),
        },
      },
    });

    const r = await client.callTool("list_teams", {});
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { teams: { id: string; key: string; name: string }[] };
    expect(body.teams[0]).toMatchObject({ id: "team-eng", key: "ENG", name: "Engineering" });
  });

  it("explore_linear_workspace returns ls-style top-level paths", async () => {
    const r = await client.callTool("explore_linear_workspace", { path: "/" });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      path: string;
      items: { kind: string; path: string }[];
      next_paths: string[];
    };
    expect(body.path).toBe("/");
    expect(body.items.some((item) => item.path === "/projects")).toBe(true);
    expect(body.next_paths).toContain("/teams");
  });

  it("explore_linear_workspace exposes Linear API budget metadata when headers are present", async () => {
    const reset = 1_787_000_000_000;
    mock.respond({
      headers: {
        "x-ratelimit-requests-limit": "2500",
        "x-ratelimit-requests-remaining": "2499",
        "x-ratelimit-requests-reset": String(reset),
        "x-complexity": "12",
        "x-ratelimit-complexity-limit": "3000000",
        "x-ratelimit-complexity-remaining": "2999988",
        "x-ratelimit-complexity-reset": String(reset),
      },
      data: {
        projects: {
          nodes: [
            mcpProjectNode({
              id: "workspace-mcp-meta-project",
              name: "Workspace MCP Meta Project",
            }),
          ],
          pageInfo: pageInfo(),
        },
      },
    });

    const r = await client.callTool("explore_linear_workspace", { path: "/projects" });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      _meta?: {
        linear_api?: {
          request_count: number;
          rate_limit: {
            requests?: { limit: number; remaining: number; reset_at: string };
            complexity?: { used: number; limit: number; remaining: number };
          };
        };
      };
    };
    expect(body._meta?.linear_api).toMatchObject({
      request_count: 1,
      rate_limit: {
        requests: {
          limit: 2500,
          remaining: 2499,
          reset_at: new Date(reset).toISOString(),
        },
        complexity: {
          used: 12,
          limit: 3000000,
          remaining: 2999988,
        },
      },
    });
  });

  it("fetch_linear_workspace materializes an issue dossier", async () => {
    const out = await mkdtemp(join(tmpdir(), "lebop-mcp-context-"));
    mock.respond({
      data: {
        a0: {
          id: "issue-uuid-eng-2",
          identifier: "ENG-2",
          title: "Context issue",
          description: "body",
          priority: 2,
          estimate: null,
          url: "https://linear.app/test/issue/ENG-2",
          updatedAt: "2026-05-01T00:00:00.000Z",
          state: { id: "state-1", name: "Todo", type: "unstarted" },
          assignee: null,
          project: null,
          team: { id: "team-eng", key: "ENG" },
          parent: null,
          labels: { nodes: [] },
        },
      },
    });
    mock.respond({
      data: {
        issue: {
          comments: {
            nodes: [],
            pageInfo: pageInfo(),
          },
        },
      },
    });
    mock.respond({
      data: {
        issue: {
          relations: { nodes: [] },
          inverseRelations: { nodes: [] },
        },
      },
    });
    mock.respond({
      data: {
        issue: {
          attachments: {
            nodes: [],
            pageInfo: pageInfo(),
          },
        },
      },
    });
    mock.respond({
      data: {
        documents: {
          nodes: [],
          pageInfo: pageInfo(),
        },
      },
    });

    const r = await client.callTool("fetch_linear_workspace", {
      target: "/issues/ENG-2",
      to: out,
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      root: string;
      counts: Record<string, number>;
      manifest_file: string;
      recommended_reads: string[];
    };
    expect(body.root).toBe(out);
    expect(body.counts.issues).toBe(1);
    expect(body.recommended_reads).toContain("index.md");
    const manifest = JSON.parse(await readFile(body.manifest_file, "utf8"));
    expect(manifest.kind).toBe("issue");
    expect(manifest.counts.issues).toBe(1);
    await rm(out, { recursive: true, force: true });
  });

  it("review_linear_changes then publish_linear_changes publishes and verifies a plan", async () => {
    const planDir = await mkdtemp(join(tmpdir(), "lebop-mcp-publish-plan-"));
    await writeFile(
      join(planDir, "_project.md"),
      "---\nname: MCP Publish Project\nteam: ENG\nstate: backlog\n---\n\nMCP publish body.\n",
    );

    queueTeamMetadataResponses("ENG");
    const review = await client.callTool("review_linear_changes", {
      source: { kind: "plan", dir: planDir },
    });
    expect(review.isError, JSON.stringify(review.parsed)).toBeFalsy();
    const reviewed = review.parsed as {
      review_id: string;
      ready: boolean;
      next: { arguments: { review_id: string; workspace: string } };
    };
    expect(reviewed.ready).toBe(true);
    expect(reviewed.review_id).toMatch(/^pub_/);
    expect(reviewed.next.arguments.review_id).toBe(reviewed.review_id);
    expect(reviewed.next.arguments.workspace).toBe("test-workspace");

    mock.respond({
      data: {
        projectCreate: {
          success: true,
          project: mcpProjectNode({
            id: "33333333-4444-5555-6666-777777777777",
            name: "MCP Publish Project",
            description: "",
            content: "MCP publish body.",
            state: "backlog",
            updatedAt: "2026-06-04T12:00:00.000Z",
          }),
        },
      },
    });
    mock.respond({
      data: {
        project: {
          id: "33333333-4444-5555-6666-777777777777",
          name: "MCP Publish Project",
          description: "",
          content: "MCP publish body.",
          icon: null,
          state: "backlog",
          url: "https://linear.app/test/project/mcp-publish-project",
          updatedAt: "2026-06-04T12:00:00.000Z",
        },
      },
    });
    mock.respond({
      data: {
        project: {
          issues: {
            nodes: [],
            pageInfo: pageInfo(),
          },
        },
      },
    });

    const applied = await client.callTool("publish_linear_changes", {
      review_id: reviewed.review_id,
    });
    expect(applied.isError, JSON.stringify(applied.parsed)).toBeFalsy();
    const body = applied.parsed as {
      status: string;
      verification: { has_drift: boolean };
    };
    expect(body.status).toBe("verified");
    expect(body.verification.has_drift).toBe(false);
    const projectFile = await readFile(join(planDir, "_project.md"), "utf8");
    expect(projectFile).toContain("linear_id: 33333333-4444-5555-6666-777777777777");
    await rm(planDir, { recursive: true, force: true });
  });

  it("publish_linear_changes refuses when reviewed remote project changed", async () => {
    const planDir = await mkdtemp(join(tmpdir(), "lebop-mcp-publish-cas-"));
    const projectId = "44444444-5555-6666-7777-888888888888";
    await writeFile(
      join(planDir, "_project.md"),
      `---\nname: MCP CAS Project\nteam: CAS\nstate: backlog\nlinear_id: ${projectId}\n---\n\nExisting body.\n`,
    );

    queueTeamMetadataResponses("CAS");
    mock.respond({
      data: {
        project: mcpProjectNode({
          id: projectId,
          name: "MCP CAS Project",
          description: "",
          content: "Existing body.",
          state: "backlog",
          updatedAt: "2026-06-04T12:00:00.000Z",
        }),
      },
    });
    mock.respond({
      data: {
        project: mcpProjectNode({
          id: projectId,
          name: "MCP CAS Project",
          description: "",
          content: "Existing body.",
          state: "backlog",
          updatedAt: "2026-06-04T12:00:00.000Z",
        }),
      },
    });
    mock.respond({
      data: { project: { issues: { nodes: [], pageInfo: pageInfo() } } },
    });
    mock.respond({
      data: {
        project: mcpProjectNode({
          id: projectId,
          name: "MCP CAS Project",
          description: "",
          content: "Existing body.",
          state: "backlog",
          updatedAt: "2026-06-04T12:00:00.000Z",
        }),
      },
    });
    mock.respond({
      data: {
        project: mcpProjectNode({
          id: projectId,
          name: "MCP CAS Project",
          description: "",
          content: "Existing body.",
          state: "backlog",
          updatedAt: "2026-06-04T12:00:00.000Z",
        }),
      },
    });
    const review = await client.callTool("review_linear_changes", {
      source: { kind: "plan", dir: planDir },
    });
    expect(review.isError, JSON.stringify(review.parsed)).toBeFalsy();
    const reviewed = review.parsed as { review_id: string; ready: boolean };
    expect(reviewed.ready).toBe(true);

    mock.respond({
      data: {
        project: mcpProjectNode({
          id: projectId,
          name: "MCP CAS Project",
          description: "",
          content: "Changed elsewhere.",
          state: "backlog",
          updatedAt: "2026-06-04T12:01:00.000Z",
        }),
      },
    });
    mock.respond({
      data: { project: { issues: { nodes: [], pageInfo: pageInfo() } } },
    });
    mock.respond({
      data: {
        project: mcpProjectNode({
          id: projectId,
          name: "MCP CAS Project",
          description: "",
          content: "Changed elsewhere.",
          state: "backlog",
          updatedAt: "2026-06-04T12:01:00.000Z",
        }),
      },
    });
    mock.respond({
      data: {
        project: mcpProjectNode({
          id: projectId,
          name: "MCP CAS Project",
          description: "",
          content: "Changed elsewhere.",
          state: "backlog",
          updatedAt: "2026-06-04T12:01:00.000Z",
        }),
      },
    });

    const applied = await client.callTool("publish_linear_changes", {
      review_id: reviewed.review_id,
    });
    expect(applied.isError).toBeFalsy();
    const body = applied.parsed as {
      status: string;
      summary: { ready: boolean; blockers: string[] };
    };
    expect(body.status).toBe("blocked");
    expect(body.summary.ready).toBe(false);
    expect(body.summary.blockers.join("\n")).toContain("Linear changed after publish review");
    await rm(planDir, { recursive: true, force: true });
  });

  it("plan_apply blocks non-dry-run apply before mutations when external references are unresolved", async () => {
    const planDir = await mkdtemp(join(tmpdir(), "lebop-mcp-plan-preflight-"));
    await writeFile(
      join(planDir, "_project.md"),
      "---\nname: MCP Preflight Plan\nteam: MPP\n---\n",
    );
    await writeFile(
      join(planDir, "01-child.md"),
      "---\ntitle: Child\nparent: MPP-404\n---\n\nChild body.\n",
    );
    queueTeamMetadataResponses("MPP");
    mock.respond({ data: { issue: null } });

    const applied = await client.callTool("plan_apply", { dir: planDir });

    expect(applied.isError, JSON.stringify(applied.parsed)).toBeFalsy();
    const body = applied.parsed as {
      dry_run: boolean;
      preflight: { ready: boolean; blockers: string[] };
    };
    expect(body.dry_run).toBe(false);
    expect(body.preflight.ready).toBe(false);
    expect(body.preflight.blockers.join("\n")).toContain("parent not found: MPP-404");
    expect(mock.requestAt(5)?.query).toContain("issue");
    expect(mock.requestAt(6)).toBeUndefined();
    await rm(planDir, { recursive: true, force: true });
  });

  it("force modes require confirm:true before Linear I/O", async () => {
    const planDir = await mkdtemp(join(tmpdir(), "lebop-mcp-force-confirm-"));
    await writeFile(
      join(planDir, "_project.md"),
      "---\nname: MCP Force Confirm Plan\nteam: MFC\n---\n",
    );

    const pushed = await client.callTool("push_changes", { force: true, team: "MFC" });
    expect(pushed.isError).toBe(true);
    expect((pushed.parsed as { error: { message: string } }).error.message).toContain(
      "confirm: true",
    );

    const applied = await client.callTool("plan_apply", { dir: planDir, force: true });
    expect(applied.isError).toBe(true);
    expect((applied.parsed as { error: { message: string } }).error.message).toContain(
      "confirm: true",
    );

    const pulled = await client.callTool("plan_pull", { dir: planDir, force: true });
    expect(pulled.isError).toBe(true);
    expect((pulled.parsed as { error: { message: string } }).error.message).toContain(
      "confirm: true",
    );
    expect(mock.requestAt(0)).toBeUndefined();
    await rm(planDir, { recursive: true, force: true });
  });

  it("force dry-runs do not require confirm:true", async () => {
    const planDir = await mkdtemp(join(tmpdir(), "lebop-mcp-force-dry-run-"));
    await writeFile(
      join(planDir, "_project.md"),
      "---\nname: MCP Force Dry Run Plan\nteam: MFD\n---\n",
    );

    const pushed = await client.callTool("push_changes", {
      force: true,
      dry_run: true,
      team: "MFD",
    });
    expect(pushed.isError, JSON.stringify(pushed.parsed)).toBeFalsy();
    const pushBody = pushed.parsed as {
      mode: string;
      results: unknown[];
      notes?: string;
    };
    expect(pushBody.mode).toBe("cache");
    expect(pushBody.results).toEqual([]);
    expect(pushBody.notes).toContain("dry-run");
    expect(mock.requestAt(0)).toBeUndefined();

    queueTeamMetadataResponses("MFD");
    const applied = await client.callTool("plan_apply", {
      dir: planDir,
      force: true,
      dry_run: true,
    });
    expect(applied.isError, JSON.stringify(applied.parsed)).toBeFalsy();
    const applyBody = applied.parsed as {
      dry_run: boolean;
      project: { status: string };
    };
    expect(applyBody.dry_run).toBe(true);
    expect(applyBody.project.status).toBe("dry-run");
    await rm(planDir, { recursive: true, force: true });
  });

  it("review_linear_changes blocks plan-source missing remotes before publish", async () => {
    const planDir = await mkdtemp(join(tmpdir(), "lebop-mcp-publish-missing-"));
    const projectId = "55555555-6666-7777-8888-999999999999";
    await writeFile(
      join(planDir, "_project.md"),
      `---\nname: Missing Project\nteam: MIS\nstate: backlog\nlinear_id: ${projectId}\n---\n\nMissing body.\n`,
    );

    queueTeamMetadataResponses("MIS");
    mock.respond({ data: { project: null } });
    mock.respond({ data: { project: null } });

    const review = await client.callTool("review_linear_changes", {
      source: { kind: "plan", dir: planDir },
    });
    expect(review.isError, JSON.stringify(review.parsed)).toBeFalsy();
    const reviewed = review.parsed as {
      ready: boolean;
      summary: { blockers: string[]; drift: boolean };
      preview: unknown;
    };
    expect(reviewed.ready).toBe(false);
    expect(reviewed.summary.blockers.join("\n")).toContain("remote project is missing");
    expect(reviewed.summary.blockers.join("\n")).toContain(projectId);
    expect(reviewed.preview).toBeNull();
    await rm(planDir, { recursive: true, force: true });
  });

  it("review_linear_changes rejects nested cache selector typos", async () => {
    const result = await client.callTool("review_linear_changes", {
      source: { kind: "cache", identifier: ["NOX-1"] },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.parsed)).toContain("unrecognized");
    expect(JSON.stringify(result.parsed)).toContain("source.identifier");
  });
});

describe("mcp: create / lifecycle / delete (raw-path representatives)", () => {
  let client: McpClient;

  beforeAll(async () => {
    client = await bootClient();
  });

  afterAll(async () => {
    await client.close();
  });

  it("manifest-required destructive tools reject missing confirm:true before Linear I/O", async () => {
    expect(Object.keys(REQUIRED_MCP_CONFIRM_ARGS).toSorted()).toEqual(
      [...REQUIRED_MCP_CONFIRM_TOOLS].toSorted(),
    );

    for (const name of REQUIRED_MCP_CONFIRM_TOOLS) {
      mock.reset();
      const r = await client.callTool(name, REQUIRED_MCP_CONFIRM_ARGS[name] ?? {});
      expect(r.isError, `${name} accepted missing confirm:true`).toBe(true);
      const body = r.parsed as { error?: { code?: string; message?: string } };
      expect(body.error?.code, name).toBe("validation_error");
      expect(body.error?.message, name).toContain(`${name} requires confirm: true`);
      expect(mock.requestAt(0), `${name} queried Linear before confirm:true`).toBeUndefined();
    }
  });

  it("cache_gc requires confirm:true only when dry_run:false", async () => {
    expect(CONDITIONAL_MCP_CONFIRM_TOOLS).toContain("cache_gc");

    let r = await client.callTool("cache_gc", { dry_run: false, max_age_days: 0 });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.parsed)).toContain("cache_gc requires confirm: true");
    expect(mock.requestAt(0)).toBeUndefined();

    r = await client.callTool("cache_gc", { dry_run: true, max_age_days: 0 });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    expect((r.parsed as { dry_run?: boolean }).dry_run).toBe(true);
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("project and initiative update empty bodies reject before lookup", async () => {
    let r = await client.callTool("create_project_update", {
      project: "Missing Project",
      body: " \n\t",
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.parsed)).toContain("empty project update body");
    expect(mock.requestAt(0)).toBeUndefined();

    r = await client.callTool("create_initiative_update", {
      initiative: "Missing Initiative",
      body: " \n\t",
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.parsed)).toContain("empty initiative update body");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("create_label returns the new label payload (raw create path)", async () => {
    // createLabel is a single raw issueLabelCreate mutation — no team
    // metadata fetch needed for a workspace-scoped label (no team_id).
    mock.respond({
      data: {
        issueLabelCreate: {
          success: true,
          issueLabel: {
            id: "label-uuid-aaaa",
            name: "needs-design",
            color: "#ff0000",
            description: "from mcp test",
            team: null,
          },
        },
      },
    });

    const r = await client.callTool("create_label", {
      name: "needs-design",
      scope: "workspace",
      color: "#ff0000",
      description: "from mcp test",
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { label: { id: string; name: string } };
    expect(body.label.name).toBe("needs-design");
    expect(body.label.id).toBe("label-uuid-aaaa");
  });

  it("create_label resolves team key inside the same MCP call", async () => {
    mock.respond(teamLookupResponse());
    mock.respond({
      data: {
        issueLabelCreate: {
          success: true,
          issueLabel: {
            id: "label-uuid-team",
            name: "team-label",
            color: "#00ff00",
            description: null,
            team: { id: "team-uuid-nox", key: "NOX", name: "Noxor" },
          },
        },
      },
    });

    const r = await client.callTool("create_label", {
      name: "team-label",
      scope: "team",
      team: "NOX",
      color: "#00ff00",
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { label: { id: string; team: { key: string } } };
    expect(body.label.id).toBe("label-uuid-team");
    expect(body.label.team.key).toBe("NOX");
    expect(mock.requestAt(0)?.variables).toMatchObject({ key: "NOX" });
    expect(mock.requestAt(1)?.variables).toMatchObject({
      input: { name: "team-label", teamId: "team-uuid-nox", color: "#00ff00" },
    });
    expect(mock.requestAt(2)).toBeUndefined();
  });

  it("create_label defaults omitted scope to the configured team", async () => {
    const home = await makeHomeWithDefaultTeam("NOX");
    const scopedClient = await bootClientWithHome(home);
    try {
      mock.respond(teamLookupResponse());
      mock.respond({
        data: {
          issueLabelCreate: {
            success: true,
            issueLabel: {
              id: "label-uuid-default-team",
              name: "default-team-label",
              color: "#00aa00",
              description: null,
              team: { id: "team-uuid-nox", key: "NOX", name: "Noxor" },
            },
          },
        },
      });

      const r = await scopedClient.callTool("create_label", {
        name: "default-team-label",
        color: "#00aa00",
      });
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      const body = r.parsed as {
        label: { id: string; team: { key: string } };
        scope: string;
        team: string;
        team_id: string;
      };
      expect(body.scope).toBe("team");
      expect(body.team).toBe("NOX");
      expect(body.team_id).toBe("team-uuid-nox");
      expect(body.label.team.key).toBe("NOX");
      expect(mock.requestAt(0)?.variables).toMatchObject({ key: "NOX" });
      expect(mock.requestAt(1)?.variables).toMatchObject({
        input: { name: "default-team-label", teamId: "team-uuid-nox", color: "#00aa00" },
      });
    } finally {
      await scopedClient.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("create_project passes icon through to ProjectCreateInput", async () => {
    mock.respond({
      data: {
        projectCreate: {
          success: true,
          project: mcpProjectNode({ icon: "Rocket" }),
        },
      },
    });

    const r = await client.callTool("create_project", {
      name: "MCP Icon Project",
      team_ids: ["team-uuid-nox"],
      icon: "Rocket",
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { project: { icon: string | null } };
    expect(body.project.icon).toBe("Rocket");
    expect(mock.requestAt(0)?.variables).toMatchObject({
      input: { name: "MCP Icon Project", teamIds: ["team-uuid-nox"], icon: "Rocket" },
    });
  });

  it("create_project resolves a team key inside the same MCP call", async () => {
    mock.respond(teamLookupResponse());
    mock.respond({
      data: {
        projectCreate: {
          success: true,
          project: mcpProjectNode({ icon: "Rocket" }),
        },
      },
    });

    const r = await client.callTool("create_project", {
      name: "MCP Icon Project",
      team: "NOX",
      icon: "Rocket",
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { project: { id: string; icon: string | null } };
    expect(body.project.id).toBe("project-uuid-icon");
    expect(body.project.icon).toBe("Rocket");
    expect(mock.requestAt(0)?.variables).toMatchObject({ key: "NOX" });
    expect(mock.requestAt(1)?.variables).toMatchObject({
      input: { name: "MCP Icon Project", teamIds: ["team-uuid-nox"], icon: "Rocket" },
    });
    expect(mock.requestAt(2)).toBeUndefined();
  });

  it("create_project uses configured default team when selectors are omitted", async () => {
    const home = await makeHomeWithDefaultTeam("NOX");
    const scopedClient = await bootClientWithHome(home);
    try {
      mock.respond(teamLookupResponse());
      mock.respond({
        data: {
          projectCreate: {
            success: true,
            project: mcpProjectNode(),
          },
        },
      });

      const r = await scopedClient.callTool("create_project", {
        name: "MCP Icon Project",
      });
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      const body = r.parsed as { project: { id: string }; team_ids: string[] };
      expect(body.project.id).toBe("project-uuid-icon");
      expect(body.team_ids).toEqual(["team-uuid-nox"]);
      expect(mock.requestAt(0)?.variables).toMatchObject({ key: "NOX" });
      expect(mock.requestAt(1)?.variables).toMatchObject({
        input: { name: "MCP Icon Project", teamIds: ["team-uuid-nox"] },
      });
    } finally {
      await scopedClient.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("create_project dedupes mixed team selectors", async () => {
    mock.respond(teamLookupResponse());
    mock.respond({
      data: {
        projectCreate: {
          success: true,
          project: mcpProjectNode(),
        },
      },
    });

    const r = await client.callTool("create_project", {
      name: "MCP Icon Project",
      team_ids: ["team-uuid-nox"],
      team_keys: ["NOX", "NOX"],
      team: "NOX",
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { team_ids: string[] };
    expect(body.team_ids).toEqual(["team-uuid-nox"]);
    expect(mock.requestAt(0)?.variables).toMatchObject({ key: "NOX" });
    expect(mock.requestAt(1)?.variables).toMatchObject({
      input: { name: "MCP Icon Project", teamIds: ["team-uuid-nox"] },
    });
    expect(mock.requestAt(2)).toBeUndefined();
  });

  it("create_issue rejects project and project_id together before mutation", async () => {
    const r = await client.callTool("create_issue", {
      team: "NOX",
      title: "bad project selector",
      project: "Roadmap",
      project_id: "11111111-2222-3333-4444-555555555555",
    });
    expect(r.isError).toBe(true);
    const body = r.parsed as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toContain("either project or project_id");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("archive_issue expands issue ranges like the CLI", async () => {
    mock.respond({ data: { issue: { id: "issue-uuid-1", identifier: "NOX-1" } } });
    mock.respond({ data: { issueArchive: { success: true } } });
    mock.respond({ data: { issue: { id: "issue-uuid-2", identifier: "NOX-2" } } });
    mock.respond({ data: { issueArchive: { success: true } } });

    const r = await client.callTool("archive_issue", {
      identifiers: ["NOX-1..NOX-2"],
      confirm: true,
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { results: { identifier: string; status: string }[] };
    expect(body.results).toEqual([
      { identifier: "NOX-1", status: "ok" },
      { identifier: "NOX-2", status: "ok" },
    ]);
    expect(mock.requestAt(0)?.variables).toMatchObject({ id: "NOX-1" });
    expect(mock.requestAt(1)?.variables).toMatchObject({ id: "issue-uuid-1" });
    expect(mock.requestAt(2)?.variables).toMatchObject({ id: "NOX-2" });
    expect(mock.requestAt(3)?.variables).toMatchObject({ id: "issue-uuid-2" });
  });

  it("archive_issue rejects empty identifier arrays before mutation", async () => {
    const r = await client.callTool("archive_issue", {
      identifiers: [],
      confirm: true,
    });
    expect(r.isError).toBe(true);
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("update_project passes icon clear through to ProjectUpdateInput", async () => {
    mock.respond({
      data: {
        projectUpdate: {
          success: true,
          project: mcpProjectNode({ icon: null }),
        },
      },
    });

    const r = await client.callTool("update_project", {
      id: "project-uuid-icon",
      icon: null,
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { project: { icon: string | null } };
    expect(body.project.icon).toBeNull();
    expect(mock.requestAt(0)?.variables).toMatchObject({
      id: "project-uuid-icon",
      input: { icon: null },
    });
  });

  it("archive_initiative returns success: true (raw lifecycle path)", async () => {
    mock.respond({ data: { initiativeArchive: { success: true } } });

    const r = await client.callTool("archive_initiative", {
      id: "11111111-2222-3333-4444-555555555555",
      confirm: true,
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { success: boolean; id: string };
    expect(body.success).toBe(true);
  });

  it("delete_initiative {id: <uuid>} happy path returns status: 'deleted' (round-9 / M-3)", async () => {
    // UUID input — resolveInitiativeId regex-matches and skips the name
    // lookup. `deleteInitiative` then runs a `getInitiative` pre-flight
    // (round-7 / Q2 archived-check) before issuing the delete mutation,
    // so two mocks are required: the pre-flight read + the delete.
    mock.respond({
      data: {
        initiatives: {
          nodes: [
            {
              id: "11111111-2222-3333-4444-555555555555",
              name: "Active Initiative",
              description: null,
              status: "Active",
              color: null,
              icon: null,
              url: "https://linear.app/test/initiative/active",
              targetDate: null,
              archivedAt: null,
              owner: null,
              projects: { nodes: [], pageInfo: pageInfo() },
            },
          ],
        },
      },
    });
    mock.respond({ data: { initiativeDelete: { success: true } } });

    const r = await client.callTool("delete_initiative", {
      id: "11111111-2222-3333-4444-555555555555",
      confirm: true,
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      status: string;
      success: boolean;
      id: string;
      query: string;
    };
    expect(body.status).toBe("deleted");
    expect(body.success).toBe(true);
    expect(body.id).toBe("11111111-2222-3333-4444-555555555555");
    expect(body.query).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("delete_initiative {id: <name>} resolves name then deletes (round-9 / H1 + M-3)", async () => {
    // Step 1: resolveInitiativeId hits the list-shape `initiatives(filter:
    // { name: { eq } }, includeArchived: true)` query — return one match.
    mock.respond({
      data: {
        initiatives: {
          nodes: [{ id: "22222222-3333-4444-5555-666666666666", name: "Q4 Goals" }],
        },
      },
    });
    // Step 2: the resolved UUID gets passed to deleteInitiative, which runs
    // a `getInitiative` pre-flight (archived-check) before the mutation.
    mock.respond({
      data: {
        initiatives: {
          nodes: [
            {
              id: "22222222-3333-4444-5555-666666666666",
              name: "Q4 Goals",
              description: null,
              status: "Active",
              color: null,
              icon: null,
              url: "https://linear.app/test/initiative/q4-goals",
              targetDate: null,
              archivedAt: null,
              owner: null,
              projects: { nodes: [], pageInfo: pageInfo() },
            },
          ],
        },
      },
    });
    // Step 3: the actual delete mutation.
    mock.respond({ data: { initiativeDelete: { success: true } } });

    const r = await client.callTool("delete_initiative", { id: "Q4 Goals", confirm: true });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      status: string;
      success: boolean;
      id: string;
      query: string;
    };
    expect(body.status).toBe("deleted");
    expect(body.id).toBe("22222222-3333-4444-5555-666666666666");
    expect(body.query).toBe("Q4 Goals");
  });

  it("delete_initiative {id: <bogus-name>} returns already-absent without mutation (round-9 / H1 + M-1)", async () => {
    // resolveInitiativeId list query returns empty nodes → already-absent
    // short-circuit fires; NO delete mutation should be sent. The envelope
    // shape carries `id: null` + `query: <input>` for caller observability.
    mock.respond({ data: { initiatives: { nodes: [] } } });

    const r = await client.callTool("delete_initiative", {
      id: "no-such-initiative-xyz",
      confirm: true,
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      status: string;
      success: boolean;
      id: string | null;
      query: string;
    };
    expect(body.status).toBe("already-absent");
    expect(body.success).toBe(false);
    expect(body.id).toBeNull();
    expect(body.query).toBe("no-such-initiative-xyz");
  });

  it("update_initiative {id: <name>, description} resolves name then updates (round-9 / M-3)", async () => {
    // Step 1: resolveInitiativeId list query → match.
    mock.respond({
      data: {
        initiatives: {
          nodes: [{ id: "33333333-4444-5555-6666-777777777777", name: "Roadmap H2" }],
        },
      },
    });
    // Step 2: initiativeUpdate mutation with resolved UUID + input.
    mock.respond({
      data: {
        initiativeUpdate: {
          success: true,
          initiative: {
            id: "33333333-4444-5555-6666-777777777777",
            name: "Roadmap H2",
            description: "updated body",
            status: "Planned",
            color: null,
            icon: null,
            url: "https://linear.app/test/initiative/roadmap-h2",
            targetDate: null,
            archivedAt: null,
            owner: null,
          },
        },
      },
    });

    const r = await client.callTool("update_initiative", {
      id: "Roadmap H2",
      description: "updated body",
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { initiative: { id: string; description: string } };
    expect(body.initiative.id).toBe("33333333-4444-5555-6666-777777777777");
    expect(body.initiative.description).toBe("updated body");
  });

  it("delete_label returns success: true", async () => {
    mock.respond({ data: { issueLabelDelete: { success: true } } });

    const r = await client.callTool("delete_label", {
      id: "11111111-2222-3333-4444-555555555555",
      confirm: true,
    });
    expect(r.isError).toBeFalsy();
    const body = r.parsed as { success: boolean };
    expect(body.success).toBe(true);
    expect(mock.requestAt(0)?.variables).toMatchObject({
      id: "11111111-2222-3333-4444-555555555555",
    });
    expect(mock.requestAt(1)).toBeUndefined();
  });

  it("delete_label requires confirm:true before mutation", async () => {
    const r = await client.callTool("delete_label", {
      id: "11111111-2222-3333-4444-555555555555",
    });
    expect(r.isError).toBe(true);
    const body = r.parsed as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toContain("confirm: true");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("delete_label resolves name_or_id inside the same MCP call", async () => {
    mock.respond(teamLookupResponse());
    mock.respond({
      data: {
        issueLabels: {
          nodes: [
            {
              id: "label-uuid-delete",
              name: "delete-me",
              color: "#cccccc",
              description: null,
              team: { id: "team-uuid-nox", key: "NOX", name: "Noxor" },
            },
          ],
          pageInfo: pageInfo(),
        },
      },
    });
    mock.respond({ data: { issueLabelDelete: { success: true } } });

    const r = await client.callTool("delete_label", {
      name_or_id: "delete-me",
      team: "NOX",
      confirm: true,
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { id: string; selector: string; success: boolean };
    expect(body.id).toBe("label-uuid-delete");
    expect(body.selector).toBe("delete-me");
    expect(body.success).toBe(true);
    expect(mock.requestAt(0)?.variables).toMatchObject({ key: "NOX" });
    expect(mock.requestAt(1)?.variables).toMatchObject({
      filter: { or: [{ team: { key: { eq: "NOX" } } }, { team: { null: true } }] },
    });
    expect(mock.requestAt(2)?.variables).toMatchObject({ id: "label-uuid-delete" });
    expect(mock.requestAt(3)).toBeUndefined();
  });

  it("delete_label default team scope does not match workspace-scoped labels", async () => {
    const home = await makeHomeWithDefaultTeam("NOX");
    const scopedClient = await bootClientWithHome(home);
    try {
      mock.respond(teamLookupResponse());
      mock.respond({
        data: {
          issueLabels: {
            nodes: [
              {
                id: "workspace-label-uuid",
                name: "delete-me",
                color: "#cccccc",
                description: null,
                team: null,
              },
            ],
            pageInfo: pageInfo(),
          },
        },
      });

      const r = await scopedClient.callTool("delete_label", {
        name_or_id: "delete-me",
        confirm: true,
      });
      expect(r.isError).toBe(true);
      const body = r.parsed as { error: { code: string; message: string } };
      expect(body.error.code).toBe("not_found");
      expect(body.error.message).toContain("label not found");
      expect(mock.requestAt(0)?.variables).toMatchObject({ key: "NOX" });
      expect(mock.requestAt(1)?.variables).toMatchObject({
        filter: { or: [{ team: { key: { eq: "NOX" } } }, { team: { null: true } }] },
      });
      expect(mock.requestAt(2)).toBeUndefined();
    } finally {
      await scopedClient.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("delete_label explicit workspace scope deletes only workspace labels", async () => {
    mock.respond({
      data: {
        issueLabels: {
          nodes: [
            {
              id: "workspace-label-uuid",
              name: "delete-me",
              color: "#cccccc",
              description: null,
              team: null,
            },
          ],
          pageInfo: pageInfo(),
        },
      },
    });
    mock.respond({ data: { issueLabelDelete: { success: true } } });

    const r = await client.callTool("delete_label", {
      name_or_id: "delete-me",
      scope: "workspace",
      confirm: true,
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { id: string; scope: string; team: string | null; success: boolean };
    expect(body.id).toBe("workspace-label-uuid");
    expect(body.scope).toBe("workspace");
    expect(body.team).toBeNull();
    expect(body.success).toBe(true);
    expect(mock.requestAt(0)?.variables).toMatchObject({ filter: { team: { null: true } } });
    expect(mock.requestAt(1)?.variables).toMatchObject({ id: "workspace-label-uuid" });
    expect(mock.requestAt(2)).toBeUndefined();
  });

  it("lookup_label_by_name uses the same default team scope as delete_label", async () => {
    mock.respond(teamLookupResponse());
    mock.respond({
      data: {
        issueLabels: {
          nodes: [
            {
              id: "workspace-label-uuid",
              name: "delete-me",
              color: "#cccccc",
              description: null,
              team: null,
            },
          ],
          pageInfo: pageInfo(),
        },
      },
    });

    const r = await client.callTool("lookup_label_by_name", {
      name: "delete-me",
      team: "NOX",
    });

    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { label: unknown; scope: string; team: string | null };
    expect(body.label).toBeNull();
    expect(body.scope).toBe("team");
    expect(body.team).toBe("NOX");
    expect(mock.requestAt(0)?.variables).toMatchObject({ key: "NOX" });
    expect(mock.requestAt(1)?.variables).toMatchObject({
      filter: { or: [{ team: { key: { eq: "NOX" } } }, { team: { null: true } }] },
    });
    expect(mock.requestAt(2)).toBeUndefined();
  });

  it("lookup_label_by_name supports explicit workspace scope", async () => {
    mock.respond({
      data: {
        issueLabels: {
          nodes: [
            {
              id: "workspace-label-uuid",
              name: "delete-me",
              color: "#cccccc",
              description: null,
              team: null,
            },
          ],
          pageInfo: pageInfo(),
        },
      },
    });

    const r = await client.callTool("lookup_label_by_name", {
      name: "delete-me",
      scope: "workspace",
    });

    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { label: { id: string }; scope: string; team: string | null };
    expect(body.label.id).toBe("workspace-label-uuid");
    expect(body.scope).toBe("workspace");
    expect(body.team).toBeNull();
    expect(mock.requestAt(0)?.variables).toMatchObject({ filter: { team: { null: true } } });
    expect(mock.requestAt(1)).toBeUndefined();
  });

  it("delete_relation deletes a matching relation idempotently", async () => {
    mock.respond({
      data: {
        issue: {
          relations: {
            nodes: [
              {
                id: "relation-uuid-1",
                type: "related",
                relatedIssue: { id: "issue-uuid-2", identifier: "ENG-2" },
              },
            ],
          },
          inverseRelations: { nodes: [] },
        },
      },
    });
    mock.respond({ data: { issueRelationDelete: { success: true } } });

    const r = await client.callTool("delete_relation", {
      from: "ENG-1",
      kind: "related",
      to: "ENG-2",
      confirm: true,
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { status: string; relation_id: string };
    expect(body.status).toBe("deleted");
    expect(body.relation_id).toBe("relation-uuid-1");
    expect(mock.requestAt(1)?.variables).toMatchObject({ id: "relation-uuid-1" });
  });

  it("update_relations requires confirm before destructive remove deltas", async () => {
    const r = await client.callTool("update_relations", {
      from: "ENG-1",
      deltas: [{ op: "remove", kind: "related", to: "ENG-2" }],
    });
    expect(r.isError).toBe(true);
    const body = r.parsed as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toContain("update_relations requires confirm");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("update_relations applies add/remove deltas and reports per-delta statuses", async () => {
    mock.respond({ data: { issue: mcpSdkIssuePayload("issue-uuid-1", "ENG-1") } });
    mock.respond({ data: { issue: mcpSdkIssuePayload("issue-uuid-2", "ENG-2") } });
    mock.respond({
      data: {
        issue: {
          relations: { nodes: [], pageInfo: pageInfo() },
          inverseRelations: { nodes: [], pageInfo: pageInfo() },
        },
      },
    });
    mock.respond({
      data: {
        issueRelationCreate: {
          success: true,
          issueRelation: { id: "relation-created-1", type: "related" },
        },
      },
    });
    mock.respond({
      data: {
        issue: {
          relations: {
            nodes: [
              {
                id: "relation-remove-1",
                type: "related",
                relatedIssue: { identifier: "ENG-2" },
              },
            ],
            pageInfo: pageInfo(),
          },
          inverseRelations: { nodes: [], pageInfo: pageInfo() },
        },
      },
    });
    mock.respond({ data: { issueRelationDelete: { success: true } } });

    const r = await client.callTool("update_relations", {
      from: "ENG-1",
      deltas: [
        { op: "add", kind: "related", to: "ENG-2" },
        { op: "remove", kind: "related", to: "ENG-2" },
      ],
      confirm: true,
    });

    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      from: string;
      results: { op: string; status: string; relation_id?: string }[];
    };
    expect(body.from).toBe("ENG-1");
    expect(body.results).toMatchObject([
      { op: "+", status: "created", relation_id: "relation-created-1" },
      { op: "-", status: "deleted", relation_id: "relation-remove-1" },
    ]);
    expect(mock.requestAt(3)?.query).toContain("issueRelationCreate");
    expect(mock.requestAt(5)?.query).toContain("issueRelationDelete");
  });

  it("update_relations re-adds a relation after an earlier remove in the same batch", async () => {
    mock.respond({ data: { issue: mcpSdkIssuePayload("issue-uuid-1", "ENG-1") } });
    mock.respond({ data: { issue: mcpSdkIssuePayload("issue-uuid-2", "ENG-2") } });
    mock.respond({
      data: {
        issue: {
          relations: {
            nodes: [
              {
                id: "relation-existing-1",
                type: "related",
                relatedIssue: { identifier: "ENG-2" },
              },
            ],
            pageInfo: pageInfo(),
          },
          inverseRelations: { nodes: [], pageInfo: pageInfo() },
        },
      },
    });
    mock.respond({
      data: {
        issue: {
          relations: {
            nodes: [
              {
                id: "relation-existing-1",
                type: "related",
                relatedIssue: { identifier: "ENG-2" },
              },
            ],
            pageInfo: pageInfo(),
          },
          inverseRelations: { nodes: [], pageInfo: pageInfo() },
        },
      },
    });
    mock.respond({ data: { issueRelationDelete: { success: true } } });
    mock.respond({
      data: {
        issue: {
          relations: { nodes: [], pageInfo: pageInfo() },
          inverseRelations: { nodes: [], pageInfo: pageInfo() },
        },
      },
    });
    mock.respond({
      data: {
        issueRelationCreate: {
          success: true,
          issueRelation: { id: "relation-recreated-1", type: "related" },
        },
      },
    });

    const r = await client.callTool("update_relations", {
      from: "ENG-1",
      deltas: [
        { op: "remove", kind: "related", to: "ENG-2" },
        { op: "add", kind: "related", to: "ENG-2" },
      ],
      confirm: true,
    });

    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      from: string;
      results: { op: string; status: string; relation_id?: string }[];
    };
    expect(body.results).toMatchObject([
      { op: "-", status: "deleted", relation_id: "relation-existing-1" },
      { op: "+", status: "created", relation_id: "relation-recreated-1" },
    ]);
    expect(mock.requestAt(4)?.query).toContain("issueRelationDelete");
    expect(mock.requestAt(6)?.query).toContain("issueRelationCreate");
  });

  it("delete_relation reports remote success separately when cached issue refresh fails", async () => {
    await writeCachedIssueFixture(lebopHome, "ENG-1", "cached body");
    mock.respond({
      data: {
        issue: {
          relations: {
            nodes: [
              {
                id: "relation-uuid-writeback",
                type: "related",
                relatedIssue: { id: "issue-uuid-2", identifier: "ENG-2" },
              },
            ],
          },
          inverseRelations: { nodes: [] },
        },
      },
    });
    mock.respond({ data: { issueRelationDelete: { success: true } } });

    const r = await client.callTool("delete_relation", {
      from: "ENG-1",
      kind: "related",
      to: "ENG-2",
      confirm: true,
    });

    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      status: string;
      relation_id: string;
      cache: { present: boolean; refreshed: boolean; error?: { message: string } };
    };
    expect(body).toMatchObject({
      status: "deleted-writeback-failed",
      relation_id: "relation-uuid-writeback",
    });
    expect(body.cache).toMatchObject({ present: true, refreshed: false });
    expect(body.cache.error?.message).toBeTruthy();
  });

  it("delete_relation refuses to overwrite a dirty cached source issue after remote success", async () => {
    const { descriptionPath } = await writeCachedIssueFixture(
      lebopHome,
      "ENG-3",
      "server baseline",
    );
    await writeFile(descriptionPath, "local relation draft");
    mock.respond({
      data: {
        issue: {
          relations: {
            nodes: [
              {
                id: "relation-uuid-dirty",
                type: "related",
                relatedIssue: { id: "issue-uuid-4", identifier: "ENG-4" },
              },
            ],
          },
          inverseRelations: { nodes: [] },
        },
      },
    });
    mock.respond({ data: { issueRelationDelete: { success: true } } });

    const r = await client.callTool("delete_relation", {
      from: "ENG-3",
      kind: "related",
      to: "ENG-4",
      confirm: true,
    });

    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      status: string;
      cache: { refreshed: boolean; error: { code: string }; dirty: { fields: string[] } };
    };
    expect(body.status).toBe("deleted-writeback-failed");
    expect(body.cache).toMatchObject({
      refreshed: false,
      error: { code: "cache_dirty" },
      dirty: { fields: ["description"] },
    });
    await expect(readFile(descriptionPath, "utf8")).resolves.toBe("local relation draft");
  });
});

describe("mcp: update_issue — wave-2 extras-only regression lock", () => {
  let client: McpClient;

  beforeAll(async () => {
    client = await bootClient();
  });

  afterAll(async () => {
    await client.close();
  });

  /**
   * Pre-wave-2: passing ONLY `project` (no title/state/etc.) routed straight
   * into lib `updateIssue`, which threw `ValidationError("nothing to update")`
   * because the lib doesn't accept project/milestone/cycle. The advertised
   * MCP surface was broken for the extras-only case.
   *
   * Post-wave-2: the MCP handler resolves extras up front, skips the lib
   * call when there are no lib-supported fields, looks up the issue UUID via
   * `getIssue`, and applies the extras via a raw `issueUpdate` mutation.
   *
   * This test locks the wave-3 behavior. Wave-3 collapsed the two-step MCP
   * dance into a single lib call — lib/updateIssue now resolves project /
   * milestone / cycle natively, and the MCP tool is a thin pass-through.
   *
   * Mock plan (wave-3 path):
   *   1. lib's `c.issue("ENG-99")` SDK call resolves the identifier → UUID.
   *      Responds with `{ issue: { id: "..." } }`; the SDK Issue constructor
   *      is happy as long as `data.issue` is defined.
   *   2. lib's `resolveProjectByWorkspaceName("Some Project")` resolves the
   *      project name → UUID via a raw projects(filter:{name eq}) query.
   *   3. lib's `issueUpdate` mutation applies `{ projectId }`.
   */
  it("update_issue with only `project` (extras-only) does NOT throw 'nothing to update'", async () => {
    // Step 1: `c.issue(id)` SDK lookup. Returns `{ issue: { id } }`; the SDK
    // Issue class hydration is lenient about missing optional fields.
    mock.respond({
      data: {
        issue: {
          id: "issue-uuid-eng-99",
          identifier: "ENG-99",
        },
      },
    });
    // Step 2: project name → UUID resolution (lib's resolveProjectByWorkspaceName).
    mock.respond({
      data: {
        projects: {
          nodes: [{ id: "project-uuid-abc", name: "Some Project" }],
        },
      },
    });
    // Step 3: issueUpdate mutation.
    mock.respond({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            id: "issue-uuid-eng-99",
            identifier: "ENG-99",
            title: "Existing issue",
            description: "",
            priority: 0,
            estimate: null,
            url: "https://linear.app/test/issue/ENG-99",
            updatedAt: "2026-05-01T00:00:01.000Z",
            state: { id: "state-x", name: "Todo", type: "unstarted" },
            assignee: null,
            project: { id: "project-uuid-abc", name: "Some Project" },
            team: { id: "team-uuid-eng", key: "ENG" },
            parent: null,
            labels: { nodes: [] },
          },
        },
      },
    });

    const r = await client.callTool("update_issue", {
      identifier: "ENG-99",
      project: "Some Project",
    });

    // The core regression assertion: the tool MUST NOT return isError:true
    // with a "nothing to update" message. It must produce a normal result.
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { issue: { identifier: string; project: { name: string } | null } };
    expect(body.issue.identifier).toBe("ENG-99");
    expect(body.issue.project?.name).toBe("Some Project");

    // Bonus integrity check: the third request is the issueUpdate mutation
    // targeting the resolved issue UUID with the resolved projectId. The
    // wave-3 lib path keeps the same ordering: c.issue() → name lookup →
    // mutation.
    const lastReq = mock.requestAt(2);
    expect(lastReq?.query).toContain("issueUpdate");
    expect(lastReq?.variables.id).toBe("issue-uuid-eng-99");
    const input = lastReq?.variables.input as { projectId: string };
    expect(input.projectId).toBe("project-uuid-abc");
  });

  it("update_issue accepts description/project/milestone/cycle in one MCP call", async () => {
    const projectUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const milestoneUuid = "11111111-2222-3333-4444-555555555555";

    mock.respond({
      data: {
        issue: {
          id: "issue-uuid-nox-120",
          identifier: "NOX-120",
        },
      },
    });
    mock.respond({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            id: "issue-uuid-nox-120",
            identifier: "NOX-120",
            title: "Existing issue",
            description: "MCP direct body",
            priority: 0,
            estimate: null,
            url: "https://linear.app/test/issue/NOX-120",
            updatedAt: "2026-05-01T00:00:01.000Z",
            state: { id: "state-x", name: "Todo", type: "unstarted" },
            assignee: null,
            project: { id: projectUuid, name: "Direct Project" },
            projectMilestone: { id: milestoneUuid, name: "Direct Milestone" },
            cycle: null,
            team: { id: "team-uuid-nox", key: "NOX" },
            parent: null,
            labels: { nodes: [] },
          },
        },
      },
    });

    const r = await client.callTool("update_issue", {
      identifier: "NOX-120",
      description: "MCP direct body",
      project: projectUuid,
      milestone: milestoneUuid,
      cycle: null,
    });

    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      issue: { identifier: string };
      remote: {
        identifier: string;
        updated_at: string;
        description: string;
        project: { id: string; name: string } | null;
        milestone: { id: string; name: string } | null;
        cycle: { id: string; name: string } | null;
        labels: { id: string; name: string }[];
      };
    };
    expect(body.issue.identifier).toBe("NOX-120");
    expect(body.remote).toMatchObject({
      identifier: "NOX-120",
      updated_at: "2026-05-01T00:00:01.000Z",
      description: "MCP direct body",
      project: { id: projectUuid, name: "Direct Project" },
      milestone: { id: milestoneUuid, name: "Direct Milestone" },
      cycle: null,
      labels: [],
    });

    const update = mock.requestAt(1);
    expect(update?.query).toContain("issueUpdate");
    expect(update?.variables.id).toBe("issue-uuid-nox-120");
    expect(update?.variables.input).toMatchObject({
      description: "MCP direct body",
      projectId: projectUuid,
      projectMilestoneId: milestoneUuid,
      cycleId: null,
    });
  });

  it("update_issue applies label deltas through MCP without replacing unrelated labels", async () => {
    mock.respond({
      data: {
        issue: {
          id: "issue-uuid-nox-121",
          identifier: "NOX-121",
          labels: {
            nodes: [
              { id: "label-keep", name: "Keep" },
              { id: "label-remove", name: "Remove Me" },
            ],
          },
        },
      },
    });
    queueTeamMetadataResponses("NOX", [
      { id: "label-keep", name: "Keep" },
      { id: "label-remove", name: "Remove Me" },
      { id: "label-add", name: "Add Me" },
    ]);
    mock.respond({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            ...mcpSdkIssuePayload("issue-uuid-nox-121", "NOX-121"),
            labels: {
              nodes: [
                { id: "label-keep", name: "Keep" },
                { id: "label-add", name: "Add Me" },
              ],
            },
          },
        },
      },
    });

    const r = await client.callTool("update_issue", {
      identifier: "NOX-121",
      labels_add: ["add me"],
      labels_remove: ["remove me"],
    });

    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { remote: { labels: { id: string; name: string }[] } };
    expect(body.remote.labels.map((label) => label.id).toSorted()).toEqual([
      "label-add",
      "label-keep",
    ]);
    const update = mock.requestAt(6);
    expect(update?.query).toContain("issueUpdate");
    expect(update?.variables.input).toMatchObject({
      labelIds: ["label-keep", "label-add"],
    });
  });

  it("update_issue refreshes an existing cached issue row", async () => {
    const { descriptionPath } = await writeCachedIssueFixture(
      lebopHome,
      "ENG-99",
      "old cached body",
    );

    mock.respond({
      data: {
        issue: {
          id: "issue-uuid-eng-99",
          identifier: "ENG-99",
        },
      },
    });
    mock.respond({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            id: "issue-uuid-eng-99",
            identifier: "ENG-99",
            title: "Fresh title",
            description: "new cached body",
            priority: 0,
            estimate: null,
            url: "https://linear.app/test/issue/ENG-99",
            updatedAt: "2026-05-01T00:00:01.000Z",
            state: { id: "state-x", name: "Todo", type: "unstarted" },
            assignee: null,
            project: null,
            team: { id: "team-uuid-eng", key: "ENG" },
            parent: null,
            labels: { nodes: [] },
          },
        },
      },
    });

    const r = await client.callTool("update_issue", {
      identifier: "ENG-99",
      title: "Fresh title",
    });

    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { status: string; cache: { refreshed: boolean; present: boolean } };
    expect(body.status).toBe("updated");
    expect(body.cache).toMatchObject({ refreshed: true, present: true });
    await expect(readFile(descriptionPath, "utf8")).resolves.toBe("new cached body");
  });

  it("update_issue refuses to overwrite a dirty cached issue row after remote success", async () => {
    const { descriptionPath } = await writeCachedIssueFixture(
      lebopHome,
      "ENG-100",
      "server baseline",
    );
    await writeFile(descriptionPath, "local unsent edit");

    mock.respond({
      data: {
        issue: {
          id: "issue-uuid-eng-100",
          identifier: "ENG-100",
        },
      },
    });
    mock.respond({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            id: "issue-uuid-eng-100",
            identifier: "ENG-100",
            title: "Remote title",
            description: "remote body should not replace local dirty body",
            priority: 0,
            estimate: null,
            url: "https://linear.app/test/issue/ENG-100",
            updatedAt: "2026-05-01T00:00:01.000Z",
            state: { id: "state-x", name: "Todo", type: "unstarted" },
            assignee: null,
            project: null,
            team: { id: "team-uuid-eng", key: "ENG" },
            parent: null,
            labels: { nodes: [] },
          },
        },
      },
    });

    const r = await client.callTool("update_issue", {
      identifier: "ENG-100",
      title: "Remote title",
    });

    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      status: string;
      cache: { refreshed: boolean; error: { code: string }; dirty: { fields: string[] } };
    };
    expect(body.status).toBe("updated-writeback-failed");
    expect(body.cache).toMatchObject({
      refreshed: false,
      error: { code: "cache_dirty" },
      dirty: { fields: ["description"] },
    });
    await expect(readFile(descriptionPath, "utf8")).resolves.toBe("local unsent edit");
  });
});

describe("mcp: cache write + push parity", () => {
  let client: McpClient;
  let cacheHome: string;

  beforeAll(async () => {
    // pull_issues writes to ~/.lebop/cache/<repo-hash>/... — point LEBOP_HOME
    // at a throwaway dir so the test's writes are isolated.
    cacheHome = await makeAuthFile("lin_api_test_mcp_cache");
    client = await startMcpClient({ ...env, LEBOP_HOME: cacheHome });
    const init = await client.initialize();
    expect(init.protocolVersion).toBe("2024-11-05");
    await client.notifyInitialized();
  });

  afterAll(async () => {
    await client.close();
    await rm(cacheHome, { recursive: true, force: true });
  });

  it("pull refresh modes require confirm:true before Linear I/O", async () => {
    const issuePull = await client.callTool("pull_issues", {
      identifiers: ["UE-359"],
      refresh: true,
    });
    expect(issuePull.isError).toBe(true);
    expect((issuePull.parsed as { error: { message: string } }).error.message).toContain(
      "confirm: true",
    );

    const projectPull = await client.callTool("pull_project", {
      project_id: "project-refresh-confirm",
      refresh: true,
    });
    expect(projectPull.isError).toBe(true);
    expect((projectPull.parsed as { error: { message: string } }).error.message).toContain(
      "confirm: true",
    );
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("pull_issues fetches issues and reports them in the wave-3 envelope", async () => {
    // pull_issues builds a multi-alias query (a0, a1 ...). Single id → single alias.
    mock.respond({
      data: {
        a0: {
          id: "ue-359-uuid",
          identifier: "UE-359",
          title: "Sandbox sentinel",
          description: "test issue",
          priority: 0,
          estimate: null,
          url: "https://linear.app/test/issue/UE-359",
          updatedAt: "2026-05-10T12:00:00.000Z",
          state: { id: "state-bl", name: "Backlog", type: "backlog" },
          assignee: null,
          project: null,
          team: { id: "team-ue", key: "UE" },
          parent: null,
          labels: { nodes: [] },
          comments: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const r = await client.callTool("pull_issues", {
      identifiers: ["UE-359"],
      // No repo_root → falls back to MCP server cwd via resolveConfig.
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    // Wave-3 parity: pull_issues now emits {team, repo_hash, mode, project,
    // issues, errors} matching `lebop pull --json`. The legacy `fetched` key
    // is renamed `issues`.
    const body = r.parsed as {
      team: string;
      repo_hash: string;
      mode: "cache";
      project: null;
      issues: { identifier: string; comments: number; cache_path: string; path: string }[];
      errors: unknown[];
    };
    expect(body.errors).toEqual([]);
    expect(body.mode).toBe("cache");
    expect(body.project).toBeNull();
    expect(typeof body.team).toBe("string");
    expect(typeof body.repo_hash).toBe("string");
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]?.identifier).toBe("UE-359");
    expect(body.issues[0]?.cache_path).toContain("UE-359");
    expect(body.issues[0]?.path).toBe(body.issues[0]?.cache_path);
  });

  it("pull_issues can export to a caller-provided directory instead of cache", async () => {
    const out = await mkdtemp(join(tmpdir(), "lebop-mcp-pull-export-"));
    try {
      mock.respond({
        data: {
          a0: {
            id: "ue-360-uuid",
            identifier: "UE-360",
            title: "Export sentinel",
            description: "exported issue body",
            priority: 0,
            estimate: null,
            url: "https://linear.app/test/issue/UE-360",
            updatedAt: "2026-05-10T12:00:00.000Z",
            state: { id: "state-bl", name: "Backlog", type: "backlog" },
            assignee: null,
            project: null,
            team: { id: "team-ue", key: "UE" },
            parent: null,
            labels: { nodes: [] },
            comments: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });

      const r = await client.callTool("pull_issues", {
        identifiers: ["UE-360"],
        to: out,
      });
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      const body = r.parsed as {
        mode: "export";
        issues: { identifier: string; comments: number; cache_path: null; path: string }[];
      };
      expect(body.mode).toBe("export");
      expect(body.issues[0]).toMatchObject({
        identifier: "UE-360",
        comments: 0,
        cache_path: null,
        path: join(out, "UE-360"),
      });
      await expect(readFile(join(out, "UE-360", "description.md"), "utf8")).resolves.toBe(
        "exported issue body",
      );
      await expect(readFile(join(out, "UE-360", "metadata.yaml"), "utf8")).resolves.toContain(
        "identifier: UE-360",
      );
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("pull_issues expands CLI-style identifier ranges before fetching", async () => {
    mock.respond({
      data: {
        a0: mcpSdkIssuePayload("ue-410-uuid", "UE-410", {
          team: { id: "team-ue", key: "UE" },
        }),
        a1: mcpSdkIssuePayload("ue-411-uuid", "UE-411", {
          team: { id: "team-ue", key: "UE" },
        }),
      },
    });

    const r = await client.callTool("pull_issues", {
      identifiers: ["UE-410..UE-411"],
      include_comments: false,
      refresh: true,
      confirm: true,
    });

    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      team: string;
      issues: { identifier: string; cache_path: string }[];
      hydration: { requested_count: number };
    };
    expect(body.team).toBe("UE");
    expect(body.hydration.requested_count).toBe(2);
    expect(body.issues.map((issue) => issue.identifier)).toEqual(["UE-410", "UE-411"]);
  });

  it("pull_issues refuses to overwrite modified canonical cache rows when requested by alias", async () => {
    const { descriptionPath } = await writeCachedIssueFixture(
      cacheHome,
      "UE-365",
      "remote baseline",
    );
    await writeFile(descriptionPath, "local unsent edit");

    mock.respond({
      data: {
        a0: {
          id: "ue-365-uuid",
          identifier: "UE-365",
          title: "Canonical issue",
          description: "remote replacement",
          priority: 0,
          estimate: null,
          url: "https://linear.app/test/issue/UE-365",
          updatedAt: "2026-05-10T12:00:00.000Z",
          state: { id: "state-bl", name: "Backlog", type: "backlog" },
          assignee: null,
          project: null,
          team: { id: "team-ue", key: "UE" },
          parent: null,
          labels: { nodes: [] },
          comments: {
            nodes: [],
            pageInfo: pageInfo(),
          },
        },
      },
    });

    const r = await client.callTool("pull_issues", {
      identifiers: ["OLD-365"],
      team: "UE",
    });

    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.parsed)).toContain("UE-365");
    await expect(readFile(descriptionPath, "utf8")).resolves.toBe("local unsent edit");
  });

  it("pull_issues paginates comment overflow and replaces stale cached comments", async () => {
    mock.respond({
      data: {
        a0: {
          id: "ue-362-uuid",
          identifier: "UE-362",
          title: "Comment cleanup before",
          description: "before",
          priority: 0,
          estimate: null,
          url: "https://linear.app/test/issue/UE-362",
          updatedAt: "2026-05-10T12:00:00.000Z",
          state: { id: "state-bl", name: "Backlog", type: "backlog" },
          assignee: null,
          project: null,
          team: { id: "team-ue", key: "UE" },
          parent: null,
          labels: { nodes: [] },
          comments: {
            nodes: [
              {
                id: "c-old",
                body: "old cached comment",
                createdAt: "2026-05-10T12:00:00.000Z",
                updatedAt: "2026-05-10T12:00:00.000Z",
                user: null,
              },
            ],
            pageInfo: pageInfo(),
          },
        },
      },
    });
    const firstPull = await client.callTool("pull_issues", {
      identifiers: ["UE-362"],
      team: "UE",
      refresh: true,
      confirm: true,
    });
    expect(firstPull.isError, JSON.stringify(firstPull.parsed)).toBeFalsy();
    const firstBody = firstPull.parsed as {
      issues: { cache_path: string }[];
    };
    const cachePath = firstBody.issues[0]?.cache_path;
    expect(cachePath).toBeTruthy();
    await expect(
      readFile(join(cachePath as string, "comments", "c-old.md"), "utf8"),
    ).resolves.toContain("old cached comment");

    mock.respond({
      data: {
        a0: {
          id: "ue-362-uuid",
          identifier: "UE-362",
          title: "Comment cleanup after",
          description: "after",
          priority: 0,
          estimate: null,
          url: "https://linear.app/test/issue/UE-362",
          updatedAt: "2026-05-10T12:01:00.000Z",
          state: { id: "state-bl", name: "Backlog", type: "backlog" },
          assignee: null,
          project: null,
          team: { id: "team-ue", key: "UE" },
          parent: null,
          labels: { nodes: [] },
          comments: {
            nodes: [
              {
                id: "c-250",
                body: "inline page comment",
                createdAt: "2026-05-10T12:01:00.000Z",
                updatedAt: "2026-05-10T12:01:00.000Z",
                user: null,
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: "cursor-250" },
          },
        },
      },
    });
    mock.respond({
      data: {
        issue: {
          comments: {
            nodes: [
              {
                id: "c-251",
                body: "overflow comment",
                createdAt: "2026-05-10T12:02:00.000Z",
                updatedAt: "2026-05-10T12:02:00.000Z",
                user: null,
              },
            ],
            pageInfo: pageInfo(),
          },
        },
      },
    });
    const secondPull = await client.callTool("pull_issues", {
      identifiers: ["UE-362"],
      team: "UE",
      refresh: true,
      confirm: true,
    });
    expect(secondPull.isError, JSON.stringify(secondPull.parsed)).toBeFalsy();
    const secondBody = secondPull.parsed as {
      issues: { comments: number; cache_path: string }[];
    };
    expect(secondBody.issues[0]?.comments).toBe(2);
    await expect(
      readFile(join(cachePath as string, "comments", "c-old.md"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(cachePath as string, "comments", "c-250.md"), "utf8"),
    ).resolves.toContain("inline page comment");
    await expect(
      readFile(join(cachePath as string, "comments", "c-251.md"), "utf8"),
    ).resolves.toContain("overflow comment");
    expect(mock.requestAt(2)?.variables).toMatchObject({
      id: "UE-362",
      first: 250,
      after: "cursor-250",
    });
  });

  it("update_issue refreshes an existing local cache row and reports cache metadata", async () => {
    mock.respond({
      data: {
        a0: {
          id: "ue-361-uuid",
          identifier: "UE-361",
          title: "Cached before update",
          description: "before",
          priority: 0,
          estimate: null,
          url: "https://linear.app/test/issue/UE-361",
          updatedAt: "2026-05-10T12:00:00.000Z",
          state: { id: "state-bl", name: "Backlog", type: "backlog" },
          assignee: null,
          project: null,
          team: { id: "team-ue", key: "UE" },
          parent: null,
          labels: { nodes: [] },
          comments: {
            nodes: [],
            pageInfo: pageInfo(),
          },
        },
      },
    });
    const pulled = await client.callTool("pull_issues", {
      identifiers: ["UE-361"],
      team: "UE",
    });
    expect(pulled.isError, JSON.stringify(pulled.parsed)).toBeFalsy();
    const pullBody = pulled.parsed as {
      issues: { identifier: string; cache_path: string }[];
    };
    const cachePath = pullBody.issues[0]?.cache_path;
    expect(cachePath).toBeTruthy();

    mock.respond({
      data: { issue: { id: "ue-361-uuid", identifier: "UE-361" } },
    });
    mock.respond({
      data: {
        issueUpdate: {
          success: true,
          issue: mcpSdkIssuePayload("ue-361-uuid", "UE-361", {
            title: "Cached after update",
            description: "after",
            updatedAt: "2026-05-10T12:01:00.000Z",
            state: { id: "state-bl", name: "Backlog", type: "backlog" },
            team: { id: "team-ue", key: "UE" },
          }),
        },
      },
    });

    const updated = await client.callTool("update_issue", {
      identifier: "UE-361",
      title: "Cached after update",
    });
    expect(updated.isError, JSON.stringify(updated.parsed)).toBeFalsy();
    const body = updated.parsed as {
      issue: { identifier: string; title: string };
      cache: {
        checked: boolean;
        present: boolean;
        refreshed: boolean;
        repo_hash: string;
        identifier: string;
        updated_at: string;
      };
    };
    expect(body.issue).toMatchObject({ identifier: "UE-361", title: "Cached after update" });
    expect(body.cache).toMatchObject({
      checked: true,
      present: true,
      refreshed: true,
      identifier: "UE-361",
      updated_at: "2026-05-10T12:01:00.000Z",
    });
    const metadata = await readFile(join(cachePath as string, "metadata.yaml"), "utf8");
    const description = await readFile(join(cachePath as string, "description.md"), "utf8");
    expect(metadata).toContain("title: Cached after update");
    expect(description).toBe("after");
  });

  it("create_issue uses team metadata from explicit repo_root cache", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "lebop-mcp-create-issue-repo-"));
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    const repoHash = hashRepoRoot(repoRoot);
    const teamDir = join(cacheHome, "cache", repoHash, "_team");
    await mkdir(teamDir, { recursive: true });
    await writeFile(
      join(teamDir, "UE.yaml"),
      [
        "team_id: team-ue",
        "team_key: UE",
        `fetched_at: ${new Date().toISOString()}`,
        "states:",
        "  - id: state-repo-ready",
        "    name: Ready",
        "    type: unstarted",
        "labels: []",
        "members: []",
        "projects: []",
        "",
      ].join("\n"),
    );

    try {
      mock.respond({
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "ue-365-uuid",
              identifier: "UE-365",
              url: "https://linear.app/test/issue/UE-365",
              title: "Repo scoped create",
              state: { name: "Ready" },
              project: null,
            },
          },
        },
      });

      const created = await client.callTool("create_issue", {
        team: "UE",
        title: "Repo scoped create",
        state: "Ready",
        repo_root: repoRoot,
      });
      expect(created.isError, JSON.stringify(created.parsed)).toBeFalsy();
      expect(mock.requestAt(0)?.query).toContain("issueCreate");
      expect(mock.requestAt(0)?.variables).toMatchObject({
        input: { teamId: "team-ue", stateId: "state-repo-ready" },
      });
      expect(mock.requestAt(1)).toBeUndefined();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("update_issue refreshes the cache under explicit repo_root", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "lebop-mcp-update-issue-repo-"));
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    const { repoHash, descriptionPath } = await writeCachedIssueFixture(
      cacheHome,
      "UE-364",
      "before explicit repo",
      repoRoot,
    );

    try {
      mock.respond({
        data: { issue: { id: "ue-364-uuid", identifier: "UE-364" } },
      });
      mock.respond({
        data: {
          issueUpdate: {
            success: true,
            issue: mcpSdkIssuePayload("ue-364-uuid", "UE-364", {
              title: "Explicit repo after",
              description: "after explicit repo",
              updatedAt: "2026-05-10T12:02:00.000Z",
              state: { id: "state-bl", name: "Backlog", type: "backlog" },
              team: { id: "team-ue", key: "UE" },
            }),
          },
        },
      });

      const updated = await client.callTool("update_issue", {
        identifier: "UE-364",
        title: "Explicit repo after",
        repo_root: repoRoot,
      });
      expect(updated.isError, JSON.stringify(updated.parsed)).toBeFalsy();
      const body = updated.parsed as {
        status: string;
        cache: { refreshed: boolean; repo_hash: string; repo_root: string };
      };
      expect(body.status).toBe("updated");
      expect(body.cache).toMatchObject({
        refreshed: true,
        repo_hash: repoHash,
        repo_root: repoRoot,
      });
      await expect(readFile(descriptionPath, "utf8")).resolves.toBe("after explicit repo");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("update_issue reports remote success separately when cache refresh fails", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "lebop-mcp-update-issue-fail-repo-"));
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    const { descriptionPath } = await writeCachedIssueFixture(
      cacheHome,
      "UE-365",
      "before failed writeback",
      repoRoot,
    );
    await rm(descriptionPath, { force: true });
    await mkdir(descriptionPath);

    try {
      mock.respond({
        data: { issue: { id: "ue-365-uuid", identifier: "UE-365" } },
      });
      mock.respond({
        data: {
          issueUpdate: {
            success: true,
            issue: {
              id: "ue-365-uuid",
              identifier: "UE-365",
              url: "https://linear.app/test/issue/UE-365",
              title: "Writeback failed after",
              state: { name: "Backlog" },
            },
          },
        },
      });
      const updated = await client.callTool("update_issue", {
        identifier: "UE-365",
        title: "Writeback failed after",
        repo_root: repoRoot,
      });
      expect(updated.isError, JSON.stringify(updated.parsed)).toBeFalsy();
      const body = updated.parsed as {
        status: string;
        cache: { present: boolean; refreshed: boolean; error?: { message: string } };
      };
      expect(body.status).toBe("updated-writeback-failed");
      expect(body.cache).toMatchObject({ present: true, refreshed: false });
      expect(body.cache.error?.message).toBeTruthy();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("unarchive_issue refuses to overwrite a dirty cached issue after remote success", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "lebop-mcp-unarchive-dirty-repo-"));
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    const { descriptionPath } = await writeCachedIssueFixture(
      cacheHome,
      "UE-366",
      "server baseline",
      repoRoot,
    );
    await writeFile(descriptionPath, "local unarchive draft");

    try {
      mock.respond({
        data: { issue: { id: "ue-366-uuid", identifier: "UE-366" } },
      });
      mock.respond({ data: { issueUnarchive: { success: true } } });

      const updated = await client.callTool("unarchive_issue", {
        identifiers: ["UE-366"],
        repo_root: repoRoot,
      });
      expect(updated.isError, JSON.stringify(updated.parsed)).toBeFalsy();
      const body = updated.parsed as {
        results: { identifier: string; status: string }[];
        cache: {
          failed: number;
          rows: { refreshed: boolean; error: { code: string }; dirty: { fields: string[] } }[];
        };
      };
      expect(body.results[0]).toMatchObject({ identifier: "UE-366", status: "ok" });
      expect(body.cache.failed).toBe(1);
      expect(body.cache.rows[0]).toMatchObject({
        refreshed: false,
        error: { code: "cache_dirty" },
        dirty: { fields: ["description"] },
      });
      await expect(readFile(descriptionPath, "utf8")).resolves.toBe("local unarchive draft");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("update_project refreshes an existing local cache row and reports cache metadata", async () => {
    const projectId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    mock.respond({
      data: {
        project: mcpProjectNode({
          id: projectId,
          name: "Cached Project Before",
          description: "before description",
          content: "before content",
          icon: "Rocket",
          state: "backlog",
          updatedAt: "2026-06-04T10:00:00.000Z",
        }),
      },
    });
    mock.respond({
      data: {
        project: {
          issues: {
            nodes: [],
            pageInfo: pageInfo(),
          },
        },
      },
    });
    const pulled = await client.callTool("pull_project", {
      project_id: projectId,
      team: "UE",
      refresh: true,
      confirm: true,
    });
    expect(pulled.isError, JSON.stringify(pulled.parsed)).toBeFalsy();
    const pullBody = pulled.parsed as {
      project: { id: string; cache_path: string; path: string };
    };
    const cachePath = pullBody.project.cache_path;
    expect(cachePath).toBeTruthy();
    expect(pullBody.project.path).toBe(cachePath);

    mock.respond({
      data: {
        projectUpdate: {
          success: true,
          project: mcpProjectNode({
            id: projectId,
            name: "Cached Project After",
            description: "after description",
            content: "after content",
            icon: "Rocket",
            state: "started",
            updatedAt: "2026-06-04T10:01:00.000Z",
          }),
        },
      },
    });

    const updated = await client.callTool("update_project", {
      id: projectId,
      name: "Cached Project After",
      content: "after content",
    });
    expect(updated.isError, JSON.stringify(updated.parsed)).toBeFalsy();
    const body = updated.parsed as {
      project: { id: string; name: string };
      cache: {
        checked: boolean;
        present: boolean;
        refreshed: boolean;
        repo_hash: string;
        project_id: string;
        updated_at: string;
      };
    };
    expect(body.project).toMatchObject({ id: projectId, name: "Cached Project After" });
    expect(body.cache).toMatchObject({
      checked: true,
      present: true,
      refreshed: true,
      project_id: projectId,
      updated_at: "2026-06-04T10:01:00.000Z",
    });
    const metadata = await readFile(join(cachePath, "metadata.yaml"), "utf8");
    const content = await readFile(join(cachePath, "content.md"), "utf8");
    expect(metadata).toContain("name: Cached Project After");
    expect(metadata).toContain("state: started");
    expect(content).toBe("after content");
  });

  it("update_project refreshes the cache under explicit repo_root", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "lebop-mcp-update-project-repo-"));
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    const projectId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const { repoHash, cachePath } = await writeCachedProjectFixture(cacheHome, projectId, repoRoot);

    try {
      mock.respond({
        data: {
          projectUpdate: {
            success: true,
            project: mcpProjectNode({
              id: projectId,
              name: "Explicit Project After",
              description: "after description",
              content: "after project content",
              icon: "Rocket",
              state: "started",
              updatedAt: "2026-06-04T10:02:00.000Z",
            }),
          },
        },
      });

      const updated = await client.callTool("update_project", {
        id: projectId,
        name: "Explicit Project After",
        content: "after project content",
        repo_root: repoRoot,
      });
      expect(updated.isError, JSON.stringify(updated.parsed)).toBeFalsy();
      const body = updated.parsed as {
        cache: { refreshed: boolean; repo_hash: string; repo_root: string };
      };
      expect(body.cache).toMatchObject({
        refreshed: true,
        repo_hash: repoHash,
        repo_root: repoRoot,
      });
      await expect(readFile(join(cachePath, "content.md"), "utf8")).resolves.toBe(
        "after project content",
      );
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("update_project reports writeback failure as top-level status", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "lebop-mcp-update-project-fail-repo-"));
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    const projectId = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa";
    const { cachePath } = await writeCachedProjectFixture(cacheHome, projectId, repoRoot);

    try {
      await rm(join(cachePath, "content.md"), { force: true });
      await mkdir(join(cachePath, "content.md"));
      mock.respond({
        data: {
          projectUpdate: {
            success: true,
            project: mcpProjectNode({
              id: projectId,
              name: "Writeback Failed Project",
              description: "after description",
              content: "after project content",
              icon: "Rocket",
              state: "started",
              updatedAt: "2026-06-04T10:03:00.000Z",
            }),
          },
        },
      });

      const updated = await client.callTool("update_project", {
        id: projectId,
        name: "Writeback Failed Project",
        content: "after project content",
        repo_root: repoRoot,
      });
      expect(updated.isError, JSON.stringify(updated.parsed)).toBeFalsy();
      const body = updated.parsed as {
        status: string;
        cache: { present: boolean; refreshed: boolean; error?: { message: string } };
      };
      expect(body.status).toBe("updated-writeback-failed");
      expect(body.cache).toMatchObject({
        present: true,
        refreshed: false,
      });
      expect(body.cache.error?.message).toBeTruthy();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("update_project refuses to overwrite dirty cached project content after remote success", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "lebop-mcp-update-project-dirty-repo-"));
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    const projectId = "dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb";
    const { cachePath } = await writeCachedProjectFixture(cacheHome, projectId, repoRoot);
    await writeFile(join(cachePath, "content.md"), "local project draft");

    try {
      mock.respond({
        data: {
          projectUpdate: {
            success: true,
            project: mcpProjectNode({
              id: projectId,
              name: "Dirty Project Remote After",
              description: "after description",
              content: "remote project content",
              icon: "Rocket",
              state: "started",
              updatedAt: "2026-06-04T10:04:00.000Z",
            }),
          },
        },
      });

      const updated = await client.callTool("update_project", {
        id: projectId,
        name: "Dirty Project Remote After",
        content: "remote project content",
        repo_root: repoRoot,
      });
      expect(updated.isError, JSON.stringify(updated.parsed)).toBeFalsy();
      const body = updated.parsed as {
        status: string;
        cache: { refreshed: boolean; error: { code: string }; dirty: { fields: string[] } };
      };
      expect(body.status).toBe("updated-writeback-failed");
      expect(body.cache).toMatchObject({
        refreshed: false,
        error: { code: "cache_dirty" },
        dirty: { fields: ["content"] },
      });
      await expect(readFile(join(cachePath, "content.md"), "utf8")).resolves.toBe(
        "local project draft",
      );
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("cache_status includes stale_check_error when the remote stale check fails", async () => {
    await writeCachedIssueFixture(cacheHome, "UE-363", "cached body");
    mock.respond({
      errors: [
        {
          message: "stale check exploded",
          extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
        },
      ],
    });

    const r = await client.callTool("cache_status", {
      team: "UE",
      check_remote: true,
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      stale_check: string;
      stale_check_error?: string;
    };
    expect(body.stale_check).toBe("errored");
    expect(body.stale_check_error).toContain("stale check exploded");
  });

  it("add_relation refreshes cached source issue under explicit repo_root", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "lebop-mcp-relation-repo-"));
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    const { repoHash, descriptionPath } = await writeCachedIssueFixture(
      cacheHome,
      "UE-501",
      "before relation refresh",
      repoRoot,
    );

    try {
      mock.respond({
        data: {
          issue: {
            relations: { nodes: [], pageInfo: pageInfo() },
            inverseRelations: { nodes: [], pageInfo: pageInfo() },
          },
        },
      });
      mock.respond({ data: { issue: mcpSdkIssuePayload("issue-uuid-501", "UE-501") } });
      mock.respond({ data: { issue: mcpSdkIssuePayload("issue-uuid-502", "UE-502") } });
      mock.respond({
        data: {
          issueRelationCreate: {
            success: true,
            issueRelation: { id: "relation-created-501", type: "related" },
          },
        },
      });
      mock.respond({
        data: {
          a0: mcpSdkIssuePayload("issue-uuid-501", "UE-501", {
            description: "after relation refresh",
            updatedAt: "2026-06-05T00:01:00.000Z",
          }),
        },
      });

      const added = await client.callTool("add_relation", {
        from: "UE-501",
        kind: "related",
        to: "UE-502",
        repo_root: repoRoot,
      });
      expect(added.isError, JSON.stringify(added.parsed)).toBeFalsy();
      const body = added.parsed as {
        status: string;
        relation_id: string;
        cache: { refreshed: boolean; repo_hash: string; repo_root: string };
      };
      expect(body).toMatchObject({
        status: "created",
        relation_id: "relation-created-501",
      });
      expect(body.cache).toMatchObject({
        refreshed: true,
        repo_hash: repoHash,
        repo_root: repoRoot,
      });
      await expect(readFile(descriptionPath, "utf8")).resolves.toBe("after relation refresh");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("cache_status rejects explicit repo_root outside a git repository", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "lebop-mcp-not-a-repo-"));
    try {
      const r = await client.callTool("cache_status", {
        team: "UE",
        repo_root: repoRoot,
      });

      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.parsed)).toContain("repo_root is not inside a git repository");
      expect(mock.requestAt(0)).toBeUndefined();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("cache_status batches remote stale checks for large issue caches", async () => {
    const isolatedHome = await makeAuthFile("lin_api_test_mcp_cache_batching");
    const isolatedClient = await startMcpClient({ ...env, LEBOP_HOME: isolatedHome });
    const identifiers = Array.from(
      { length: CAS_QUERY_BATCH_SIZE + 1 },
      (_, i) => `UE-${1000 + i}`,
    );

    try {
      const init = await isolatedClient.initialize();
      expect(init.protocolVersion).toBe("2024-11-05");
      await isolatedClient.notifyInitialized();

      for (const identifier of identifiers) {
        await writeCachedIssueFixture(isolatedHome, identifier, "cached body");
      }
      for (const batch of [
        identifiers.slice(0, CAS_QUERY_BATCH_SIZE),
        identifiers.slice(CAS_QUERY_BATCH_SIZE),
      ]) {
        mock.respond({
          data: Object.fromEntries(
            batch.map((identifier, i) => [
              `a${i}`,
              {
                id: `issue-uuid-${identifier.toLowerCase()}`,
                identifier,
                updatedAt: "2026-05-01T00:00:00.000Z",
              },
            ]),
          ),
        });
      }

      const r = await isolatedClient.callTool("cache_status", {
        team: "UE",
        check_remote: true,
      });

      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      const body = r.parsed as { stale_check: string; stale: unknown[] };
      expect(body.stale_check).toBe("ok");
      expect(body.stale).toEqual([]);
      expect(mock.requestAt(0)?.query.match(/issue\(id:/g)).toHaveLength(CAS_QUERY_BATCH_SIZE);
      expect(mock.requestAt(1)?.query.match(/issue\(id:/g)).toHaveLength(1);
      expect(mock.requestAt(2)).toBeUndefined();
    } finally {
      await isolatedClient.close();
      await rm(isolatedHome, { recursive: true, force: true });
    }
  });

  it("pull_project resolves project names with the duplicate-aware shared resolver", async () => {
    mock.respond({
      data: {
        projects: {
          nodes: [
            {
              id: "project-target",
              name: "Target Project",
              teams: { nodes: [{ key: "UE" }] },
            },
          ],
        },
      },
    });
    mock.respond({
      data: {
        project: mcpProjectNode({
          id: "project-target",
          name: "Target Project",
          description: "Target project",
          content: "Project content",
          state: "started",
          updatedAt: "2026-06-06T00:00:00.000Z",
        }),
      },
    });
    mock.respond({
      data: {
        project: {
          issues: {
            nodes: [],
            pageInfo: pageInfo(),
          },
        },
      },
    });

    const pulled = await client.callTool("pull_project", {
      project: "Target Project",
      team: "UE",
      refresh: true,
      confirm: true,
    });

    expect(pulled.isError, JSON.stringify(pulled.parsed)).toBeFalsy();
    const body = pulled.parsed as { project: { id: string; name: string; issues: number } };
    expect(body.project).toMatchObject({
      id: "project-target",
      name: "Target Project",
      issues: 0,
    });
    expect(mock.requestAt(0)?.variables).toEqual({ name: "Target Project", teamKey: "UE" });
    expect(mock.requestAt(0)?.query).toContain("first: 2");
    expect(mock.requestAt(0)?.query).toContain("accessibleTeams");
  });

  it("pull_project rejects duplicate project-name matches instead of taking the first", async () => {
    mock.respond({
      data: {
        projects: {
          nodes: [
            { id: "project-a", name: "Duplicate Project", teams: { nodes: [{ key: "UE" }] } },
            { id: "project-b", name: "Duplicate Project", teams: { nodes: [{ key: "UE" }] } },
          ],
        },
      },
    });

    const pulled = await client.callTool("pull_project", {
      project: "Duplicate Project",
      team: "UE",
      refresh: true,
      confirm: true,
    });

    expect(pulled.isError).toBe(true);
    const body = pulled.parsed as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toContain('ambiguous project name "Duplicate Project"');
  });

  it("pull_project fetches the project and child issues, then push_changes can push project edits", async () => {
    const projectId = "11111111-2222-3333-4444-555555555555";
    mock.respond({
      data: {
        project: mcpProjectNode({
          id: projectId,
          name: "MCP Cache Project",
          description: "cache project",
          content: "Original project content.",
          icon: "Rocket",
          state: "backlog",
          updatedAt: "2026-06-04T10:00:00.000Z",
        }),
      },
    });
    mock.respond({
      data: {
        project: {
          issues: {
            nodes: [{ identifier: "UE-360", title: "Project child" }],
            pageInfo: pageInfo(),
          },
        },
      },
    });
    mock.respond({
      data: {
        a0: {
          id: "ue-360-uuid",
          identifier: "UE-360",
          title: "Project child",
          description: "child body",
          priority: 0,
          estimate: null,
          url: "https://linear.app/test/issue/UE-360",
          updatedAt: "2026-05-10T12:00:00.000Z",
          state: { id: "state-bl", name: "Backlog", type: "backlog" },
          assignee: null,
          project: { id: projectId, name: "MCP Cache Project" },
          team: { id: "team-ue", key: "UE" },
          parent: null,
          labels: { nodes: [] },
          comments: {
            nodes: [],
            pageInfo: pageInfo(),
          },
        },
      },
    });

    const pulled = await client.callTool("pull_project", {
      project_id: projectId,
      team: "UE",
      refresh: true,
      confirm: true,
    });
    expect(pulled.isError, JSON.stringify(pulled.parsed)).toBeFalsy();
    const pullBody = pulled.parsed as {
      project: { id: string; name: string; issues: number; cache_path: string; path: string };
      issues: { identifier: string; cache_path?: string; path?: string }[];
    };
    expect(pullBody.project).toMatchObject({
      id: projectId,
      name: "MCP Cache Project",
      issues: 1,
    });
    expect(pullBody.issues[0]?.identifier).toBe("UE-360");
    expect(pullBody.project.path).toBe(pullBody.project.cache_path);
    expect(pullBody.issues[0]?.path).toBe(pullBody.issues[0]?.cache_path);

    await writeFile(join(pullBody.project.cache_path, "content.md"), "Updated project content.\n");
    mock.respond({
      data: {
        project: mcpProjectNode({
          id: projectId,
          name: "MCP Cache Project",
          description: "cache project",
          content: "Original project content.",
          icon: "Rocket",
          state: "backlog",
          updatedAt: "2026-06-04T10:00:00.000Z",
        }),
      },
    });
    const diff = await client.callTool("diff_project", {
      project_id: projectId,
      team: "UE",
    });
    expect(diff.isError, JSON.stringify(diff.parsed)).toBeFalsy();
    const diffBody = diff.parsed as {
      project_id: string;
      fields: { field: string }[];
      content_changed: boolean;
    };
    expect(diffBody.project_id).toBe(projectId);
    expect(diffBody.content_changed).toBe(true);
    expect(diffBody.fields.map((f) => f.field)).toContain("content");

    mock.respond({
      data: { p0: { id: projectId, updatedAt: "2026-06-04T10:00:00.000Z" } },
    });
    const dryRun = await client.callTool("push_changes", {
      project_ids: [projectId],
      team: "UE",
      dry_run: true,
    });
    expect(dryRun.isError, JSON.stringify(dryRun.parsed)).toBeFalsy();
    const dryRunBody = dryRun.parsed as {
      team: string;
      repo_hash: string;
      mode: "cache";
      results: { kind: string; status: string; fields?: string[] }[];
    };
    expect(dryRunBody).toMatchObject({ team: "UE", mode: "cache" });
    expect(typeof dryRunBody.repo_hash).toBe("string");
    expect(dryRunBody.results[0]).toMatchObject({
      kind: "project",
      status: "dry-run",
      fields: ["content"],
    });

    mock.respond({
      data: { p0: { id: projectId, updatedAt: "2026-06-04T10:00:00.000Z" } },
    });
    mock.respond({
      data: { p0: { id: projectId, updatedAt: "2026-06-04T10:00:00.000Z" } },
    });
    mock.respond({
      data: {
        projectUpdate: {
          success: true,
          project: mcpProjectNode({
            id: projectId,
            name: "MCP Cache Project",
            description: "cache project",
            content: "Updated project content.\n",
            icon: "Rocket",
            state: "backlog",
            updatedAt: "2026-06-04T10:01:00.000Z",
          }),
        },
      },
    });
    const pushed = await client.callTool("push_changes", {
      project_ids: [projectId],
      team: "UE",
    });
    expect(pushed.isError, JSON.stringify(pushed.parsed)).toBeFalsy();
    const pushBody = pushed.parsed as {
      team: string;
      repo_hash: string;
      mode: "cache";
      results: { kind: string; status: string; fields?: string[] }[];
    };
    expect(pushBody).toMatchObject({ team: "UE", mode: "cache" });
    expect(typeof pushBody.repo_hash).toBe("string");
    expect(pushBody.results[0]).toMatchObject({
      kind: "project",
      status: "pushed",
      fields: ["content"],
    });
    expect(mock.requestAt(7)?.variables).toMatchObject({
      id: projectId,
      input: { content: "Updated project content.\n" },
    });
  });

  it("pull_project paginates child issue comment overflow", async () => {
    const projectId = "22222222-3333-4444-8555-666666666666";
    mock.respond({
      data: {
        project: mcpProjectNode({
          id: projectId,
          name: "MCP Overflow Project",
          description: "cache project",
          content: "Project content.",
          icon: "Rocket",
          state: "backlog",
          updatedAt: "2026-06-04T10:00:00.000Z",
        }),
      },
    });
    mock.respond({
      data: {
        project: {
          issues: {
            nodes: [{ identifier: "UE-364", title: "Project child with comments" }],
            pageInfo: pageInfo(),
          },
        },
      },
    });
    mock.respond({
      data: {
        a0: {
          id: "ue-364-uuid",
          identifier: "UE-364",
          title: "Project child with comments",
          description: "child body",
          priority: 0,
          estimate: null,
          url: "https://linear.app/test/issue/UE-364",
          updatedAt: "2026-05-10T12:00:00.000Z",
          state: { id: "state-bl", name: "Backlog", type: "backlog" },
          assignee: null,
          project: { id: projectId, name: "MCP Overflow Project" },
          team: { id: "team-ue", key: "UE" },
          parent: null,
          labels: { nodes: [] },
          comments: {
            nodes: [
              {
                id: "pc-250",
                body: "project inline comment",
                createdAt: "2026-05-10T12:00:00.000Z",
                updatedAt: "2026-05-10T12:00:00.000Z",
                user: null,
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: "project-cursor-250" },
          },
        },
      },
    });
    mock.respond({
      data: {
        issue: {
          comments: {
            nodes: [
              {
                id: "pc-251",
                body: "project overflow comment",
                createdAt: "2026-05-10T12:01:00.000Z",
                updatedAt: "2026-05-10T12:01:00.000Z",
                user: null,
              },
            ],
            pageInfo: pageInfo(),
          },
        },
      },
    });

    const pulled = await client.callTool("pull_project", {
      project_id: projectId,
      team: "UE",
      refresh: true,
      confirm: true,
    });
    expect(pulled.isError, JSON.stringify(pulled.parsed)).toBeFalsy();
    const body = pulled.parsed as {
      issues: { identifier: string; comments: number; cache_path: string }[];
    };
    expect(body.issues[0]).toMatchObject({ identifier: "UE-364", comments: 2 });
    await expect(
      readFile(join(body.issues[0]?.cache_path ?? "", "comments", "pc-251.md"), "utf8"),
    ).resolves.toContain("project overflow comment");
    expect(mock.requestAt(3)?.variables).toMatchObject({
      id: "UE-364",
      first: 250,
      after: "project-cursor-250",
    });
  });
});

describe("mcp: plan_validate / lint_text / raw_graphql", () => {
  let client: McpClient;
  let planDir: string;

  beforeAll(async () => {
    client = await bootClient();
    planDir = await mkdtemp(join(tmpdir(), "lebop-mcp-plan-"));
    await writeFile(
      join(planDir, "_project.md"),
      `---
name: "MCP test plan"
description: "tiny plan for mcp.test.ts"
state: backlog
team: ENG
---

# Test project
`,
    );
    await writeFile(
      join(planDir, "01-task.md"),
      `---
title: "Just a task"
state: Backlog
priority: normal
---

# Body
A single line.
`,
    );
  });

  afterAll(async () => {
    await client.close();
    await rm(planDir, { recursive: true, force: true });
  });

  it("plan_validate on a clean tmp plan reports no errors", async () => {
    queueTeamMetadataResponses("ENG");
    const r = await client.callTool("plan_validate", { dir: planDir });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    // Wave-3 parity: plan_validate now emits the CLI's richer shape with
    // a full `issues` array (slug + title + linear_id) instead of an
    // `issue_count` scalar.
    const body = r.parsed as {
      errors: unknown[];
      warnings: unknown[];
      project: { name: string; linear_id: string | null };
      issues: { slug: string; title: string; linear_id: string | null }[];
    };
    expect(body.errors).toEqual([]);
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]?.slug).toBeDefined();
    expect(body.project).toBeDefined();
  });

  it("plan_lint lints every plan markdown body", async () => {
    const r = await client.callTool("plan_lint", { dir: planDir, strict: true });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      files: { path: string; warnings: unknown[]; fixed: boolean }[];
      remaining_warnings: number;
      strict_failed: boolean;
    };
    expect(body.files).toHaveLength(2);
    expect(body.remaining_warnings).toBe(0);
    expect(body.strict_failed).toBe(false);
  });

  it("plan_lint fix=true reports final warnings after writing fixes", async () => {
    const fixPlanDir = await mkdtemp(join(tmpdir(), "lebop-mcp-plan-lint-fix-"));
    try {
      await writeFile(join(fixPlanDir, "_project.md"), "---\nname: Fix\nteam: ENG\n---\n\n");
      await writeFile(
        join(fixPlanDir, "01-task.md"),
        ["---", "title: Task", "---", "| Header |", "| --- |", "| 1. inline list |", ""].join("\n"),
      );

      const r = await client.callTool("plan_lint", {
        dir: fixPlanDir,
        fix: true,
        strict: true,
      });
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      const body = r.parsed as {
        files: { path: string; warnings: unknown[]; fixed: number }[];
        remaining_warnings: number;
        strict_failed: boolean;
      };
      const issueFile = body.files.find((file) => file.path.endsWith("01-task.md"));

      expect(issueFile?.fixed).toBe(1);
      expect(issueFile?.warnings).toEqual([]);
      expect(body.remaining_warnings).toBe(0);
      expect(body.strict_failed).toBe(false);
      await expect(readFile(join(fixPlanDir, "01-task.md"), "utf8")).resolves.toContain("Row 1");
    } finally {
      await rm(fixPlanDir, { recursive: true, force: true });
    }
  });

  it("lint_text flags L001 on table-cell ordered-list markers", async () => {
    const content = "| header |\n| --- |\n| 1. inline list |\n";
    const r = await client.callTool("lint_text", { content });
    expect(r.isError).toBeFalsy();
    const body = r.parsed as { warnings: { rule: string }[] };
    const codes = body.warnings.map((w) => w.rule);
    // L001 is the rule for ordered-list markers inside table cells.
    expect(codes).toContain("L001");
  });

  it("lint_text returns fixed content when fix=true", async () => {
    const content = "| header |\n| --- |\n| 1. inline list |\n";
    const r = await client.callTool("lint_text", { content, fix: true });
    expect(r.isError).toBeFalsy();
    const body = r.parsed as {
      fixed: boolean;
      fixed_content: string;
      remaining_warning_count: number;
      fix_passes: number;
    };
    expect(body.fixed).toBe(true);
    expect(body.fixed_content).toContain("Row 1");
    expect(body.fixed_content).not.toContain("1. inline list");
    expect(body.remaining_warning_count).toBe(0);
    expect(body.fix_passes).toBeGreaterThan(0);
  });

  it("lint_files lints explicit local markdown paths", async () => {
    const lintDir = await mkdtemp(join(tmpdir(), "lebop-mcp-lint-files-"));
    try {
      const file = join(lintDir, "table.md");
      await writeFile(file, "| header |\n| --- |\n| 1. inline list |\n");

      const r = await client.callTool("lint_files", { paths: [file], strict: true });
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      const body = r.parsed as {
        files: { path: string; warnings: { rule: string }[]; fixed: number }[];
        warning_count: number;
        fixed_count: number;
        missing_count: number;
        strict_failed: boolean;
        cache_mode: boolean;
      };
      expect(body.cache_mode).toBe(false);
      expect(body.files).toHaveLength(1);
      expect(body.files[0]?.path).toBe(file);
      expect(body.files[0]?.warnings.map((warning) => warning.rule)).toContain("L001");
      expect(body.files[0]?.fixed).toBe(0);
      expect(body.warning_count).toBeGreaterThan(0);
      expect(body.fixed_count).toBe(0);
      expect(body.missing_count).toBe(0);
      expect(body.strict_failed).toBe(true);
    } finally {
      await rm(lintDir, { recursive: true, force: true });
    }
  });

  it("lint_files fix=true writes safe fixes in-place", async () => {
    const lintDir = await mkdtemp(join(tmpdir(), "lebop-mcp-lint-files-fix-"));
    try {
      const file = join(lintDir, "table.md");
      await writeFile(file, "| header |\n| --- |\n| 1. inline list |\n");

      const r = await client.callTool("lint_files", { paths: [file], fix: true, strict: true });
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      const body = r.parsed as {
        files: { fixed: number; warnings: { rule: string }[] }[];
        warning_count: number;
        fixed_count: number;
        strict_failed: boolean;
      };
      expect(body.files[0]?.warnings.map((warning) => warning.rule)).not.toContain("L001");
      expect(body.files[0]?.fixed).toBeGreaterThan(0);
      expect(body.warning_count).toBe(0);
      expect(body.fixed_count).toBeGreaterThan(0);
      expect(body.strict_failed).toBe(false);
      await expect(readFile(file, "utf8")).resolves.toContain("Row 1");
    } finally {
      await rm(lintDir, { recursive: true, force: true });
    }
  });

  it("lint_files fix=true still reports unfixable remaining warnings", async () => {
    const lintDir = await mkdtemp(join(tmpdir(), "lebop-mcp-lint-files-mixed-fix-"));
    try {
      const file = join(lintDir, "mixed.md");
      await writeFile(file, "| header |\n| --- |\n| 1. inline list |\n\n    ```ts\n");

      const r = await client.callTool("lint_files", { paths: [file], fix: true, strict: true });
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      const body = r.parsed as {
        files: { fixed: number; warnings: { rule: string }[] }[];
        warning_count: number;
        fixed_count: number;
        strict_failed: boolean;
      };
      const rules = body.files[0]?.warnings.map((warning) => warning.rule) ?? [];
      expect(rules).not.toContain("L001");
      expect(rules).toContain("L003");
      expect(body.files[0]?.fixed).toBeGreaterThan(0);
      expect(body.warning_count).toBe(1);
      expect(body.fixed_count).toBeGreaterThan(0);
      expect(body.strict_failed).toBe(true);
      await expect(readFile(file, "utf8")).resolves.toContain("Row 1");
    } finally {
      await rm(lintDir, { recursive: true, force: true });
    }
  });

  it("lint_files rejects all-missing explicit paths before Linear I/O", async () => {
    const missing = join(tmpdir(), `lebop-mcp-lint-missing-${Date.now()}.md`);
    const r = await client.callTool("lint_files", { paths: [missing] });
    expect(r.isError).toBe(true);
    const body = r.parsed as { error: { code: string; message: string; hint?: string } };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toContain("no files linted");
    expect(body.error.hint).toContain("verify the path");
  });

  it("raw_graphql passes the query through and returns response.data", async () => {
    mock.respond({
      data: {
        viewer: { id: "viewer-id" },
      },
    });

    const r = await client.callTool("raw_graphql", {
      query: "query { viewer { id } }",
    });
    expect(r.isError).toBeFalsy();
    const body = r.parsed as { data: { viewer: { id: string } } };
    expect(body.data.viewer.id).toBe("viewer-id");
  });

  it("raw_graphql paginate returns the standard envelope with merged response data", async () => {
    mock.respond({
      data: {
        teams: {
          nodes: [{ id: "team-1" }],
          pageInfo: { hasNextPage: true, endCursor: "teams-cursor-1" },
        },
      },
    });
    mock.respond({
      data: {
        teams: {
          nodes: [{ id: "team-2" }],
          pageInfo: pageInfo(),
        },
      },
    });

    const r = await client.callTool("raw_graphql", {
      query:
        "query Teams($first: Int!, $after: String) { teams(first: $first, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }",
      paginate: true,
    });

    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      schema_version: number;
      data: { teams: { nodes: { id: string }[] } };
    };
    expect(body.schema_version).toBe(1);
    expect(body.data.teams.nodes.map((team) => team.id)).toEqual(["team-1", "team-2"]);
    expect(mock.requestAt(0)?.variables).toMatchObject({ first: 250 });
    expect(mock.requestAt(1)?.variables).toMatchObject({ first: 250, after: "teams-cursor-1" });
  });

  it("raw_graphql rejects mutation operations without explicit mutation intent", async () => {
    const r = await client.callTool("raw_graphql", {
      query: "mutation CreateThing { issueCreate(input: {}) { success } }",
    });

    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.parsed)).toContain("allow_mutation=true");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("raw_graphql rejects fragment-leading mutation documents without explicit mutation intent", async () => {
    const r = await client.callTool("raw_graphql", {
      query:
        "fragment IssueFields on Issue { id }\nmutation CreateThing { issueCreate(input: {}) { success } }",
    });

    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.parsed)).toContain("allow_mutation=true");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("raw_graphql rejects allowed mutation operations without confirm", async () => {
    const r = await client.callTool("raw_graphql", {
      query: "mutation CreateThing { issueCreate(input: {}) { success } }",
      allow_mutation: true,
    });

    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.parsed)).toContain("confirm: true");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("raw_graphql does not retry explicitly allowed mutation operations after a transient response", async () => {
    mock.respond({
      status: 503,
      errors: [{ message: "Service Unavailable", extensions: { code: "SERVICE_UNAVAILABLE" } }],
    });

    const r = await client.callTool("raw_graphql", {
      query: "mutation CreateThing { issueCreate(input: {}) { success } }",
      allow_mutation: true,
      confirm: true,
    });

    expect(r.isError).toBe(true);
    expect(mock.requestAt(0)?.query).toContain("mutation CreateThing");
    expect(mock.requestAt(1)).toBeUndefined();
  });

  it("raw_graphql rejects paginate for mutations before contacting Linear", async () => {
    const r = await client.callTool("raw_graphql", {
      query: "mutation CreateThing { issueCreate(input: {}) { success } }",
      paginate: true,
    });

    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.parsed)).toContain("--paginate requires a GraphQL query operation");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("raw_graphql rejects subscription operations before contacting Linear", async () => {
    const r = await client.callTool("raw_graphql", {
      query: "subscription Events { issueCreated { id } }",
    });

    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.parsed)).toContain("raw_graphql requires a GraphQL query");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("raw_graphql paginate rejects non-connection query responses instead of returning empty success", async () => {
    mock.respond({
      data: {
        viewer: { id: "viewer-id" },
      },
    });

    const r = await client.callTool("raw_graphql", {
      query: "query { viewer { id } }",
      paginate: true,
    });

    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.parsed)).toContain("no connection-shaped field");
    expect(mock.requestAt(0)?.query).toContain("viewer");
  });
});

describe("mcp: error shapes", () => {
  let client: McpClient;

  beforeAll(async () => {
    client = await bootClient();
  });

  afterAll(async () => {
    await client.close();
  });

  it("missing required param yields a structured validation/protocol error", async () => {
    // get_issue requires `identifier`. The MCP SDK's zod-derived input schema
    // rejects the call before our handler runs, so the SDK returns a
    // protocol-level error (not isError:true). Either shape is acceptable as
    // long as the call doesn't succeed.
    let threw = false;
    let toolResult: Awaited<ReturnType<typeof client.callTool>> | null = null;
    try {
      toolResult = await client.callTool("get_issue", {});
    } catch {
      threw = true;
    }
    if (threw) {
      // Protocol-level rejection — fine.
      expect(threw).toBe(true);
    } else {
      // Handler-level rejection — expect isError:true with a structured body.
      expect(toolResult?.isError).toBe(true);
    }
  });

  it("omitted MCP arguments still reject required tool params", async () => {
    const r = await client.callToolOmittingArguments("get_issue");
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.parsed)).toContain("Invalid arguments for tool get_issue");
    expect(JSON.stringify(r.parsed)).toContain("identifier");
  });

  it("get_issue with a NOT_FOUND extension returns structured not_found", async () => {
    mock.respond({
      data: { a0: null },
      errors: [
        {
          message: "Entity not found",
          extensions: { code: "NOT_FOUND" },
        },
      ],
    });

    const r = await client.callTool("get_issue", { identifier: "NOX-999999" });
    expect(r.isError).toBe(true);
    const body = r.parsed as {
      schema_version: number;
      error: { code: string; message: string; hint?: string };
    };
    expect(body.schema_version).toBe(1);
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toContain("issue not found: NOX-999999");
  });

  it("get_issue with a clean null response also returns structured not_found", async () => {
    mock.respond({ data: { a0: null } });

    const r = await client.callTool("get_issue", { identifier: "NOX-99999" });
    expect(r.isError).toBe(true);
    const body = r.parsed as {
      schema_version: number;
      error: { code: string; message: string; hint?: string };
    };
    expect(body.schema_version).toBe(1);
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toContain("issue not found: NOX-99999");
  });

  it("list_comments returns not_found for a missing issue", async () => {
    mock.respond({ data: { issue: null } });

    const r = await client.callTool("list_comments", { identifier: "NOX-99999" });
    expect(r.isError).toBe(true);
    const body = r.parsed as {
      schema_version: number;
      error: { code: string; message: string; hint?: string };
    };
    expect(body.schema_version).toBe(1);
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toContain("issue not found: NOX-99999");
  });

  it("whoami with an unknown for_workspace surfaces auth_error with hint", async () => {
    // No mock queued — auth resolution happens BEFORE any HTTP call.
    // whoami calls loadAuthForWorkspace(for_workspace) which throws AuthError
    // for an unknown slug. Verifies the safe() wrapper preserves
    // LebopError.code + hint through the MCP boundary (spec §13.3 contract).
    const r = await client.callTool("whoami", {
      for_workspace: "no-such-workspace",
    });
    expect(r.isError).toBe(true);
    const body = r.parsed as {
      schema_version: number;
      error: { code: string; message: string; hint?: string };
    };
    // Error envelopes carry schema_version: 1 (formatToolError uses the
    // SCHEMA_VERSION constant from envelope.ts — locks success/error
    // envelopes to the same versioning contract).
    expect(body.schema_version).toBe(1);
    expect(body.error.code).toBe("auth_error");
    expect(body.error.message).toContain("not configured");
    expect(body.error.hint).toBeTruthy();
  });
});

describe("mcp: wave-4A — attachments / lookups / bulk_update_issues", () => {
  let client: McpClient;

  beforeAll(async () => {
    client = await bootClient();
  });

  afterAll(async () => {
    await client.close();
  });

  it("list_attachments returns the issue's attachments and shapes the envelope", async () => {
    mock.respond({
      data: {
        issue: {
          attachments: {
            nodes: [
              {
                id: "att-1",
                title: "PR #42",
                url: "https://github.com/x/y/pull/42",
                sourceType: "github",
                metadata: { kind: "pr" },
                creator: { id: "u-1", name: "Alice", email: "a@x.io" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
    const r = await client.callTool("list_attachments", { identifier: "ENG-1" });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      identifier: string;
      count: number;
      attachments: { id: string; title: string; source_type: string | null }[];
    };
    expect(body.identifier).toBe("ENG-1");
    expect(body.count).toBe(1);
    expect(body.attachments[0]?.title).toBe("PR #42");
    expect(body.attachments[0]?.source_type).toBe("github");
  });

  it("delete_attachment round-trips success: true", async () => {
    mock.respond({ data: { attachmentDelete: { success: true } } });
    const r = await client.callTool("delete_attachment", {
      id: "11111111-2222-3333-4444-555555555555",
      confirm: true,
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { id: string; success: boolean };
    expect(body.success).toBe(true);
  });

  it("lookup_state_by_name returns null when no state matches (get_* contract)", async () => {
    mock.respond({ data: { workflowStates: { nodes: [] } } });
    const r = await client.callTool("lookup_state_by_name", {
      team: "ENG",
      name: "Nonexistent",
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { state: unknown };
    expect(body.state).toBeNull();
  });

  it("lookup_user_by_email shapes the envelope on a hit", async () => {
    mock.respond({
      data: {
        users: {
          nodes: [
            {
              id: "u-1",
              email: "a@x.io",
              name: "Alice",
              displayName: "alice",
              active: true,
            },
          ],
        },
      },
    });
    const r = await client.callTool("lookup_user_by_email", { email: "a@x.io" });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      user: { id: string; display_name: string; active: boolean };
    };
    expect(body.user?.display_name).toBe("alice");
  });

  it("get_team resolves by key and surfaces default_state_name", async () => {
    mock.respond({
      data: {
        teams: {
          nodes: [
            {
              id: "team-uuid-eng",
              key: "ENG",
              name: "Engineering",
              description: null,
              defaultIssueState: { id: "state-bl", name: "Backlog" },
            },
          ],
        },
      },
    });
    const r = await client.callTool("get_team", { id: "ENG" });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      team: { key: string; default_state_name: string };
    };
    expect(body.team.key).toBe("ENG");
    expect(body.team.default_state_name).toBe("Backlog");
  });

  it("bulk_update_issues partial success: one good id + one not-found surfaces both rows", async () => {
    // Step 1: parallel issue(id) lookups — order may vary; we queue one
    // success + one null and let either land first. Both query strings are
    // identical so the mock's FIFO doesn't care which identifier maps to
    // which response. We compensate below by checking the row STATUS, not
    // the mock order.
    mock.respond({
      data: { issue: { id: "issue-uuid-34", identifier: "NOX-34" } },
    });
    mock.respond({ data: { issue: null } });
    // Step 2: issueBatchUpdate echoes only NOX-34.
    mock.respond({
      data: {
        issueBatchUpdate: {
          success: true,
          issues: [{ id: "issue-uuid-34", identifier: "NOX-34" }],
        },
      },
    });

    const r = await client.callTool("bulk_update_issues", {
      identifiers: ["NOX-34", "NOX-999"],
      patch: { priority: "high" },
      confirm: true,
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      results: { identifier: string; status: string; error?: { code: string } }[];
      summary: { updated: number; failed: number; total: number };
    };
    expect(body.summary.total).toBe(2);
    // Exactly one updated + one failed. The good identifier may be either
    // NOX-34 or NOX-999 depending on which lookup the FIFO matched; we
    // assert on the row that landed as updated.
    const updated = body.results.find((r2) => r2.status === "updated");
    const failed = body.results.find((r2) => r2.status === "failed");
    expect(updated).toBeDefined();
    expect(failed).toBeDefined();
    // Either NOX-34 or NOX-999 should show up as not_found — whichever
    // happened to consume the `{issue: null}` mock.
    expect(failed?.error?.code).toBe("not_found");
  });

  it("bulk_update_issues refuses to overwrite dirty cached issues after remote success", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "lebop-mcp-bulk-dirty-repo-"));
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    const { descriptionPath } = await writeCachedIssueFixture(
      lebopHome,
      "NOX-35",
      "server baseline",
      repoRoot,
    );
    await writeFile(descriptionPath, "local bulk draft");

    try {
      mock.respond({
        data: { issue: { id: "issue-uuid-35", identifier: "NOX-35" } },
      });
      mock.respond({
        data: {
          issueBatchUpdate: {
            success: true,
            issues: [{ id: "issue-uuid-35", identifier: "NOX-35" }],
          },
        },
      });

      const r = await client.callTool("bulk_update_issues", {
        identifiers: ["NOX-35"],
        patch: { priority: "high" },
        repo_root: repoRoot,
        confirm: true,
      });
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      const body = r.parsed as {
        summary: { updated: number };
        cache: {
          failed: number;
          rows: { refreshed: boolean; error: { code: string }; dirty: { fields: string[] } }[];
        };
      };
      expect(body.summary.updated).toBe(1);
      expect(body.cache.failed).toBe(1);
      expect(body.cache.rows[0]).toMatchObject({
        refreshed: false,
        error: { code: "cache_dirty" },
        dirty: { fields: ["description"] },
      });
      await expect(readFile(descriptionPath, "utf8")).resolves.toBe("local bulk draft");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("bulk_update_issues rejects empty identifier arrays before mutation", async () => {
    const r = await client.callTool("bulk_update_issues", {
      identifiers: [],
      patch: { priority: "high" },
      confirm: true,
    });
    expect(r.isError).toBe(true);
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("bulk_update_issues dry_run previews without confirm or mutation", async () => {
    mock.respond({
      data: { issue: { id: "issue-uuid-36", identifier: "NOX-36" } },
    });

    const r = await client.callTool("bulk_update_issues", {
      identifiers: ["NOX-36"],
      patch: { priority: "high" },
      dry_run: true,
    });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      results: { identifier: string; status: string; fields?: string[] }[];
      summary: { updated: number; would_update: number; dry_run: boolean };
    };
    expect(body.summary).toMatchObject({ updated: 0, would_update: 1, dry_run: true });
    expect(body.results[0]).toMatchObject({
      identifier: "NOX-36",
      status: "would_update",
      fields: ["priority"],
    });
    expect(mock.requestAt(1)).toBeUndefined();
  });

  it("bulk_update_issues requires confirm for real mutations before Linear I/O", async () => {
    const r = await client.callTool("bulk_update_issues", {
      identifiers: ["NOX-37"],
      patch: { priority: "high" },
    });

    expect(r.isError).toBe(true);
    expect((r.parsed as { error: { message: string } }).error.message).toContain("confirm");
    expect(mock.requestAt(0)).toBeUndefined();
  });
});

describe("mcp: structured error shapes from converted tool-handler sites (wave-4 round-B item #2)", () => {
  // Wave-4 round-B converted the remaining raw `throw new Error(...)` sites
  // in server.ts handler bodies to structured LebopError subtypes
  // (NotFoundError / ValidationError) so MCP clients see meaningful `code`
  // values instead of `code: "unknown"`. These smoke tests cover one
  // representative per category: team-not-found (workflow_states), input
  // validation (update_milestone with no fields), project-not-found
  // (create_milestone with an unresolvable name).
  let client: McpClient;

  beforeAll(async () => {
    client = await bootClient();
  });

  afterAll(async () => {
    await client.close();
  });

  it("list_workflow_states surfaces `not_found` with a hint when the team key is unknown", async () => {
    // listWorkflowStates returns null when the team key doesn't resolve.
    // The MCP handler turns that into a LebopError(code=not_found).
    mock.respond({ data: { teams: { nodes: [] } } });
    const r = await client.callTool("list_workflow_states", { team: "DOES_NOT_EXIST" });
    expect(r.isError).toBe(true);
    const body = r.parsed as { error: { code: string; message: string; hint?: string } };
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toContain("team not found");
    expect(body.error.hint).toBeTruthy();
  });

  it("list_workflow_states resolves the configured default team when omitted", async () => {
    const home = await makeHomeWithDefaultTeam("NOX");
    const defaultClient = await bootClientWithHome(home);
    try {
      mock.respond({
        data: {
          teams: {
            nodes: [
              {
                id: "team-uuid",
                key: "NOX",
                name: "Noxor",
                defaultIssueState: { id: "state-backlog" },
                states: {
                  nodes: [
                    { id: "state-backlog", name: "Backlog", type: "backlog", color: "#aaaaaa" },
                  ],
                  pageInfo: pageInfo(),
                },
              },
            ],
          },
        },
      });

      const r = await defaultClient.callTool("list_workflow_states", {});
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      expect(r.parsed).toMatchObject({
        team: "NOX",
        count: 1,
        states: [{ id: "state-backlog", default: true }],
      });
      expect(mock.requestAt(0)?.variables).toMatchObject({ key: "NOX" });
    } finally {
      await defaultClient.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("update_milestone with no patch fields surfaces `validation_error` with a hint", async () => {
    // No `name`/`description`/`target_date`/`sort_order`/`project` → the
    // handler used to throw a raw Error. Now it throws a structured
    // ValidationError that the safe() wrapper preserves through MCP.
    const r = await client.callTool("update_milestone", {
      id: "11111111-2222-3333-4444-555555555555",
    });
    expect(r.isError).toBe(true);
    const body = r.parsed as { error: { code: string; message: string; hint?: string } };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toMatch(/nothing to update/);
    expect(body.error.hint).toBeTruthy();
  });

  it("create_milestone with an unresolvable project name surfaces `not_found` + hint", async () => {
    // resolveProjectId returns null → handler used to throw raw Error.
    // Now NotFoundError flows through with a hint pointing at list_projects.
    mock.respond({
      data: { projects: { nodes: [] } },
    });
    const r = await client.callTool("create_milestone", {
      name: "v1",
      project: "Nonexistent Project",
    });
    expect(r.isError).toBe(true);
    const body = r.parsed as { error: { code: string; message: string; hint?: string } };
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toContain("project not found");
    expect(body.error.hint).toBeTruthy();
  });
});

describe("mcp: list_team_members — round-5 arg rename (BREAKING: team_key → team)", () => {
  // Round 5 renamed the inputSchema field `team_key` → `team` for
  // consistency with every other team-keyed MCP tool. These tests lock
  // both directions: the new `team` arg works, and the old `team_key`
  // arg now fails input validation (the field doesn't exist anymore).
  let client: McpClient;

  beforeAll(async () => {
    client = await bootClient();
  });

  afterAll(async () => {
    await client.close();
  });

  it("accepts the new `team` arg and returns shaped members envelope", async () => {
    // listTeamMembers makes TWO calls:
    //   1. `c.teams({filter: {key}})` — SDK typed call, resolves key→UUID
    //   2. `LIST_TEAM_MEMBERSHIPS_QUERY` — paginated membership walk
    mock.respond({
      data: {
        teams: {
          nodes: [{ id: "team-uuid", key: "NOX", name: "Noxor", description: null }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
    mock.respond({
      data: {
        team: {
          id: "team-uuid",
          key: "NOX",
          name: "Noxor",
          memberships: {
            nodes: [
              {
                id: "membership-1",
                owner: false,
                user: {
                  id: "u-1",
                  name: "Justice",
                  email: "justice@unlink.xyz",
                  displayName: "justice",
                  active: true,
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
    const r = await client.callTool("list_team_members", { team: "NOX" });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      schema_version: number;
      team: string;
      count: number;
      members: Array<{ id: string; email: string }>;
    };
    expect(body.schema_version).toBe(1);
    expect(body.team).toBe("NOX");
    expect(body.count).toBe(1);
    expect(body.members[0]?.email).toBe("justice@unlink.xyz");
  });

  it("omitted team resolves the configured default team", async () => {
    const home = await makeHomeWithDefaultTeam("NOX");
    const defaultClient = await bootClientWithHome(home);
    try {
      mock.respond({
        data: {
          teams: {
            nodes: [{ id: "team-uuid", key: "NOX", name: "Noxor", description: null }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
      mock.respond({
        data: {
          team: {
            id: "team-uuid",
            key: "NOX",
            name: "Noxor",
            memberships: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });

      const r = await defaultClient.callTool("list_team_members", {});
      expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
      expect(r.parsed).toMatchObject({ team: "NOX", count: 0, members: [] });
      expect(mock.requestAt(0)?.variables.filter).toMatchObject({ key: { eq: "NOX" } });
    } finally {
      await defaultClient.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects the old `team_key` arg with input-validation error (no `team` provided)", async () => {
    // Calling with the pre-round-5 arg name leaves `team` unset → Zod
    // validation surfaces an `Invalid input` error at the MCP protocol
    // layer. The old field name is intentionally undefined so any client
    // that didn't update will see a clear failure rather than a silent
    // wrong-team query.
    let threw: unknown = null;
    let toolResult: Awaited<ReturnType<typeof client.callTool>> | null = null;
    try {
      toolResult = await client.callTool("list_team_members", { team_key: "NOX" });
    } catch (e) {
      threw = e;
    }
    // Either a protocol-level rejection (threw at the JSON-RPC layer) or
    // a handler-level isError envelope is acceptable evidence that the
    // old field name is dead. The one outcome we must NOT see is a
    // normal success envelope keyed by team="NOX" — that would mean the
    // rename didn't take effect.
    if (threw) {
      expect(threw).toBeTruthy();
    } else {
      expect(toolResult?.isError).toBe(true);
    }
  });
});

describe("mcp: round-6 / H11 — zod validation errors emit the structured envelope", () => {
  // Pre-fix bug: zod input-validation errors bypassed the envelope contract.
  // The SDK's `validateToolInput` threw `McpError(InvalidParams, ...)` before
  // the user handler ran, and the SDK's outer catch routed it through
  // `createToolError(msg)` to produce a prose payload (`"MCP error -32602:
  // Input validation error: ..."`). Programmatic dispatch on `error.code`
  // was impossible without string parsing.
  //
  // Post-fix: `installEnvelopeValidator` replaces the SDK's
  // CallToolRequestSchema handler with one that runs the same zod parse
  // but emits a structured envelope on failure (`code: "invalid_arguments"`,
  // plus a `issues[]` array with per-field detail). The success path is
  // unchanged.
  let client: McpClient;

  beforeAll(async () => {
    client = await bootClient();
  });

  afterAll(async () => {
    await client.close();
  });

  it("required-field rejection emits envelope with `code: invalid_arguments` + structured issues", async () => {
    // `get_issue` requires `identifier`. Omitting it triggers a zod failure
    // BEFORE the handler runs, exercising the new validator path.
    const r = await client.callTool("get_issue", {});
    expect(r.isError, JSON.stringify(r.parsed)).toBe(true);
    const body = r.parsed as {
      schema_version: number;
      error: {
        code: string;
        message: string;
        hint?: string;
        issues?: Array<{ path: unknown[]; code?: string; message?: string }>;
      };
    };
    expect(body.schema_version).toBe(1);
    expect(body.error.code).toBe("invalid_arguments");
    expect(body.error.message).toContain("get_issue");
    expect(body.error.hint).toBeTruthy();
    // The issues array is the zod issues passed through. Each entry has a
    // `path` (field name) and a zod issue `code` (`invalid_type`, etc.) —
    // shape stable enough for clients to switch on.
    expect(Array.isArray(body.error.issues)).toBe(true);
    expect((body.error.issues ?? []).length).toBeGreaterThan(0);
    const firstIssue = body.error.issues?.[0];
    expect(firstIssue?.path).toEqual(["identifier"]);
  });

  it("unrecognized-key rejection emits envelope with `code: invalid_arguments` + `issues[0].code: unrecognized_keys` (round-7 / Q3)", async () => {
    // Round-7 / Q3: the envelope validator does a post-validation key-set
    // check after zod's parse succeeds. Any input key that didn't survive
    // into the parsed data was silently stripped (typo, wrong plural,
    // forward-compat probe). Emit the same `invalid_arguments` envelope
    // shape as native zod rejections so clients branch uniformly.
    const r = await client.callTool("get_issue", {
      identifier: "ENG-1",
      bogus_field: "x",
    });
    expect(r.isError).toBe(true);
    const body = r.parsed as {
      schema_version: number;
      error: {
        code: string;
        message: string;
        issues?: Array<{ code: string; keys?: string[]; path: unknown[] }>;
      };
    };
    expect(body.schema_version).toBe(1);
    expect(body.error.code).toBe("invalid_arguments");
    expect(body.error.message).toContain("bogus_field");
    expect(body.error.issues?.[0]?.code).toBe("unrecognized_keys");
    expect(body.error.issues?.[0]?.keys).toEqual(["bogus_field"]);
  });

  it("unrecognized-keys rejection works on a read tool too (Q3 is universal)", async () => {
    // Verify the post-validation check applies to read tools, not just
    // mutations — typos on filter args should also surface, since the
    // silent-drop class of bug is the same.
    const r = await client.callTool("list_issues", {
      team: "ENG",
      limit: 1,
      typo_filter: "x",
    });
    expect(r.isError).toBe(true);
    const body = r.parsed as {
      error: { code: string; issues?: Array<{ code: string; keys?: string[] }> };
    };
    expect(body.error.code).toBe("invalid_arguments");
    expect(body.error.issues?.[0]?.code).toBe("unrecognized_keys");
    expect(body.error.issues?.[0]?.keys).toContain("typo_filter");
  });

  it("range-constraint rejection emits envelope with structured issues (priority > 4)", async () => {
    // `list_issues.priority` has `.min(0).max(4)`. priority=99 trips the
    // `too_big` zod issue code; we lock in that the path + code surface
    // cleanly via the envelope.
    const r = await client.callTool("list_issues", { team: "NOX", priority: 99 });
    expect(r.isError).toBe(true);
    const body = r.parsed as {
      schema_version: number;
      error: { code: string; issues?: Array<{ path: unknown[]; code?: string }> };
    };
    expect(body.error.code).toBe("invalid_arguments");
    expect(body.error.issues?.[0]?.path).toEqual(["priority"]);
    expect(body.error.issues?.[0]?.code).toBe("too_big");
  });

  it("empty pull_issues identifiers array is rejected at the MCP boundary", async () => {
    const r = await client.callTool("pull_issues", { identifiers: [] });
    expect(r.isError).toBe(true);
    const body = r.parsed as {
      error: { code: string; issues?: Array<{ path: unknown[]; code?: string }> };
    };
    expect(body.error.code).toBe("invalid_arguments");
    expect(body.error.issues?.[0]?.path).toEqual(["identifiers"]);
    expect(body.error.issues?.[0]?.code).toBe("too_small");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("unknown tool name emits envelope with `code: not_found` (not the SDK's prose error)", async () => {
    // Pre-fix the SDK emitted `MCP error -32602: Tool <name> not found` as
    // a prose payload. Post-fix it's a structured envelope. Catch the
    // protocol-level shape change too: in earlier MCP SDKs an unknown tool
    // was a protocol-level error (call throws); some test harnesses raise
    // before the envelope is returned, in which case we accept the throw.
    let threw: unknown = null;
    let toolResult: Awaited<ReturnType<typeof client.callTool>> | null = null;
    try {
      toolResult = await client.callTool("definitely_not_a_real_tool", {});
    } catch (e) {
      threw = e;
    }
    if (threw) {
      expect(threw).toBeTruthy();
    } else {
      expect(toolResult?.isError).toBe(true);
      const body = toolResult?.parsed as { schema_version: number; error: { code: string } };
      expect(body.schema_version).toBe(1);
      expect(body.error.code).toBe("not_found");
    }
  });

  it("success path is unchanged — non-validation calls still return their normal envelope", async () => {
    // Regression lock: the replacement handler MUST delegate cleanly to
    // the registered `tool.handler` (which is already wrapped in safe()).
    // `whoami` (no `refresh: true`) reads the local auth file directly
    // without touching the mock, so the response always matches the test
    // harness's default viewer (set in makeAuthFile).
    const r = await client.callTool("whoami", {});
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      schema_version: number;
      auth_file: string;
      auth_storage: string;
      viewer: { email: string };
    };
    expect(body.schema_version).toBe(1);
    expect(body.auth_file).toBe("LEBOP_HOME/auth.json");
    expect(body.auth_storage).toBe("lebop-home-auth-json");
    expect(body.auth_file).not.toContain(lebopHome);
    expect(typeof body.viewer.email).toBe("string");
    expect(body.viewer.email.length).toBeGreaterThan(0);
  });

  it("omitted MCP arguments are treated like {} for all-optional schemas", async () => {
    const r = await client.callToolOmittingArguments("whoami");
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as {
      schema_version: number;
      workspace: string;
      viewer: { email: string };
    };
    expect(body.schema_version).toBe(1);
    expect(body.workspace).toBe("test-workspace");
    expect(typeof body.viewer.email).toBe("string");
  });

  it("refresh_whoami revalidates and persists refreshed viewer metadata", async () => {
    mock.respond({
      data: {
        viewer: {
          id: "viewer-refreshed",
          name: "Refreshed Viewer",
          email: "refreshed@example.com",
        },
      },
    });
    mock.respond({
      data: {
        organization: {
          id: "org-test-workspace",
          name: "Test Workspace Refreshed",
          projectStatuses: [],
          urlKey: "test-workspace",
        },
      },
    });

    const refreshed = await client.callTool("refresh_whoami", {});
    expect(refreshed.isError, JSON.stringify(refreshed.parsed)).toBeFalsy();
    expect(refreshed.parsed).toMatchObject({
      workspace: "test-workspace",
      workspace_name: "Test Workspace Refreshed",
      refreshed: true,
      viewer: { email: "refreshed@example.com" },
    });

    const cached = await client.callTool("whoami", {});
    expect(cached.isError, JSON.stringify(cached.parsed)).toBeFalsy();
    expect(cached.parsed).toMatchObject({
      refreshed: false,
      viewer: { email: "refreshed@example.com" },
    });
  });

  it("lib-level errors still flow through unchanged (validation_error from updateMilestone)", async () => {
    // The envelope-validator must NOT shadow `safe()`. Lib-thrown LebopError
    // subtypes (ValidationError, NotFoundError, etc.) must keep emitting
    // their existing `code` — only the zod-rejection path was reshaped.
    const r = await client.callTool("update_milestone", {
      id: "11111111-2222-3333-4444-555555555555",
    });
    expect(r.isError).toBe(true);
    const body = r.parsed as { error: { code: string } };
    // Distinct code from the new `invalid_arguments` — proves the existing
    // taxonomy is preserved end-to-end.
    expect(body.error.code).toBe("validation_error");
  });
});
