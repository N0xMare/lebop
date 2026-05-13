/**
 * Negative-path test for `writeAtomic` in src/lib/cache.ts. The happy
 * path is exercised everywhere (cache reads, push, plan apply, etc.); this
 * file owns the rename-failure cleanup branch added in round 2 polish.
 *
 * Vitest under Node can't `vi.spyOn` an ESM re-export of `renameSync`
 * (the namespace is not configurable). We use `vi.mock("node:fs", ...)`
 * with `importOriginal` so only `renameSync` is replaced; everything
 * else flows through.
 *
 * `Bun.write` is shimmed to forward to `node:fs.writeFileSync` (same
 * pattern as tests/configWrite.test.ts) because vitest runs under Node
 * by default.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stash so we can flip the throw on/off per test without re-mocking.
let renameShouldThrow: Error | null = null;

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (renameShouldThrow) throw renameShouldThrow;
      return actual.renameSync(...args);
    },
  };
});

let dir: string;
let prevBun: unknown;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lebop-writeatomic-"));
  renameShouldThrow = null;

  // Bun.write shim — forwards to fs.writeFileSync so the lib can run
  // under vitest (Bun.write is Bun-specific).
  prevBun = (globalThis as { Bun?: unknown }).Bun;
  (globalThis as { Bun?: unknown }).Bun = {
    write: async (path: string, content: string) => {
      writeFileSync(path, content);
    },
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  (globalThis as { Bun?: unknown }).Bun = prevBun;
  renameShouldThrow = null;
});

describe("writeAtomic — rename-failure cleanup", () => {
  it("happy path: writes content, leaves no tmp files behind", async () => {
    const { writeAtomic } = await import("../src/lib/cache.ts");
    const path = join(dir, "happy.txt");
    await writeAtomic(path, "hello\n");
    expect(existsSync(path)).toBe(true);
    const stragglers = readdirSync(dir).filter((n) => n.includes(".tmp-"));
    expect(stragglers).toEqual([]);
  });

  it("cleans up the tmp file when renameSync throws, then rethrows the original error", async () => {
    const { writeAtomic } = await import("../src/lib/cache.ts");
    const path = join(dir, "should-not-exist.txt");
    const renameErr = new Error("simulated cross-fs rename failure");
    renameShouldThrow = renameErr;

    const thrown = await writeAtomic(path, "payload\n").catch((e) => e);

    // The original error propagates verbatim.
    expect(thrown).toBe(renameErr);
    // Final file was never created (rename failed).
    expect(existsSync(path)).toBe(false);
    // Tmp file was cleaned up — no stragglers in the dir.
    const stragglers = readdirSync(dir).filter((n) => n.includes(".tmp-"));
    expect(stragglers).toEqual([]);
  });
});
