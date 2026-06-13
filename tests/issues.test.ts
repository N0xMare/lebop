import { describe, expect, it, vi } from "vitest";
import { NotFoundError, ValidationError } from "../src/lib/errors.ts";

let mockResponses: Array<{ data: unknown }> = [];
let calls: Array<{ query: string; variables: unknown }> = [];
let issueLookups: Array<string> = [];
let issueLookupOverride: ((id: string) => unknown) | null = null;
let rawRequestOverride: ((q: string, v: unknown) => Promise<unknown>) | null = null;
let projectResolveCalls: Array<{ nameOrId: string; opts: { teamKey?: string } | undefined }> = [];
let milestoneResolveCalls: Array<{
  nameOrId: string;
  opts: { projectId?: string | null } | undefined;
}> = [];
const stubIssue = (identifier: string) => ({ id: `uuid-of-${identifier}` });

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      issue: async (id: string) => {
        issueLookups.push(id);
        if (issueLookupOverride) return issueLookupOverride(id);
        return stubIssue(id);
      },
      // Round-7 / HIGH-1: viewer is resolved at the SDK boundary for
      // `@me`/`me` assignee tokens — provide a stub so tests that exercise
      // string-assignee paths don't crash on a missing field.
      get viewer() {
        return Promise.resolve({ id: "viewer-uuid", email: "test@example.com" });
      },
      client: {
        rawRequest: handleRawRequest,
      },
    }),
  linear: async () => ({
    client: {
      rawRequest: handleRawRequest,
    },
  }),
}));

/**
 * Mock router for `c.client.rawRequest`. The wave-3 lib refactor swapped
 * the SDK-typed `c.issue(id)` call for a hand-rolled `ResolveIssueId`
 * query; recognize that here so updateIssue's identifier-lookup step
 * doesn't consume a mock response queued for the downstream mutation.
 */
async function handleRawRequest(query: string, variables: unknown): Promise<unknown> {
  calls.push({ query, variables });
  if (rawRequestOverride) return rawRequestOverride(query, variables);
  if (query.includes("ResolveIssueId")) {
    const id = (variables as { id: string }).id;
    issueLookups.push(id);
    const override = issueLookupOverride ? issueLookupOverride(id) : stubIssue(id);
    return { data: { issue: override ?? null } };
  }
  const next = mockResponses.shift();
  if (!next) throw new Error(`mock exhausted: ${query.slice(0, 60)}...`);
  return next;
}

// Stub team-metadata helpers — createIssue / updateIssue route through them
// only when team / state / labels / assignee are set. Wave 3 added milestone
// + cycle resolvers; they're stubbed here in pass-through mode (UUIDs return
// as-is, names route through a minimal team-aware shim) so tests can swap
// behavior per-case.
vi.mock("../src/lib/resolve.ts", async () => {
  // Pull in the real ValidationError so deriveTeamFromIdentifiers' real
  // behavior (used by the round-6 C3 fix) can throw the same structured error
  // the lib expects.
  const errors =
    await vi.importActual<typeof import("../src/lib/errors.ts")>("../src/lib/errors.ts");
  class MockResolveError extends errors.ValidationError {}
  return {
    ResolveError: MockResolveError,
    withFreshMetadataOnMiss: async <T>(
      _fetcher: unknown,
      fn: (md: unknown) => Promise<T>,
    ): Promise<T> =>
      fn({ team_id: "team-uuid", projects: [], states: [], labels: [], members: [] }),
    getTeamMetadata: async () => ({ team_id: "team-uuid" }),
    resolveStateId: () => "state-uuid",
    resolveLabelIds: () => ["label-uuid"],
    resolveAssigneeId: async () => "assignee-uuid",
    resolvePriority: (v: unknown) => (typeof v === "number" ? v : 2),
    resolveMilestoneIdByName: async (
      nameOrId: string,
      opts?: { projectId?: string | null },
    ): Promise<string> => {
      milestoneResolveCalls.push({ nameOrId, opts });
      if (/^[0-9a-f-]{36}$/i.test(nameOrId)) return nameOrId;
      return `uuid-of-milestone-${nameOrId}`;
    },
    resolveProjectIdByName: async (
      nameOrId: string,
      opts?: { teamKey?: string },
    ): Promise<string> => {
      projectResolveCalls.push({ nameOrId, opts });
      if (/^[0-9a-f-]{36}$/i.test(nameOrId)) return nameOrId;
      if (nameOrId === "Ambiguous Project") {
        throw new MockResolveError(
          'ambiguous project name "Ambiguous Project" matches: Ambiguous Project (NOX), Ambiguous Project (ENG)',
          "pass an explicit team scope or the project UUID",
        );
      }
      if (nameOrId === "Missing In Team") {
        throw new MockResolveError(
          `project not found: Missing In Team (team ${opts?.teamKey ?? "UNKNOWN"})`,
          "verify the project name belongs to that team, or use the project UUID",
        );
      }
      return `uuid-of-project-${nameOrId}`;
    },
    resolveCycleIdByName: async (nameOrId: string, teamKey?: string): Promise<string> => {
      if (/^[0-9a-f-]{36}$/i.test(nameOrId)) return nameOrId;
      if (!teamKey) {
        throw new Error(`cycle name "${nameOrId}" requires a team scope`);
      }
      return `uuid-of-cycle-${nameOrId}`;
    },
    // Match the real helper's contract: TEAM-NN form → "TEAM"; UUID or other
    // shapes throw ValidationError. Lets round-6 / C3 tests exercise both the
    // derive-success path and the malformed-identifier rejection.
    deriveTeamFromIdentifiers: (ids: string[]): string | null => {
      if (ids.length === 0) return null;
      const prefixes = new Set<string>();
      for (const id of ids) {
        const match = /^([A-Z][A-Z0-9_]*)-\d+$/.exec(id.toUpperCase());
        if (!match) {
          throw new errors.ValidationError(`invalid identifier: ${id}`, "expected TEAM-NN form");
        }
        prefixes.add(match[1] as string);
      }
      if (prefixes.size > 1) {
        throw new errors.ValidationError(
          `identifiers span multiple teams: ${[...prefixes].join(", ")}`,
          "pass --team explicitly",
        );
      }
      return [...prefixes][0] ?? null;
    },
  };
});

