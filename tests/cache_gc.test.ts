/**
 * Tests for `gcCache` — the cache garbage-collection lib.
 *
 * `CACHE_ROOT` is computed at module-load time from `LEBOP_HOME`, so each
 * test sets a fresh `LEBOP_HOME` BEFORE importing `cache.ts` via
 * `vi.resetModules()` + dynamic import. This guarantees we never touch the
 * real `~/.lebop/cache/` on the developer's machine.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface CacheModule {
  gcCache: typeof import("../src/lib/cache.ts").gcCache;
  listCachedIssues: typeof import("../src/lib/cache.ts").listCachedIssues;
}

interface ConfigModule {
  hashRepoRoot: typeof import("../src/lib/config.ts").hashRepoRoot;
}

let home: string;
let cacheRoot: string;
let cache: CacheModule;
let config: ConfigModule;
let originalHome: string | undefined;

/** Day in milliseconds. */
const DAY = 86_400_000;

/** Set mtime of a file/dir to a given timestamp. */
function setMtime(p: string, when: Date): void {
  utimesSync(p, when, when);
}

/**
 * Create a fake repo-hash subdir under cacheRoot with one file. Sets the
 * file's mtime to `mtime` so `gcCache`'s scan sees a specific age.
 */
function makeFakeRepo(hash: string, mtime: Date, bytes = 32): void {
  const dir = join(cacheRoot, hash, "issues", "FAKE-1");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "description.md");
  writeFileSync(file, "x".repeat(bytes));
  setMtime(file, mtime);
  // Also push the dir mtimes back so any later walk that touches dirs
  // sees them as old. mtime on files dominates scanDir's newestMtime, but
  // setting both keeps the test robust to implementation changes.
  setMtime(dir, mtime);
}

/** Reload cache.ts after LEBOP_HOME changes. */
async function importCache(): Promise<void> {
  vi.resetModules();
  cache = (await import("../src/lib/cache.ts")) as unknown as CacheModule;
  config = (await import("../src/lib/config.ts")) as unknown as ConfigModule;
}

