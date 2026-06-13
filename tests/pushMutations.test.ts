/**
 * Wave 3 / structured-error taxonomy: `buildCasQuery` invariants must
 * surface as ValidationError with code + hint, not raw Error.
 */

import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/lib/errors.ts";
import { buildCasQuery, buildProjectCasQuery } from "../src/lib/pushMutations.ts";

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
    const q = buildCasQuery(["UE-10", "A1-11"]);
    expect(q).toContain('a0: issue(id: "UE-10")');
    expect(q).toContain('a1: issue(id: "A1-11")');
  });
});

describe("buildProjectCasQuery", () => {
  it("empty project ids is a ValidationError with code + hint", () => {
    const err = (() => {
      try {
        buildProjectCasQuery([]);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "validation_error", hint: expect.any(String) });
  });

  it("malformed project id is a ValidationError with code + hint", () => {
    const err = (() => {
      try {
        buildProjectCasQuery(["not-a-uuid"]);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "validation_error", hint: expect.any(String) });
  });

  it("happy path builds a project CAS query string with one alias per project id", () => {
    const q = buildProjectCasQuery([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(q).toContain('p0: project(id: "11111111-1111-4111-8111-111111111111")');
    expect(q).toContain('p1: project(id: "22222222-2222-4222-8222-222222222222")');
  });
});
