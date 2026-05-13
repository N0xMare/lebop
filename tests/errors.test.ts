import { describe, expect, it } from "vitest";
import {
  AuthError,
  NotFoundError,
  RateLimitError,
  rewriteNotFound,
  tryIdempotentDelete,
  tryMapToNull,
  ValidationError,
} from "../src/lib/errors.ts";

describe("rewriteNotFound", () => {
  // Post-RH2: rewriteNotFound returns NotFoundError (was ValidationError).
  // Aligns the function's return-type with its name and ensures CLI `--json`
  // envelopes emit `code: "not_found"` for missing entities instead of the
  // pre-fix `code: "validation_error"`.
  it("rewrites Linear's not-found error with the identifier, returns NotFoundError", () => {
    const err = new Error("Entity not found: Issue - Could not find referenced Issue.");
    const result = rewriteNotFound(err, "UE-999");
    expect(result.message).toBe("not found: UE-999");
    expect(result).toBeInstanceOf(NotFoundError);
  });

  it("matches case-insensitively, returns NotFoundError", () => {
    const err = new Error("entity NOT FOUND: project");
    const result = rewriteNotFound(err, "UE-1");
    expect(result.message).toBe("not found: UE-1");
    expect(result).toBeInstanceOf(NotFoundError);
  });

  it("returns NotFoundError when structured GraphQL extensions.code is NOT_FOUND", () => {
    const err = { errors: [{ extensions: { code: "NOT_FOUND" }, message: "missing" }] };
    const result = rewriteNotFound(err, "UE-7");
    expect(result.message).toBe("not found: UE-7");
    expect(result).toBeInstanceOf(NotFoundError);
  });

  // Round-10 / M5: lock L-2's hint-preservation behavior. Pre-L-2 the
  // reconstruction dropped the hint produced by `hintForNotFound`, leaving
  // callers (CLI `--json` envelopes, MCP error responses) without the
  // actionable "no <Entity> with the given id" context.
  it("preserves the hintForNotFound hint on message-regex path (L-2)", () => {
    const err = new Error("Entity not found: Issue - Could not find referenced Issue.");
    const result = rewriteNotFound(err, "UE-999") as NotFoundError;
    expect(result.hint).toBe("no Issue with the given id");
  });

  it("preserves the hintForNotFound hint on structured GraphQL extension path (L-2)", () => {
    const err = {
      errors: [
        {
          extensions: { code: "NOT_FOUND" },
          message: "Entity not found: Project - Could not find referenced Project.",
        },
      ],
    };
    const result = rewriteNotFound(err, "P-1") as NotFoundError;
    expect(result.hint).toBe("no Project with the given id");
  });

  it("passes through unrelated errors unchanged", () => {
    const err = new Error("network timeout");
    const result = rewriteNotFound(err, "UE-1");
    expect(result).toBe(err);
  });

  it("wraps non-Error throwables", () => {
    const result = rewriteNotFound("oh no", "UE-1");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("oh no");
  });
});