import {
  archiveIssues,
  createIssue,
  issueWriteProof,
  unarchiveIssues,
  updateIssue,
} from "../src/lib/issues.ts";

function reset() {
  mockResponses = [];
  calls = [];
  issueLookups = [];
  issueLookupOverride = null;
  rawRequestOverride = null;
  projectResolveCalls = [];
  milestoneResolveCalls = [];
}

describe("createIssue", () => {
  it("builds Linear input from user-facing strings", async () => {
    reset();
    mockResponses.push({
      data: {
        issueCreate: {
          success: true,
          issue: {
            id: "issue-uuid",
            identifier: "NOX-1",
            url: "https://linear.app/x/nox-1",
            title: "T",
            state: { name: "Backlog" },
            project: null,
          },
        },
      },
    });

    const issue = await createIssue({
      team: "NOX",
      title: "T",
      description: "d",
      state: "Backlog",
      priority: "high",
      labels: ["bug"],
      assignee: "@me",
    });

    expect(issue.identifier).toBe("NOX-1");
    expect(calls[0]?.query).toContain("issueCreate");
    expect(calls[0]?.variables).toMatchObject({
      input: {
        teamId: "team-uuid",
        title: "T",
        description: "d",
        stateId: "state-uuid",
        priority: 2,
        labelIds: ["label-uuid"],
        assigneeId: "assignee-uuid",
      },
    });
  });

  it("omits resolved fields when the user didn't provide them", async () => {
    reset();
    mockResponses.push({
      data: {
        issueCreate: {
          success: true,
          issue: {
            id: "i",
            identifier: "NOX-2",
            url: "u",
            title: "T",
            state: { name: "B" },
            project: null,
          },
        },
      },
    });

    await createIssue({ team: "NOX", title: "T" });
    const input = (calls[0]?.variables as { input: Record<string, unknown> }).input;
    expect(input).toEqual({ teamId: "team-uuid", title: "T" });
  });

  it("rejects duplicate cached project names instead of taking the first", async () => {
    reset();
    const mockedResolve = await import("../src/lib/resolve.ts");
    const origWith = mockedResolve.withFreshMetadataOnMiss;
    (mockedResolve as Record<string, unknown>).withFreshMetadataOnMiss = async <T>(
      _fetcher: unknown,
      fn: (md: unknown) => Promise<T>,
    ): Promise<T> =>
      fn({
        team_id: "team-uuid",
        projects: [
          { id: "project-a", name: "Duplicate Project" },
          { id: "project-b", name: "Duplicate Project" },
        ],
        states: [],
        labels: [],
        members: [],
      });

    try {
      const err = await createIssue({
        team: "NOX",
        title: "T",
        project: "Duplicate Project",
      }).catch((e) => e);

      expect(err).toMatchObject({ code: "validation_error" });
      expect(err.message).toMatch(/ambiguous project "Duplicate Project"/);
      expect(
        calls.map((call) => call.query).filter((query) => query.includes("issueCreate")),
      ).toEqual([]);
    } finally {
      (mockedResolve as Record<string, unknown>).withFreshMetadataOnMiss = origWith;
    }
  });
});

