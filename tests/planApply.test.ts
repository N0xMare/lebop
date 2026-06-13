import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------- mock SDK boundary ----------
//
// Tests for `applyPlan`'s relation reporting layer. P0 fix: re-applying a plan
// against a Linear workspace that already has the declared relations must
// report `status: "unchanged"` (not `"created"`) because `issueRelationCreate`
// is server-side idempotent. The fix pre-fetches each source issue's existing
// relations via `listRelations` and uses that to decide create-vs-unchanged.
//
// We mock at the SDK boundary (matching `tests/issues.test.ts`). The mock
// queue is a hybrid: GraphQL responses are matched by a substring of the
// query, and `c.issue(id)` lookups go through a separate stub map. This lets
// us drive a full `applyPlan` invocation without coupling the test to call
// order across heterogeneous request types.

interface MockState {
  rawByQuery: Map<string, Array<{ data: unknown }>>;
  issuesById: Map<string, { id: string }>;
  rawCalls: Array<{ query: string; variables: unknown }>;
  viewer: { id: string };
}

let state: MockState = {
  rawByQuery: new Map(),
  issuesById: new Map(),
  rawCalls: [],
  viewer: { id: "viewer-id" },
};

function pickRawResponse(query: string): { data: unknown } {
  for (const [needle, queue] of state.rawByQuery.entries()) {
    if (query.includes(needle) && queue.length > 0) {
      const next = queue.shift();
      if (next) return next;
    }
  }
  throw new Error(`mock exhausted for query: ${query.slice(0, 80).replace(/\s+/g, " ")}...`);
}

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      viewer: state.viewer,
      issue: async (id: string) => state.issuesById.get(id) ?? null,
      client: {
        rawRequest: async (query: string, variables: unknown) => {
          state.rawCalls.push({ query, variables });
          return pickRawResponse(query);
        },
      },
    }),
  linear: async () => ({
    client: {
      rawRequest: async (query: string, variables: unknown) => {
        state.rawCalls.push({ query, variables });
        return pickRawResponse(query);
      },
    },
  }),
}));

import { applyPlan, preflightPlanApply } from "../src/lib/planApply.ts";
import { diffPlan } from "../src/lib/planDiff.ts";
import { parsePlan } from "../src/lib/planParse.ts";
import { pullPlan } from "../src/lib/planPull.ts";

// ---------- helpers ----------

