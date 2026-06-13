import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type MockServer,
  makeAuthFile,
  runLebop,
  runLebopWithStdin,
  startMockLinear,
} from "./harness.ts";

let mock: MockServer;
let lebopHome: string;
let env: Record<string, string>;

beforeAll(async () => {
  mock = await startMockLinear();
  lebopHome = await makeAuthFile("lin_api_test_integration");
  env = { LEBOP_HOME: lebopHome, LEBOP_API_URL: mock.url };
});

function cliProjectNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-uuid-icon",
    name: "CLI Icon Project",
    description: null,
    content: null,
    icon: null,
    state: "backlog",
    url: "https://linear.app/test/project/cli-icon-project",
    updatedAt: "2026-06-04T00:00:00.000Z",
    startDate: null,
    targetDate: null,
    archivedAt: null,
    teams: { nodes: [{ id: "team-uuid-nox", key: "NOX", name: "Noxor" }] },
    lead: null,
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

function cliIssuePayload(id: string, identifier: string, overrides: Record<string, unknown> = {}) {
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

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function queueTeamMetadataResponses(teamKey = "ENG") {
  const teamId = `team-${teamKey.toLowerCase()}`;
  const teamConnections = {
    states: {
      nodes: [
        { id: "state-backlog", name: "Backlog", type: "backlog" },
        { id: "state-todo", name: "Todo", type: "unstarted" },
      ],
      pageInfo: pageInfo(),
    },
    labels: { nodes: [], pageInfo: pageInfo() },
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
  mock.respond({ data: { team: teamConnections } });
  mock.respond({ data: { team: teamConnections } });
  mock.respond({ data: { team: teamConnections } });
  mock.respond({ data: { team: teamConnections } });
}

afterEach(() => {
  try {
    mock.assertNoPendingResponses();
  } finally {
    mock.reset({ allowPendingResponses: true });
  }
});

afterAll(async () => {
  await mock.stop();
  await rm(lebopHome, { recursive: true, force: true });
});

describe("auth whoami", () => {
  it("prints cached viewer without hitting Linear", async () => {
    const r = await runLebop(["auth", "whoami"], env);
    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("Test Viewer");
    expect(r.stdout).toContain("viewer@example.com");
    expect(r.stdout).toContain("test-workspace");
  });

  it("--json emits structured envelope including workspace", async () => {
    const r = await runLebop(["auth", "whoami", "--json"], env);
    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.viewer.email).toBe("viewer@example.com");
    expect(parsed.workspace).toBe("test-workspace");
    expect(parsed.auth_file).toBe("LEBOP_HOME/auth.json");
    expect(parsed.auth_storage).toBe("lebop-home-auth-json");
    expect(parsed.auth_file).not.toContain(lebopHome);
    expect(parsed.refreshed).toBe(false);
  });

  it("emits structured AuthError when credentials are missing", async () => {
    const noAuthHome = await makeAuthFile("placeholder");
    // Wipe the auth file to simulate logged-out state.
    await rm(`${noAuthHome}/auth.json`);
    const r = await runLebop(["teams"], { LEBOP_HOME: noAuthHome, LEBOP_API_URL: mock.url });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("error[auth_error]:");
    expect(r.stderr).toContain("no Linear credentials found");
    expect(r.stderr).toContain("hint:");
    expect(r.stderr).toContain("lebop auth login");
    await rm(noAuthHome, { recursive: true, force: true });
  });
});

describe("project and initiative list parity", () => {
  it("lebop projects accepts the same workspace-wide project list flags as project list", async () => {
    mock.respond({
      data: {
        projects: {
          nodes: [],
          pageInfo: pageInfo(),
        },
      },
    });
    const alias = await runLebop(
      ["projects", "--all-teams", "--include-archived", "--limit", "1", "--json"],
      env,
    );
    expect(alias.exitCode, `${alias.stdout}\n${alias.stderr}`).toBe(0);
    expect(JSON.parse(alias.stdout)).toMatchObject({
      team: "*",
      count: 0,
      limit: 1,
      has_more: false,
      next_cursor: null,
      truncated: false,
      projects: [],
    });
    expect(mock.requestAt(0)?.variables).toMatchObject({ first: 1, includeArchived: true });
    expect(mock.requestAt(0)?.variables.filter).toBeUndefined();

    mock.reset();
    mock.respond({
      data: {
        projects: {
          nodes: [],
          pageInfo: pageInfo(),
        },
      },
    });
    const canonical = await runLebop(
      ["project", "list", "--all-teams", "--include-archived", "--limit", "1", "--json"],
      env,
    );
    expect(canonical.exitCode, `${canonical.stdout}\n${canonical.stderr}`).toBe(0);
    expect(JSON.parse(canonical.stdout)).toMatchObject({
      team: "*",
      count: 0,
      limit: 1,
      has_more: false,
      next_cursor: null,
      truncated: false,
      projects: [],
    });
    expect(mock.requestAt(0)?.variables).toMatchObject({ first: 1, includeArchived: true });
    expect(mock.requestAt(0)?.variables.filter).toBeUndefined();
  });

  it("project list --json exposes cursor completion metadata", async () => {
    mock.respond({
      data: {
        projects: {
          nodes: [
            cliProjectNode({
              id: "project-list-1",
              name: "Cursor Project",
              updatedAt: new Date("2026-06-04T00:00:00.000Z"),
            }),
          ],
          pageInfo: { ...pageInfo(), hasNextPage: true, endCursor: "project-cursor-next" },
        },
      },
    });

    const r = await runLebop(
      [
        "project",
        "list",
        "--all-teams",
        "--limit",
        "1",
        "--cursor",
        "project-cursor-prev",
        "--json",
      ],
      env,
    );

    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      team: "*",
      count: 1,
      limit: 1,
      has_more: true,
      next_cursor: "project-cursor-next",
      truncated: true,
      projects: [{ id: "project-list-1", name: "Cursor Project" }],
    });
    expect(mock.requestAt(0)?.variables).toMatchObject({
      first: 1,
      after: "project-cursor-prev",
    });
  });

  it("initiative list forwards --owner-id to Linear", async () => {
    mock.respond({
      data: {
        initiatives: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });

    const r = await runLebop(["initiative", "list", "--owner-id", "user-1", "--json"], env);
    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ count: 0, initiatives: [] });
    expect(mock.requestAt(0)?.variables.filter).toMatchObject({
      owner: { id: { eq: "user-1" } },
    });
  });
});

