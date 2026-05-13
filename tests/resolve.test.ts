import { describe, expect, it } from "vitest";
import type { TeamMetadata } from "../src/lib/cache.ts";
import { ValidationError } from "../src/lib/errors.ts";
import {
  deriveTeamFromIdentifiers,
  labelNameById,
  memberById,
  priorityName,
  ResolveError,
  resolveLabelId,
  resolveLabelIds,
  resolvePriority,
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

  it("accepts multi-letter and digit-suffix team keys", () => {
    expect(deriveTeamFromIdentifiers(["UE_X1-7"])).toBe("UE_X1");
  });

  it("throws ValidationError on mixed teams", () => {
    expect(() => deriveTeamFromIdentifiers(["NOX-1", "UE-2"])).toThrow(ValidationError);
    expect(() => deriveTeamFromIdentifiers(["NOX-1", "UE-2"])).toThrow(/span multiple teams/);
  });

  it("throws ValidationError on malformed identifier", () => {
    expect(() => deriveTeamFromIdentifiers(["NOX1"])).toThrow(ValidationError);
    expect(() => deriveTeamFromIdentifiers([""])).toThrow(ValidationError);
  });
});