describe("tryMapToNull (round-6 / H3 direct unit coverage)", () => {
  // Round 5 introduced `tryMapToNull` as the shared "SDK-boundary NotFound
  // → null" helper across 8 `get_*` lib functions. Until now coverage was
  // transitive only — a bug in the branching logic would surface as 8
  // simultaneous regressions in the get-* tests. These tests exercise the
  // four code paths directly.

  it("returns the resolved value on success", async () => {
    expect(await tryMapToNull(async () => 42)).toBe(42);
  });

  it("maps an explicitly-thrown NotFoundError → null", async () => {
    const result = await tryMapToNull(async () => {
      throw new NotFoundError("milestone not found");
    });
    expect(result).toBeNull();
  });

  it("maps a raw SDK 'Entity not found' error → null via mapSdkError", async () => {
    // Linear's @linear/sdk throws plain Error with this message; `tryMapToNull`
    // delegates to `mapSdkError` to classify it before the NotFound check.
    const result = await tryMapToNull(async () => {
      throw new Error("Entity not found: Project - Could not find referenced Project.");
    });
    expect(result).toBeNull();
  });

  it("rethrows other LebopError subtypes unchanged (RateLimitError preserved)", async () => {
    const original = new RateLimitError("slow down", "wait and retry");
    let caught: unknown = null;
    try {
      await tryMapToNull(async () => {
        throw original;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(original);
    expect(caught).toBeInstanceOf(RateLimitError);
    if (caught instanceof RateLimitError) {
      expect(caught.code).toBe("rate_limit_error");
      expect(caught.hint).toBe("wait and retry");
    }
  });

  it("rethrows AuthError unchanged (not absorbed by NotFound contract)", async () => {
    const original = new AuthError("token expired");
    let caught: unknown = null;
    try {
      await tryMapToNull(async () => {
        throw original;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(original);
  });

  it("rethrows a generic ValidationError that doesn't mention 'argument validation' + 'id'", async () => {
    // The M-7 widening only catches ValidationErrors with BOTH "argument
    // validation" AND \bid\b in the message. A plain "bad input" message
    // doesn't match either pattern, so it must still propagate.
    const original = new ValidationError("bad input");
    let caught: unknown = null;
    try {
      await tryMapToNull(async () => {
        throw original;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(original);
  });

  // Round-10 / M4: lock the M-7 widening behavior. The helper now maps
  // ValidationErrors with BOTH "argument validation" AND `\bid\b` in
  // their message to `null`, so `getMilestone` / `getInitiative` (whose
  // GraphQL queries take an `ID!` scalar) return null for malformed
  // UUID input — matching the `get_document` / `get_project` behavior
  // for the same input shape.
  it("maps ValidationError matching 'argument validation' + 'id' to null (M-7 widening)", async () => {
    const malformed = new ValidationError(
      'Argument Validation Error - Variable "id" got invalid value "00000000-0000-0000-0000-000000000000"',
    );
    const result = await tryMapToNull(async () => {
      throw malformed;
    });
    expect(result).toBeNull();
  });

  it("propagates ValidationError that mentions 'argument validation' but not 'id' (M-7 narrow)", async () => {
    // Negative case: a non-id validation error must still propagate so
    // genuine schema-rejections (e.g. priority out of range) don't get
    // silently absorbed by the widening.
    const original = new ValidationError(
      "Argument Validation Error - field 'priority' must be 0..4",
    );
    let caught: unknown = null;
    try {
      await tryMapToNull(async () => {
        throw original;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(original);
  });

  it("propagates ValidationError with 'id' but no 'argument validation' marker (M-7 narrow)", async () => {
    // Negative case 2: just containing the word "id" isn't enough — the
    // message must also be argument-validation-shaped. Guards against
    // false-positive absorption of business-rule validations.
    const original = new ValidationError("the id you provided is reserved by the team");
    let caught: unknown = null;
    try {
      await tryMapToNull(async () => {
        throw original;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(original);
  });

  it("rethrows a raw non-LebopError that doesn't map to NotFoundError (after mapSdkError)", async () => {
    // A raw error that mapSdkError can't classify falls through unchanged.
    const original = new Error("totally unrelated runtime error");
    let caught: unknown = null;
    try {
      await tryMapToNull(async () => {
        throw original;
      });
    } catch (err) {
      caught = err;
    }
    // mapSdkError returns the original error unchanged when it can't classify;
    // tryMapToNull then rethrows that.
    expect(caught).toBe(original);
  });
});

describe("tryIdempotentDelete (round-8 / N2 discriminated-union return)", () => {
  // The helper standardizes the "missing → already-absent" delete contract
  // across 7 CLI + 7 MCP delete surfaces. Round-7 introduced the helper with
  // a flat `{status, result: T | null}` shape; round-8 / N2 tightened it to
  // a discriminated union so `result` only exists on the "deleted" branch.

  it("returns {status: 'deleted', result} on success — `result` typed as T", async () => {
    const r = await tryIdempotentDelete(async () => true);
    expect(r.status).toBe("deleted");
    // TypeScript narrows `r.result` to `boolean` here via the discriminator.
    if (r.status === "deleted") expect(r.result).toBe(true);
  });

  it("returns {status: 'already-absent'} (no result key) on NotFoundError", async () => {
    const r = await tryIdempotentDelete(async () => {
      throw new NotFoundError("entity not found");
    });
    expect(r.status).toBe("already-absent");
    // The already-absent branch has no `result` key — narrowing prevents
    // TypeScript from accessing it. Verify at runtime too.
    expect("result" in r).toBe(false);
  });

  it("maps a raw SDK 'Entity not found' error to already-absent via mapSdkError", async () => {
    const r = await tryIdempotentDelete(async () => {
      throw new Error("Entity not found: Document - Could not find referenced Document.");
    });
    expect(r.status).toBe("already-absent");
  });

  it("rethrows non-NotFound LebopError subtypes (RateLimitError passes through)", async () => {
    const original = new RateLimitError("slow down", "wait and retry");
    let caught: unknown = null;
    try {
      await tryIdempotentDelete(async () => {
        throw original;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(original);
    expect(caught).toBeInstanceOf(RateLimitError);
  });

  it("rethrows AuthError unchanged", async () => {
    const original = new AuthError("token expired");
    let caught: unknown = null;
    try {
      await tryIdempotentDelete(async () => {
        throw original;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(original);
  });

  it("rethrows ValidationError unchanged (distinct from NotFound)", async () => {
    const original = new ValidationError("bad input");
    let caught: unknown = null;
    try {
      await tryIdempotentDelete(async () => {
        throw original;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(original);
  });
});
