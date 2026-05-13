import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findGitRoot, hashRepoRoot, loadUserConfig, resolveConfig } from "../src/lib/config.ts";
import { ConfigError } from "../src/lib/errors.ts";

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

// Wave 3 / structured-error taxonomy: config-shape problems must surface as
// ConfigError (code=config_error) with a hint, not raw Error. We stub the
// `Bun.file` shim that config.ts uses (vitest runs under Node, not Bun) so
// loadUserConfig can be exercised without a real file.
describe("loadUserConfig (structured errors)", () => {
  let prevBun: unknown;

  beforeEach(() => {
    prevBun = (globalThis as { Bun?: unknown }).Bun;
  });

  afterEach(() => {
    (globalThis as { Bun?: unknown }).Bun = prevBun;
  });

  it("throws ConfigError when the YAML is a bare scalar at top level", async () => {
    (globalThis as { Bun?: unknown }).Bun = {
      file: () => ({
        exists: async () => true,
        text: async () => "just a string",
      }),
    };
    const err = await loadUserConfig().catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err).toMatchObject({ code: "config_error", hint: expect.any(String) });
  });
});

describe("resolveConfig (structured errors)", () => {
  let prevBun: unknown;
  let prevTeam: string | undefined;
  let tmp: string;

  beforeEach(() => {
    prevBun = (globalThis as { Bun?: unknown }).Bun;
    prevTeam = process.env.LEBOP_TEAM;
    delete process.env.LEBOP_TEAM;
    tmp = mkdtempSync(join(tmpdir(), "lebop-config-resolve-"));
  });

  afterEach(() => {
    (globalThis as { Bun?: unknown }).Bun = prevBun;
    if (prevTeam === undefined) delete process.env.LEBOP_TEAM;
    else process.env.LEBOP_TEAM = prevTeam;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws ConfigError when no team source is configured", async () => {
    // Stub Bun.file so loadUserConfig reads "no config" (exists=false → {}).
    // loadAuth also uses Bun.file under the hood — make exists() false to
    // avoid an auth-side read.
    (globalThis as { Bun?: unknown }).Bun = {
      file: () => ({
        exists: async () => false,
        text: async () => "",
      }),
    };
    // cwd = tmp so findGitRoot returns null and an enclosing repo's config
    // can't leak in.
    const err = await resolveConfig({ cwd: tmp }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err).toMatchObject({ code: "config_error", hint: expect.any(String) });
  });
});
