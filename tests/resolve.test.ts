import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamMetadata } from "../src/lib/cache.ts";
import { ValidationError } from "../src/lib/errors.ts";
import { normalizeIssueIdentifier, parseIssueIdentifier } from "../src/lib/issueIdentifiers.ts";

const sdkMock = vi.hoisted(() => ({
  rawResponses: [] as { data: unknown }[],
  calls: [] as { query: string; variables: unknown }[],
}));

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (client: unknown) => Promise<T>): Promise<T> =>
    fn({
      client: {
        rawRequest: async (query: string, variables: unknown) => {
          sdkMock.calls.push({ query, variables });
          const next = sdkMock.rawResponses.shift();
          if (!next) throw new Error(`mock exhausted: ${query.slice(0, 80)}`);
          return next;
        },
      },
    }),
}));

import {
  deriveTeamFromIdentifiers,
  labelNameById,
  memberById,
  priorityName,
  ResolveError,
  resolveAssigneeId,
  resolveLabelId,
  resolveLabelIds,
  resolveMilestoneIdByName,
  resolvePriority,
  resolveProjectIdByName,
  resolveStateId,
  stateNameById,
} from "../src/lib/resolve.ts";

const metadata: TeamMetadata = {
  team_id: "t-1",
  team_key: "UE",
  fetched_at: new Date().toISOString(),
  states: [
    { id: "s-backlog", name: "Backlog", type: "backlog" },
    { id: "s-todo", name: "Todo", type: "unstarted" },
    { id: "s-inprog", name: "In Progress", type: "started" },
  ],
  labels: [
    { id: "l-p0", name: "priority:p0" },
    { id: "l-p1", name: "priority:p1" },
    { id: "l-test", name: "type:test" },
  ],
  members: [
    { id: "m-alice", name: "Alice", email: "alice@example.com" },
    { id: "m-bob", name: "Bob", email: "bob@example.com" },
  ],
  projects: [{ id: "pr-1", name: "Example", state: "started" }],
};

beforeEach(() => {
  sdkMock.rawResponses = [];
  sdkMock.calls = [];
});

describe("resolveStateId", () => {
  it("resolves exact name", () => {
    expect(resolveStateId(metadata, "Backlog")).toBe("s-backlog");
  });

  it("is case-insensitive", () => {
    expect(resolveStateId(metadata, "in progress")).toBe("s-inprog");
  });

  it("throws on unknown state with candidate list", () => {
    expect(() => resolveStateId(metadata, "Nope")).toThrow(ResolveError);
    expect(() => resolveStateId(metadata, "Nope")).toThrow(/Backlog.*Todo.*In Progress/);
  });
});

describe("resolveLabelId", () => {
  it("resolves exact name", () => {
    expect(resolveLabelId(metadata, "type:test")).toBe("l-test");
  });

  it("is case-insensitive", () => {
    expect(resolveLabelId(metadata, "PRIORITY:P0")).toBe("l-p0");
  });

  it("suggests partial matches in error", () => {
    expect(() => resolveLabelId(metadata, "priority")).toThrow(/priority:p0.*priority:p1/);
  });

  it("throws without suggestions when no partial match", () => {
    expect(() => resolveLabelId(metadata, "zzz")).toThrow(ResolveError);
  });
});

describe("resolveLabelIds", () => {
  it("resolves a list", () => {
    expect(resolveLabelIds(metadata, ["type:test", "priority:p0"])).toEqual(["l-test", "l-p0"]);
  });

  it("throws on the first unknown label", () => {
    expect(() => resolveLabelIds(metadata, ["type:test", "nope"])).toThrow(ResolveError);
  });
});

describe("resolveAssigneeId", () => {
  it("prefers exact email even when display names are duplicated", async () => {
    const duplicateNames: TeamMetadata = {
      ...metadata,
      members: [
        { id: "m-sam-1", name: "Sam", email: "sam.one@example.com" },
        { id: "m-sam-2", name: "Sam", email: "sam.two@example.com" },
      ],
    };

    await expect(resolveAssigneeId(duplicateNames, "sam.two@example.com")).resolves.toBe("m-sam-2");
  });

  it("rejects duplicate exact display-name matches instead of taking the first", async () => {
    const duplicateNames: TeamMetadata = {
      ...metadata,
      members: [
        { id: "m-sam-1", name: "Sam", email: "sam.one@example.com" },
        { id: "m-sam-2", name: "Sam", email: "sam.two@example.com" },
      ],
    };

    await expect(resolveAssigneeId(duplicateNames, "sam")).rejects.toThrow(ResolveError);
    await expect(resolveAssigneeId(duplicateNames, "sam")).rejects.toThrow(
      /ambiguous assignee "sam".*sam.one@example.com.*sam.two@example.com/,
    );
  });
});

describe("reverse lookups", () => {
  it("stateNameById returns name or null", () => {
    expect(stateNameById(metadata, "s-backlog")).toBe("Backlog");
    expect(stateNameById(metadata, "missing")).toBeNull();
  });

  it("labelNameById returns name or null", () => {
    expect(labelNameById(metadata, "l-p1")).toBe("priority:p1");
    expect(labelNameById(metadata, "missing")).toBeNull();
  });

  it("memberById returns name+email or null", () => {
    expect(memberById(metadata, "m-alice")).toEqual({
      name: "Alice",
      email: "alice@example.com",
    });
    expect(memberById(metadata, "missing")).toBeNull();
  });
});