describe("updateIssue", () => {
  it("requires at least one field — throws ValidationError with code=validation_error", async () => {
    reset();
    // Wave 2 / A2: assert the structured taxonomy, not just the message string.
    const err = await updateIssue({ identifier: "NOX-1" }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.code).toBe("validation_error");
    expect(err.message).toMatch(/nothing to update/);
    expect(err.hint).toMatch(/title.*description.*state/);
  });

  it("throws NotFoundError when the identifier doesn't resolve to an issue", async () => {
    // Wave 2 / A1: the SDK's `c.issue(id)` resolver returns null/undefined
    // for unknown identifiers. updateIssue must surface that as a structured
    // NotFoundError with code=not_found, not a raw Error.
    reset();
    issueLookupOverride = () => null;
    const err = await updateIssue({ identifier: "NOX-DOES-NOT-EXIST", title: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe("not_found");
    expect(err.message).toMatch(/issue not found: NOX-DOES-NOT-EXIST/);
    expect(err.hint).toMatch(/verify the identifier/);
  });

  it("resolves the identifier → UUID before the mutation", async () => {
    reset();
    mockResponses.push({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            id: "uuid-of-NOX-1",
            identifier: "NOX-1",
            url: "u",
            title: "new title",
            state: { name: "B" },
          },
        },
      },
    });
    await updateIssue({ identifier: "NOX-1", title: "new title" });
    expect(issueLookups[0]).toBe("NOX-1");
    // calls[0] is now the wave-3 identifier-lookup (ResolveIssueId); the
    // mutation is the last call. We assert against the last one.
    expect(calls.at(-1)?.variables).toMatchObject({
      id: "uuid-of-NOX-1",
      input: { title: "new title" },
    });
  });

  it("clears parent when null is passed (vs omitted)", async () => {
    reset();
    mockResponses.push({
      data: {
        issueUpdate: {
          success: true,
          issue: { id: "u", identifier: "NOX-1", url: "u", title: "T", state: { name: "B" } },
        },
      },
    });
    await updateIssue({ identifier: "NOX-1", team: "NOX", parent: null });
    const input = (calls.at(-1)?.variables as { input: Record<string, unknown> }).input;
    expect(input.parentId).toBeNull();
  });
});

