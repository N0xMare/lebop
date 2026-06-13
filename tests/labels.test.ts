import { beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../src/lib/errors.ts";

let mockRawResponses: Array<{ data: unknown }> = [];
let mockRawCalls: Array<{ query: string; variables: unknown }> = [];

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      client: {
        rawRequest: async (query: string, variables: unknown) => {
          mockRawCalls.push({ query, variables });
          const next = mockRawResponses.shift();
          if (!next) throw new Error("mock exhausted");
          return next;
        },
      },
    }),
  linear: async () => ({
    client: {
      rawRequest: async (query: string, variables: unknown) => {
        mockRawCalls.push({ query, variables });
        const next = mockRawResponses.shift();
        if (!next) throw new Error("mock exhausted");
        return next;
      },
    },
  }),
}));

vi.mock("../src/lib/config.ts", () => ({
  resolveConfig: async ({ teamOverride }: { teamOverride?: string } = {}) => ({
    repoHash: "repo-hash",
    team: teamOverride ?? "NOX",
  }),
}));

vi.mock("../src/lib/teams.ts", () => ({
  getTeam: async (key: string) => ({ id: `team-${key.toLowerCase()}`, key, name: key }),
}));

import {
  createLabel,
  deleteLabel,
  resolveLabelByName,
  resolveLabelSelectorToId,
} from "../src/lib/labels.ts";

beforeEach(() => {
  mockRawResponses = [];
  mockRawCalls = [];
});

describe("label mutation truthfulness", () => {
  it("createLabel rejects success:false before returning the label", async () => {
    mockRawResponses.push({
      data: {
        issueLabelCreate: {
          success: false,
          issueLabel: {
            id: "label-1",
            name: "blocked",
            color: "#ff0000",
            description: null,
            team: null,
          },
        },
      },
    });

    const err = await createLabel({ name: "blocked" }).catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("issueLabelCreate failed");
  });

  it("deleteLabel rejects success:false", async () => {
    mockRawResponses.push({ data: { issueLabelDelete: { success: false } } });

    const err = await deleteLabel("label-1").catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("issueLabelDelete failed");
  });
});

describe("label name resolution", () => {
  it("resolveLabelByName scans past the first label page", async () => {
    mockRawResponses.push(
      labelsPage([label("label-other", "Other", "NOX")], true, "labels-cursor-1"),
      labelsPage([label("label-target", "Target", "NOX")], false, null),
    );

    const resolved = await resolveLabelByName("Target", "NOX");

    expect(resolved?.id).toBe("label-target");
    expect(mockRawCalls[1]?.variables).toMatchObject({ after: "labels-cursor-1" });
  });

  it("selector resolution scans all pages before applying ambiguity checks", async () => {
    mockRawResponses.push(
      labelsPage([label("label-other", "Other", "NOX")], true, "labels-cursor-1"),
      labelsPage([label("label-target", "Target", "NOX")], false, null),
    );

    const resolved = await resolveLabelSelectorToId("Target", "team", "NOX");

    expect(resolved).toMatchObject({
      id: "label-target",
      scope: "team",
      team: "NOX",
      label: { id: "label-target", name: "Target" },
    });
    expect(mockRawCalls[1]?.variables).toMatchObject({ after: "labels-cursor-1" });
  });
});

function label(id: string, name: string, teamKey: string | null) {
  return {
    id,
    name,
    color: "#cccccc",
    description: null,
    team: teamKey ? { id: `team-${teamKey.toLowerCase()}`, key: teamKey, name: teamKey } : null,
  };
}

function labelsPage(
  nodes: ReturnType<typeof label>[],
  hasNextPage: boolean,
  endCursor: string | null,
) {
  return {
    data: {
      issueLabels: {
        nodes,
        pageInfo: { hasNextPage, endCursor },
      },
    },
  };
}
