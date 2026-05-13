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

  it("auth set-default-team --json emits `team` (not `team_key`) — round-7 / HIGH-3", async () => {
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
    const r = await runLebop(["auth", "set-default-team", "test-workspace", "NOX", "--json"], env);
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
      ["initiative", "remove-project", INITIATIVE_UUID, PROJECT_UUID, "--json"],
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
      ["initiative", "remove-project", INITIATIVE_UUID, PROJECT_UUID, "--json"],
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
      ["initiative", "remove-project", INITIATIVE_UUID, PROJECT_UUID, "--json"],
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

    const r = await runLebop(["initiative", "remove-project", INITIATIVE_UUID, PROJECT_UUID], env);
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

  it("archive <name> resolves and emits success", async () => {
    mock.respond({
      data: {
        initiatives: { nodes: [{ id: INITIATIVE_UUID, name: "Roadmap H2" }] },
      },
    });
    mock.respond({ data: { initiativeArchive: { success: true } } });

    const r = await runLebop(["initiative", "archive", "Roadmap H2", "--json"], env);
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

  it("delete <id> without --yes exits 1 and prints a hint to stderr", async () => {
    // No mocks needed — the --yes gate fires before any Linear call.
    const r = await runLebop(["initiative", "delete", INITIATIVE_UUID, "--json"], env);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--yes");
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
