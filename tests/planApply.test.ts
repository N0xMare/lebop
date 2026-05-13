import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
}

let state: MockState = {
  rawByQuery: new Map(),
  issuesById: new Map(),
  rawCalls: [],
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

import { applyPlan } from "../src/lib/planApply.ts";
import { parsePlan } from "../src/lib/planParse.ts";

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

function queueRaw(needle: string, response: { data: unknown }): void {
  if (!state.rawByQuery.has(needle)) state.rawByQuery.set(needle, []);
  state.rawByQuery.get(needle)?.push(response);
}

function projectReadResponse(linearId: string, name: string, body: string) {
  return {
    data: {
      project: {
        id: linearId,
        name,
        description: "",
        content: body,
        state: "planned",
        url: `https://linear.app/p/${linearId}`,
        updatedAt: "2026-01-01T00:00:00Z",
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
        updatedAt: "2026-01-01T00:00:00Z",
        state: { id: "state-backlog", name: args.stateName ?? "Backlog", type: "backlog" },
        assignee: null,
        project: { id: "proj-uuid", name: "Test" },
        team: { id: "team-uuid", key: "UE" },
        parent: null,
        labels: { nodes: [] },
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
        },
        inverseRelations: {
          nodes: inbound.map((r) => ({
            id: r.id,
            type: r.type,
            issue: { id: `uuid-${r.sourceIdentifier}`, identifier: r.sourceIdentifier },
          })),
        },
      },
    },
  };
}

// ---------- tests ----------

describe("applyPlan: relation idempotency reporting (P0 #4)", () => {
  let dir: string | null = null;

  beforeEach(() => {
    state = { rawByQuery: new Map(), issuesById: new Map(), rawCalls: [] };
    // Pre-seed identifier → UUID for `c.issue()` lookups used by the relation
    // resolver pre-pass. Both members of the relation are needed.
    state.issuesById.set("UE-100", { id: "uuid-UE-100" });
    state.issuesById.set("UE-200", { id: "uuid-UE-200" });
  });

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it("reports `created` on first plan_apply when relation is absent on remote", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\nlinear_id: proj-uuid\n---\n", // body intentionally blank
      "01-first.md": "---\ntitle: First\nlinear_id: UE-100\nblocks:\n  - UE-200\n---\n",
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
    // listRelations for UE-100: empty (relation not yet created).
    queueRaw("FindRelation", relationsReadResponse([], []));
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
      "01-first.md": "---\ntitle: First\nlinear_id: UE-100\nblocks:\n  - UE-200\n---\n",
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
    // listRelations for UE-100: relation already exists (outbound `blocks → UE-200`).
    queueRaw(
      "FindRelation",
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
      "01-first.md": "---\ntitle: First\nlinear_id: UE-100\nblocked_by:\n  - UE-200\n---\n",
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
    queueRaw(
      "FindRelation",
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
});