describe("updateIssue — round-6 / C3 team auto-derivation from identifier", () => {
  // Pre-fix bug: passing state/labels/string-assignee without an explicit
  // `team` arg silently dropped those fields (response said success but the
  // mutation never carried the resolved IDs). The MCP surface was hit hardest
  // because it has no equivalent of the CLI's resolveConfig team enforcement.
  //
  // Post-fix: team is derived from the canonical TEAM-NN identifier; name
  // fields resolve transparently. Malformed identifiers + multi-team bulk
  // contexts still error loudly via ValidationError.

  it("derives team from a TEAM-NN identifier when `team` is omitted (state resolution works)", async () => {
    reset();
    mockResponses.push({
      data: {
        issueUpdate: {
          success: true,
          issue: { id: "u", identifier: "NOX-1", url: "u", title: "T", state: { name: "Done" } },
        },
      },
    });
    // No `team` arg — derivation should pick "NOX" from "NOX-1" and let the
    // state name resolve via the mocked team metadata.
    await updateIssue({ identifier: "NOX-1", state: "Done" });
    const input = (calls.at(-1)?.variables as { input: Record<string, unknown> }).input;
    expect(input.stateId).toBe("state-uuid");
  });

  it("derives team for labels resolution when `team` is omitted", async () => {
    reset();
    mockResponses.push({
      data: {
        issueUpdate: {
          success: true,
          issue: { id: "u", identifier: "NOX-1", url: "u", title: "T", state: { name: "B" } },
        },
      },
    });
    await updateIssue({ identifier: "NOX-1", labels: ["bug"] });
    const input = (calls.at(-1)?.variables as { input: Record<string, unknown> }).input;
    expect(input.labelIds).toEqual(["label-uuid"]);
  });

  it("derives team for string-assignee resolution when `team` is omitted (non-@me)", async () => {
    reset();
    mockResponses.push({
      data: {
        issueUpdate: {
          success: true,
          issue: { id: "u", identifier: "NOX-1", url: "u", title: "T", state: { name: "B" } },
        },
      },
    });
    // Non-@me string assignee goes through the team-metadata resolver path
    // (resolves email/name against team members). Round-7 / HIGH-1 carved
    // out `@me`/`me` to the workspace-wide viewer query — see the next
    // test for that path.
    await updateIssue({ identifier: "NOX-1", assignee: "alice@example.com" });
    const input = (calls.at(-1)?.variables as { input: Record<string, unknown> }).input;
    expect(input.assigneeId).toBe("assignee-uuid");
  });

  it("resolves `@me` via workspace viewer (no team scope required — round-7 / HIGH-1)", async () => {
    reset();
    mockResponses.push({
      data: {
        issueUpdate: {
          success: true,
          issue: { id: "u", identifier: "NOX-1", url: "u", title: "T", state: { name: "B" } },
        },
      },
    });
    // `@me` short-circuits the team-metadata path entirely. Even an unparseable
    // identifier (no team derivable) must still succeed for @me. Use a
    // malformed identifier to prove no team scope is involved.
    issueLookupOverride = (id: string) => ({ id: `uuid-of-${id}` });
    await updateIssue({ identifier: "no-team-shape", assignee: "@me" });
    const input = (calls.at(-1)?.variables as { input: Record<string, unknown> }).input;
    expect(input.assigneeId).toBe("viewer-uuid");
  });

  it("resolves `me` (without @) the same as `@me`", async () => {
    reset();
    mockResponses.push({
      data: {
        issueUpdate: {
          success: true,
          issue: { id: "u", identifier: "NOX-1", url: "u", title: "T", state: { name: "B" } },
        },
      },
    });
    await updateIssue({ identifier: "NOX-1", assignee: "me" });
    const input = (calls.at(-1)?.variables as { input: Record<string, unknown> }).input;
    expect(input.assigneeId).toBe("viewer-uuid");
  });

  it("@me + state together: viewer query short-circuits inside the team-metadata closure (round-8 / N1)", async () => {
    // Pre-fix (round-7 HIGH-1 only): when both `@me` AND a team-scoped
    // field (state/labels) were passed, viewer was resolved TWICE — once
    // in the hoist before the closure, and again inside `resolveAssigneeId`
    // when the closure fired. Same result, but an extra HTTP round-trip.
    // Post-fix (N1): closure short-circuits assigneeId resolution when the
    // hoist has already populated viewerAssigneeId. The mock counts the
    // resolveAssigneeId hits — should be ZERO when @me is combined with
    // state, because the closure sees viewerAssigneeId is already set.
    reset();
    mockResponses.push({
      data: {
        issueUpdate: {
          success: true,
          issue: { id: "u", identifier: "NOX-1", url: "u", title: "T", state: { name: "Done" } },
        },
      },
    });
    await updateIssue({ identifier: "NOX-1", assignee: "@me", state: "Done" });
    const input = (calls.at(-1)?.variables as { input: Record<string, unknown> }).input;
    // viewerAssigneeId (from the hoist) wins; not the closure's
    // resolveAssigneeId stub which would also return "viewer-uuid".
    expect(input.assigneeId).toBe("viewer-uuid");
    expect(input.stateId).toBe("state-uuid");
  });

  it("explicit `team` arg still overrides derivation (mismatched team passes through)", async () => {
    reset();
    mockResponses.push({
      data: {
        issueUpdate: {
          success: true,
          issue: { id: "u", identifier: "NOX-1", url: "u", title: "T", state: { name: "B" } },
        },
      },
    });
    // Identifier prefix is "NOX" but caller explicitly passes "OPS" — the
    // explicit arg wins. The lib doesn't sanity-check the relationship
    // (Linear's resolver does that via the underlying issue UUID lookup).
    await updateIssue({ identifier: "NOX-1", team: "OPS", state: "Done" });
    const input = (calls.at(-1)?.variables as { input: Record<string, unknown> }).input;
    expect(input.stateId).toBe("state-uuid");
  });

  it("priority/description/estimate still work without team (no team-scope needed)", async () => {
    reset();
    mockResponses.push({
      data: {
        issueUpdate: {
          success: true,
          issue: { id: "u", identifier: "NOX-1", url: "u", title: "T", state: { name: "B" } },
        },
      },
    });
    await updateIssue({
      identifier: "NOX-1",
      priority: 2,
      description: "updated",
      estimate: 3,
    });
    const input = (calls.at(-1)?.variables as { input: Record<string, unknown> }).input;
    expect(input.priority).toBe(2);
    expect(input.description).toBe("updated");
    expect(input.estimate).toBe(3);
    // No team-scoped fields means no need to derive — but derivation succeeds
    // anyway and is harmless. Verify nothing leaked from the team branch.
    expect(input.stateId).toBeUndefined();
    expect(input.labelIds).toBeUndefined();
    expect(input.assigneeId).toBeUndefined();
  });

  it("parent works without team (workspace-wide identifier lookup — independent C3 sub-fix)", async () => {
    reset();
    // Pre-fix bug: parent resolution was incorrectly gated on team, so this
    // silently dropped parentId. Post-fix: parent is resolved outside the
    // team-gated block.
    mockResponses.push({
      data: {
        issueUpdate: {
          success: true,
          issue: { id: "u", identifier: "NOX-1", url: "u", title: "T", state: { name: "B" } },
        },
      },
    });
    await updateIssue({ identifier: "NOX-1", parent: "NOX-2" });
    const input = (calls.at(-1)?.variables as { input: Record<string, unknown> }).input;
    expect(input.parentId).toBe("uuid-of-NOX-2");
  });

  it("fails before mutation when a non-null parent identifier cannot be resolved", async () => {
    reset();
    rawRequestOverride = async (query, variables) => {
      if (query.includes("ResolveIssueId")) {
        const id = (variables as { id: string }).id;
        return { data: { issue: id === "NOX-404" ? null : stubIssue(id) } };
      }
      throw new Error("unexpected mutation");
    };

    const err = await updateIssue({ identifier: "NOX-1", parent: "NOX-404" }).catch((e) => e);

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toBe("parent issue not found: NOX-404");
    expect(
      calls.map((call) => call.query).filter((query) => query.includes("issueUpdate")),
    ).toEqual([]);
  });

  it("clearing assignee with null works without team (no resolution needed)", async () => {
    reset();
    mockResponses.push({
      data: {
        issueUpdate: {
          success: true,
          issue: { id: "u", identifier: "NOX-1", url: "u", title: "T", state: { name: "B" } },
        },
      },
    });
    await updateIssue({ identifier: "NOX-1", assignee: null });
    const input = (calls.at(-1)?.variables as { input: Record<string, unknown> }).input;
    expect(input.assigneeId).toBeNull();
  });

  it("throws ValidationError when state requested with a malformed identifier (can't derive team)", async () => {
    reset();
    // Mock the issue-lookup to return a stub with a malformed identifier so
    // both `issue.identifier` AND the input.identifier fallback fail to
    // derive. Without team, name-shaped fields must throw.
    issueLookupOverride = (id: string) => ({ id: `uuid-of-${id}` });
    const err = await updateIssue({ identifier: "not-team-shape", state: "Done" }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.code).toBe("validation_error");
    expect(err.message).toMatch(/state.*labels.*assignee resolution requires a team/);
    expect(err.hint).toMatch(/pass team explicitly/);
  });

  it("priority works WITHOUT team even when identifier is malformed (no team-scope needed)", async () => {
    reset();
    // Sanity: malformed identifier should NOT block non-team-scoped updates.
    issueLookupOverride = (id: string) => ({ id: `uuid-of-${id}` });
    mockResponses.push({
      data: {
        issueUpdate: {
          success: true,
          issue: { id: "u", identifier: "ok", url: "u", title: "T", state: { name: "B" } },
        },
      },
    });
    await updateIssue({ identifier: "not-team-shape", priority: 1 });
    const input = (calls.at(-1)?.variables as { input: Record<string, unknown> }).input;
    expect(input.priority).toBe(1);
  });
});