function writePlanDir(contents: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lebop-planapply-test-"));
  for (const [name, content] of Object.entries(contents)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

const TEAM_METADATA = {
  team_id: "team-uuid",
  team_key: "UE",
  fetched_at: new Date().toISOString(),
  states: [{ id: "state-backlog", name: "Backlog", type: "backlog" }],
  labels: [],
  members: [],
  projects: [],
};

const TEAM_METADATA_WITH_MEMBER = {
  ...TEAM_METADATA,
  members: [{ id: "user-alice", name: "Alice Example", email: "alice@example.com" }],
};

function queueRaw(needle: string, response: { data: unknown }): void {
  if (!state.rawByQuery.has(needle)) state.rawByQuery.set(needle, []);
  state.rawByQuery.get(needle)?.push(response);
}

function projectReadResponse(
  linearId: string,
  name: string,
  body: string,
  icon: string | null = null,
  updatedAt = "2026-01-01T00:00:00Z",
  startDate: string | null = null,
  targetDate: string | null = null,
) {
  return {
    data: {
      project: {
        id: linearId,
        name,
        description: "",
        content: body,
        icon,
        state: "planned",
        startDate,
        targetDate,
        url: `https://linear.app/p/${linearId}`,
        updatedAt,
      },
    },
  };
}

function issueReadResponse(args: {
  uuid: string;
  identifier: string;
  title: string;
  body: string;
  stateName?: string;
  updatedAt?: string;
  assignee?: { id: string; name: string; email: string } | null;
  labels?: { id: string; name: string }[];
}) {
  return {
    data: {
      a0: {
        id: args.uuid,
        identifier: args.identifier,
        title: args.title,
        description: args.body,
        priority: 0,
        estimate: null,
        url: `https://linear.app/i/${args.identifier}`,
        updatedAt: args.updatedAt ?? "2026-01-01T00:00:00Z",
        state: { id: "state-backlog", name: args.stateName ?? "Backlog", type: "backlog" },
        assignee: args.assignee ?? null,
        project: { id: "proj-uuid", name: "Test" },
        team: { id: "team-uuid", key: "UE" },
        parent: null,
        labels: { nodes: args.labels ?? [] },
      },
    },
  };
}

function relationsReadResponse(
  outbound: { id: string; type: "blocks" | "duplicate" | "related"; targetIdentifier: string }[],
  inbound: { id: string; type: "blocks" | "duplicate" | "related"; sourceIdentifier: string }[],
) {
  return {
    data: {
      issue: {
        relations: {
          nodes: outbound.map((r) => ({
            id: r.id,
            type: r.type,
            relatedIssue: { id: `uuid-${r.targetIdentifier}`, identifier: r.targetIdentifier },
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
        inverseRelations: {
          nodes: inbound.map((r) => ({
            id: r.id,
            type: r.type,
            issue: { id: `uuid-${r.sourceIdentifier}`, identifier: r.sourceIdentifier },
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  };
}

function issueUpdatedAtResponse(identifier: string, updatedAt = "2026-01-01T00:00:00Z") {
  return { data: { issue: { identifier, updatedAt } } };
}

// ---------- tests ----------

describe("applyPlan: relation idempotency reporting (P0 #4)", () => {
  let dir: string | null = null;
  let prevBun: unknown;

  beforeEach(() => {
    state = {
      rawByQuery: new Map(),
      issuesById: new Map(),
      rawCalls: [],
      viewer: { id: "viewer-id" },
    };
    // Pre-seed identifier → UUID for `c.issue()` lookups used by the relation
    // resolver pre-pass. Both members of the relation are needed.
    state.issuesById.set("UE-100", { id: "uuid-UE-100" });
    state.issuesById.set("UE-200", { id: "uuid-UE-200" });
    prevBun = (globalThis as { Bun?: unknown }).Bun;
    Object.defineProperty(globalThis, "Bun", {
      value: {
        write: async (path: string, content: string) => {
          writeFileSync(path, content);
        },
      },
      configurable: true,
    });
  });

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
    Object.defineProperty(globalThis, "Bun", { value: prevBun, configurable: true });
  });

  it("reports `created` on first plan_apply when relation is absent on remote", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n", // body intentionally blank
      "01-first.md":
        "---\ntitle: First\nlinear_id: UE-100\n_server:\n  updated_at: 2026-01-01T00:00:00Z\nblocks:\n  - UE-200\n---\n",
      "02-second.md": "---\ntitle: Second\nlinear_id: UE-200\n---\n",
    });

    // Project read → matches local (unchanged).
    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    // Issue reads for each issue's UPDATE path (both match remote → unchanged).
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-100", identifier: "UE-100", title: "First", body: "" }),
    );
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-200", identifier: "UE-200", title: "Second", body: "" }),
    );
    queueRaw("PlanApplyIssueUpdatedAt", issueUpdatedAtResponse("UE-100"));
    // listRelations for UE-100: empty (relation not yet created).
    queueRaw("ListRelations", relationsReadResponse([], []));
    // createLink response (issueRelationCreate).
    queueRaw("CreateRelation", {
      data: { issueRelationCreate: { success: true, issueRelation: { id: "rel-new-1" } } },
    });

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]).toMatchObject({
      fromIdentifier: "UE-100",
      toIdentifier: "UE-200",
      kind: "blocks",
      status: "created",
    });
    // Sanity check: the CreateRelation mutation actually fired.
    expect(state.rawCalls.some((c) => c.query.includes("issueRelationCreate"))).toBe(true);
  });

  it("reports `unchanged` on re-apply when relation already exists on remote", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-first.md":
        "---\ntitle: First\nlinear_id: UE-100\n_server:\n  updated_at: 2026-01-01T00:00:00Z\nblocks:\n  - UE-200\n---\n",
      "02-second.md": "---\ntitle: Second\nlinear_id: UE-200\n---\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-100", identifier: "UE-100", title: "First", body: "" }),
    );
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-200", identifier: "UE-200", title: "Second", body: "" }),
    );
    queueRaw("PlanApplyIssueUpdatedAt", issueUpdatedAtResponse("UE-100"));
    // listRelations for UE-100: relation already exists (outbound `blocks → UE-200`).
    queueRaw(
      "ListRelations",
      relationsReadResponse(
        [{ id: "rel-existing", type: "blocks", targetIdentifier: "UE-200" }],
        [],
      ),
    );
    // Note: NO CreateRelation queued — re-apply must not fire that mutation.

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]).toMatchObject({
      fromIdentifier: "UE-100",
      toIdentifier: "UE-200",
      kind: "blocks",
      status: "unchanged",
    });
    expect(result.relations[0]?.error).toBeUndefined();
    // Regression guard: issueRelationCreate must NOT be called when the
    // relation is already known to exist on remote.
    expect(state.rawCalls.some((c) => c.query.includes("issueRelationCreate"))).toBe(false);
  });

  it("detects existing inverse-direction relations (`blocked_by` finds inbound)", async () => {
    // When the plan declares `A blocked_by: [B]`, the API stores it as
    // `issueRelationCreate(type=blocks, issueId=B, relatedIssueId=A)`. From
    // A's perspective that surfaces as an INBOUND edge, not outbound.
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-first.md":
        "---\ntitle: First\nlinear_id: UE-100\n_server:\n  updated_at: 2026-01-01T00:00:00Z\nblocked_by:\n  - UE-200\n---\n",
      "02-second.md": "---\ntitle: Second\nlinear_id: UE-200\n---\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw("PlanApplyIssueUpdatedAt", issueUpdatedAtResponse("UE-100"));
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-100", identifier: "UE-100", title: "First", body: "" }),
    );
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-200", identifier: "UE-200", title: "Second", body: "" }),
    );
    queueRaw(
      "ListRelations",
      relationsReadResponse(
        [],
        [{ id: "rel-existing", type: "blocks", sourceIdentifier: "UE-200" }],
      ),
    );

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]).toMatchObject({
      kind: "blocked_by",
      status: "unchanged",
    });
    expect(state.rawCalls.some((c) => c.query.includes("issueRelationCreate"))).toBe(false);
  });

  it("round-trips existing duplicate relations as unchanged", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-first.md":
        "---\ntitle: First\nlinear_id: UE-100\n_server:\n  updated_at: 2026-01-01T00:00:00Z\nduplicates:\n  - UE-200\n---\n",
      "02-second.md": "---\ntitle: Second\nlinear_id: UE-200\n---\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw("PlanApplyIssueUpdatedAt", issueUpdatedAtResponse("UE-100"));
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-100", identifier: "UE-100", title: "First", body: "" }),
    );
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-200", identifier: "UE-200", title: "Second", body: "" }),
    );
    queueRaw(
      "ListRelations",
      relationsReadResponse(
        [{ id: "rel-duplicate", type: "duplicate", targetIdentifier: "UE-200" }],
        [],
      ),
    );

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]).toMatchObject({
      fromIdentifier: "UE-100",
      toIdentifier: "UE-200",
      kind: "duplicates",
      status: "unchanged",
    });
    expect(state.rawCalls.some((c) => c.query.includes("issueRelationCreate"))).toBe(false);
  });

  it("blocks new duplicate relation creation without mutating", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-first.md":
        "---\ntitle: First\nlinear_id: UE-100\n_server:\n  updated_at: 2026-01-01T00:00:00Z\nduplicates:\n  - UE-200\n---\n",
      "02-second.md": "---\ntitle: Second\nlinear_id: UE-200\n---\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw("PlanApplyIssueUpdatedAt", issueUpdatedAtResponse("UE-100"));
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-100", identifier: "UE-100", title: "First", body: "" }),
    );
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-200", identifier: "UE-200", title: "Second", body: "" }),
    );
    queueRaw("ListRelations", relationsReadResponse([], []));

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.relations).toEqual([
      expect.objectContaining({
        fromIdentifier: "UE-100",
        toIdentifier: "UE-200",
        kind: "duplicates",
        status: "error",
        error: expect.stringContaining("Duplicate state"),
      }),
    ]);
    expect(state.rawCalls.some((c) => c.query.includes("issueRelationCreate"))).toBe(false);
  });

  it("blocks relation-only direct apply when the issue CAS snapshot is stale", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-first.md":
        "---\ntitle: First\nlinear_id: UE-100\n_server:\n  updated_at: 2026-01-01T00:00:00Z\nblocks:\n  - UE-200\n---\n",
      "02-second.md": "---\ntitle: Second\nlinear_id: UE-200\n---\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-100", identifier: "UE-100", title: "First", body: "" }),
    );
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-200", identifier: "UE-200", title: "Second", body: "" }),
    );
    queueRaw("PlanApplyIssueUpdatedAt", issueUpdatedAtResponse("UE-100", "2026-01-02T00:00:00Z"));

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.relations).toEqual([
      expect.objectContaining({
        fromIdentifier: "UE-100",
        toIdentifier: "UE-200",
        kind: "blocks",
        status: "error",
        error: expect.stringContaining("changed on Linear after plan snapshot"),
      }),
    ]);
    expect(state.rawCalls.some((c) => c.query.includes("issueRelationCreate"))).toBe(false);
    expect(state.rawCalls.some((c) => c.query.includes("ListRelations"))).toBe(false);
  });

  it("blocks dry-run relation changes when the source issue snapshot is stale", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-first.md":
        "---\ntitle: First\nlinear_id: UE-100\n_server:\n  updated_at: 2026-01-01T00:00:00Z\nblocks:\n  - UE-200\n---\n",
      "02-second.md": "---\ntitle: Second\nlinear_id: UE-200\n---\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-100", identifier: "UE-100", title: "First", body: "" }),
    );
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-200", identifier: "UE-200", title: "Second", body: "" }),
    );
    queueRaw("PlanApplyIssueUpdatedAt", issueUpdatedAtResponse("UE-100", "2026-01-02T00:00:00Z"));

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, { dryRun: true });

    expect(result.relations).toEqual([
      expect.objectContaining({
        fromIdentifier: "UE-100",
        toIdentifier: "UE-200",
        kind: "blocks",
        status: "error",
        error: expect.stringContaining("changed on Linear after plan snapshot"),
      }),
    ]);
    expect(state.rawCalls.some((c) => c.query.includes("issueRelationCreate"))).toBe(false);
    expect(state.rawCalls.some((c) => c.query.includes("ListRelations"))).toBe(false);
  });

  it("blocks relation creation when the local target issue snapshot is stale", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-first.md":
        "---\ntitle: First\nlinear_id: UE-100\n_server:\n  updated_at: 2026-01-01T00:00:00Z\nblocks:\n  - UE-200\n---\n",
      "02-second.md":
        "---\ntitle: Second\nlinear_id: UE-200\n_server:\n  updated_at: 2026-01-01T00:00:00Z\n---\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-100", identifier: "UE-100", title: "First", body: "" }),
    );
    queueRaw(
      "PullIssues",
      issueReadResponse({
        uuid: "uuid-UE-200",
        identifier: "UE-200",
        title: "Second",
        body: "",
        updatedAt: "2026-01-02T00:00:00Z",
      }),
    );
    queueRaw("PlanApplyIssueUpdatedAt", issueUpdatedAtResponse("UE-100"));
    queueRaw("ListRelations", relationsReadResponse([], []));
    queueRaw("PlanApplyIssueUpdatedAt", issueUpdatedAtResponse("UE-200", "2026-01-02T00:00:00Z"));

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.relations).toEqual([
      expect.objectContaining({
        fromIdentifier: "UE-100",
        toIdentifier: "UE-200",
        kind: "blocks",
        status: "error",
        error: expect.stringContaining("issue/UE-200 changed on Linear after plan snapshot"),
      }),
    ]);
    expect(state.rawCalls.some((c) => c.query.includes("issueRelationCreate"))).toBe(false);
  });

  it("does not mutate when relation prefetch fails", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-first.md":
        "---\ntitle: First\nlinear_id: UE-100\n_server:\n  updated_at: 2026-01-01T00:00:00Z\nblocks:\n  - UE-200\n---\n",
      "02-second.md": "---\ntitle: Second\nlinear_id: UE-200\n---\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-100", identifier: "UE-100", title: "First", body: "" }),
    );
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-200", identifier: "UE-200", title: "Second", body: "" }),
    );
    queueRaw("PlanApplyIssueUpdatedAt", issueUpdatedAtResponse("UE-100"));

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.relations[0]).toMatchObject({
      status: "error",
      error: expect.stringContaining("relation preflight failed"),
    });
    expect(state.rawCalls.some((c) => c.query.includes("issueRelationCreate"))).toBe(false);
  });

  it("emits relation error rows when source issue UUID resolution fails", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-first.md":
        "---\ntitle: First\nlinear_id: UE-100\n_server:\n  updated_at: 2026-01-01T00:00:00Z\nblocks:\n  - UE-200\n---\n",
      "02-second.md": "---\ntitle: Second\nlinear_id: UE-200\n---\n",
    });
    state.issuesById.delete("UE-100");

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-100", identifier: "UE-100", title: "First", body: "" }),
    );
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-200", identifier: "UE-200", title: "Second", body: "" }),
    );
    queueRaw("PlanApplyIssueUpdatedAt", issueUpdatedAtResponse("UE-100"));
    queueRaw("ListRelations", relationsReadResponse([], []));

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.relations).toEqual([
      expect.objectContaining({
        fromIdentifier: "UE-100",
        toIdentifier: "UE-200",
        kind: "blocks",
        status: "error",
        error: expect.stringContaining("source issue not resolved: UE-100"),
      }),
    ]);
    expect(state.rawCalls.some((c) => c.query.includes("issueRelationCreate"))).toBe(false);
  });

  it("blocks plan relation creation when it would replace a different same-pair relation", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-first.md":
        "---\ntitle: First\nlinear_id: UE-100\n_server:\n  updated_at: 2026-01-01T00:00:00Z\nblocks:\n  - UE-200\n---\n",
      "02-second.md": "---\ntitle: Second\nlinear_id: UE-200\n---\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-100", identifier: "UE-100", title: "First", body: "" }),
    );
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-200", identifier: "UE-200", title: "Second", body: "" }),
    );
    queueRaw("PlanApplyIssueUpdatedAt", issueUpdatedAtResponse("UE-100"));
    queueRaw(
      "ListRelations",
      relationsReadResponse(
        [{ id: "rel-related", type: "related", targetIdentifier: "UE-200" }],
        [],
      ),
    );

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.relations).toEqual([
      expect.objectContaining({
        fromIdentifier: "UE-100",
        toIdentifier: "UE-200",
        kind: "blocks",
        status: "error",
        error: expect.stringContaining("would replace existing pair relation"),
      }),
    ]);
    expect(state.rawCalls.some((c) => c.query.includes("issueRelationCreate"))).toBe(false);
  });

  it("updates project icon from _project.md frontmatter", async () => {
    dir = writePlanDir({
      "_project.md":
        "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\nicon: Rocket\n_server:\n  updated_at: 2026-01-01T00:00:00Z\n---\nProject body\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", "Project body", null));
    queueRaw("ProjectUpdate", {
      data: {
        projectUpdate: {
          success: true,
          project: {
            id: "proj-uuid",
            name: "Test",
            description: "",
            content: "Project body",
            icon: "Rocket",
            state: "planned",
            url: "https://linear.app/p/proj-uuid",
            updatedAt: "2026-01-01T00:00:01Z",
          },
        },
      },
    });

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.project.status).toBe("updated");
    const updateCall = state.rawCalls.find((c) => c.query.includes("projectUpdate"));
    expect(updateCall?.variables).toMatchObject({
      id: "proj-uuid",
      input: { icon: "Rocket" },
    });
  });

  it("updates project dates from _project.md frontmatter", async () => {
    dir = writePlanDir({
      "_project.md":
        "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\nstart_date: 2026-06-01\ntarget_date: null\n_server:\n  updated_at: 2026-01-01T00:00:00Z\n---\nProject body\n",
    });

    queueRaw(
      "ReadProject",
      projectReadResponse(
        "proj-uuid",
        "Test",
        "Project body",
        null,
        "2026-01-01T00:00:00Z",
        null,
        "2026-06-30",
      ),
    );
    queueRaw("ProjectUpdate", {
      data: {
        projectUpdate: {
          success: true,
          project: {
            id: "proj-uuid",
            name: "Test",
            description: "",
            content: "Project body",
            icon: null,
            state: "planned",
            startDate: "2026-06-01",
            targetDate: null,
            url: "https://linear.app/p/proj-uuid",
            updatedAt: "2026-01-01T00:00:01Z",
          },
        },
      },
    });

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.project.status).toBe("updated");
    const updateCall = state.rawCalls.find((c) => c.query.includes("projectUpdate"));
    expect(updateCall?.variables).toMatchObject({
      id: "proj-uuid",
      input: { startDate: "2026-06-01", targetDate: null },
    });
    const written = readFileSync(join(dir, "_project.md"), "utf8");
    expect(written).toContain("start_date: 2026-06-01");
    expect(written).toContain("target_date: null");
  });

  it("reports updated project id when local project update writeback fails", async () => {
    dir = writePlanDir({
      "_project.md":
        "---\nname: Renamed\nteam: UE\nlinear_id: proj-uuid\n_server:\n  updated_at: 2026-01-01T00:00:00Z\n---\nProject body\n",
      "01-child.md": "---\ntitle: Child\n---\n",
    });
    Object.defineProperty(globalThis, "Bun", {
      value: {
        write: async () => {
          throw new Error("disk full");
        },
      },
      configurable: true,
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Original", "Project body"));
    queueRaw("ProjectUpdate", {
      data: {
        projectUpdate: {
          success: true,
          project: {
            id: "proj-uuid",
            name: "Renamed",
            description: "",
            content: "Project body",
            icon: null,
            state: "planned",
            url: "https://linear.app/p/proj-uuid",
            updatedAt: "2026-01-01T00:00:01Z",
          },
        },
      },
    });

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.project).toMatchObject({
      status: "updated-writeback-failed",
      linearId: "proj-uuid",
      error: expect.stringContaining("updated in Linear but local writeback failed"),
    });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      slug: "01-child",
      status: "error",
      error: expect.stringContaining("skipped because project apply failed"),
    });
    expect(state.rawCalls.some((c) => c.query.includes("issueCreate"))).toBe(false);
  });

  it("blocks direct project updates when the plan has no CAS snapshot", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Renamed\nteam: UE\nlinear_id: proj-uuid\n---\nProject body\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Original", "Project body"));

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.project).toMatchObject({
      status: "error",
      error: expect.stringContaining("missing plan _server.updated_at"),
    });
    expect(state.rawCalls.some((c) => c.query.includes("projectUpdate"))).toBe(false);
  });

  it("blocks dry-run project updates when the plan snapshot is stale", async () => {
    dir = writePlanDir({
      "_project.md":
        "---\nname: Renamed\nteam: UE\nlinear_id: proj-uuid\n_server:\n  updated_at: 2026-01-01T00:00:00Z\n---\nProject body\n",
      "01-child.md": "---\ntitle: Child\n---\n",
    });

    queueRaw(
      "ReadProject",
      projectReadResponse("proj-uuid", "Original", "Project body", null, "2026-01-02T00:00:00Z"),
    );

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, { dryRun: true });

    expect(result.project).toMatchObject({
      status: "error",
      error: expect.stringContaining("changed on Linear after plan snapshot"),
    });
    expect(result.issues[0]).toMatchObject({
      slug: "01-child",
      status: "error",
      error: expect.stringContaining("skipped because project apply failed"),
    });
    expect(state.rawCalls.some((c) => c.query.includes("projectUpdate"))).toBe(false);
    expect(state.rawCalls.some((c) => c.query.includes("issueCreate"))).toBe(false);
  });

  it("blocks direct issue updates when Linear changed after the plan snapshot", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-child.md":
        "---\ntitle: Local title\nlinear_id: UE-100\n_server:\n  updated_at: 2026-01-01T00:00:00Z\n---\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({
        uuid: "uuid-UE-100",
        identifier: "UE-100",
        title: "Remote title",
        body: "",
        updatedAt: "2026-01-01T00:00:01Z",
      }),
    );

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.issues[0]).toMatchObject({
      status: "error",
      error: expect.stringContaining("changed on Linear after plan snapshot"),
    });
    expect(state.rawCalls.some((c) => c.query.includes("issueUpdate"))).toBe(false);
  });

  it("blocks dry-run issue updates when Linear changed after the plan snapshot", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-child.md":
        "---\ntitle: Local title\nlinear_id: UE-100\n_server:\n  updated_at: 2026-01-01T00:00:00Z\n---\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({
        uuid: "uuid-UE-100",
        identifier: "UE-100",
        title: "Remote title",
        body: "",
        updatedAt: "2026-01-01T00:00:01Z",
      }),
    );

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, { dryRun: true });

    expect(result.issues[0]).toMatchObject({
      status: "error",
      error: expect.stringContaining("changed on Linear after plan snapshot"),
    });
    expect(state.rawCalls.some((c) => c.query.includes("issueUpdate"))).toBe(false);
  });

  it("allows direct stale-snapshot plan updates with force", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-child.md":
        "---\ntitle: Local title\nlinear_id: UE-100\n_server:\n  updated_at: 2026-01-01T00:00:00Z\n---\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({
        uuid: "uuid-UE-100",
        identifier: "UE-100",
        title: "Remote title",
        body: "",
        updatedAt: "2026-01-01T00:00:01Z",
      }),
    );
    queueRaw("IssueUpdate", {
      data: {
        issueUpdate: {
          success: true,
          issue: {
            id: "uuid-UE-100",
            identifier: "UE-100",
            title: "Local title",
            description: "",
            priority: 0,
            estimate: null,
            url: "https://linear.app/i/UE-100",
            updatedAt: "2026-01-01T00:00:02Z",
            state: { id: "state-backlog", name: "Backlog", type: "backlog" },
            assignee: null,
            project: { id: "proj-uuid", name: "Test" },
            team: { id: "team-uuid", key: "UE" },
            parent: null,
            labels: { nodes: [] },
          },
        },
      },
    });

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, { force: true });

    expect(result.issues[0]).toMatchObject({ status: "updated", fields: ["title"] });
    expect(state.rawCalls.some((c) => c.query.includes("issueUpdate"))).toBe(true);
  });

  it("writes back server-stable assignee email after applying an assignee name", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-child.md":
        "---\ntitle: Child\nlinear_id: UE-100\nassignee: Alice Example\n_server:\n  updated_at: 2026-01-01T00:00:00Z\n---\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-100", identifier: "UE-100", title: "Child", body: "" }),
    );
    queueRaw("IssueUpdate", {
      data: {
        issueUpdate: {
          success: true,
          issue: {
            id: "uuid-UE-100",
            identifier: "UE-100",
            title: "Child",
            description: "",
            priority: 0,
            estimate: null,
            url: "https://linear.app/i/UE-100",
            updatedAt: "2026-01-01T00:00:01Z",
            state: { id: "state-backlog", name: "Backlog", type: "backlog" },
            assignee: {
              id: "user-alice",
              name: "Alice Example",
              email: "alice@example.com",
            },
            project: { id: "proj-uuid", name: "Test" },
            team: { id: "team-uuid", key: "UE" },
            parent: null,
            labels: { nodes: [] },
          },
        },
      },
    });

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA_WITH_MEMBER, {});

    expect(result.issues[0]).toMatchObject({ status: "updated", fields: ["assignee"] });
    const written = readFileSync(join(dir, "01-child.md"), "utf8");
    expect(written).toContain("assignee: alice@example.com");
    expect(written).not.toContain("assignee: Alice Example");
  });

  it("reports updated issue identifier when local issue update writeback fails", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-child.md":
        "---\ntitle: Local title\nlinear_id: UE-100\n_server:\n  updated_at: 2026-01-01T00:00:00Z\n---\n",
    });
    Object.defineProperty(globalThis, "Bun", {
      value: {
        write: async () => {
          throw new Error("readonly filesystem");
        },
      },
      configurable: true,
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({
        uuid: "uuid-UE-100",
        identifier: "UE-100",
        title: "Remote title",
        body: "",
      }),
    );
    queueRaw("IssueUpdate", {
      data: {
        issueUpdate: {
          success: true,
          issue: {
            id: "uuid-UE-100",
            identifier: "UE-100",
            title: "Local title",
            description: "",
            priority: 0,
            estimate: null,
            url: "https://linear.app/i/UE-100",
            updatedAt: "2026-01-01T00:00:01Z",
            state: { id: "state-backlog", name: "Backlog", type: "backlog" },
            assignee: null,
            project: { id: "proj-uuid", name: "Test" },
            team: { id: "team-uuid", key: "UE" },
            parent: null,
            labels: { nodes: [] },
          },
        },
      },
    });

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.issues[0]).toMatchObject({
      status: "updated-writeback-failed",
      linearId: "UE-100",
      fields: ["title"],
      error: expect.stringContaining("updated in Linear but local writeback failed"),
    });
  });

  it("stops remaining issue and relation writes after local issue update writeback fails", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-first.md":
        "---\ntitle: Local title\nlinear_id: UE-100\n_server:\n  updated_at: 2026-01-01T00:00:00Z\nblocks:\n  - UE-200\n---\n",
      "02-second.md": "---\ntitle: Second\nlinear_id: UE-200\n---\n",
    });
    Object.defineProperty(globalThis, "Bun", {
      value: {
        write: async () => {
          throw new Error("readonly filesystem");
        },
      },
      configurable: true,
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({
        uuid: "uuid-UE-100",
        identifier: "UE-100",
        title: "Remote title",
        body: "",
      }),
    );
    queueRaw("IssueUpdate", {
      data: {
        issueUpdate: {
          success: true,
          issue: {
            id: "uuid-UE-100",
            identifier: "UE-100",
            title: "Local title",
            description: "",
            priority: 0,
            estimate: null,
            url: "https://linear.app/i/UE-100",
            updatedAt: "2026-01-01T00:00:01Z",
            state: { id: "state-backlog", name: "Backlog", type: "backlog" },
            assignee: null,
            project: { id: "proj-uuid", name: "Test" },
            team: { id: "team-uuid", key: "UE" },
            parent: null,
            labels: { nodes: [] },
          },
        },
      },
    });

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]).toMatchObject({ status: "updated-writeback-failed" });
    expect(result.issues[1]).toMatchObject({
      slug: "02-second",
      status: "error",
      error: expect.stringContaining("skipped because issue writeback failed"),
    });
    expect(result.relations).toEqual([]);
    expect(state.rawCalls.filter((c) => c.query.includes("PullIssues"))).toHaveLength(1);
    expect(state.rawCalls.some((c) => c.query.includes("issueRelationCreate"))).toBe(false);
  });

  it("returns a structured result when link slug rewrite writeback fails", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-first.md":
        "---\ntitle: First\nlinear_id: UE-100\n_server:\n  updated_at: 2026-01-01T00:00:00Z\nblocks:\n  - 02-second\n---\n",
      "02-second.md":
        "---\ntitle: Second\nlinear_id: UE-200\n_server:\n  updated_at: 2026-01-01T00:00:00Z\n---\n",
    });
    Object.defineProperty(globalThis, "Bun", {
      value: {
        write: async () => {
          throw new Error("readonly filesystem");
        },
      },
      configurable: true,
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({
        uuid: "uuid-UE-100",
        identifier: "UE-100",
        title: "First",
        body: "",
      }),
    );
    queueRaw(
      "PullIssues",
      issueReadResponse({
        uuid: "uuid-UE-200",
        identifier: "UE-200",
        title: "Second",
        body: "",
      }),
    );

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]).toMatchObject({
      slug: "01-first",
      status: "error",
      error: expect.stringContaining("local link slug rewrite failed"),
    });
    expect(result.issues[1]).toMatchObject({ slug: "02-second", status: "unchanged" });
    expect(result.relations).toEqual([]);
    expect(state.rawCalls.some((c) => c.query.includes("issueRelationCreate"))).toBe(false);
  });

  it("skips issue and relation writes when project apply fails", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Missing Project\nteam: UE\nlinear_id: missing-proj\n---\n",
      "01-child.md": "---\ntitle: Child\n---\n",
    });

    queueRaw("ReadProject", { data: { project: null } });

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.project).toMatchObject({
      status: "error",
      error: "project not found: missing-proj",
    });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      slug: "01-child",
      status: "error",
      error: expect.stringContaining("skipped because project apply failed"),
    });
    expect(result.relations).toEqual([]);
    expect(state.rawCalls.some((c) => c.query.includes("issueCreate"))).toBe(false);
    expect(state.rawCalls.some((c) => c.query.includes("issueUpdate"))).toBe(false);
  });

  it("treats projectUpdate success:false as an apply error before writeback", async () => {
    dir = writePlanDir({
      "_project.md":
        "---\nname: Renamed\nteam: UE\nlinear_id: proj-uuid\n_server:\n  updated_at: 2026-01-01T00:00:00Z\n---\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Original", ""));
    queueRaw("ProjectUpdate", {
      data: {
        projectUpdate: {
          success: false,
          project: {
            id: "proj-uuid",
            name: "Renamed",
            description: "",
            content: "",
            icon: null,
            state: "planned",
            url: "https://linear.app/p/proj-uuid",
            updatedAt: "2026-01-01T00:00:01Z",
          },
        },
      },
    });

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.project).toMatchObject({
      status: "error",
      error: "projectUpdate failed",
    });
  });

  it("treats issueUpdate success:false as an apply error before writeback", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-child.md":
        "---\ntitle: Local title\nlinear_id: UE-100\n_server:\n  updated_at: 2026-01-01T00:00:00Z\n---\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({
        uuid: "uuid-UE-100",
        identifier: "UE-100",
        title: "Remote title",
        body: "",
      }),
    );
    queueRaw("IssueUpdate", {
      data: {
        issueUpdate: {
          success: false,
          issue: {
            id: "uuid-UE-100",
            identifier: "UE-100",
            title: "Local title",
            description: "",
            priority: 0,
            estimate: null,
            url: "https://linear.app/i/UE-100",
            updatedAt: "2026-01-01T00:00:00Z",
            state: { id: "state-backlog", name: "Backlog", type: "backlog" },
            assignee: null,
            project: { id: "proj-uuid", name: "Test" },
            team: { id: "team-uuid", key: "UE" },
            parent: null,
            labels: { nodes: [] },
          },
        },
      },
    });

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.issues[0]).toMatchObject({
      status: "error",
      error: "issueUpdate failed",
    });
  });

  it("fails issue creation before mutation when parent cannot be resolved", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-child.md": "---\ntitle: Child\nparent: UE-404\n---\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      slug: "01-child",
      status: "error",
      error: "parent not found: UE-404",
    });
    expect(state.rawCalls.some((c) => c.query.includes("issueCreate"))).toBe(false);
  });

  it("fails dry-run issue creation when an external parent cannot be resolved", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-child.md": "---\ntitle: Child\nparent: UE-404\n---\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, { dryRun: true });

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      slug: "01-child",
      status: "error",
      error: "parent not found: UE-404",
    });
    expect(state.rawCalls.some((c) => c.query.includes("issueCreate"))).toBe(false);
  });

  it("allows dry-run issue creation for all-new local parent chains", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-parent.md": "---\ntitle: Parent\n---\n",
      "02-child.md": "---\ntitle: Child\nparent: 01-parent\n---\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, { dryRun: true });

    expect(result.issues).toEqual([
      expect.objectContaining({ slug: "01-parent", status: "dry-run" }),
      expect.objectContaining({ slug: "02-child", status: "dry-run" }),
    ]);
    expect(state.rawCalls.some((c) => c.query.includes("issueCreate"))).toBe(false);
  });

  it("fails issue update before mutation when changed parent cannot be resolved", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-child.md": "---\ntitle: Child\nlinear_id: UE-100\nparent: UE-404\n---\n",
    });

    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-100", identifier: "UE-100", title: "Child", body: "" }),
    );

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      slug: "01-child",
      linearId: "UE-100",
      status: "error",
      error: "parent not found: UE-404",
    });
    expect(state.rawCalls.some((c) => c.query.includes("issueUpdate"))).toBe(false);
  });

  it("reports created project id when local project writeback fails", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: New Project\nteam: UE\n---\n",
      "01-child.md": "---\ntitle: Child\n---\n",
    });
    Object.defineProperty(globalThis, "Bun", {
      value: {
        write: async () => {
          throw new Error("disk full");
        },
      },
      configurable: true,
    });
    queueRaw("CreateProject", {
      data: {
        projectCreate: {
          success: true,
          project: {
            id: "created-project-uuid",
            name: "New Project",
            description: "",
            content: "",
            icon: null,
            state: "planned",
            url: "https://linear.app/p/created-project-uuid",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
      },
    });

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.project).toMatchObject({
      status: "created-writeback-failed",
      linearId: "created-project-uuid",
      error: expect.stringContaining("created in Linear but local writeback failed"),
    });
    expect(result.issues[0]).toMatchObject({
      status: "error",
      error: expect.stringContaining("skipped because project apply failed"),
    });
    expect(state.rawCalls.some((c) => c.query.includes("issueCreate"))).toBe(false);
  });

  it("reports created issue identifier when local issue writeback fails", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-child.md": "---\ntitle: Child\n---\n",
    });
    Object.defineProperty(globalThis, "Bun", {
      value: {
        write: async () => {
          throw new Error("readonly filesystem");
        },
      },
      configurable: true,
    });
    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw("CreateIssue", {
      data: {
        issueCreate: {
          success: true,
          issue: {
            id: "uuid-UE-300",
            identifier: "UE-300",
            title: "Child",
            description: "",
            priority: 0,
            estimate: null,
            url: "https://linear.app/i/UE-300",
            updatedAt: "2026-01-01T00:00:00Z",
            state: { id: "state-backlog", name: "Backlog", type: "backlog" },
            assignee: null,
            project: { id: "proj-uuid", name: "Test" },
            team: { id: "team-uuid", key: "UE" },
            parent: null,
            labels: { nodes: [] },
          },
        },
      },
    });

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.issues[0]).toMatchObject({
      status: "created-writeback-failed",
      linearId: "UE-300",
      error: expect.stringContaining("created in Linear but local writeback failed"),
    });
  });

  it("stops remaining issue and relation writes after local issue create writeback fails", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-first.md": "---\ntitle: First\nblocks:\n  - UE-200\n---\n",
      "02-second.md": "---\ntitle: Second\nlinear_id: UE-200\n---\n",
    });
    Object.defineProperty(globalThis, "Bun", {
      value: {
        write: async () => {
          throw new Error("readonly filesystem");
        },
      },
      configurable: true,
    });
    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw("CreateIssue", {
      data: {
        issueCreate: {
          success: true,
          issue: {
            id: "uuid-UE-301",
            identifier: "UE-301",
            title: "First",
            description: "",
            priority: 0,
            estimate: null,
            url: "https://linear.app/i/UE-301",
            updatedAt: "2026-01-01T00:00:00Z",
            state: { id: "state-backlog", name: "Backlog", type: "backlog" },
            assignee: null,
            project: { id: "proj-uuid", name: "Test" },
            team: { id: "team-uuid", key: "UE" },
            parent: null,
            labels: { nodes: [] },
          },
        },
      },
    });

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.issues[0]).toMatchObject({
      status: "created-writeback-failed",
      linearId: "UE-301",
    });
    expect(result.issues[1]).toMatchObject({
      slug: "02-second",
      status: "error",
      error: expect.stringContaining("skipped because issue writeback failed"),
    });
    expect(result.relations).toEqual([]);
    expect(state.rawCalls.some((c) => c.query.includes("issueRelationCreate"))).toBe(false);
  });

  it("preflights unresolved external parents and relation targets", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-child.md": "---\ntitle: Child\nparent: UE-404\nrelated:\n  - UE-405\n---\n",
    });

    const plan = await parsePlan(dir);
    const preflight = await preflightPlanApply(plan);

    expect(preflight.ready).toBe(false);
    expect(preflight.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining("parent not found: UE-404"),
        expect.stringContaining("related target not found: UE-405"),
      ]),
    );
  });

  it("treats relation create success:false as a relation error", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-first.md":
        "---\ntitle: First\nlinear_id: UE-100\n_server:\n  updated_at: 2026-01-01T00:00:00Z\nblocks:\n  - UE-200\n---\n",
      "02-second.md": "---\ntitle: Second\nlinear_id: UE-200\n---\n",
    });
    state.issuesById.set("UE-100", { id: "uuid-UE-100" });
    state.issuesById.set("UE-200", { id: "uuid-UE-200" });
    queueRaw("ReadProject", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-100", identifier: "UE-100", title: "First", body: "" }),
    );
    queueRaw(
      "PullIssues",
      issueReadResponse({ uuid: "uuid-UE-200", identifier: "UE-200", title: "Second", body: "" }),
    );
    queueRaw("PlanApplyIssueUpdatedAt", issueUpdatedAtResponse("UE-100"));
    queueRaw("ListRelations", relationsReadResponse([], []));
    queueRaw("IssueRelationCreate", {
      data: { issueRelationCreate: { success: false, issueRelation: { id: "rel-failed" } } },
    });

    const plan = await parsePlan(dir);
    const result = await applyPlan(plan, TEAM_METADATA, {});

    expect(result.relations[0]).toMatchObject({
      status: "error",
      error: "issueRelationCreate failed",
    });
  });

  it("does not report assignee drift when a plan name resolves to the remote assignee id", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-child.md": "---\ntitle: Child\nlinear_id: UE-100\nassignee: Alice Example\n---\n",
    });
    queueRaw("PullProjectHeader", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({
        uuid: "uuid-UE-100",
        identifier: "UE-100",
        title: "Child",
        body: "",
        assignee: { id: "user-alice", name: "Alice Example", email: "alice@example.com" },
      }),
    );
    queueRaw("ListRelations", relationsReadResponse([], []));
    queueRaw("PlanProjectIssues", {
      data: {
        project: {
          issues: {
            nodes: [{ identifier: "UE-100", title: "Child" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const plan = await parsePlan(dir);
    const result = await diffPlan(plan, TEAM_METADATA_WITH_MEMBER);

    expect(result.issues[0]).toMatchObject({ status: "unchanged", field_changes: [] });
    expect(result.has_drift).toBe(false);
  });

  it("reports project date drift in plan diffs", async () => {
    dir = writePlanDir({
      "_project.md":
        "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\nstart_date: 2026-06-01\ntarget_date: null\n---\n",
    });
    queueRaw(
      "PullProjectHeader",
      projectReadResponse(
        "proj-uuid",
        "Test",
        "",
        null,
        "2026-01-01T00:00:00Z",
        null,
        "2026-06-30",
      ),
    );
    queueRaw("PlanProjectIssues", {
      data: {
        project: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const plan = await parsePlan(dir);
    const result = await diffPlan(plan, TEAM_METADATA);

    expect(result.project.field_changes).toEqual(
      expect.arrayContaining([
        { field: "start_date", local: "2026-06-01", remote: null },
        { field: "target_date", local: null, remote: "2026-06-30" },
      ]),
    );
    expect(result.has_drift).toBe(true);
  });

  it("pulls project dates into _project.md", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
    });
    queueRaw(
      "PullProjectHeader",
      projectReadResponse(
        "proj-uuid",
        "Test",
        "",
        null,
        "2026-01-01T00:00:00Z",
        "2026-06-01",
        null,
      ),
    );
    queueRaw("PlanProjectIssues", {
      data: {
        project: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const plan = await parsePlan(dir);
    const result = await pullPlan(plan, TEAM_METADATA, {});

    expect(result.project.status).toBe("updated");
    const written = readFileSync(join(dir, "_project.md"), "utf8");
    expect(written).toContain("start_date: 2026-06-01");
    expect(written).toContain("target_date: null");
  });

  it("imports remote-only issues with non-empty identifier fallback slugs", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "ue-500.md": "---\ntitle: Local placeholder without remote id\n---\n",
    });
    queueRaw("PlanProjectIssues", {
      data: {
        project: {
          issues: {
            nodes: [{ identifier: "UE-500", title: "日本語" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
    queueRaw("PullProjectHeader", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({
        uuid: "uuid-UE-500",
        identifier: "UE-500",
        title: "日本語",
        body: "remote body",
      }),
    );
    queueRaw("ListRelations", relationsReadResponse([], []));

    const plan = await parsePlan(dir);
    const result = await pullPlan(plan, TEAM_METADATA, { includeNew: true });

    expect(result.new_imports).toEqual([
      {
        status: "imported",
        identifier: "UE-500",
        path: join(dir, "ue-500-2.md"),
        title: "日本語",
      },
    ]);
    expect(readFileSync(join(dir, "ue-500-2.md"), "utf8")).toContain("linear_id: UE-500");
    expect(readFileSync(join(dir, "ue-500-2.md"), "utf8")).toContain("remote body");
  });

  it("does not mutate parsed label arrays while computing plan diffs", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-child.md": "---\ntitle: Child\nlinear_id: UE-100\nlabels:\n  - zeta\n  - alpha\n---\n",
    });
    queueRaw("PullProjectHeader", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({
        uuid: "uuid-UE-100",
        identifier: "UE-100",
        title: "Child",
        body: "",
        labels: [{ id: "label-alpha", name: "alpha" }],
      }),
    );
    queueRaw("ListRelations", relationsReadResponse([], []));
    queueRaw("PlanProjectIssues", {
      data: {
        project: {
          issues: {
            nodes: [{ identifier: "UE-100", title: "Child" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const plan = await parsePlan(dir);
    const originalLabels = plan.issues[0]?.frontmatter.labels;
    expect(originalLabels).toEqual(["zeta", "alpha"]);
    const result = await diffPlan(plan, {
      ...TEAM_METADATA,
      labels: [
        { id: "label-alpha", name: "alpha" },
        { id: "label-zeta", name: "zeta" },
      ],
    });

    expect(result.issues[0]?.field_changes.find((field) => field.field === "labels")).toMatchObject(
      {
        local: ["alpha", "zeta"],
        remote: ["alpha"],
      },
    );
    expect(plan.issues[0]?.frontmatter.labels).toEqual(["zeta", "alpha"]);
  });

  it("does not report assignee drift when @me resolves to the remote assignee id", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-child.md": '---\ntitle: Child\nlinear_id: UE-100\nassignee: "@me"\n---\n',
    });
    state.viewer = { id: "user-alice" };
    queueRaw("PullProjectHeader", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw(
      "PullIssues",
      issueReadResponse({
        uuid: "uuid-UE-100",
        identifier: "UE-100",
        title: "Child",
        body: "",
        assignee: { id: "user-alice", name: "Alice Example", email: "alice@example.com" },
      }),
    );
    queueRaw("ListRelations", relationsReadResponse([], []));
    queueRaw("PlanProjectIssues", {
      data: {
        project: {
          issues: {
            nodes: [{ identifier: "UE-100", title: "Child" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const plan = await parsePlan(dir);
    const result = await diffPlan(plan, TEAM_METADATA_WITH_MEMBER);

    expect(result.issues[0]).toMatchObject({ status: "unchanged", field_changes: [] });
    expect(result.has_drift).toBe(false);
  });

  it("surfaces remote-only issue scan failures in plan diff", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
    });
    queueRaw("PullProjectHeader", projectReadResponse("proj-uuid", "Test", ""));

    const plan = await parsePlan(dir);
    const result = await diffPlan(plan, TEAM_METADATA);

    expect(result.has_drift).toBe(false);
    expect(result.has_blockers).toBe(false);
    expect(result.has_incomplete_scan).toBe(true);
    expect(result.extra_remote_issues_error).toMatch(/mock exhausted/);
  });

  it("marks missing remote projects as plan diff blockers", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
    });
    queueRaw("PullProjectHeader", { data: { project: null } });

    const plan = await parsePlan(dir);
    const result = await diffPlan(plan, TEAM_METADATA);

    expect(result.has_drift).toBe(false);
    expect(result.has_blockers).toBe(true);
    expect(result.has_incomplete_scan).toBe(false);
    expect(result.project.status).toBe("missing-remote");
  });

  it("marks missing remote issues as plan diff blockers", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
      "01-first.md": "---\ntitle: First\nlinear_id: UE-100\n---\n",
    });
    queueRaw("PullProjectHeader", projectReadResponse("proj-uuid", "Test", ""));
    queueRaw("PullIssues", { data: { a0: null } });
    queueRaw("PlanProjectIssues", {
      data: {
        project: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });

    const plan = await parsePlan(dir);
    const result = await diffPlan(plan, TEAM_METADATA);

    expect(result.has_drift).toBe(false);
    expect(result.has_blockers).toBe(true);
    expect(result.has_incomplete_scan).toBe(false);
    expect(result.issues[0]).toMatchObject({ linear_id: "UE-100", status: "missing-remote" });
  });

  it("surfaces remote-only issue scan failures in plan pull", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n",
    });
    queueRaw("PullProjectHeader", projectReadResponse("proj-uuid", "Test", ""));

    const plan = await parsePlan(dir);
    const result = await pullPlan(plan, TEAM_METADATA, { includeNew: true });

    expect(result.remote_scan_error).toMatch(/mock exhausted/);
    expect(result.project.status).toBe("error");
    expect(result.issues).toEqual([]);
  });
});
