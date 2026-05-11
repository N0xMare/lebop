import { describe, expect, it } from "vitest";
import { rewriteNotFound } from "../src/lib/errors.ts";

describe("rewriteNotFound", () => {
  it("rewrites Linear's not-found error with the identifier", () => {
    const err = new Error("Entity not found: Issue - Could not find referenced Issue.");
    expect(rewriteNotFound(err, "UE-999").message).toBe("not found: UE-999");
  });

  it("matches case-insensitively", () => {
    const err = new Error("entity NOT FOUND: project");
    expect(rewriteNotFound(err, "UE-1").message).toBe("not found: UE-1");
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