describe("resolvePriority", () => {
  it("accepts names", () => {
    expect(resolvePriority("none")).toBe(0);
    expect(resolvePriority("urgent")).toBe(1);
    expect(resolvePriority("high")).toBe(2);
    expect(resolvePriority("normal")).toBe(3);
    expect(resolvePriority("low")).toBe(4);
  });

  it("accepts names case-insensitively", () => {
    expect(resolvePriority("URGENT")).toBe(1);
    expect(resolvePriority("High")).toBe(2);
  });

  it("accepts numeric strings 0..4", () => {
    expect(resolvePriority("0")).toBe(0);
    expect(resolvePriority("4")).toBe(4);
  });

  it("accepts raw numbers 0..4", () => {
    expect(resolvePriority(0)).toBe(0);
    expect(resolvePriority(3)).toBe(3);
  });

  it("rejects out-of-range numbers", () => {
    expect(() => resolvePriority(5)).toThrow(ResolveError);
    expect(() => resolvePriority(-1)).toThrow(ResolveError);
  });

  it("rejects fractional numbers", () => {
    expect(() => resolvePriority(1.5)).toThrow(ResolveError);
  });

  it("rejects malformed numeric strings", () => {
    for (const value of ["3abc", "3.7", "0x3", " 3", "3 "]) {
      expect(() => resolvePriority(value)).toThrow(ResolveError);
    }
  });

  it("rejects unknown name", () => {
    expect(() => resolvePriority("critical")).toThrow(ResolveError);
  });
});

describe("priorityName", () => {
  it("maps valid indices", () => {
    expect(priorityName(0)).toBe("none");
    expect(priorityName(1)).toBe("urgent");
    expect(priorityName(4)).toBe("low");
  });

  it("falls back to unknown(n) for out-of-range", () => {
    expect(priorityName(9)).toBe("unknown(9)");
  });
});

describe("deriveTeamFromIdentifiers", () => {
  it("returns null for empty list", () => {
    expect(deriveTeamFromIdentifiers([])).toBeNull();
  });

  it("returns the prefix when all share one team", () => {
    expect(deriveTeamFromIdentifiers(["NOX-1", "NOX-22", "NOX-300"])).toBe("NOX");
  });

  it("is case-insensitive on input but returns upper-case", () => {
    expect(deriveTeamFromIdentifiers(["nox-1", "Nox-2"])).toBe("NOX");
  });

  it("accepts digit-bearing team keys", () => {
    expect(deriveTeamFromIdentifiers(["A1-7"])).toBe("A1");
  });

  it("uses the shared issue identifier parser", () => {
    expect(parseIssueIdentifier("a1-42")).toEqual({
      identifier: "A1-42",
      teamKey: "A1",
      number: 42,
    });
    expect(normalizeIssueIdentifier("nox-34")).toBe("NOX-34");
  });

  it("throws ValidationError on mixed teams", () => {
    expect(() => deriveTeamFromIdentifiers(["NOX-1", "UE-2"])).toThrow(ValidationError);
    expect(() => deriveTeamFromIdentifiers(["NOX-1", "UE-2"])).toThrow(/span multiple teams/);
  });

  it("throws ValidationError on malformed identifier", () => {
    expect(() => deriveTeamFromIdentifiers(["NOX1"])).toThrow(ValidationError);
    expect(() => deriveTeamFromIdentifiers([""])).toThrow(ValidationError);
    expect(() => deriveTeamFromIdentifiers(["UE_X1-7"])).toThrow(ValidationError);
  });
});

describe("resolveProjectIdByName", () => {
  it("rejects duplicate workspace project names instead of taking the first row", async () => {
    sdkMock.rawResponses.push({
      data: {
        projects: {
          nodes: [
            { id: "project-nox", name: "Shared Name", teams: { nodes: [{ key: "NOX" }] } },
            { id: "project-eng", name: "Shared Name", teams: { nodes: [{ key: "ENG" }] } },
          ],
        },
      },
    });

    await expect(resolveProjectIdByName("Shared Name")).rejects.toThrow(/ambiguous project name/);
    expect(sdkMock.calls[0]?.query).toContain("first: 2");
    expect(sdkMock.calls[0]?.variables).toEqual({ name: "Shared Name" });
  });

  it("honors explicit team scope and reports a team-scoped miss", async () => {
    sdkMock.rawResponses.push({ data: { projects: { nodes: [] } } });

    await expect(resolveProjectIdByName("Shared Name", { teamKey: "NOX" })).rejects.toThrow(
      /project not found: Shared Name \(team NOX\)/,
    );
    expect(sdkMock.calls[0]?.query).toContain("accessibleTeams");
    expect(sdkMock.calls[0]?.variables).toEqual({ name: "Shared Name", teamKey: "NOX" });
  });
});

describe("resolveMilestoneIdByName", () => {
  it("scopes milestone names to a project when projectId is supplied", async () => {
    sdkMock.rawResponses.push({
      data: {
        projectMilestones: {
          nodes: [{ id: "milestone-1", name: "Beta", project: { id: "project-1", name: "P1" } }],
        },
      },
    });

    await expect(resolveMilestoneIdByName("Beta", { projectId: "project-1" })).resolves.toBe(
      "milestone-1",
    );
    expect(sdkMock.calls[0]?.query).toContain("$projectId: ID!");
    expect(sdkMock.calls[0]?.variables).toEqual({ name: "Beta", projectId: "project-1" });
  });

  it("rejects ambiguous unscoped milestone names", async () => {
    sdkMock.rawResponses.push({
      data: {
        projectMilestones: {
          nodes: [
            { id: "milestone-1", name: "Beta", project: { id: "project-1", name: "P1" } },
            { id: "milestone-2", name: "Beta", project: { id: "project-2", name: "P2" } },
          ],
        },
      },
    });

    await expect(resolveMilestoneIdByName("Beta")).rejects.toThrow(/ambiguous milestone name/);
    expect(sdkMock.calls[0]?.query).toContain("first: 2");
  });
});