describe("show read surface", () => {
  it("show --json completes comment overflow and reports completeness", async () => {
    mock.respond({
      data: {
        a0: cliIssuePayload("eng-7-uuid", "ENG-7", {
          title: "Show overflow",
          comments: {
            nodes: [
              {
                id: "show-c-1",
                body: "inline comment",
                createdAt: "2026-06-06T01:00:00.000Z",
                updatedAt: "2026-06-06T01:00:00.000Z",
                user: null,
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: "show-comment-cursor-1" },
          },
          relations: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          inverseRelations: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }),
      },
    });
    mock.respond({
      data: {
        issue: {
          comments: {
            nodes: [
              {
                id: "show-c-2",
                body: "overflow comment",
                createdAt: "2026-06-06T02:00:00.000Z",
                updatedAt: "2026-06-06T02:00:00.000Z",
                user: null,
              },
            ],
            pageInfo: pageInfo(),
          },
        },
      },
    });

    const r = await runLebop(["show", "ENG-7", "--json"], env);
    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
    const body = JSON.parse(r.stdout) as {
      comments: { frontmatter: { id: string } }[];
      completeness: {
        comments: { complete: boolean; count: number; next_cursor: string | null };
        relations: { complete: boolean };
      };
    };
    expect(body.comments.map((c) => c.frontmatter.id)).toEqual(["show-c-1", "show-c-2"]);
    expect(body.completeness.comments).toMatchObject({
      complete: true,
      count: 2,
      next_cursor: null,
    });
    expect(body.completeness.relations.complete).toBe(true);
    expect(mock.requestAt(1)?.variables).toMatchObject({
      id: "ENG-7",
      first: 250,
      after: "show-comment-cursor-1",
    });
  });
});

describe("pull read surface", () => {
  it("pull --no-comments clears stale cached comments after a successful refresh", async () => {
    const home = await makeAuthFile("lin_api_test_pull_no_comments");
    const cwd = await mkdtemp(join(tmpdir(), "lebop-pull-no-comments-cwd-"));
    const staleCommentsDir = join(home, "cache", "_global", "issues", "NOX-8", "comments");
    await mkdir(staleCommentsDir, { recursive: true });
    await writeFile(join(staleCommentsDir, "stale.md"), "stale cached comment");

    try {
      mock.respond({
        data: {
          a0: cliIssuePayload("nox-8-uuid", "NOX-8", {
            title: "No comments refresh",
            description: "fresh body",
            updatedAt: "2026-06-08T00:00:00.000Z",
          }),
        },
      });

      const r = await runLebop(
        ["pull", "NOX-8", "--team", "NOX", "--no-comments", "--refresh", "--yes", "--json"],
        { LEBOP_HOME: home, LEBOP_API_URL: mock.url },
        cwd,
      );
      expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
      const body = JSON.parse(r.stdout) as {
        issues: { identifier: string; comments: number; path: string; cache_path?: string }[];
      };
      expect(body.issues[0]).toMatchObject({ identifier: "NOX-8", comments: 0 });
      expect(body.issues[0]?.cache_path).toBeUndefined();
      await expect(
        readFile(join(body.issues[0]?.path ?? "", "comments", "stale.md"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("pull --project resolves project names with the duplicate-aware shared resolver", async () => {
    mock.respond({
      data: {
        projects: {
          nodes: [
            {
              id: "project-target",
              name: "Target Project",
              teams: { nodes: [{ key: "ENG" }] },
            },
          ],
        },
      },
    });
    mock.respond({
      data: {
        project: cliProjectNode({
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

    const r = await runLebop(
      ["pull", "--team", "ENG", "--project", "Target Project", "--json"],
      env,
    );
    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
    const body = JSON.parse(r.stdout) as {
      project: { id: string; name: string; issues: number; cache_path?: string };
      hydration: { requested_count: number };
    };
    expect(body.project).toMatchObject({
      id: "project-target",
      name: "Target Project",
      issues: 0,
    });
    expect(body.project.cache_path).toBeUndefined();
    expect(body.hydration.requested_count).toBe(0);
    expect(mock.requestAt(0)?.variables).toEqual({ name: "Target Project", teamKey: "ENG" });
    expect(mock.requestAt(0)?.query).toContain("first: 2");
    expect(mock.requestAt(0)?.query).toContain("accessibleTeams");
  });

  it("pull --project rejects duplicate project-name matches instead of taking the first", async () => {
    mock.respond({
      data: {
        projects: {
          nodes: [
            { id: "project-a", name: "Duplicate Project", teams: { nodes: [{ key: "ENG" }] } },
            { id: "project-b", name: "Duplicate Project", teams: { nodes: [{ key: "ENG" }] } },
          ],
        },
      },
    });

    const r = await runLebop(
      ["pull", "--team", "ENG", "--project", "Duplicate Project", "--json"],
      env,
    );

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("");
    const body = JSON.parse(r.stdout) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toContain('ambiguous project name "Duplicate Project"');
  });
});

describe("CLI parser and limit errors", () => {
  it("emits a structured --json envelope for commander usage errors", async () => {
    const r = await runLebop(["list", "--definitely-not-real", "--json"], env);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout) as {
      ok: boolean;
      schema_version: number;
      error: { code: string; message: string; hint?: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.error.code).toBe("invalid_arguments");
    expect(parsed.error.message).toContain("unknown option");
    expect(parsed.error.hint).toContain("--help");
  });

  it("rejects malformed --limit values before calling Linear", async () => {
    const r = await runLebop(["projects", "--all-teams", "--limit", "1abc", "--json"], env);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout) as {
      ok: boolean;
      error: { code: string; message: string; hint?: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("validation_error");
    expect(parsed.error.message).toBe('invalid --limit value "1abc"');
    expect(parsed.error.hint).toContain("0 or greater");
    expect(mock.requestAt(0)).toBeUndefined();
  });
});

describe("auth list / default / token", () => {
  it("auth list shows the configured workspace as default", async () => {
    const r = await runLebop(["auth", "list"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("test-workspace");
    expect(r.stdout).toContain("Test Workspace");
    // The * marker indicates default
    expect(r.stdout).toContain("*");
  });

  it("auth list --json emits the workspace + is_default flag", async () => {
    const r = await runLebop(["auth", "list", "--json"], env);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.default).toBe("test-workspace");
    expect(parsed.auth_file).toBe("LEBOP_HOME/auth.json");
    expect(parsed.auth_storage).toBe("lebop-home-auth-json");
    expect(parsed.auth_file).not.toContain(lebopHome);
    expect(parsed.workspaces).toHaveLength(1);
    expect(parsed.workspaces[0].slug).toBe("test-workspace");
    expect(parsed.workspaces[0].is_default).toBe(true);
  });

  it("auth list --json reports empty local state when no credentials exist", async () => {
    const noAuthHome = await mkdtemp(join(tmpdir(), "lebop-no-auth-list-"));
    const r = await runLebop(["auth", "list", "--json"], {
      LEBOP_HOME: noAuthHome,
      LEBOP_API_URL: mock.url,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.default).toBeNull();
    expect(parsed.workspaces).toEqual([]);
    expect(parsed.auth_file).toBe("LEBOP_HOME/auth.json");
    expect(parsed.auth_storage).toBe("lebop-home-auth-json");
    expect(parsed.auth_file).not.toContain(noAuthHome);
    await rm(noAuthHome, { recursive: true, force: true });
  });

  it("auth default (no arg) prints the current default slug", async () => {
    const r = await runLebop(["auth", "default"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("test-workspace");
  });

  it("auth default --json emits structured success and empty-state reads", async () => {
    const ok = await runLebop(["auth", "default", "--json"], env);
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(ok.stdout).default).toBe("test-workspace");

    const noAuthHome = await mkdtemp(join(tmpdir(), "lebop-no-auth-default-"));
    const missing = await runLebop(["auth", "default", "--json"], {
      LEBOP_HOME: noAuthHome,
      LEBOP_API_URL: mock.url,
    });
    expect(missing.exitCode).toBe(0);
    const parsed = JSON.parse(missing.stdout);
    expect(parsed.default).toBeNull();
    await rm(noAuthHome, { recursive: true, force: true });
  });

  it("auth token --unsafe prints the full token (round-6 / CLI 19)", async () => {
    // Round-6: default behavior is now MASKED. The `--unsafe` flag opts
    // into the legacy full-token print (still needed for `lebop auth
    // token --unsafe | xargs -I{} curl -H "Authorization: {}"` workflows).
    const r = await runLebop(["auth", "token", "--unsafe"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("lin_api_test_integration");
  });

  it("auth token (no --unsafe) prints a masked preview (round-6 / CLI 19)", async () => {
    // Default behavior: print head + middle masked + last 4 chars so a
    // careless copy/paste / screenshot doesn't leak the full PAK.
    const r = await runLebop(["auth", "token"], env);
    expect(r.exitCode).toBe(0);
    const out = r.stdout.trim();
    expect(out).toMatch(/^lin_api_/); // prefix preserved
    expect(out).toContain("*"); // masked region
    expect(out).toMatch(/tion$/); // last 4 of "integration"
    expect(out).not.toBe("lin_api_test_integration"); // NOT the full token
    // Stderr advises about the --unsafe escape hatch.
    expect(r.stderr).toContain("--unsafe");
  });

  it("auth token <unknown-slug> errors with structured AuthError", async () => {
    const r = await runLebop(["auth", "token", "no-such-workspace"], env);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("error[auth_error]:");
    expect(r.stderr).toContain("not configured");
  });

  it("--workspace flag selects the named workspace via env", async () => {
    // The flag is propagated to LEBOP_WORKSPACE by the preAction hook;
    // since the test only has one workspace, passing the right slug works
    // and passing a wrong one errors via loadAuthForWorkspace.
    // Pass --unsafe so we can deep-assert the token (round-6 CLI 19 made
    // the default print masked).
    const r = await runLebop(["--workspace", "test-workspace", "auth", "token", "--unsafe"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("lin_api_test_integration");

    const bad = await runLebop(["--workspace", "no-such", "auth", "token"], env);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("error[auth_error]:");
    expect(bad.stderr).toContain("not configured");
  });

  it("root --workspace does not leak across in-process run() calls", async () => {
    const home = await mkdtemp(join(tmpdir(), "lebop-context-isolation-"));
    await writeFile(
      join(home, "auth.json"),
      JSON.stringify(
        {
          schema_version: 2,
          workspaces: {
            primary: {
              slug: "primary",
              name: "Primary",
              url_key: "primary",
              token: "lin_api_primary",
              viewer: { id: "u1", email: "primary@example.com", name: "Primary Viewer" },
              created_at: "2026-06-05T00:00:00.000Z",
            },
            secondary: {
              slug: "secondary",
              name: "Secondary",
              url_key: "secondary",
              token: "lin_api_secondary",
              viewer: { id: "u2", email: "secondary@example.com", name: "Secondary Viewer" },
              created_at: "2026-06-05T00:00:00.000Z",
            },
          },
          default: "primary",
        },
        null,
        2,
      ),
    );

    const prevHome = process.env.LEBOP_HOME;
    const prevApiUrl = process.env.LEBOP_API_URL;
    const prevBunDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Bun");
    let installedBunMock = false;
    const bunMock = {
      file: (path: string) => ({
        exists: async () =>
          readFile(path)
            .then(() => true)
            .catch(() => false),
        json: async () => JSON.parse(await readFile(path, "utf8")),
        text: async () => readFile(path, "utf8"),
      }),
    };
    process.env.LEBOP_HOME = home;
    process.env.LEBOP_API_URL = mock.url;
    if (!(globalThis as { Bun?: unknown }).Bun) {
      if (prevBunDescriptor && !prevBunDescriptor.configurable && prevBunDescriptor.writable) {
        (globalThis as { Bun?: unknown }).Bun = bunMock;
        installedBunMock = true;
      } else if (!prevBunDescriptor || prevBunDescriptor.configurable) {
        Object.defineProperty(globalThis, "Bun", {
          value: bunMock,
          configurable: true,
        });
        installedBunMock = true;
      }
    } else if (!prevBunDescriptor || prevBunDescriptor.configurable) {
      Object.defineProperty(globalThis, "Bun", {
        value: bunMock,
        configurable: true,
      });
      installedBunMock = true;
    }
    const { run } = await import("../../src/cli.ts");
    const writes: string[] = [];
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await run(["bun", "lebop", "--workspace", "secondary", "auth", "token", "--unsafe"]);
      await run(["bun", "lebop", "auth", "token", "--unsafe"]);
    } finally {
      stdoutWrite.mockRestore();
      if (prevHome === undefined) delete process.env.LEBOP_HOME;
      else process.env.LEBOP_HOME = prevHome;
      if (prevApiUrl === undefined) delete process.env.LEBOP_API_URL;
      else process.env.LEBOP_API_URL = prevApiUrl;
      if (installedBunMock) {
        if (prevBunDescriptor) Object.defineProperty(globalThis, "Bun", prevBunDescriptor);
        else delete (globalThis as { Bun?: unknown }).Bun;
      }
      await rm(home, { recursive: true, force: true });
    }

    expect(writes.join("").split("\n").filter(Boolean)).toEqual([
      "lin_api_secondary",
      "lin_api_primary",
    ]);
  });

  it("auth set-default-team --json emits canonical `team` (not `team_key`)", async () => {
    // Round-7 / HIGH-3 lock-in: the CLI envelope key was renamed to `team`
    // for parity with the MCP `set_workspace_default_team` rename (round-6
    // / C1). Pre-fix the CLI emitted `team_key`, so scripts piping
    // `lebop auth set-default-team --json | jq .team` got null.
    // Round-11 / M-2: the command now pre-validates the team via getTeam,
    // so the mock needs a NOX response before the write step.
    mock.respond({
      data: {
        teams: {
          nodes: [
            {
              id: "team-uuid-nox",
              key: "NOX",
              name: "Noxor",
              description: null,
              defaultIssueState: { id: "state-bl", name: "Backlog" },
            },
          ],
        },
      },
    });
    const r = await runLebop(["auth", "set-default-team", "test-workspace", "nox", "--json"], env);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout) as {
      schema_version: number;
      workspace_slug: string;
      team?: string;
      team_key?: string;
    };
    expect(body.schema_version).toBe(1);
    expect(body.workspace_slug).toBe("test-workspace");
    expect(body.team).toBe("NOX");
    expect(body.team_key).toBeUndefined();
  });
});

describe("mine + unarchive (smoke)", () => {
  it("mine appears in --help with sensible defaults", async () => {
    const r = await runLebop(["mine", "--help"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("list issues assigned to you");
    expect(r.stdout).toContain("--all-states");
    expect(r.stdout).toContain("--include-archived");
  });

  it("unarchive appears in --help with bulk-friendly shape", async () => {
    const r = await runLebop(["unarchive", "--help"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("unarchive one or more issues");
    expect(r.stdout).toContain("<ids...>");
  });

  it("list --help shows all the rich filter flags", async () => {
    const r = await runLebop(["list", "--help"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--search");
    expect(r.stdout).toContain("--unassigned");
    expect(r.stdout).toContain("--cycle");
    expect(r.stdout).toContain("--milestone");
    expect(r.stdout).toContain("--created-after");
    expect(r.stdout).toContain("--include-archived");
    expect(r.stdout).toContain("--all-teams");
  });
});

describe("comment delete safety", () => {
  it("comment delete --json without --yes emits a structured error envelope", async () => {
    const r = await runLebop(["comment", "delete", "comment-uuid", "--json"], env);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("validation_error");
    expect(parsed.error.message).toContain("--yes");
  });
});

describe("destructive CLI confirmation gates", () => {
  it.each([
    { name: "attachment delete", args: ["attachment", "delete", "attachment-uuid", "--json"] },
    { name: "document delete", args: ["document", "delete", "document-uuid", "--json"] },
    { name: "project delete", args: ["project", "delete", "project-uuid", "--json"] },
    { name: "label delete", args: ["label", "delete", "release-risk", "--json"] },
    { name: "milestone delete", args: ["milestone", "delete", "milestone-uuid", "--json"] },
    { name: "initiative delete", args: ["initiative", "delete", "Roadmap H2", "--json"] },
  ])("$name --json without --yes emits a structured error before lookup", async ({ args }) => {
    const r = await runLebop(args, env);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("validation_error");
    expect(parsed.error.message).toContain("--yes");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("attachment update --json without fields emits a structured error before lookup", async () => {
    const r = await runLebop(["attachment", "update", "attachment-uuid", "--json"], env);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("validation_error");
    expect(parsed.error.message).toContain("nothing to update");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("archive --json without --yes emits a structured error before contacting Linear", async () => {
    const r = await runLebop(["archive", "NOX-1", "--json"], env);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.error.code).toBe("validation_error");
    expect(parsed.error.message).toContain("--yes");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it.each([
    { name: "push --force", args: ["push", "--force", "--json"] },
    { name: "pull --refresh", args: ["pull", "NOX-1", "--refresh", "--json"] },
    {
      name: "plan apply --force",
      args: ["plan", "apply", "/tmp/lebop-missing-plan", "--force", "--json"],
    },
    {
      name: "plan pull --force",
      args: ["plan", "pull", "/tmp/lebop-missing-plan", "--force", "--json"],
    },
  ])("$name --json requires --yes/--confirm before lookup", async ({ args }) => {
    const r = await runLebop(args, env);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.error.code).toBe("validation_error");
    expect(parsed.error.message).toContain("--yes/--confirm");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("relation delete --json without --yes emits a structured error before lookup", async () => {
    const r = await runLebop(["relation", "delete", "NOX-1", "related", "NOX-2", "--json"], env);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.error.code).toBe("validation_error");
    expect(parsed.error.message).toContain("--yes");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("set links negative deltas require --yes before config or issue lookup", async () => {
    const r = await runLebop(["set", "links", "NOX-1", "--json", "-related:NOX-2"], env);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.error.code).toBe("validation_error");
    expect(parsed.error.message).toContain("--yes");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("set links accepts --yes inside the variadic value tail", async () => {
    mock.respond({ data: { issue: cliIssuePayload("issue-uuid-1", "NOX-1") } });
    mock.respond({ data: { issue: cliIssuePayload("issue-uuid-2", "NOX-2") } });
    mock.respond({
      data: {
        issue: {
          relations: {
            nodes: [
              {
                id: "relation-1",
                type: "related",
                relatedIssue: { id: "issue-uuid-2", identifier: "NOX-2" },
              },
            ],
          },
          inverseRelations: { nodes: [] },
        },
      },
    });
    mock.respond({ data: { issueRelationDelete: { success: true } } });

    const r = await runLebop(["set", "links", "NOX-1", "--yes", "--json", "-related:NOX-2"], env);

    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.results[0]).toMatchObject({
      op: "-",
      kind: "related",
      target: "NOX-2",
      status: "deleted",
      relationId: "relation-1",
    });
  });

  it("set links re-adds a relation after an earlier remove in the same batch", async () => {
    mock.respond({ data: { issue: cliIssuePayload("issue-uuid-1", "NOX-1") } });
    mock.respond({ data: { issue: cliIssuePayload("issue-uuid-2", "NOX-2") } });
    mock.respond({
      data: {
        issue: {
          relations: {
            nodes: [
              {
                id: "relation-existing-1",
                type: "related",
                relatedIssue: { id: "issue-uuid-2", identifier: "NOX-2" },
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
                relatedIssue: { id: "issue-uuid-2", identifier: "NOX-2" },
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

    const r = await runLebop(
      ["set", "links", "NOX-1", "--yes", "--json", "-related:NOX-2", "+related:NOX-2"],
      env,
    );

    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.results).toMatchObject([
      {
        op: "-",
        kind: "related",
        target: "NOX-2",
        status: "deleted",
        relationId: "relation-existing-1",
      },
      {
        op: "+",
        kind: "related",
        target: "NOX-2",
        status: "created",
        relationId: "relation-recreated-1",
      },
    ]);
    expect(mock.requestAt(4)?.query).toContain("issueRelationDelete");
    expect(mock.requestAt(6)?.query).toContain("issueRelationCreate");
  });

  it("set links reports remote success separately when cached issue refresh fails", async () => {
    const home = await makeAuthFile("lin_api_test_set_links_writeback");
    const cwd = await mkdtemp(join(tmpdir(), "lebop-set-links-cwd-"));

    try {
      await mkdir(join(home, "cache", "_global", "issues", "NOX-1"), { recursive: true });
      await writeFile(
        join(home, "cache", "_global", "issues", "NOX-1", "metadata.yaml"),
        [
          "identifier: NOX-1",
          "title: NOX-1",
          "state: Backlog",
          "priority: 0",
          "estimate: null",
          "labels: []",
          "assignee: null",
          "project: null",
          "parent: null",
          "_server:",
          "  id: issue-uuid-1",
          "  identifier: NOX-1",
          "  url: https://linear.app/test/issue/NOX-1",
          "  state_id: state-backlog",
          "  state_name: Backlog",
          "  state_type: backlog",
          "  priority: 0",
          "  estimate: null",
          "  label_ids: []",
          "  assignee_id: null",
          "  assignee_name: null",
          "  assignee_email: null",
          "  title: NOX-1",
          `  description_hash: ${sha256("Cached description.")}`,
          "  project_id: null",
          "  project_name: null",
          "  parent_id: null",
          "  parent_identifier: null",
          "  updated_at: 2026-06-05T00:00:00.000Z",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(home, "cache", "_global", "issues", "NOX-1", "description.md"),
        "Cached description.",
      );

      mock.respond({ data: { issue: cliIssuePayload("issue-uuid-1", "NOX-1") } });
      mock.respond({ data: { issue: cliIssuePayload("issue-uuid-2", "NOX-2") } });
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

      const r = await runLebop(
        ["set", "links", "NOX-1", "+related:NOX-2", "--json"],
        { LEBOP_HOME: home, LEBOP_API_URL: mock.url },
        cwd,
      );

      expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(1);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.results[0]).toMatchObject({
        op: "+",
        kind: "related",
        target: "NOX-2",
        status: "created-writeback-failed",
        relationId: "relation-created-1",
      });
      expect(parsed.cache_writeback.status).toBe("failed");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("relation add reports remote success separately when cached issue refresh fails", async () => {
    const home = await makeAuthFile("lin_api_test_relation_add_writeback");
    const cwd = await mkdtemp(join(tmpdir(), "lebop-relation-add-cwd-"));

    try {
      await mkdir(join(home, "cache", "_global", "issues", "NOX-1"), { recursive: true });
      await writeFile(
        join(home, "cache", "_global", "issues", "NOX-1", "metadata.yaml"),
        [
          "identifier: NOX-1",
          "title: NOX-1",
          "state: Backlog",
          "priority: 0",
          "estimate: null",
          "labels: []",
          "assignee: null",
          "project: null",
          "parent: null",
          "_server:",
          "  id: issue-uuid-1",
          "  identifier: NOX-1",
          "  url: https://linear.app/test/issue/NOX-1",
          "  state_id: state-backlog",
          "  state_name: Backlog",
          "  state_type: backlog",
          "  priority: 0",
          "  estimate: null",
          "  label_ids: []",
          "  assignee_id: null",
          "  assignee_name: null",
          "  assignee_email: null",
          "  title: NOX-1",
          `  description_hash: ${sha256("Cached description.")}`,
          "  project_id: null",
          "  project_name: null",
          "  parent_id: null",
          "  parent_identifier: null",
          "  updated_at: 2026-06-05T00:00:00.000Z",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(home, "cache", "_global", "issues", "NOX-1", "description.md"),
        "Cached description.",
      );

      mock.respond({
        data: {
          issue: {
            relations: { nodes: [], pageInfo: pageInfo() },
            inverseRelations: { nodes: [], pageInfo: pageInfo() },
          },
        },
      });
      mock.respond({ data: { issue: cliIssuePayload("issue-uuid-1", "NOX-1") } });
      mock.respond({ data: { issue: cliIssuePayload("issue-uuid-2", "NOX-2") } });
      mock.respond({
        data: {
          issueRelationCreate: {
            success: true,
            issueRelation: { id: "relation-created-1", type: "related" },
          },
        },
      });

      const r = await runLebop(
        ["relation", "add", "NOX-1", "related", "NOX-2", "--json"],
        { LEBOP_HOME: home, LEBOP_API_URL: mock.url },
        cwd,
      );

      expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(1);
      const parsed = JSON.parse(r.stdout);
      expect(parsed).toMatchObject({
        op: "add",
        from: "NOX-1",
        kind: "related",
        to: "NOX-2",
        status: "created-writeback-failed",
        relation_id: "relation-created-1",
      });
      expect(parsed.cache_writeback).toMatchObject({
        checked: true,
        present: true,
        refreshed: false,
      });
      expect(parsed.cache_writeback.error.message).toContain("no mock response queued");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("set links uses the canonical source identifier for cached writeback", async () => {
    const home = await makeAuthFile("lin_api_test_set_links_canonical_writeback");
    const cwd = await mkdtemp(join(tmpdir(), "lebop-set-links-cwd-"));

    try {
      await mkdir(join(home, "cache", "_global", "issues", "NOX-1"), { recursive: true });
      await writeFile(
        join(home, "cache", "_global", "issues", "NOX-1", "metadata.yaml"),
        [
          "identifier: NOX-1",
          "title: NOX-1",
          "state: Backlog",
          "priority: 0",
          "estimate: null",
          "labels: []",
          "assignee: null",
          "project: null",
          "parent: null",
          "_server:",
          "  id: issue-uuid-1",
          "  identifier: NOX-1",
          "  url: https://linear.app/test/issue/NOX-1",
          "  state_id: state-backlog",
          "  state_name: Backlog",
          "  state_type: backlog",
          "  priority: 0",
          "  estimate: null",
          "  label_ids: []",
          "  assignee_id: null",
          "  assignee_name: null",
          "  assignee_email: null",
          "  title: NOX-1",
          `  description_hash: ${sha256("Cached description.")}`,
          "  project_id: null",
          "  project_name: null",
          "  parent_id: null",
          "  parent_identifier: null",
          "  updated_at: 2026-06-05T00:00:00.000Z",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(home, "cache", "_global", "issues", "NOX-1", "description.md"),
        "Cached description.",
      );

      mock.respond({ data: { issue: cliIssuePayload("issue-uuid-1", "NOX-1") } });
      mock.respond({ data: { issue: cliIssuePayload("issue-uuid-2", "NOX-2") } });
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
      mock.respond({ data: { a0: cliIssuePayload("issue-uuid-1", "NOX-1") } });

      const r = await runLebop(
        ["set", "links", "nox-1", "--team", "NOX", "--json", "+related:NOX-2"],
        { LEBOP_HOME: home, LEBOP_API_URL: mock.url },
        cwd,
      );

      expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.identifier).toBe("NOX-1");
      expect(parsed.results[0]).toMatchObject({
        op: "+",
        kind: "related",
        target: "NOX-2",
        status: "created",
        relationId: "relation-created-1",
      });
      expect(parsed.cache_writeback.status).toBe("refreshed");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("set links refuses to overwrite cache edits that appear during refresh", async () => {
    const home = await makeAuthFile("lin_api_test_set_links_guarded_writeback");
    const cwd = await mkdtemp(join(tmpdir(), "lebop-set-links-guard-cwd-"));
    const descriptionPath = join(home, "cache", "_global", "issues", "NOX-1", "description.md");

    try {
      await mkdir(join(home, "cache", "_global", "issues", "NOX-1"), { recursive: true });
      await writeFile(
        join(home, "cache", "_global", "issues", "NOX-1", "metadata.yaml"),
        [
          "identifier: NOX-1",
          "title: NOX-1",
          "state: Backlog",
          "priority: 0",
          "estimate: null",
          "labels: []",
          "assignee: null",
          "project: null",
          "parent: null",
          "_server:",
          "  id: issue-uuid-1",
          "  identifier: NOX-1",
          "  url: https://linear.app/test/issue/NOX-1",
          "  state_id: state-backlog",
          "  state_name: Backlog",
          "  state_type: backlog",
          "  priority: 0",
          "  estimate: null",
          "  label_ids: []",
          "  assignee_id: null",
          "  assignee_name: null",
          "  assignee_email: null",
          "  title: NOX-1",
          `  description_hash: ${sha256("Cached description.")}`,
          "  project_id: null",
          "  project_name: null",
          "  parent_id: null",
          "  parent_identifier: null",
          "  updated_at: 2026-06-05T00:00:00.000Z",
          "",
        ].join("\n"),
      );
      await writeFile(descriptionPath, "Cached description.");

      mock.respond({ data: { issue: cliIssuePayload("issue-uuid-1", "NOX-1") } });
      mock.respond({ data: { issue: cliIssuePayload("issue-uuid-2", "NOX-2") } });
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
            issueRelation: { id: "relation-created-guard", type: "related" },
          },
        },
      });
      mock.respond({
        beforeRespond: async () => {
          await writeFile(descriptionPath, "local relation draft");
        },
        data: {
          a0: cliIssuePayload("issue-uuid-1", "NOX-1", {
            description: "remote relation refresh",
            updatedAt: "2026-06-06T00:00:00.000Z",
          }),
        },
      });

      const r = await runLebop(
        ["set", "links", "NOX-1", "+related:NOX-2", "--json"],
        { LEBOP_HOME: home, LEBOP_API_URL: mock.url },
        cwd,
      );

      expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(1);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.results[0]).toMatchObject({
        op: "+",
        kind: "related",
        target: "NOX-2",
        status: "created-writeback-failed",
        relationId: "relation-created-guard",
      });
      expect(parsed.cache_writeback).toMatchObject({
        status: "failed",
        code: "cache_dirty",
        dirty: { fields: ["description"] },
      });
      await expect(readFile(descriptionPath, "utf8")).resolves.toBe("local relation draft");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("initiative archive --json without --yes emits a structured error before lookup", async () => {
    const r = await runLebop(["initiative", "archive", "Roadmap H2", "--json"], env);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.error.code).toBe("validation_error");
    expect(parsed.error.message).toContain("--yes");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("initiative remove-project --json without --yes emits a structured error before lookup", async () => {
    const r = await runLebop(
      ["initiative", "remove-project", "Roadmap H2", "Project A", "--json"],
      env,
    );

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.error.code).toBe("validation_error");
    expect(parsed.error.message).toContain("--yes");
    expect(mock.requestAt(0)).toBeUndefined();
  });
});

describe("set command mutation truthfulness", () => {
  it("set title --json refreshes cached issue with Linear's canonical identifier", async () => {
    const home = await makeAuthFile("lin_api_test_set_canonical_writeback");
    const cwd = await mkdtemp(join(tmpdir(), "lebop-set-canonical-cwd-"));

    try {
      const dir = join(home, "cache", "_global", "issues", "NOX-1");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "metadata.yaml"),
        [
          "identifier: NOX-1",
          "title: Old title",
          "state: Backlog",
          "priority: 0",
          "estimate: null",
          "labels: []",
          "assignee: null",
          "project: null",
          "parent: null",
          "_server:",
          "  id: issue-uuid-1",
          "  identifier: NOX-1",
          "  url: https://linear.app/test/issue/NOX-1",
          "  state_id: state-backlog",
          "  state_name: Backlog",
          "  state_type: backlog",
          "  priority: 0",
          "  estimate: null",
          "  label_ids: []",
          "  assignee_id: null",
          "  assignee_name: null",
          "  assignee_email: null",
          "  title: Old title",
          `  description_hash: ${sha256("old cached description")}`,
          "  project_id: null",
          "  project_name: null",
          "  parent_id: null",
          "  parent_identifier: null",
          "  updated_at: 2026-06-05T00:00:00.000Z",
          "",
        ].join("\n"),
      );
      await writeFile(join(dir, "description.md"), "old cached description");

      mock.respond({ data: { issue: cliIssuePayload("issue-uuid-1", "NOX-1") } });
      mock.respond({
        data: {
          issueUpdate: {
            success: true,
            issue: cliIssuePayload("issue-uuid-1", "NOX-1", {
              title: "New title",
              description: "new cached description",
              updatedAt: "2026-06-05T00:00:01.000Z",
            }),
          },
        },
      });

      const r = await runLebop(
        ["set", "title", "nox-1", "--team", "NOX", "--json", "New title"],
        { LEBOP_HOME: home, LEBOP_API_URL: mock.url },
        cwd,
      );

      expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.identifier).toBe("NOX-1");
      expect(parsed.requested_identifier).toBe("nox-1");
      expect(parsed.remote).toMatchObject({
        identifier: "NOX-1",
        updated_at: "2026-06-05T00:00:01.000Z",
        title: "New title",
        description: "new cached description",
        state: { id: "state-backlog", name: "Backlog", type: "backlog" },
        priority: 0,
        estimate: null,
        labels: [],
        assignee: null,
        parent: null,
        project: null,
        milestone: null,
        cycle: null,
      });
      expect(parsed.cache_writeback.status).toBe("refreshed");
      await expect(readFile(join(dir, "description.md"), "utf8")).resolves.toBe(
        "new cached description",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("set title --json refuses to overwrite a dirty cached issue after remote success", async () => {
    const home = await makeAuthFile("lin_api_test_set_dirty_writeback");
    const cwd = await mkdtemp(join(tmpdir(), "lebop-set-dirty-cwd-"));

    try {
      const dir = join(home, "cache", "_global", "issues", "NOX-1");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "metadata.yaml"),
        [
          "identifier: NOX-1",
          "title: Old title",
          "state: Backlog",
          "priority: 0",
          "estimate: null",
          "labels: []",
          "assignee: null",
          "project: null",
          "parent: null",
          "_server:",
          "  id: issue-uuid-1",
          "  identifier: NOX-1",
          "  url: https://linear.app/test/issue/NOX-1",
          "  state_id: state-backlog",
          "  state_name: Backlog",
          "  state_type: backlog",
          "  priority: 0",
          "  estimate: null",
          "  label_ids: []",
          "  assignee_id: null",
          "  assignee_name: null",
          "  assignee_email: null",
          "  title: Old title",
          `  description_hash: ${sha256("server baseline")}`,
          "  project_id: null",
          "  project_name: null",
          "  parent_id: null",
          "  parent_identifier: null",
          "  updated_at: 2026-06-05T00:00:00.000Z",
          "",
        ].join("\n"),
      );
      await writeFile(join(dir, "description.md"), "local unsent edit");

      mock.respond({ data: { issue: cliIssuePayload("issue-uuid-1", "NOX-1") } });
      mock.respond({
        data: {
          issueUpdate: {
            success: true,
            issue: cliIssuePayload("issue-uuid-1", "NOX-1", {
              title: "Remote title",
              description: "remote body should not replace local dirty body",
              updatedAt: "2026-06-05T00:00:01.000Z",
            }),
          },
        },
      });

      const r = await runLebop(
        ["set", "title", "NOX-1", "--team", "NOX", "--json", "Remote title"],
        { LEBOP_HOME: home, LEBOP_API_URL: mock.url },
        cwd,
      );

      expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(1);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.status).toBe("updated-writeback-failed");
      expect(parsed.cache_writeback).toMatchObject({
        status: "failed",
        code: "cache_dirty",
        dirty: { fields: ["description"] },
      });
      await expect(readFile(join(dir, "description.md"), "utf8")).resolves.toBe(
        "local unsent edit",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("set title --json treats issueUpdate success:false as a structured failure", async () => {
    mock.respond({
      data: {
        issue: {
          id: "issue-uuid-1",
          identifier: "NOX-1",
          title: "Old title",
          description: "",
          priority: 0,
          estimate: null,
          url: "https://linear.app/test/issue/NOX-1",
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
        },
      },
    });
    mock.respond({
      data: {
        issueUpdate: {
          success: false,
          issue: {
            id: "issue-uuid-1",
            identifier: "NOX-1",
            title: "New title",
            description: "",
            priority: 0,
            estimate: null,
            url: "https://linear.app/test/issue/NOX-1",
            updatedAt: "2026-06-05T00:00:00.000Z",
            state: { id: "state-backlog", name: "Backlog", type: "backlog" },
            assignee: null,
            project: null,
            team: { id: "team-nox", key: "NOX" },
            parent: null,
            labels: { nodes: [] },
          },
        },
      },
    });

    const r = await runLebop(["set", "title", "NOX-1", "--json", "New title"], env);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.error.code).toBe("validation_error");
    expect(parsed.error.message).toBe("issueUpdate failed");
  });

  it("set description --description-file --json updates the issue description", async () => {
    const home = await makeAuthFile("lin_api_test_set_description_file");
    const dir = await mkdtemp(join(tmpdir(), "lebop-set-description-"));
    const bodyPath = join(dir, "description.md");
    await writeFile(bodyPath, "Description from file.\n");

    try {
      mock.respond({ data: { issue: { id: "issue-uuid-1", identifier: "NOX-1" } } });
      mock.respond({
        data: {
          issueUpdate: {
            success: true,
            issue: cliIssuePayload("issue-uuid-1", "NOX-1", {
              title: "NOX-1",
              description: "Description from file.",
              updatedAt: "2026-06-05T00:00:02.000Z",
            }),
          },
        },
      });

      const r = await runLebop(
        ["set", "description", "NOX-1", "--description-file", bodyPath, "--json"],
        { LEBOP_HOME: home, LEBOP_API_URL: mock.url },
      );

      expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.identifier).toBe("NOX-1");
      expect(parsed.field).toBe("description");
      expect(parsed.remote).toMatchObject({
        identifier: "NOX-1",
        updated_at: "2026-06-05T00:00:02.000Z",
        description: "Description from file.",
        labels: [],
        milestone: null,
        cycle: null,
      });
      const update = [...Array(8).keys()]
        .map((index) => mock.requestAt(index))
        .find((request) => request?.query.includes("issueUpdate"));
      expect(update?.variables.input).toMatchObject({ description: "Description from file." });
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("set project --json resolves project names through the shared update path", async () => {
    const home = await makeAuthFile("lin_api_test_set_project_name");
    try {
      mock.respond({ data: { issue: { id: "issue-uuid-1", identifier: "NOX-1" } } });
      mock.respond({ data: { projects: { nodes: [{ id: "project-uuid-1" }] } } });
      mock.respond({
        data: {
          issueUpdate: {
            success: true,
            issue: {
              id: "issue-uuid-1",
              identifier: "NOX-1",
              url: "https://linear.app/test/issue/NOX-1",
              title: "NOX-1",
              state: { name: "Backlog" },
            },
          },
        },
      });

      const r = await runLebop(["set", "project", "NOX-1", "Agent Project", "--json"], {
        LEBOP_HOME: home,
        LEBOP_API_URL: mock.url,
      });

      expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
      const update = [...Array(9).keys()]
        .map((index) => mock.requestAt(index))
        .find((request) => request?.query.includes("issueUpdate"));
      expect(update?.variables.input).toMatchObject({ projectId: "project-uuid-1" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("set milestone null and set cycle null send clear mutations", async () => {
    const home = await makeAuthFile("lin_api_test_set_milestone_cycle_null");
    try {
      for (const field of ["milestone", "cycle"]) {
        mock.respond({ data: { issue: { id: "issue-uuid-1", identifier: "NOX-1" } } });
        mock.respond({
          data: {
            issueUpdate: {
              success: true,
              issue: {
                id: "issue-uuid-1",
                identifier: "NOX-1",
                url: "https://linear.app/test/issue/NOX-1",
                title: "NOX-1",
                state: { name: "Backlog" },
              },
            },
          },
        });

        const r = await runLebop(["set", field, "NOX-1", "null", "--json"], {
          LEBOP_HOME: home,
          LEBOP_API_URL: mock.url,
        });

        expect(r.exitCode, `${field}\n${r.stdout}\n${r.stderr}`).toBe(0);
      }

      const updates = [...Array(16).keys()]
        .map((index) => mock.requestAt(index))
        .filter((request) => request?.query.includes("issueUpdate"));
      expect(updates[0]?.variables.input).toMatchObject({ projectMilestoneId: null });
      expect(updates[1]?.variables.input).toMatchObject({ cycleId: null });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("pull command JSON conflict handling", () => {
  it("pull --json emits a structured cache conflict and failing exit code", async () => {
    const home = await makeAuthFile("lin_api_test_pull_json_conflict");
    const cwd = await mkdtemp(join(tmpdir(), "lebop-pull-json-conflict-cwd-"));

    try {
      const dir = join(home, "cache", "_global", "issues", "NOX-1");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "metadata.yaml"),
        [
          "identifier: NOX-1",
          "title: Old title",
          "state: Backlog",
          "priority: 0",
          "estimate: null",
          "labels: []",
          "assignee: null",
          "project: null",
          "parent: null",
          "_server:",
          "  id: issue-uuid-1",
          "  identifier: NOX-1",
          "  url: https://linear.app/test/issue/NOX-1",
          "  state_id: state-backlog",
          "  state_name: Backlog",
          "  state_type: backlog",
          "  priority: 0",
          "  estimate: null",
          "  label_ids: []",
          "  assignee_id: null",
          "  assignee_name: null",
          "  assignee_email: null",
          "  title: Old title",
          `  description_hash: ${sha256("server baseline")}`,
          "  project_id: null",
          "  project_name: null",
          "  parent_id: null",
          "  parent_identifier: null",
          "  updated_at: 2026-06-05T00:00:00.000Z",
          "",
        ].join("\n"),
      );
      await writeFile(join(dir, "description.md"), "local unsent edit");

      mock.respond({
        data: {
          a0: cliIssuePayload("issue-uuid-1", "NOX-1", {
            title: "Remote title",
            description: "remote body",
          }),
        },
      });

      const r = await runLebop(
        ["pull", "NOX-1", "--team", "NOX", "--no-comments", "--json"],
        { LEBOP_HOME: home, LEBOP_API_URL: mock.url },
        cwd,
      );

      expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(1);
      expect(r.stderr).toBe("");
      const parsed = JSON.parse(r.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.schema_version).toBe(1);
      expect(parsed.error).toMatchObject({
        code: "cache_conflict",
        conflicts: ["NOX-1"],
        hint: expect.stringContaining("--refresh --yes"),
      });
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("raw GraphQL", () => {
  it("rejects mutation operations without explicit mutation intent before contacting Linear", async () => {
    const r = await runLebop(
      ["raw", "mutation CreateThing { issueCreate(input: {}) { success } }"],
      env,
    );

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("raw GraphQL mutation requires --allow-mutation");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("rejects allowed mutation operations without confirmation before contacting Linear", async () => {
    const r = await runLebop(
      ["raw", "--allow-mutation", "mutation CreateThing { issueCreate(input: {}) { success } }"],
      env,
    );

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--yes/--confirm");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("does not retry explicitly allowed mutation operations after a transient response", async () => {
    mock.respond({
      status: 503,
      errors: [{ message: "Service Unavailable", extensions: { code: "SERVICE_UNAVAILABLE" } }],
    });

    const r = await runLebop(
      [
        "raw",
        "--allow-mutation",
        "--confirm",
        "mutation CreateThing { issueCreate(input: {}) { success } }",
      ],
      env,
    );

    expect(r.exitCode).toBe(1);
    expect(mock.requestAt(0)?.query).toContain("mutation CreateThing");
    expect(mock.requestAt(1)).toBeUndefined();
  });

  it("rejects --paginate for mutations before contacting Linear", async () => {
    const r = await runLebop(
      ["raw", "--paginate", "mutation CreateThing { issueCreate(input: {}) { success } }"],
      env,
    );

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--paginate requires a GraphQL query operation");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("rejects subscriptions before contacting Linear", async () => {
    const r = await runLebop(["raw", "subscription Events { issueCreated { id } }"], env);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("raw GraphQL requires a GraphQL query");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("rejects --variables-json arrays before contacting Linear", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lebop-raw-vars-"));
    try {
      const varsPath = join(dir, "vars.json");
      await writeFile(varsPath, "[1,2,3]");

      const r = await runLebop(
        ["raw", "query { viewer { id } }", "--variables-json", varsPath],
        env,
      );

      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("--variables-json must contain a JSON object");
      expect(mock.requestAt(0)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects raw query stdin combined with --variables-json stdin before contacting Linear", async () => {
    const r = await runLebopWithStdin(
      ["raw", "--variables-json", "-"],
      "query { viewer { id } }\n",
      env,
    );

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("raw cannot read both query and --variables-json from stdin");
    expect(mock.requestAt(0)).toBeUndefined();
  });

  it("allows raw positional query with --variables-json stdin", async () => {
    mock.respond({ data: { viewer: { id: "viewer-1" } } });

    const r = await runLebopWithStdin(
      ["raw", "query Viewer($id: String) { viewer { id } }", "--variables-json", "-"],
      '{"id":"viewer-1"}\n',
      env,
    );

    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ viewer: { id: "viewer-1" } });
    expect(mock.requestAt(0)?.variables).toEqual({ id: "viewer-1" });
  });
});

describe("teams", () => {
  it("paginates and lists teams", async () => {
    mock.respond({
      data: {
        teams: {
          nodes: [
            { id: "team-1", key: "ENG", name: "Engineering", description: null },
            { id: "team-2", key: "DES", name: "Design", description: "Design team" },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
    const r = await runLebop(["teams"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ENG");
    expect(r.stdout).toContain("Engineering");
    expect(r.stdout).toContain("DES");
    expect(r.stdout).toContain("Design");
  });

  it("--json emits a versioned envelope", async () => {
    mock.respond({
      data: {
        teams: {
          nodes: [{ id: "team-3", key: "OPS", name: "Operations", description: null }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
    const r = await runLebop(["teams", "--json"], env);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.teams).toHaveLength(1);
    expect(parsed.teams[0].key).toBe("OPS");
  });

  it("walks multiple pages until hasNextPage is false", async () => {
    mock.respond({
      data: {
        teams: {
          nodes: [{ id: "team-4", key: "AAA", name: "A", description: null }],
          pageInfo: { hasNextPage: true, endCursor: "cursor-page-2" },
        },
      },
    });
    mock.respond({
      data: {
        teams: {
          nodes: [{ id: "team-5", key: "BBB", name: "B", description: null }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
    const r = await runLebop(["teams"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("AAA");
    expect(r.stdout).toContain("BBB");
  });
});

describe("workspace context", () => {
  it("workspace explore / --json returns top-level paths", async () => {
    const r = await runLebop(["workspace", "explore", "/", "--json"], env);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout) as {
      path: string;
      items: { kind: string; path: string }[];
      next_paths: string[];
    };
    expect(body.path).toBe("/");
    expect(body.items.some((item) => item.path === "/projects")).toBe(true);
    expect(body.next_paths).toContain("/teams");
  });

  it("workspace explore exposes Linear API budget metadata when headers are present", async () => {
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
            cliProjectNode({
              id: "workspace-meta-project",
              name: "Workspace Meta Project",
            }),
          ],
          pageInfo: pageInfo(),
        },
      },
    });

    const r = await runLebop(["workspace", "explore", "/projects", "--json"], env);
    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
    const body = JSON.parse(r.stdout) as {
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

  it("root --team scopes workspace explore when the leaf command omits --team", async () => {
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
        issues: {
          nodes: [],
          pageInfo: pageInfo(),
        },
      },
    });

    const r = await runLebop(["--team", "NOX", "workspace", "explore", "/issues", "--json"], env);
    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
    const body = JSON.parse(r.stdout) as {
      team: string | null;
      summary: { kind?: string; all_teams?: boolean };
    };
    expect(body.team).toBe("NOX");
    expect(body.summary).toMatchObject({ kind: "issues", all_teams: false });
    expect(mock.requestAt(1)?.variables.filter).toMatchObject({
      team: { key: { eq: "NOX" } },
    });
  });

  it("workspace fetch <issue> --json writes a context manifest", async () => {
    const out = await mkdtemp(join(tmpdir(), "lebop-cli-context-"));
    const reset = 1_787_000_000_000;
    mock.respond({
      headers: {
        "x-ratelimit-requests-limit": "2500",
        "x-ratelimit-requests-remaining": "2499",
        "x-ratelimit-requests-reset": String(reset),
      },
      data: {
        a0: {
          id: "issue-uuid-eng-3",
          identifier: "ENG-3",
          title: "CLI context issue",
          description: "body",
          priority: 2,
          estimate: null,
          url: "https://linear.app/test/issue/ENG-3",
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

    const r = await runLebop(["workspace", "fetch", "/issues/ENG-3", "--to", out, "--json"], env);
    expect(r.exitCode, r.stderr).toBe(0);
    const body = JSON.parse(r.stdout) as {
      root: string;
      counts: Record<string, number>;
      manifest_file: string;
      _meta?: {
        linear_api?: {
          request_count: number;
          rate_limit: { requests?: { remaining: number; reset_at: string } };
        };
      };
    };
    expect(body.root).toBe(out);
    expect(body.counts.issues).toBe(1);
    expect(body._meta?.linear_api).toMatchObject({
      request_count: 5,
      rate_limit: {
        requests: {
          remaining: 2499,
          reset_at: new Date(reset).toISOString(),
        },
      },
    });
    const manifest = JSON.parse(await readFile(body.manifest_file, "utf8"));
    expect(manifest.kind).toBe("issue");
    expect(manifest.counts.issues).toBe(1);
    await rm(out, { recursive: true, force: true });
  });
});

describe("pull export safety", () => {
  it("pull --to refuses an existing output root under a symlinked ancestor", async () => {
    const target = await mkdtemp(join(tmpdir(), "lebop-cli-pull-real-parent-"));
    const link = join(tmpdir(), `lebop-cli-pull-parent-link-${Date.now()}`);
    await symlink(target, link, "dir");
    const out = join(link, "existing-export-root");
    await mkdir(out, { recursive: true });

    const r = await runLebop(["pull", "NOX-1", "--team", "NOX", "--to", out], env);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("refusing to export through symlinked ancestor");
    await rm(link, { force: true });
    await rm(target, { recursive: true, force: true });
  });
});

describe("publish workflow", () => {
  it("publish review/apply stores a review id and verifies the published plan", async () => {
    const planDir = await mkdtemp(join(tmpdir(), "lebop-cli-publish-plan-"));
    await writeFile(
      join(planDir, "_project.md"),
      "---\nname: CLI Publish Project\nteam: ENG\nstate: backlog\n---\n\nCLI publish body.\n",
    );

    queueTeamMetadataResponses("ENG");
    const review = await runLebop(["publish", "review", "--plan", planDir, "--json"], env);
    expect(review.exitCode, review.stderr).toBe(0);
    const reviewed = JSON.parse(review.stdout) as {
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
          project: cliProjectNode({
            id: "22222222-3333-4444-5555-666666666666",
            name: "CLI Publish Project",
            description: "",
            content: "CLI publish body.",
            state: "backlog",
            updatedAt: "2026-06-04T12:00:00.000Z",
          }),
        },
      },
    });
    mock.respond({
      data: {
        project: {
          id: "22222222-3333-4444-5555-666666666666",
          name: "CLI Publish Project",
          description: "",
          content: "CLI publish body.",
          icon: null,
          state: "backlog",
          url: "https://linear.app/test/project/cli-publish-project",
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

    const applied = await runLebop(["publish", "apply", reviewed.review_id, "--json"], env);
    expect(applied.exitCode, applied.stderr).toBe(0);
    const body = JSON.parse(applied.stdout) as {
      status: string;
      verification: { has_drift: boolean };
    };
    expect(body.status).toBe("verified");
    expect(body.verification.has_drift).toBe(false);
    const projectFile = await readFile(join(planDir, "_project.md"), "utf8");
    expect(projectFile).toContain("linear_id: 22222222-3333-4444-5555-666666666666");
    await rm(planDir, { recursive: true, force: true });
  });

  it("publish apply refuses when the reviewed plan changed", async () => {
    const planDir = await mkdtemp(join(tmpdir(), "lebop-cli-publish-stale-"));
    await writeFile(
      join(planDir, "_project.md"),
      "---\nname: CLI Stale Publish Project\nteam: ENG\nstate: backlog\n---\n\nReviewed body.\n",
    );

    const review = await runLebop(["publish", "review", "--plan", planDir, "--json"], env);
    expect(review.exitCode, review.stderr).toBe(0);
    const reviewed = JSON.parse(review.stdout) as { review_id: string };
    await writeFile(
      join(planDir, "_project.md"),
      "---\nname: CLI Stale Publish Project\nteam: ENG\nstate: backlog\n---\n\nChanged body.\n",
    );

    const applied = await runLebop(["publish", "apply", reviewed.review_id, "--json"], env);
    expect(applied.exitCode).toBe(1);
    const body = JSON.parse(applied.stdout) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toContain("stale");
    await rm(planDir, { recursive: true, force: true });
  });
});

describe("plan apply preflight", () => {
  it("blocks non-dry-run apply before mutations when external references are unresolved", async () => {
    const planDir = await mkdtemp(join(tmpdir(), "lebop-cli-plan-preflight-"));
    const home = await makeAuthFile("lin_api_test_cli_plan_preflight");
    await writeFile(
      join(planDir, "_project.md"),
      "---\nname: CLI Preflight Plan\nteam: PFL\n---\n",
    );
    await writeFile(
      join(planDir, "01-child.md"),
      "---\ntitle: Child\nparent: PFL-404\n---\n\nChild body.\n",
    );
    queueTeamMetadataResponses("PFL");
    mock.respond({ data: { issue: null } });

    const r = await runLebop(["plan", "apply", planDir, "--json"], { ...env, LEBOP_HOME: home });

    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.dry_run).toBe(false);
    expect(parsed.preflight.ready).toBe(false);
    expect(parsed.preflight.blockers.join("\n")).toContain("parent not found: PFL-404");
    expect(mock.requestAt(5)?.query).toContain("issue");
    expect(mock.requestAt(6)).toBeUndefined();
    await rm(home, { recursive: true, force: true });
    await rm(planDir, { recursive: true, force: true });
  });

  it("blocks dry-run apply at the same external-reference preflight", async () => {
    const planDir = await mkdtemp(join(tmpdir(), "lebop-cli-plan-dry-preflight-"));
    const home = await makeAuthFile("lin_api_test_cli_plan_dry_preflight");
    await writeFile(
      join(planDir, "_project.md"),
      "---\nname: CLI Dry Preflight Plan\nteam: PFD\n---\n",
    );
    await writeFile(
      join(planDir, "01-child.md"),
      "---\ntitle: Child\nrelated:\n  - PFD-404\n---\n\nChild body.\n",
    );
    queueTeamMetadataResponses("PFD");
    mock.respond({ data: { issue: null } });

    const r = await runLebop(["plan", "apply", planDir, "--dry-run", "--json"], {
      ...env,
      LEBOP_HOME: home,
    });

    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.preflight.ready).toBe(false);
    expect(parsed.preflight.blockers.join("\n")).toContain("related target not found: PFD-404");
    expect(mock.requestAt(5)?.query).toContain("issue");
    expect(mock.requestAt(6)).toBeUndefined();
    await rm(home, { recursive: true, force: true });
    await rm(planDir, { recursive: true, force: true });
  });
});

describe("project icon CLI parity", () => {
  it("project create --icon passes icon to ProjectCreateInput", async () => {
    mock.respond({
      data: {
        projectCreate: {
          success: true,
          project: cliProjectNode({ icon: "Rocket" }),
        },
      },
    });

    const r = await runLebop(
      [
        "project",
        "create",
        "CLI Icon Project",
        "--team-id",
        "team-uuid-nox",
        "--icon",
        "Rocket",
        "--json",
      ],
      env,
    );

    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout) as {
      project: { icon: string | null };
      team_ids: string[];
    };
    expect(body.project.icon).toBe("Rocket");
    expect(body.team_ids).toEqual(["team-uuid-nox"]);
    expect(mock.requestAt(0)?.variables).toMatchObject({
      input: { name: "CLI Icon Project", teamIds: ["team-uuid-nox"], icon: "Rocket" },
    });
  });

  it("project update --icon null clears icon in ProjectUpdateInput", async () => {
    mock.respond({
      data: {
        projectUpdate: {
          success: true,
          project: cliProjectNode({ icon: null }),
        },
      },
    });

    const r = await runLebop(
      ["project", "update", "project-uuid-icon", "--icon", "null", "--json"],
      env,
    );

    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout) as { project: { icon: string | null } };
    expect(body.project.icon).toBeNull();
    expect(mock.requestAt(0)?.variables).toMatchObject({
      id: "project-uuid-icon",
      input: { icon: null },
    });
  });

  it("project update reports writeback failure as top-level status", async () => {
    const home = await makeAuthFile("lin_api_test_project_update_writeback");
    const cwd = await mkdtemp(join(tmpdir(), "lebop-project-update-cwd-"));
    const projectId = "project-uuid-writeback";
    const cachePath = join(home, "cache", "_global", "projects", projectId);

    try {
      await mkdir(join(cachePath, "content.md"), { recursive: true });
      await writeFile(
        join(cachePath, "metadata.yaml"),
        [
          "name: Cached Project Before",
          "description: before description",
          "icon: Rocket",
          "state: backlog",
          "_server:",
          `  id: ${projectId}`,
          "  url: https://linear.app/test/project/cached-project",
          "  state: backlog",
          "  name: Cached Project Before",
          "  description: before description",
          "  icon: Rocket",
          "  content_hash: oldhash",
          "  updated_at: 2026-06-04T10:00:00.000Z",
          "",
        ].join("\n"),
      );
      mock.respond({
        data: {
          projectUpdate: {
            success: true,
            project: cliProjectNode({
              id: projectId,
              name: "Writeback Failed Project",
              content: "after content",
              updatedAt: "2026-06-04T10:03:00.000Z",
            }),
          },
        },
      });

      const r = await runLebop(
        ["project", "update", projectId, "--name", "Writeback Failed Project", "--json"],
        { LEBOP_HOME: home, LEBOP_API_URL: mock.url },
        cwd,
      );

      expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(1);
      const body = JSON.parse(r.stdout) as {
        status: string;
        cache: { present: boolean; refreshed: boolean; error?: { message: string } };
      };
      expect(body.status).toBe("updated-writeback-failed");
      expect(body.cache).toMatchObject({ present: true, refreshed: false });
      expect(body.cache.error?.message).toBeTruthy();
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("label CLI workspace scope parity", () => {
  it("label list --workspace-only --json does not require team config", async () => {
    mock.respond({
      data: {
        issueLabels: {
          nodes: [
            {
              id: "workspace-label-uuid",
              name: "workspace-label",
              color: "#ff00aa",
              description: null,
              team: null,
            },
          ],
          pageInfo: pageInfo(),
        },
      },
    });

    const r = await runLebop(["label", "list", "--workspace-only", "--json"], env);

    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.scope).toEqual({ type: "workspace", team: null });
    expect(parsed.team).toBeNull();
    expect(parsed.labels[0]).toMatchObject({ id: "workspace-label-uuid", team: null });
    expect(mock.requestAt(0)?.variables).toMatchObject({
      filter: { team: { null: true } },
    });
  });

  it("label list --team rejects unknown teams instead of returning workspace labels", async () => {
    mock.respond({
      data: {
        teams: {
          nodes: [],
        },
      },
    });

    const r = await runLebop(["label", "list", "--team", "BAD", "--json"], env);

    expect(r.exitCode).toBe(1);
    expect(`${r.stdout}\n${r.stderr}`).toContain("team not found: BAD");
    expect(mock.requestAt(0)?.query).toContain("GetTeamByKey");
    expect(mock.requestAt(1)).toBeUndefined();
  });

  it("label create --workspace-scoped --json does not require team config", async () => {
    mock.respond({
      data: {
        issueLabelCreate: {
          success: true,
          issueLabel: {
            id: "workspace-label-created",
            name: "workspace-label",
            color: "#ff00aa",
            description: "workspace",
            team: null,
          },
        },
      },
    });

    const r = await runLebop(
      [
        "label",
        "create",
        "workspace-label",
        "--workspace-scoped",
        "--color",
        "#ff00aa",
        "--description",
        "workspace",
        "--json",
      ],
      env,
    );

    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.label).toMatchObject({ id: "workspace-label-created", team: null });
    expect(mock.requestAt(0)?.variables).toMatchObject({
      input: {
        name: "workspace-label",
        color: "#ff00aa",
        description: "workspace",
      },
    });
    expect(mock.requestAt(0)?.variables.input).not.toHaveProperty("teamId");
  });
});

describe("project create multi-team CLI parity", () => {
  it("project create accepts repeated --team-id values", async () => {
    mock.respond({
      data: {
        projectCreate: {
          success: true,
          project: cliProjectNode({
            teams: {
              nodes: [
                { id: "team-uuid-nox", key: "NOX", name: "Noxor" },
                { id: "team-uuid-ops", key: "OPS", name: "Operations" },
              ],
            },
          }),
        },
      },
    });

    const r = await runLebop(
      [
        "project",
        "create",
        "Multi Team Project",
        "--team-id",
        "team-uuid-nox",
        "--team-id",
        "team-uuid-ops",
        "--json",
      ],
      env,
    );

    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(JSON.parse(r.stdout).team_ids).toEqual(["team-uuid-nox", "team-uuid-ops"]);
    expect(mock.requestAt(0)?.variables).toMatchObject({
      input: {
        name: "Multi Team Project",
        teamIds: ["team-uuid-nox", "team-uuid-ops"],
      },
    });
  });

  it("project create accepts repeated --team-key values", async () => {
    const home = await makeAuthFile("lin_api_test_project_multi_team_keys");
    try {
      queueTeamMetadataResponses("NOX");
      queueTeamMetadataResponses("OPS");
      mock.respond({
        data: {
          projectCreate: {
            success: true,
            project: cliProjectNode({
              teams: {
                nodes: [
                  { id: "team-nox", key: "NOX", name: "Engineering" },
                  { id: "team-ops", key: "OPS", name: "Engineering" },
                ],
              },
            }),
          },
        },
      });

      const r = await runLebop(
        [
          "project",
          "create",
          "Multi Team Key Project",
          "--team-key",
          "NOX",
          "--team-key",
          "OPS",
          "--json",
        ],
        { LEBOP_HOME: home, LEBOP_API_URL: mock.url },
      );

      expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(JSON.parse(r.stdout).team_ids).toEqual(["team-nox", "team-ops"]);
      expect(mock.requestAt(10)?.variables).toMatchObject({
        input: {
          name: "Multi Team Key Project",
          teamIds: ["team-nox", "team-ops"],
        },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("initiative remove-project (CLI regression for the structured result)", () => {
  // The lib's `initiativeRemoveProject` returns
  //   { removed: boolean, reason?: "absent" | "archived" | "other", message?: string }
  // (changed from plain boolean during the wave-1 fix). The CLI caller used
  // to do `if (success)` and treat the returned object as truthy regardless
  // of `removed` — these tests guard against that regression and confirm
  // the `--json` envelope shape matches the MCP tool's output.
  const INITIATIVE_UUID = "11111111-2222-3333-4444-555555555555";
  const PROJECT_UUID = "66666666-7777-8888-9999-aaaaaaaaaaaa";
  const EDGE_UUID = "edge-aaaa-bbbb-cccc-dddddddddddd";

  it("--json reports removed: true on successful unlink", async () => {
    // Step 1: find the edge via projectLinksPage walk
    mock.respond({
      data: {
        project: {
          initiativeToProjects: {
            nodes: [{ id: EDGE_UUID, initiative: { id: INITIATIVE_UUID } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
    // Step 2: delete mutation succeeds
    mock.respond({ data: { initiativeToProjectDelete: { success: true } } });

    const r = await runLebop(
      ["initiative", "remove-project", INITIATIVE_UUID, PROJECT_UUID, "--yes", "--json"],
      env,
    );
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.removed).toBe(true);
    expect(parsed).not.toHaveProperty("success"); // no legacy field leak
  });

  it("--json reports removed: false + reason: 'absent' when the link doesn't exist", async () => {
    // Step 1: projectLinksPage returns no matching edges, hasNextPage false
    mock.respond({
      data: {
        project: {
          initiativeToProjects: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
    // Step 2: archive probe runs to disambiguate absent vs archived;
    // initiative is live (archivedAt: null) → classify as absent.
    mock.respond({
      data: { initiatives: { nodes: [{ id: INITIATIVE_UUID, archivedAt: null }] } },
    });

    const r = await runLebop(
      ["initiative", "remove-project", INITIATIVE_UUID, PROJECT_UUID, "--yes", "--json"],
      env,
    );
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.removed).toBe(false);
    expect(parsed.reason).toBe("absent");
  });

  it("--json reports removed: false + reason: 'archived' when the initiative is archived", async () => {
    // Step 1: find the edge
    mock.respond({
      data: {
        project: {
          initiativeToProjects: {
            nodes: [{ id: EDGE_UUID, initiative: { id: INITIATIVE_UUID } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
    // Step 2: delete returns success: false (no exception)
    mock.respond({ data: { initiativeToProjectDelete: { success: false } } });
    // Step 3: archive probe confirms the initiative is archived. Uses the
    // `initiatives(filter:..., includeArchived: true)` shape because the
    // single-record `initiative(id:)` query throws NOT_FOUND for archived
    // initiatives (defeating the probe). See `src/lib/initiatives.ts`.
    mock.respond({
      data: {
        initiatives: {
          nodes: [{ id: INITIATIVE_UUID, archivedAt: "2026-05-11T00:00:00.000Z" }],
        },
      },
    });

    const r = await runLebop(
      ["initiative", "remove-project", INITIATIVE_UUID, PROJECT_UUID, "--yes", "--json"],
      env,
    );
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.removed).toBe(false);
    expect(parsed.reason).toBe("archived");
  });

  it("human output prints a reason-specific line on the absent path (not a fake 'unlinked')", async () => {
    mock.respond({
      data: {
        project: {
          initiativeToProjects: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const r = await runLebop(
      ["initiative", "remove-project", INITIATIVE_UUID, PROJECT_UUID, "--yes"],
      env,
    );
    expect(r.exitCode).toBe(0);
    // The regression we're guarding against: pre-fix code emitted
    // "✓ unlinked …" even when nothing was actually unlinked.
    expect(r.stdout).not.toContain("unlinked");
    expect(r.stdout).toContain("was not linked");
  });
});

describe("initiative lifecycle CLI parity (round-9 / M-4)", () => {
  // RH1 wrapped the four lifecycle handlers (update / archive / unarchive /
  // delete) with `resolveInitiativeId`. These tests lock the wire shape +
  // name-resolution behavior so a future regression that bypasses the
  // resolver is caught at unit-test time.
  const INITIATIVE_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("update <name> resolves and emits the updated initiative envelope", async () => {
    // Step 1: resolveInitiativeId name lookup
    mock.respond({
      data: {
        initiatives: { nodes: [{ id: INITIATIVE_UUID, name: "Roadmap H2" }] },
      },
    });
    // Step 2: initiativeUpdate mutation
    mock.respond({
      data: {
        initiativeUpdate: {
          success: true,
          initiative: {
            id: INITIATIVE_UUID,
            name: "Roadmap H2",
            description: "RH1 lock",
            status: "Active",
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

    const r = await runLebop(
      ["initiative", "update", "Roadmap H2", "--description", "RH1 lock", "--json"],
      env,
    );
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.initiative.id).toBe(INITIATIVE_UUID);
    expect(parsed.initiative.description).toBe("RH1 lock");
  });

  it("update <name> --clear-owner sends ownerId: null", async () => {
    mock.respond({
      data: {
        initiatives: { nodes: [{ id: INITIATIVE_UUID, name: "Roadmap H2" }] },
      },
    });
    mock.respond({
      data: {
        initiativeUpdate: {
          success: true,
          initiative: {
            id: INITIATIVE_UUID,
            name: "Roadmap H2",
            description: null,
            status: "Active",
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

    const r = await runLebop(
      ["initiative", "update", "Roadmap H2", "--clear-owner", "--json"],
      env,
    );

    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.initiative.owner).toBeNull();
    expect(mock.requestAt(1)?.variables).toMatchObject({
      id: INITIATIVE_UUID,
      input: { ownerId: null },
    });
  });

  it("archive <name> resolves and emits success", async () => {
    mock.respond({
      data: {
        initiatives: { nodes: [{ id: INITIATIVE_UUID, name: "Roadmap H2" }] },
      },
    });
    mock.respond({ data: { initiativeArchive: { success: true } } });

    const r = await runLebop(["initiative", "archive", "Roadmap H2", "--yes", "--json"], env);
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.id).toBe(INITIATIVE_UUID);
    expect(parsed.success).toBe(true);
  });

  it("unarchive <name> resolves and emits success", async () => {
    mock.respond({
      data: {
        initiatives: { nodes: [{ id: INITIATIVE_UUID, name: "Roadmap H2" }] },
      },
    });
    mock.respond({ data: { initiativeUnarchive: { success: true } } });

    const r = await runLebop(["initiative", "unarchive", "Roadmap H2", "--json"], env);
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.id).toBe(INITIATIVE_UUID);
    expect(parsed.success).toBe(true);
  });

  it("delete <name> --yes resolves and emits status: 'deleted' with id + query", async () => {
    // Step 1: resolveInitiativeId name lookup.
    mock.respond({
      data: {
        initiatives: { nodes: [{ id: INITIATIVE_UUID, name: "Roadmap H2" }] },
      },
    });
    // Step 2: deleteInitiative's getInitiative pre-flight (archived-check).
    mock.respond({
      data: {
        initiatives: {
          nodes: [
            {
              id: INITIATIVE_UUID,
              name: "Roadmap H2",
              description: null,
              status: "Active",
              color: null,
              icon: null,
              url: "https://linear.app/test/initiative/roadmap-h2",
              targetDate: null,
              archivedAt: null,
              owner: null,
              projects: { nodes: [] },
            },
          ],
        },
      },
    });
    // Step 3: the delete mutation.
    mock.respond({ data: { initiativeDelete: { success: true } } });

    const r = await runLebop(["initiative", "delete", "Roadmap H2", "--yes", "--json"], env);
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("deleted");
    expect(parsed.success).toBe(true);
    expect(parsed.id).toBe(INITIATIVE_UUID);
    expect(parsed.query).toBe("Roadmap H2");
  });

  it("delete <bogus-name> --yes short-circuits to already-absent with id: null + query (round-9 / M-1)", async () => {
    // Only the resolveInitiativeId list query fires; no delete mutation
    // should follow, since name resolution returns no match.
    mock.respond({ data: { initiatives: { nodes: [] } } });

    const r = await runLebop(
      ["initiative", "delete", "no-such-initiative", "--yes", "--json"],
      env,
    );
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("already-absent");
    expect(parsed.success).toBe(false);
    expect(parsed.id).toBeNull();
    expect(parsed.query).toBe("no-such-initiative");
  });

  it("delete <id> without --yes emits a structured error envelope", async () => {
    // No mocks needed — the --yes gate fires before any Linear call.
    const r = await runLebop(["initiative", "delete", INITIATIVE_UUID, "--json"], env);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.error.code).toBe("validation_error");
    expect(parsed.error.message).toContain("--yes");
  });
});

describe("error handling", () => {
  it("retries on rate-limit, eventually surfacing RateLimitError", async () => {
    // Five 429s in a row — exhausts the default 5-attempt budget.
    for (let i = 0; i < 5; i++) {
      mock.respond({
        status: 429,
        errors: [{ message: "Too many requests" }],
      });
    }
    const r = await runLebop(["teams"], env);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("error[rate_limit_error]:");
    expect(r.stderr).toContain("rate limited by Linear");
    expect(r.stderr).toContain("hint:");
  }, 30_000);

  it("surfaces Linear rate-limit details in JSON errors", async () => {
    const reset = 1_787_000_000_000;
    for (let i = 0; i < 5; i++) {
      mock.respond({
        status: 400,
        headers: {
          "retry-after": "0",
          "x-ratelimit-requests-limit": "2500",
          "x-ratelimit-requests-remaining": "0",
          "x-ratelimit-requests-reset": String(reset),
        },
        errors: [
          {
            message: "Rate limit exceeded",
            extensions: { code: "RATELIMITED" },
          },
        ],
      });
    }

    const r = await runLebop(["workspace", "explore", "/projects", "--json"], env);
    expect(r.exitCode).toBe(1);
    const body = JSON.parse(r.stdout) as {
      error: {
        code: string;
        details?: {
          request_budget?: { limit: number; remaining: number; reset_at: string };
          retry_after_seconds?: number;
        };
      };
    };
    expect(body.error.code).toBe("rate_limit_error");
    expect(body.error.details).toMatchObject({
      request_budget: {
        limit: 2500,
        remaining: 0,
        reset_at: new Date(reset).toISOString(),
      },
      retry_after_seconds: 0,
    });
  }, 30_000);
});

describe("wave-4A CLI surfaces (smoke)", () => {
  it("attachment --help lists list/update/delete", async () => {
    const r = await runLebop(["attachment", "--help"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/list/);
    expect(r.stdout).toMatch(/update/);
    expect(r.stdout).toMatch(/delete/);
  });

  it("team get --help is registered", async () => {
    const r = await runLebop(["team", "get", "--help"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("key");
  });

  it("team workflow-states --help is registered", async () => {
    const r = await runLebop(["team", "workflow-states", "--help"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("workflow");
  });

  it("lookup state --help shows team + name args", async () => {
    const r = await runLebop(["lookup", "state", "--help"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("<team>");
    expect(r.stdout).toContain("<name>");
  });

  it("lookup user --help shows the email arg", async () => {
    const r = await runLebop(["lookup", "user", "--help"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("<email>");
  });

  it("bulk update --help lists the patch flags", async () => {
    const r = await runLebop(["bulk", "update", "--help"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--state");
    expect(r.stdout).toContain("--priority");
    expect(r.stdout).toContain("--label");
    expect(r.stdout).toContain("--assignee");
    expect(r.stdout).toContain("--project");
  });

  it("auth set-default-team --help is registered", async () => {
    const r = await runLebop(["auth", "set-default-team", "--help"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("<workspace>");
    expect(r.stdout).toContain("<team>");
  });

  it("mine --priority 99 rejects with validation_error envelope (round-10 / M-5)", async () => {
    // Pre-M-5 `mine --priority 99` silently returned an empty result; now
    // it must fail loud at the CLI boundary with the same envelope shape
    // as `list --priority 99`. No Linear mocks needed — the rejection
    // fires before any API call (mine has no getTeam pre-check, so the
    // priority IIFE runs first; the structurally-identical IIFE in
    // commands/list.ts:65-82 is reviewed by inspection only — both share
    // the same `ValidationError` message + hint strings, and any drift
    // between them is caught at code-review time).
    const r = await runLebop(["mine", "--priority", "99", "--json"], env);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.error.code).toBe("validation_error");
    expect(parsed.error.message).toBe('invalid --priority value "99"');
    expect(parsed.error.hint).toBe(
      "priority must be an integer 0..4 (none|urgent|high|normal|low)",
    );
  });
});

describe("paginate cap-approaching warning (wave-4 round-B item #6)", () => {
  // Wave-4 round-B: integration coverage for the cap-approaching stderr
  // warning that paginate.ts emits when an implicit safety-capped walk
  // crosses 50% of the cap. The unit tests (tests/paginate.test.ts) cover
  // the latch + threshold logic at the lib level; this one drives a real
  // CLI invocation end-to-end so we know the stderr write actually
  // surfaces under bun + the spawn harness.
  it("emits 'approaching the safety cap' to stderr at >= 50% of LEBOP_MAX_ITEMS", async () => {
    // Cap of 10 → warn fires at 5 accumulated items. Two pages of 3 each
    // gets us past the threshold while staying under the hard cap (so the
    // walk completes successfully and we see the warning, not the throw).
    mock.respond({
      data: {
        teams: {
          nodes: [
            { id: "team-w1", key: "AA", name: "A", description: null },
            { id: "team-w2", key: "BB", name: "B", description: null },
            { id: "team-w3", key: "CC", name: "C", description: null },
          ],
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        },
      },
    });
    mock.respond({
      data: {
        teams: {
          nodes: [
            { id: "team-w4", key: "DD", name: "D", description: null },
            { id: "team-w5", key: "EE", name: "E", description: null },
            { id: "team-w6", key: "FF", name: "F", description: null },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
    const r = await runLebop(["teams"], { ...env, LEBOP_MAX_ITEMS: "10" });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("approaching the safety cap");
    expect(r.stderr).toContain("LEBOP_MAX_ITEMS");
    expect(r.stderr).toContain("10");
    // Walk still completed — all 6 teams render in stdout.
    expect(r.stdout).toContain("FF");
  });
});

describe("lebop lint — round-5 no-team fallback", () => {
  // Round 5 made `lebop lint <path>` work without a configured team —
  // structurally team-independent for the universal rules (L001-L006);
  // team-scoped rules (R001-R002, L004) degrade gracefully with an empty
  // repoConfig + no workspaceUrlPrefix. Cache-mode (no paths) still
  // requires a team for repoHash resolution.

  it("explicit path + no configured team: universal rules still fire (success)", async () => {
    const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    // Empty LEBOP_HOME — no auth.json, no config.yaml, no team resolvable.
    const emptyHome = await mkdtemp(join(tmpdir(), "lebop-lint-noteam-home-"));
    const markdownPath = join(emptyHome, "trip-l001.md");
    // L001 triggers on table cells starting with `1.` (Linear breaks rows).
    await writeFile(markdownPath, "## table\n\n| col |\n|---|\n| 1. first |\n| 2. second |\n");

    try {
      const r = await runLebop(["lint", markdownPath, "--json"], {
        LEBOP_HOME: emptyHome,
        LEBOP_API_URL: mock.url,
      });

      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout) as {
        schema_version: number;
        files: Array<{ path: string; warnings: Array<{ rule: string }> }>;
      };
      expect(parsed.schema_version).toBe(1);
      expect(parsed.files).toHaveLength(1);
      // L001 fired on the table cells → confirms universal rules work
      // without team config.
      const rules = parsed.files[0]?.warnings.map((w) => w.rule);
      expect(rules).toContain("L001");
    } finally {
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it("lint --fix --strict --json reports post-fix warnings after writing fixes", async () => {
    const { readFile, writeFile, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const emptyHome = await mkdtemp(join(tmpdir(), "lebop-lint-fix-json-home-"));
    const markdownPath = join(emptyHome, "fix-l001.md");
    await writeFile(markdownPath, "## table\n\n| col |\n|---|\n| 1. first |\n");

    try {
      const r = await runLebop(["lint", markdownPath, "--fix", "--strict", "--json"], {
        LEBOP_HOME: emptyHome,
        LEBOP_API_URL: mock.url,
      });

      expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
      const parsed = JSON.parse(r.stdout) as {
        files: Array<{ warnings: Array<{ rule: string }>; fixed: number }>;
        warning_count: number;
        fixed_count: number;
        strict_failed: boolean;
      };
      expect(parsed.files).toHaveLength(1);
      expect(parsed.files[0]?.warnings.map((warning) => warning.rule)).not.toContain("L001");
      expect(parsed.files[0]?.fixed).toBeGreaterThan(0);
      expect(parsed.warning_count).toBe(0);
      expect(parsed.fixed_count).toBeGreaterThan(0);
      expect(parsed.strict_failed).toBe(false);
      await expect(readFile(markdownPath, "utf8")).resolves.toContain("Row 1");
    } finally {
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it("cache-mode (no paths) without team: errors with config_error + hint", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const emptyHome = await mkdtemp(join(tmpdir(), "lebop-lint-cachemode-home-"));

    try {
      // No paths positional + no team config → can't resolve repoHash for
      // cache mode → ConfigError. The lint fallback only fires when paths
      // are explicit.
      // Round-7 / Q4: with `--json`, the structured envelope now goes to
      // stdout (not stderr human prose). Assert the envelope shape.
      const r = await runLebop(["lint", "--json"], {
        LEBOP_HOME: emptyHome,
        LEBOP_API_URL: mock.url,
      });

      expect(r.exitCode).toBe(1);
      const body = JSON.parse(r.stdout) as {
        ok: boolean;
        schema_version: number;
        error: { code: string; message: string; hint?: string };
      };
      expect(body.ok).toBe(false);
      expect(body.schema_version).toBe(1);
      expect(body.error.code).toBe("config_error");
      expect(body.error.message).toContain("no Linear team resolved");
      expect(body.error.hint).toBeTruthy();
    } finally {
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  // Round-7 / Q4: human-mode (no `--json`) still emits the chalk-formatted
  // stderr prose. Lock the two paths separately so a future refactor can't
  // collapse them silently.
  it("cache-mode (no paths) without team — human mode emits stderr prose (no --json)", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const emptyHome = await mkdtemp(join(tmpdir(), "lebop-lint-cachemode-human-"));

    try {
      const r = await runLebop(["lint"], {
        LEBOP_HOME: emptyHome,
        LEBOP_API_URL: mock.url,
      });

      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("error[config_error]:");
      expect(r.stderr).toContain("no Linear team resolved");
      expect(r.stderr).toContain("hint:");
    } finally {
      await rm(emptyHome, { recursive: true, force: true });
    }
  });
});

describe("lebop lint --strict — round-6 / H2 exit-1 path coverage", () => {
  // Pre-round-6: --strict's exit-1 path (lint.ts:130) had zero coverage.
  // The flag is advertised as a pre-commit gate; if it silently stops firing
  // (warning subtraction bug, opts.strict typo), nothing in the suite catches
  // the regression. These tests lock the gate's two outcomes.

  it("--strict on a file with warnings exits 1", async () => {
    const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = await mkdtemp(join(tmpdir(), "lebop-strict-warn-"));
    const md = join(home, "with-warnings.md");
    // Same L001 trigger as the round-5 no-team fallback test — universal
    // rule, no team scope needed.
    await writeFile(md, "## table\n\n| col |\n|---|\n| 1. first |\n");

    try {
      const r = await runLebop(["lint", md, "--strict"], {
        LEBOP_HOME: home,
        LEBOP_API_URL: mock.url,
      });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("L001");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("--strict on a clean file exits 0", async () => {
    const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = await mkdtemp(join(tmpdir(), "lebop-strict-clean-"));
    const md = join(home, "clean.md");
    // Plain markdown with no Linear renderer quirks → zero warnings.
    await writeFile(md, "# Heading\n\nA paragraph.\n\n- bullet 1\n- bullet 2\n");

    try {
      const r = await runLebop(["lint", md, "--strict"], {
        LEBOP_HOME: home,
        LEBOP_API_URL: mock.url,
      });
      expect(r.exitCode).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("--fix --strict --json reports remaining post-fix warnings", async () => {
    const { readFile, writeFile, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = await mkdtemp(join(tmpdir(), "lebop-strict-fix-json-"));
    const md = join(home, "fixable.md");
    await writeFile(md, "| col |\n|---|\n| 1. first |\n");

    try {
      const r = await runLebop(["lint", md, "--fix", "--strict", "--json"], {
        LEBOP_HOME: home,
        LEBOP_API_URL: mock.url,
      });
      expect(r.exitCode).toBe(0);
      const body = JSON.parse(r.stdout) as {
        files: { warnings: { rule: string }[]; fixed: number }[];
        warning_count: number;
        fixed_count: number;
        strict_failed: boolean;
      };
      expect(body.files[0]?.warnings.map((warning) => warning.rule)).not.toContain("L001");
      expect(body.files[0]?.fixed).toBeGreaterThan(0);
      expect(body.warning_count).toBe(0);
      expect(body.fixed_count).toBeGreaterThan(0);
      expect(body.strict_failed).toBe(false);
      await expect(readFile(md, "utf8")).resolves.toContain("Row 1");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("lebop diff — round-6 / H1 exit-code-on-drift regression lock", () => {
  // Round-5-followup made `lebop diff --json` honor the `git diff --exit-code`
  // contract (process.exitCode = 1 on drift, 0 on match — set BEFORE the
  // --json branch returns). These tests lock both human + --json behaviors
  // so a future refactor can't silently regress the CI-gate semantics.
  //
  // Cache is written to LEBOP_HOME/cache/_global/issues/<id>/ — spawning
  // lebop from a tmpdir cwd (no git) forces repoHash="_global".

  // Shared mock-issue-response shape — minimal fields the FetchedIssue
  // fragment needs to satisfy buildIssueMetadata + the description compare.
  function mockIssueResponse(overrides?: {
    title?: string;
    description?: string;
    state?: string;
    priority?: number;
  }) {
    return {
      data: {
        a0: {
          id: "issue-uuid-nox-1",
          identifier: "NOX-1",
          title: overrides?.title ?? "Test issue",
          description: overrides?.description ?? "Original description.",
          priority: overrides?.priority ?? 2,
          estimate: null,
          url: "https://linear.app/test/issue/NOX-1",
          updatedAt: "2026-05-01T00:00:01.000Z",
          state: { id: "state-x", name: overrides?.state ?? "Backlog", type: "backlog" },
          assignee: null,
          project: null,
          team: { id: "team-uuid", key: "NOX" },
          parent: null,
          labels: { nodes: [] },
        },
      },
    };
  }

  async function writeIssueCache(
    home: string,
    metadata: {
      title: string;
      state: string;
      priority: number;
      _server: { updated_at: string; state_name: string };
    },
    description: string,
  ): Promise<void> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { stringify } = await import("yaml");
    const dir = join(home, "cache", "_global", "issues", "NOX-1");
    await mkdir(dir, { recursive: true });
    // Minimal metadata.yaml shape the cache reader expects.
    const full = {
      identifier: "NOX-1",
      title: metadata.title,
      state: metadata.state,
      priority: metadata.priority,
      estimate: null,
      labels: [],
      assignee: null,
      project: null,
      parent: null,
      _server: {
        id: "issue-uuid-nox-1",
        identifier: "NOX-1",
        url: "https://linear.app/test/issue/NOX-1",
        state_id: "state-x",
        state_name: metadata._server.state_name,
        state_type: "backlog",
        priority: metadata.priority,
        estimate: null,
        label_ids: [],
        assignee_id: null,
        assignee_name: null,
        assignee_email: null,
        title: metadata.title,
        description_hash: "deadbeef",
        project_id: null,
        project_name: null,
        parent_id: null,
        parent_identifier: null,
        updated_at: metadata._server.updated_at,
      },
    };
    await writeFile(join(dir, "metadata.yaml"), stringify(full));
    await writeFile(join(dir, "description.md"), description);
  }

  it("matching cache vs remote: human mode exits 0", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = await makeAuthFile("lin_api_test_diff_match");
    const cwd = await mkdtemp(join(tmpdir(), "lebop-diff-cwd-"));

    try {
      await writeIssueCache(
        home,
        {
          title: "Test issue",
          state: "Backlog",
          priority: 2,
          _server: { updated_at: "2026-05-01T00:00:01.000Z", state_name: "Backlog" },
        },
        "Original description.",
      );
      mock.respond(mockIssueResponse());

      const r = await runLebop(
        ["diff", "NOX-1", "--team", "NOX"],
        { LEBOP_HOME: home, LEBOP_API_URL: mock.url },
        cwd,
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("local matches remote");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("matching cache vs remote: --json mode exits 0 with clean envelope", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = await makeAuthFile("lin_api_test_diff_match_json");
    const cwd = await mkdtemp(join(tmpdir(), "lebop-diff-cwd-"));

    try {
      await writeIssueCache(
        home,
        {
          title: "Test issue",
          state: "Backlog",
          priority: 2,
          _server: { updated_at: "2026-05-01T00:00:01.000Z", state_name: "Backlog" },
        },
        "Original description.",
      );
      mock.respond(mockIssueResponse());

      const r = await runLebop(
        ["diff", "NOX-1", "--team", "NOX", "--json"],
        { LEBOP_HOME: home, LEBOP_API_URL: mock.url },
        cwd,
      );
      expect(r.exitCode).toBe(0);
      const body = JSON.parse(r.stdout) as {
        schema_version: number;
        fields: unknown[];
        description_changed: boolean;
      };
      expect(body.schema_version).toBe(1);
      expect(body.fields).toEqual([]);
      expect(body.description_changed).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("drifted cache: human mode exits 1 + emits patch", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = await makeAuthFile("lin_api_test_diff_drift");
    const cwd = await mkdtemp(join(tmpdir(), "lebop-diff-cwd-"));

    try {
      // Local description differs from remote → drift expected.
      await writeIssueCache(
        home,
        {
          title: "Test issue",
          state: "Backlog",
          priority: 2,
          _server: { updated_at: "2026-05-01T00:00:01.000Z", state_name: "Backlog" },
        },
        "Locally edited description.",
      );
      mock.respond(mockIssueResponse({ description: "Original description." }));

      const r = await runLebop(
        ["diff", "NOX-1", "--team", "NOX"],
        { LEBOP_HOME: home, LEBOP_API_URL: mock.url },
        cwd,
      );
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("(local → remote drift)");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("drifted cache: --json mode exits 1 (round-5-followup regression lock)", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = await makeAuthFile("lin_api_test_diff_drift_json");
    const cwd = await mkdtemp(join(tmpdir(), "lebop-diff-cwd-"));

    try {
      // The bug this test locks: pre-round-5-followup, `--json` returned
      // before `process.exitCode = 1` was set, so CI gates piping
      // `lebop diff --json | jq …` saw exit 0 on drift. The fix moved
      // exit-code assignment ABOVE the json branch.
      await writeIssueCache(
        home,
        {
          title: "Test issue",
          state: "Backlog",
          priority: 2,
          _server: { updated_at: "2026-05-01T00:00:01.000Z", state_name: "Backlog" },
        },
        "Locally edited description.",
      );
      mock.respond(mockIssueResponse({ description: "Original description." }));

      const r = await runLebop(
        ["diff", "NOX-1", "--team", "NOX", "--json"],
        { LEBOP_HOME: home, LEBOP_API_URL: mock.url },
        cwd,
      );
      expect(r.exitCode).toBe(1);
      const body = JSON.parse(r.stdout) as {
        description_changed: boolean;
        description_patch: string | null;
      };
      expect(body.description_changed).toBe(true);
      expect(body.description_patch).toBeTruthy();
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
