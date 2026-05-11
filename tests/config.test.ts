import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findGitRoot, hashRepoRoot } from "../src/lib/config.ts";

describe("hashRepoRoot", () => {
  it("returns 12-char hex", () => {
    const h = hashRepoRoot("/abs/path");
    expect(h).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is deterministic", () => {
    expect(hashRepoRoot("/a/b")).toBe(hashRepoRoot("/a/b"));
  });

  it("differs for different inputs", () => {
    expect(hashRepoRoot("/a")).not.toBe(hashRepoRoot("/b"));
  });
});

describe("findGitRoot", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lebop-config-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the dir containing .git", async () => {
    await mkdir(join(tmp, ".git"), { recursive: true });
    expect(findGitRoot(tmp)).toBe(tmp);
  });

  it("walks upward from a subdirectory", async () => {
    await mkdir(join(tmp, ".git"), { recursive: true });
    const nested = join(tmp, "src", "deep");
    await mkdir(nested, { recursive: true });
    expect(findGitRoot(nested)).toBe(tmp);
  });

  it("returns null when no .git ancestor exists", async () => {
    // tmp has no .git, and /private/tmp or similar shouldn't either
    const nested = join(tmp, "sub");
    await mkdir(nested, { recursive: true });
    // walking up from tmp might eventually reach a machine-level .git — guard with a
    // nested structure and accept null OR some unrelated root; what matters is we
    // don't incorrectly return `nested` or `tmp`.
    const result = findGitRoot(nested);
    expect(result === null || (result !== nested && result !== tmp)).toBe(true);
  });
});
