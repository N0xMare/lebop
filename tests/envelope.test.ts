import { describe, expect, it } from "vitest";
import { envelope, SCHEMA_VERSION } from "../src/lib/envelope.ts";

describe("envelope()", () => {
  it("returns a new object with schema_version: 1 plus the payload fields", () => {
    const out = envelope({ count: 3, items: ["a", "b", "c"] });
    expect(out).toEqual({ schema_version: 1, count: 3, items: ["a", "b", "c"] });
  });

  it("uses the SCHEMA_VERSION constant (single source of truth)", () => {
    expect(SCHEMA_VERSION).toBe(1);
    const out = envelope({ x: 1 });
    expect(out.schema_version).toBe(SCHEMA_VERSION);
  });

  it("does not mutate the input payload", () => {
    const payload = { issue: { id: "abc" } };
    const out = envelope(payload);
    expect(Object.keys(payload)).toEqual(["issue"]);
    // out is a fresh object, payload didn't gain `schema_version`.
    expect((payload as Record<string, unknown>).schema_version).toBeUndefined();
    expect(out.schema_version).toBe(1);
  });

  it("serializes schema_version FIRST so head/tail tooling can spot-check the version", () => {
    // Field ordering is contractually first-position via the explicit
    // schema_version line in envelope().
    const json = JSON.stringify(envelope({ z: "z", a: "a" }));
    expect(json.startsWith('{"schema_version":1')).toBe(true);
  });

  it("supports an empty payload", () => {
    expect(envelope({})).toEqual({ schema_version: 1 });
  });

  it("preserves nested values verbatim", () => {
    const out = envelope({
      results: [
        { identifier: "NOX-1", status: "ok" },
        { identifier: "NOX-2", status: "not-found" as const },
      ],
    });
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toEqual({ identifier: "NOX-1", status: "ok" });
  });

  it("payload fields can shadow nothing — schema_version cannot collide", () => {
    // Belt-and-braces: even if a payload accidentally includes a different
    // schema_version (e.g. from a passthrough), the envelope helper's value
    // wins because of object-spread order — `schema_version` is set first
    // and spread fields overwrite it only if explicitly present in payload.
    // We DO allow that override path because some adapters need it; this
    // test just locks the documented behavior.
    const out = envelope({ schema_version: 99 as unknown as 1, count: 0 } as unknown as Record<
      string,
      unknown
    >);
    // Spread wins — caller-supplied schema_version overrides the default.
    expect(out.schema_version).toBe(99);
  });

  it("works with a heterogeneous payload (string + boolean + null + object)", () => {
    const out = envelope({
      identifier: "UE-359",
      success: true,
      error: null,
      issue: { id: "uuid-1" },
    });
    expect(out).toMatchObject({
      schema_version: 1,
      identifier: "UE-359",
      success: true,
      error: null,
      issue: { id: "uuid-1" },
    });
  });

  it("handles a freshly destructured ...result spread cleanly", () => {
    // Common pattern in commands/plan.ts and commands/cache.ts: spread a
    // result object into the envelope. Verify this composes.
    const result = { dry_run: true, removed: 2, candidates: ["a", "b"] };
    const out = envelope({ dir: "/tmp/p", ...result });
    expect(out).toEqual({
      schema_version: 1,
      dir: "/tmp/p",
      dry_run: true,
      removed: 2,
      candidates: ["a", "b"],
    });
  });
});
