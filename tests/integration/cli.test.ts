import { rm } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type MockServer, makeAuthFile, runLebop, startMockLinear } from "./harness.ts";

let mock: MockServer;
let lebopHome: string;
let env: Record<string, string>;

beforeAll(async () => {
  mock = await startMockLinear();
  lebopHome = await makeAuthFile("lin_api_test_integration");
  env = { LEBOP_HOME: lebopHome, LEBOP_API_URL: mock.url };
});

afterEach(() => {
  // Clear any queued mock responses + request log so tests are independent.
  // Without this, a test that queues N but consumes <N leaks the rest into
  // the next test.
  mock.reset();
});

afterAll(async () => {
  await mock.stop();
  await rm(lebopHome, { recursive: true, force: true });
});

describe("auth whoami", () => {
  it("prints cached viewer without hitting Linear", async () => {
    const r = await runLebop(["auth", "whoami"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Test Viewer");
    expect(r.stdout).toContain("viewer@example.com");
    expect(r.stdout).toContain("test-workspace");
  });

  it("--json emits structured envelope including workspace", async () => {
    const r = await runLebop(["auth", "whoami", "--json"], env);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.viewer.email).toBe("viewer@example.com");
    expect(parsed.workspace).toBe("test-workspace");
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
    expect(parsed.workspaces).toHaveLength(1);
    expect(parsed.workspaces[0].slug).toBe("test-workspace");
    expect(parsed.workspaces[0].is_default).toBe(true);
  });

  it("auth default (no arg) prints the current default slug", async () => {
    const r = await runLebop(["auth", "default"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("test-workspace");
  });

  it("auth token prints the token to stdout", async () => {
    const r = await runLebop(["auth", "token"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("lin_api_test_integration");
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
    const r = await runLebop(["--workspace", "test-workspace", "auth", "token"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("lin_api_test_integration");

    const bad = await runLebop(["--workspace", "no-such", "auth", "token"], env);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("error[auth_error]:");
    expect(bad.stderr).toContain("not configured");
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
});
