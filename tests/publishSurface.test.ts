import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/lib/errors.ts";
import {
  buildPublishApplyInputFromCli,
  buildPublishApplyInputFromMcp,
  buildPublishReviewInputFromCli,
  buildPublishReviewInputFromMcp,
} from "../src/surface/publish.ts";

describe("publish surface contracts", () => {
  it("normalizes CLI plan review inputs", () => {
    expect(
      buildPublishReviewInputFromCli({
        ids: [],
        opts: {
          plan: "plans/release",
          team: "NOX",
          strict: true,
        },
      }),
    ).toEqual({
      source: { kind: "plan", dir: "plans/release" },
      team: "NOX",
      strict: true,
    });
  });

  it("normalizes CLI cache review inputs with expanded issue ranges", () => {
    expect(
      buildPublishReviewInputFromCli({
        ids: ["nox-1..nox-2"],
        opts: {
          cache: true,
          projectId: ["project-1"],
          allModified: false,
          team: "NOX",
        },
      }),
    ).toEqual({
      source: {
        kind: "cache",
        identifiers: ["NOX-1", "NOX-2"],
        projectIds: ["project-1"],
        allModified: false,
      },
      team: "NOX",
      strict: undefined,
    });
  });

  it("preserves CLI review source exclusivity errors", () => {
    expect(() =>
      buildPublishReviewInputFromCli({
        ids: [],
        opts: { plan: "plans/release", cache: true },
      }),
    ).toThrow("pass exactly one of --plan or --cache");

    expect(() => buildPublishReviewInputFromCli({ ids: [], opts: {} })).toThrow(
      "publish review requires --plan <dir> or --cache",
    );
  });

  it("normalizes MCP plan review inputs and ignores transport workspace", () => {
    expect(
      buildPublishReviewInputFromMcp({
        source: { kind: "plan", dir: "/tmp/plan" },
        team: "UE",
        strict: false,
        workspace: "noxor",
      }),
    ).toEqual({
      source: { kind: "plan", dir: "/tmp/plan" },
      team: "UE",
      strict: false,
    });
  });

  it("normalizes MCP cache review inputs into canonical cache selectors", () => {
    expect(
      buildPublishReviewInputFromMcp({
        source: {
          kind: "cache",
          repo_root: "/repo/root",
          identifiers: ["ue-10..ue-11"],
          project_ids: ["project-1"],
          all_modified: false,
        },
        workspace: "noxor",
      }),
    ).toEqual({
      source: {
        kind: "cache",
        repoRoot: "/repo/root",
        identifiers: ["UE-10", "UE-11"],
        projectIds: ["project-1"],
        allModified: false,
      },
      team: undefined,
      strict: undefined,
    });
  });

  it("rejects nested MCP cache selector typos at the surface boundary", () => {
    expect(() =>
      buildPublishReviewInputFromMcp({
        source: { kind: "cache", identifier: ["NOX-1"] } as never,
      }),
    ).toThrow(ValidationError);
  });

  it("normalizes publish apply inputs from CLI and MCP", () => {
    expect(
      buildPublishApplyInputFromCli({
        reviewId: "pub_20260609_review",
        opts: { verify: false },
      }),
    ).toEqual({ reviewId: "pub_20260609_review", verify: false });

    expect(
      buildPublishApplyInputFromMcp({
        review_id: "pub_20260609_review",
        verify: true,
        workspace: "noxor",
      }),
    ).toEqual({ reviewId: "pub_20260609_review", verify: true });
  });
});
