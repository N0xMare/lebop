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

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
  mock.reset();
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
    await client.notifyInitialized();
  });

  it("tools/list returns all 73 tools with stable names", async () => {
    const { tools } = await client.listTools();
    // Lock the count so future tool additions are intentional. If you add
    // or remove a tool, bump this number AND verify the new tool has an
    // MCP-level test (not just a lib test).
    expect(tools).toHaveLength(73);

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
      "plan_validate",
      "lint_text",
      "raw_graphql",
      "list_workspaces",
      "whoami",
      "cache_status",
      "diff_issue",
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
    ]) {
      expect(names.has(expected), `tools/list missing "${expected}"`).toBe(true);
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
      issue: { identifier: string; title: string };
    };
    expect(body.schema_version).toBe(1);
    expect(body.issue.identifier).toBe("ENG-1");
    expect(body.issue.title).toBe("First issue");
  });

  it("list_workspaces (pure-local) returns the configured workspace", async () => {
    // Pure-local tool — exercises the safe() wrapper + envelope shape
    // without any network mocking. Belt-and-braces coverage that the
    // stdio transport survives a no-Linear call cleanly.
    const r = await client.callTool("list_workspaces", {});
    expect(r.isError).toBeFalsy();
    const body = r.parsed as {
      default: string;
      workspaces: { slug: string; is_default: boolean }[];
    };
    expect(body.default).toBe("test-workspace");
    expect(body.workspaces.some((w) => w.slug === "test-workspace" && w.is_default)).toBe(true);
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

  it("archive_initiative returns success: true (raw lifecycle path)", async () => {
    mock.respond({ data: { initiativeArchive: { success: true } } });

    const r = await client.callTool("archive_initiative", {
      id: "11111111-2222-3333-4444-555555555555",
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
              projects: { nodes: [] },
            },
          ],
        },
      },
    });
    mock.respond({ data: { initiativeDelete: { success: true } } });

    const r = await client.callTool("delete_initiative", {
      id: "11111111-2222-3333-4444-555555555555",
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
              projects: { nodes: [] },
            },
          ],
        },
      },
    });
    // Step 3: the actual delete mutation.
    mock.respond({ data: { initiativeDelete: { success: true } } });

    const r = await client.callTool("delete_initiative", { id: "Q4 Goals" });
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

    const r = await client.callTool("delete_initiative", { id: "no-such-initiative-xyz" });
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
    });
    expect(r.isError).toBeFalsy();
    const body = r.parsed as { success: boolean };
    expect(body.success).toBe(true);
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
});

describe("mcp: pull_issues — cache write", () => {
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
      issues: { identifier: string; comments: number; cache_path: string }[];
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
    // No Linear network — plan_validate without team skips semantic checks.
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

  it("lint_text flags L001 on table-cell ordered-list markers", async () => {
    const content = "| header |\n| --- |\n| 1. inline list |\n";
    const r = await client.callTool("lint_text", { content });
    expect(r.isError).toBeFalsy();
    const body = r.parsed as { warnings: { rule: string }[] };
    const codes = body.warnings.map((w) => w.rule);
    // L001 is the rule for ordered-list markers inside table cells.
    expect(codes).toContain("L001");
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

  it("get_issue with a NOT_FOUND extension returns `{issue: null}` (round-8 / H1 null-contract alignment)", async () => {
    // Round-8 / H1: getIssue now uses `tryMapToNull` (round-5 contract);
    // a Linear NOT_FOUND extension OR `data.a0 === null` both yield
    // `{issue: null}` instead of the prior ValidationError envelope.
    // Aligns with the 7 other `get_*` MCP tools.
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
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { schema_version: number; issue: unknown };
    expect(body.schema_version).toBe(1);
    expect(body.issue).toBeNull();
  });

  it("get_issue with a clean null response also returns `{issue: null}` (no errors array)", async () => {
    // Some Linear SDK paths return `data.a0 === null` without an errors
    // array. Either shape resolves to `{issue: null}` via tryMapToNull.
    // Use TEAM-NN format so buildPullIssuesQuery's identifier validation
    // doesn't reject the call upstream of the resolver.
    mock.respond({ data: { a0: null } });

    const r = await client.callTool("get_issue", { identifier: "NOX-99999" });
    expect(r.isError, JSON.stringify(r.parsed)).toBeFalsy();
    const body = r.parsed as { schema_version: number; issue: unknown };
    expect(body.issue).toBeNull();
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
    const body = r.parsed as { schema_version: number; viewer: { email: string } };
    expect(body.schema_version).toBe(1);
    expect(typeof body.viewer.email).toBe("string");
    expect(body.viewer.email.length).toBeGreaterThan(0);
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
