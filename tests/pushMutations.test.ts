/**
 * Wave 3 / structured-error taxonomy: `buildCasQuery` invariants must
 * surface as ValidationError with code + hint, not raw Error.
 */

import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/lib/errors.ts";
import { buildCasQuery } from "../src/lib/pushMutations.ts";

describe("buildCasQuery (structured errors)", () => {
  it("empty identifiers is a ValidationError with code + hint", () => {
    const err = (() => {
      try {
        buildCasQuery([]);
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
        buildCasQuery(["bad-id"]);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "validation_error", hint: expect.any(String) });
  });

  it("happy path builds a query string with one alias per id", () => {
    const q = buildCasQuery(["UE-10", "UE-11"]);
    expect(q).toContain('a0: issue(id: "UE-10")');
    expect(q).toContain('a1: issue(id: "UE-11")');
  });
});
