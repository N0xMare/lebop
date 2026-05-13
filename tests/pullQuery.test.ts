/**
 * Wave 3 / structured-error taxonomy: `buildPullIssuesQuery` invariants
 * (empty identifier list, malformed TEAM-NN id) must surface as
 * ValidationError with code + hint, not raw Error.
 */

import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/lib/errors.ts";
import { buildPullIssuesQuery } from "../src/lib/pullQuery.ts";

describe("buildPullIssuesQuery (structured errors)", () => {
  it("empty identifiers is a ValidationError with code + hint", () => {
    const err = (() => {
      try {
        buildPullIssuesQuery([], false);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "validation_error", hint: expect.any(String) });
  });

  it("malformed identifier is a ValidationError with code + hint", () => {
    const err = (() => {
      try {
        buildPullIssuesQuery(["not-an-id"], false);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "validation_error", hint: expect.any(String) });
  });

  it("happy path still builds a query string with one alias per id", () => {
    const q = buildPullIssuesQuery(["UE-1", "UE-2"], false);
    expect(q).toContain('a0: issue(id: "UE-1")');
    expect(q).toContain('a1: issue(id: "UE-2")');
  });
});