beforeEach(async () => {
  originalHome = process.env.LEBOP_HOME;
  home = mkdtempSync(join(tmpdir(), "lebop-gc-test-"));
  process.env.LEBOP_HOME = home;
  cacheRoot = join(home, "cache");
  mkdirSync(cacheRoot, { recursive: true });
  await importCache();
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.LEBOP_HOME;
  } else {
    process.env.LEBOP_HOME = originalHome;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("gcCache — dry run", () => {
  it("with default options reports candidates but does not delete", async () => {
    const oldDate = new Date(Date.now() - 60 * DAY);
    makeFakeRepo("aaaa11112222", oldDate);
    makeFakeRepo("bbbb33334444", new Date()); // fresh

    const result = await cache.gcCache({}); // defaults: dryRun=true, maxAgeDays=30

    expect(result.removed).toEqual([]);
    expect(result.candidates.map((c) => c.hash)).toContain("aaaa11112222");
    expect(result.candidates.find((c) => c.hash === "bbbb33334444")).toBeUndefined();
    // dir must still exist on disk.
    expect(() => statSync(join(cacheRoot, "aaaa11112222"))).not.toThrow();
  });

  it("dryRun:true with explicit maxAgeDays:0 reports everything but deletes nothing", async () => {
    // Use ages well past the 0-day cutoff so FS mtime granularity cannot flake.
    const aged = new Date(Date.now() - 48 * 60 * 60 * 1000);
    makeFakeRepo("aaaa11112222", aged);
    makeFakeRepo("bbbb33334444", aged);

    const result = await cache.gcCache({
      maxAgeDays: 0,
      dryRun: true,
      preserveCwdRepo: false,
    });

    expect(result.removed).toEqual([]);
    // Both qualify (older than 0-day cutoff).
    expect(result.candidates.length).toBe(2);
    expect(() => statSync(join(cacheRoot, "aaaa11112222"))).not.toThrow();
    expect(() => statSync(join(cacheRoot, "bbbb33334444"))).not.toThrow();
  });
});

describe("listCachedIssues", () => {
  it("ignores non-canonical issue cache directories", async () => {
    mkdirSync(join(cacheRoot, "_global", "issues", "NOX-1"), { recursive: true });
    mkdirSync(join(cacheRoot, "_global", "issues", "not-an-issue"), { recursive: true });
    mkdirSync(join(cacheRoot, "_global", "issues", "NOX-one"), { recursive: true });

    await expect(cache.listCachedIssues("_global")).resolves.toEqual(["NOX-1"]);
  });
});

describe("gcCache — age-based selection", () => {
  it("with maxAgeDays:30 and a 60-day-old hash, deletes only the old one", async () => {
    const oldDate = new Date(Date.now() - 60 * DAY);
    makeFakeRepo("aaaa11112222", oldDate);
    makeFakeRepo("bbbb33334444", new Date());

    const result = await cache.gcCache({
      maxAgeDays: 30,
      dryRun: false,
      preserveCwdRepo: false,
    });

    expect(result.removed).toEqual(["aaaa11112222"]);
    expect(() => statSync(join(cacheRoot, "aaaa11112222"))).toThrow();
    expect(() => statSync(join(cacheRoot, "bbbb33334444"))).not.toThrow();
  });

  it("does not select a fresh hash", async () => {
    makeFakeRepo("aaaa11112222", new Date());

    const result = await cache.gcCache({
      maxAgeDays: 30,
      dryRun: true,
      preserveCwdRepo: false,
    });

    expect(result.candidates).toEqual([]);
  });
});

describe("gcCache — size-based selection", () => {
  it("trims oldest hashes until under the limit", async () => {
    // Create three repos, 0.5 MB each. With maxSizeMb=0.6, two must go.
    const halfMb = 512 * 1024;
    const t0 = new Date(Date.now() - 30 * DAY);
    const t1 = new Date(Date.now() - 20 * DAY);
    const t2 = new Date(Date.now() - 10 * DAY);
    makeFakeRepo("aaaa00000000", t0, halfMb);
    makeFakeRepo("bbbb00000000", t1, halfMb);
    makeFakeRepo("cccc00000000", t2, halfMb);

    const result = await cache.gcCache({
      maxSizeMb: 0.6,
      dryRun: false,
      preserveCwdRepo: false,
    });

    // Oldest two should be evicted; newest stays.
    expect(result.removed.sort()).toEqual(["aaaa00000000", "bbbb00000000"]);
    expect(() => statSync(join(cacheRoot, "cccc00000000"))).not.toThrow();
    // totalSizeAfterMb should be roughly half a MB (one repo left).
    expect(result.totalSizeAfterMb).toBeLessThan(result.totalSizeBeforeMb);
  });

  it("does nothing when total is already below the limit", async () => {
    makeFakeRepo("aaaa00000000", new Date(), 1024);

    const result = await cache.gcCache({
      maxSizeMb: 500,
      dryRun: true,
      preserveCwdRepo: false,
    });

    expect(result.candidates).toEqual([]);
  });
});

describe("gcCache — preserveCwdRepo", () => {
  it("never evicts the cwd's hash even when it qualifies", async () => {
    // Compute the hash for the current cwd and stage a stale repo there.
    const cwdHash = config.hashRepoRoot(
      // gcCache uses findGitRoot(cwd); fall back to cwd if no .git ancestor.
      // For determinism we use a synthetic root and force the hash directly.
      process.cwd(),
    );
    // The test runner's cwd IS inside a git repo (lebop), so findGitRoot
    // resolves there. Compute the hash from THAT root to match the lib.
    const lebopRoot = await findLebopRoot();
    const expectedCwdHash = config.hashRepoRoot(lebopRoot);

    const oldDate = new Date(Date.now() - 60 * DAY);
    makeFakeRepo(expectedCwdHash, oldDate);
    makeFakeRepo("dddd99998888", oldDate);

    const result = await cache.gcCache({
      maxAgeDays: 30,
      dryRun: false,
      preserveCwdRepo: true,
    });

    // Other stale hash gets removed, cwd hash is preserved.
    expect(result.removed).toContain("dddd99998888");
    expect(result.removed).not.toContain(expectedCwdHash);
    expect(() => statSync(join(cacheRoot, expectedCwdHash))).not.toThrow();

    // Silence "unused" — cwdHash is computed only to demonstrate the
    // synthetic-vs-real distinction.
    void cwdHash;
  });

  it("with preserveCwdRepo:false WILL evict the cwd's hash if it qualifies", async () => {
    const lebopRoot = await findLebopRoot();
    const cwdHash = config.hashRepoRoot(lebopRoot);
    const oldDate = new Date(Date.now() - 60 * DAY);
    makeFakeRepo(cwdHash, oldDate);

    const result = await cache.gcCache({
      maxAgeDays: 30,
      dryRun: false,
      preserveCwdRepo: false,
    });

    expect(result.removed).toContain(cwdHash);
  });
});

describe("gcCache — explicit hash", () => {
  it("with hash:<H> only targets that one", async () => {
    makeFakeRepo("aaaa11112222", new Date());
    makeFakeRepo("bbbb33334444", new Date());

    const result = await cache.gcCache({
      hash: "aaaa11112222",
      dryRun: false,
      preserveCwdRepo: false,
    });

    expect(result.removed).toEqual(["aaaa11112222"]);
    expect(() => statSync(join(cacheRoot, "aaaa11112222"))).toThrow();
    expect(() => statSync(join(cacheRoot, "bbbb33334444"))).not.toThrow();
  });

  it("with an unknown hash, returns no candidates", async () => {
    makeFakeRepo("aaaa11112222", new Date());

    const result = await cache.gcCache({
      hash: "deadbeef0000",
      dryRun: true,
      preserveCwdRepo: false,
    });

    expect(result.candidates).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("rejects invalid explicit hashes before scanning", async () => {
    await expect(
      cache.gcCache({
        hash: "../outside",
        dryRun: false,
        preserveCwdRepo: false,
      }),
    ).rejects.toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("invalid cache gc hash"),
    });
  });
});

describe("gcCache — misc", () => {
  it("never evicts _global", async () => {
    // Stage _global with very old mtime.
    const dir = join(cacheRoot, "_global", "_team");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "ENG.yaml");
    writeFileSync(file, "team_key: ENG\n");
    setMtime(file, new Date(Date.now() - 365 * DAY));

    const result = await cache.gcCache({
      maxAgeDays: 1,
      dryRun: false,
      preserveCwdRepo: false,
    });

    expect(result.candidates.find((c) => c.hash === "_global")).toBeUndefined();
    expect(result.removed).not.toContain("_global");
    expect(() => statSync(join(cacheRoot, "_global"))).not.toThrow();
  });

  it("returns an empty result when CACHE_ROOT does not exist", async () => {
    // Wipe the cache root we just created.
    rmSync(cacheRoot, { recursive: true, force: true });

    const result = await cache.gcCache({ dryRun: true });
    expect(result).toEqual({
      candidates: [],
      removed: [],
      totalSizeBeforeMb: 0,
      totalSizeAfterMb: 0,
    });
  });

  it("refuses to scan or delete through a symlinked cache root", async () => {
    const realCache = mkdtempSync(join(tmpdir(), "lebop-gc-real-cache-"));
    rmSync(cacheRoot, { recursive: true, force: true });
    symlinkSync(realCache, cacheRoot, "dir");
    mkdirSync(join(realCache, "aaaa11112222", "issues", "FAKE-1"), { recursive: true });
    writeFileSync(join(realCache, "aaaa11112222", "issues", "FAKE-1", "description.md"), "x");

    await expect(
      cache.gcCache({
        maxAgeDays: 0,
        dryRun: false,
        preserveCwdRepo: false,
      }),
    ).rejects.toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("unsafe cache root"),
    });
    expect(() => statSync(join(realCache, "aaaa11112222"))).not.toThrow();
    rmSync(realCache, { recursive: true, force: true });
  });

  it("refuses to scan or delete through a symlinked LEBOP_HOME ancestor", async () => {
    const previousHome = home;
    const realHome = mkdtempSync(join(tmpdir(), "lebop-gc-real-home-"));
    const linkHome = join(tmpdir(), `lebop-gc-home-link-${process.pid}-${Date.now()}`);
    symlinkSync(realHome, linkHome, "dir");

    try {
      process.env.LEBOP_HOME = linkHome;
      home = linkHome;
      cacheRoot = join(home, "cache");
      mkdirSync(join(realHome, "cache", "aaaa11112222", "issues", "FAKE-1"), {
        recursive: true,
      });
      writeFileSync(
        join(realHome, "cache", "aaaa11112222", "issues", "FAKE-1", "description.md"),
        "x",
      );
      await importCache();

      await expect(
        cache.gcCache({
          maxAgeDays: 0,
          dryRun: false,
          preserveCwdRepo: false,
        }),
      ).rejects.toMatchObject({
        code: "validation_error",
        message: expect.stringContaining("symlinked ancestor"),
      });
      expect(() => statSync(join(realHome, "cache", "aaaa11112222"))).not.toThrow();
    } finally {
      rmSync(previousHome, { recursive: true, force: true });
      rmSync(linkHome, { recursive: true, force: true });
      rmSync(realHome, { recursive: true, force: true });
    }
  });
});

/**
 * The test process's cwd is inside the lebop git repo, so `findGitRoot`
 * walks up to the lebop checkout. Mirror that resolution here so we can
 * compute the same hash gcCache will produce.
 */
async function findLebopRoot(): Promise<string> {
  const { findGitRoot } = await import("../src/lib/config.ts");
  const root = findGitRoot(process.cwd());
  if (!root) throw new Error("no git root from cwd — test environment unexpected");
  return root;
}