describe("updateIssue with project/milestone/cycle (wave-3 single-call path)", () => {
  it("project + milestone + cycle all resolve and ride a single issueUpdate", async () => {
    // Wave 3: lib/updateIssue now accepts project/milestone/cycle directly.
    // Verify a multi-extras call produces exactly two raw requests: the
    // identifier-lookup + the single issueUpdate carrying every resolved id.
    // Name resolution for project/milestone/cycle is mocked through the
    // resolve.ts module (stubbed below); this test exercises the lib path
    // not the resolver internals.
    reset();
    // Queue the issueUpdate mutation response. The ResolveIssueId lookup
    // is handled inline by handleRawRequest (returns stubIssue).
    mockResponses.push({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            id: "uuid-of-NOX-1",
            identifier: "NOX-1",
            url: "u",
            title: "T",
            state: { name: "Done" },
          },
        },
      },
    });

    // 8-4-4-4-12 hex form so updateIssue's UUID_RE short-circuits the
    // milestone/cycle resolvers (no extra GraphQL round-trips).
    const projectUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const milestoneUuid = "11111111-2222-3333-4444-555555555555";
    const cycleUuid = "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb";
    await updateIssue({
      identifier: "NOX-1",
      team: "NOX",
      project: projectUuid,
      milestone: milestoneUuid,
      cycle: cycleUuid,
    });

    // Two raw calls: ResolveIssueId, issueUpdate. The UUID inputs above
    // short-circuit the milestone/cycle resolvers (no extra GraphQL).
    expect(calls.length).toBe(2);
    expect(calls[0]?.query).toContain("ResolveIssueId");
    expect(calls[1]?.query).toContain("issueUpdate");
    const input = (calls[1]?.variables as { input: Record<string, unknown> }).input;
    expect(input.projectId).toBeDefined();
    expect(input.projectMilestoneId).toBeDefined();
    expect(input.cycleId).toBeDefined();
  });

  it("project: null / milestone: null / cycle: null all serialize as null clears", async () => {
    // Detach semantics — pass null to remove the association. The lib must
    // emit `projectId: null` (and friends) so Linear actually clears them
    // instead of leaving the field unset.
    reset();
    mockResponses.push({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            id: "uuid-of-NOX-1",
            identifier: "NOX-1",
            url: "u",
            title: "T",
            state: { name: "Done" },
          },
        },
      },
    });
    await updateIssue({
      identifier: "NOX-1",
      team: "NOX",
      project: null,
      milestone: null,
      cycle: null,
    });
    const input = (calls.at(-1)?.variables as { input: Record<string, unknown> }).input;
    expect(input.projectId).toBeNull();
    expect(input.projectMilestoneId).toBeNull();
    expect(input.cycleId).toBeNull();
  });

  it("project resolution prefers the team-cache when the name matches there", async () => {
    // Project-name path: when the team-metadata cache contains a project
    // by that name, we use its UUID without a separate workspace lookup.
    // This test exercises the team-cache hit path (the resolve.ts stub
    // returns a team metadata with a "Some Project" entry).
    reset();
    // The resolve.ts vi.mock at the top of this file replaces the team
    // metadata with an empty `projects` array. Re-stub the closure to
    // include a project entry.
    const mockedResolve = await import("../src/lib/resolve.ts");
    const origWith = mockedResolve.withFreshMetadataOnMiss;
    (mockedResolve as Record<string, unknown>).withFreshMetadataOnMiss = async <T>(
      _fetcher: unknown,
      fn: (md: unknown) => Promise<T>,
    ): Promise<T> =>
      fn({
        team_id: "team-uuid",
        projects: [{ id: "team-cache-project-uuid", name: "Some Project" }],
        states: [],
        labels: [],
        members: [],
      });

    try {
      mockResponses.push({
        data: {
          issueUpdate: {
            success: true,
            issue: {
              id: "uuid-of-NOX-1",
              identifier: "NOX-1",
              url: "u",
              title: "T",
              state: { name: "Done" },
            },
          },
        },
      });
      await updateIssue({
        identifier: "NOX-1",
        team: "NOX",
        project: "Some Project",
      });
      const input = (calls.at(-1)?.variables as { input: Record<string, unknown> }).input;
      // Team-cache hit → no workspace-wide projects(...) query was emitted.
      expect(input.projectId).toBe("team-cache-project-uuid");
      expect(calls.length).toBe(2); // ResolveIssueId + issueUpdate only
    } finally {
      (mockedResolve as Record<string, unknown>).withFreshMetadataOnMiss = origWith;
    }
  });

  it("rejects duplicate cached project names on explicit-team updates", async () => {
    reset();
    const mockedResolve = await import("../src/lib/resolve.ts");
    const origWith = mockedResolve.withFreshMetadataOnMiss;
    (mockedResolve as Record<string, unknown>).withFreshMetadataOnMiss = async <T>(
      _fetcher: unknown,
      fn: (md: unknown) => Promise<T>,
    ): Promise<T> =>
      fn({
        team_id: "team-uuid",
        projects: [
          { id: "project-a", name: "Duplicate Project" },
          { id: "project-b", name: "Duplicate Project" },
        ],
        states: [],
        labels: [],
        members: [],
      });

    try {
      const err = await updateIssue({
        identifier: "NOX-1",
        team: "NOX",
        project: "Duplicate Project",
      }).catch((e) => e);

      expect(err).toMatchObject({ code: "validation_error" });
      expect(err.message).toMatch(/ambiguous project "Duplicate Project"/);
      expect(projectResolveCalls).toEqual([]);
      expect(
        calls.map((call) => call.query).filter((query) => query.includes("issueUpdate")),
      ).toEqual([]);
    } finally {
      (mockedResolve as Record<string, unknown>).withFreshMetadataOnMiss = origWith;
    }
  });

  it("rejects ambiguous project names without treating an identifier-derived team as explicit scope", async () => {
    reset();

    const err = await updateIssue({
      identifier: "NOX-1",
      project: "Ambiguous Project",
    }).catch((e) => e);

    expect(err).toMatchObject({ code: "validation_error" });
    expect(err.message).toMatch(/ambiguous project name/);
    expect(projectResolveCalls).toEqual([
      { nameOrId: "Ambiguous Project", opts: { teamKey: undefined } },
    ]);
    expect(
      calls.map((call) => call.query).filter((query) => query.includes("issueUpdate")),
    ).toEqual([]);
  });

  it("honors explicit team boundaries for project-name misses", async () => {
    reset();

    const err = await updateIssue({
      identifier: "NOX-1",
      team: "NOX",
      project: "Missing In Team",
    }).catch((e) => e);

    expect(err).toMatchObject({ code: "validation_error" });
    expect(err.message).toBe("project not found: Missing In Team (team NOX)");
    expect(projectResolveCalls).toEqual([
      { nameOrId: "Missing In Team", opts: { teamKey: "NOX" } },
    ]);
    expect(
      calls.map((call) => call.query).filter((query) => query.includes("issueUpdate")),
    ).toEqual([]);
  });

  it("scopes milestone names to the issue's current project", async () => {
    reset();
    issueLookupOverride = (id: string) => ({
      id: `uuid-of-${id}`,
      identifier: id.toUpperCase(),
      project: { id: "project-current", name: "Current Project" },
    });
    mockResponses.push({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            id: "uuid-of-NOX-1",
            identifier: "NOX-1",
            url: "u",
            title: "T",
            state: { name: "Done" },
          },
        },
      },
    });

    await updateIssue({
      identifier: "NOX-1",
      milestone: "Beta",
    });

    expect(milestoneResolveCalls).toEqual([
      { nameOrId: "Beta", opts: { projectId: "project-current" } },
    ]);
    const input = (calls.at(-1)?.variables as { input: Record<string, unknown> }).input;
    expect(input.projectMilestoneId).toBe("uuid-of-milestone-Beta");
  });

  it("rejects milestone names when neither target nor current project is available", async () => {
    reset();

    const err = await updateIssue({
      identifier: "NOX-1",
      milestone: "Beta",
    }).catch((e) => e);

    expect(err).toMatchObject({ code: "validation_error" });
    expect(err.message).toMatch(/requires a project scope/);
    expect(milestoneResolveCalls).toEqual([]);
    expect(
      calls.map((call) => call.query).filter((query) => query.includes("issueUpdate")),
    ).toEqual([]);
  });

  it("returns enough remote fields for one-call write proof", async () => {
    reset();
    mockResponses.push({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            id: "uuid-of-NOX-1",
            identifier: "NOX-1",
            url: "https://linear.app/test/issue/NOX-1",
            updatedAt: "2026-06-07T12:00:00.000Z",
            title: "New title",
            description: "New body",
            state: { id: "state-1", name: "Done", type: "completed" },
            priority: 2,
            estimate: 5,
            labels: { nodes: [{ id: "label-1", name: "bug" }] },
            assignee: { id: "user-1", name: "Alice", email: "alice@example.com" },
            parent: { id: "parent-1", identifier: "NOX-0" },
            project: { id: "project-1", name: "Project" },
            projectMilestone: { id: "milestone-1", name: "Beta" },
            cycle: { id: "cycle-1", name: "Cycle 1" },
            team: { id: "team-1", key: "NOX" },
          },
        },
      },
    });

    const issue = await updateIssue({ identifier: "NOX-1", title: "New title" });
    const proof = issueWriteProof(issue);

    expect(proof).toMatchObject({
      identifier: "NOX-1",
      updated_at: "2026-06-07T12:00:00.000Z",
      title: "New title",
      description: "New body",
      state: { id: "state-1", name: "Done", type: "completed" },
      priority: 2,
      estimate: 5,
      labels: [{ id: "label-1", name: "bug" }],
      assignee: { id: "user-1", name: "Alice", email: "alice@example.com" },
      parent: { id: "parent-1", identifier: "NOX-0" },
      project: { id: "project-1", name: "Project" },
      milestone: { id: "milestone-1", name: "Beta" },
      cycle: { id: "cycle-1", name: "Cycle 1" },
    });
  });

  it("cycle name uses identifier-derived team scoping when team is omitted", async () => {
    // Cycle names aren't globally unique, so name resolution must be scoped.
    // `updateIssue` can derive that scope from a canonical TEAM-NN
    // identifier; callers only need to pass `team` when the identifier shape
    // does not carry a team key.
    reset();
    mockResponses.push({
      data: {
        issueUpdate: {
          success: true,
          issue: {
            id: "uuid-of-NOX-1",
            identifier: "NOX-1",
            url: "u",
            title: "T",
            state: { name: "Done" },
          },
        },
      },
    });

    await updateIssue({
      identifier: "NOX-1",
      cycle: "Cycle 12",
    });

    const input = (calls.at(-1)?.variables as { input: Record<string, unknown> }).input;
    expect(input.cycleId).toBe("uuid-of-cycle-Cycle 12");
  });

  it("cycle name without derivable team scoping is rejected by the resolver", async () => {
    // If the identifier cannot provide a TEAM-NN prefix and no explicit team
    // is passed, the resolver must still reject name input instead of picking
    // a cross-team match.
    reset();
    // Override the resolve mock so resolveCycleIdByName is exercised
    // (the top-of-file mock omits it, so we add it just for this test).
    const mockedResolve = await import("../src/lib/resolve.ts");
    const origCycle = (mockedResolve as Record<string, unknown>).resolveCycleIdByName;
    (mockedResolve as Record<string, unknown>).resolveCycleIdByName = async (
      nameOrId: string,
      teamKey?: string,
    ): Promise<string> => {
      if (/^[0-9a-f-]{36}$/i.test(nameOrId)) return nameOrId;
      if (!teamKey) {
        throw new Error(`cycle name "${nameOrId}" requires a team scope`);
      }
      return "uuid-of-cycle";
    };

    try {
      const err = await updateIssue({
        identifier: "not-team-shaped",
        cycle: "Cycle 12",
        // No team passed.
      }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message)).toMatch(/cycle name.*requires a team scope/);
    } finally {
      (mockedResolve as Record<string, unknown>).resolveCycleIdByName = origCycle;
    }
  });
});

describe("archiveIssues + unarchiveIssues", () => {
  it("archive: returns one result per identifier", async () => {
    reset();
    mockResponses.push({ data: { issueArchive: { success: true } } });
    mockResponses.push({ data: { issueArchive: { success: true } } });
    const results = await archiveIssues(["NOX-1", "NOX-2"]);
    expect(results).toEqual([
      { identifier: "NOX-1", status: "ok" },
      { identifier: "NOX-2", status: "ok" },
    ]);
  });

  it("unarchive: same shape", async () => {
    reset();
    mockResponses.push({ data: { issueUnarchive: { success: true } } });
    const results = await unarchiveIssues(["NOX-1"]);
    expect(results).toEqual([{ identifier: "NOX-1", status: "ok" }]);
  });

  it("archive: reports success:false mutation payloads as errors", async () => {
    reset();
    mockResponses.push({ data: { issueArchive: { success: false } } });
    const results = await archiveIssues(["NOX-1"]);
    expect(results[0]).toMatchObject({
      identifier: "NOX-1",
      status: "error",
      error: "issueArchive failed",
    });
  });

  it("unarchive: reports success:false mutation payloads as errors", async () => {
    reset();
    mockResponses.push({ data: { issueUnarchive: { success: false } } });
    const results = await unarchiveIssues(["NOX-1"]);
    expect(results[0]).toMatchObject({
      identifier: "NOX-1",
      status: "error",
      error: "issueUnarchive failed",
    });
  });

  it("archive: lifecycleOne recognizes a structured NotFoundError from the SDK boundary", async () => {
    // Wave 2 / A3: lifecycleOne previously string-sniffed `not found:` on the
    // translated error. With wave-1's `installRawRequestMapping` in place,
    // SDK errors now arrive as structured NotFoundError instances. Verify
    // lifecycleOne maps that to `{status: "not-found"}` without going through
    // the legacy message-string fallback.
    reset();
    rawRequestOverride = async () => {
      throw new NotFoundError("Entity not found: Issue", "no issue with the given id");
    };
    const results = await archiveIssues(["NOX-MISSING"]);
    expect(results).toEqual([{ identifier: "NOX-MISSING", status: "not-found" }]);
  });

  it("archive: lifecycleOne propagates a non-not-found error into status=error", async () => {
    // Regression guard for A3: an unrelated error (e.g. network) must NOT be
    // silently mapped to `not-found`.
    reset();
    rawRequestOverride = async () => {
      throw new Error("ECONNRESET");
    };
    const results = await archiveIssues(["NOX-1"]);
    expect(results[0]?.status).toBe("error");
    expect(results[0]?.error).toMatch(/ECONNRESET/);
  });

  it("archive: returns status=not-found when the issue resolver yields null", async () => {
    // A3 path #2: the `if (!issue) return { status: "not-found" }` branch.
    reset();
    issueLookupOverride = () => null;
    const results = await archiveIssues(["NOX-GHOST"]);
    expect(results).toEqual([{ identifier: "NOX-GHOST", status: "not-found" }]);
  });

  it("archive: lifecycleOne resolves the identifier via raw ResolveIssueId (not the SDK c.issue path)", async () => {
    // Wave-4 round-B: lifecycleOne migrated from SDK-typed c.issue() to the
    // raw `ResolveIssueId` query for consistency with updateIssue (and to
    // make mocking trivial — no 60+ field fragment to fake). Assert the new
    // call shape: a ResolveIssueId raw request before the mutation.
    reset();
    mockResponses.push({ data: { issueArchive: { success: true } } });
    const results = await archiveIssues(["NOX-42"]);
    expect(results).toEqual([{ identifier: "NOX-42", status: "ok" }]);
    // Two raw calls: ResolveIssueId lookup + issueArchive mutation.
    expect(calls[0]?.query).toContain("ResolveIssueId");
    expect(calls[0]?.variables).toEqual({ id: "NOX-42" });
    expect(calls[1]?.query).toContain("issueArchive");
    expect(calls[1]?.variables).toEqual({ id: "uuid-of-NOX-42" });
  });
});
