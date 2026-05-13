/**
 * Tests for setWorkspaceDefaultTeam. Mirrors the cache_gc.test.ts pattern:
 * set LEBOP_HOME to a fresh tmpdir BEFORE importing the lib so the path
 * resolution lands in our throwaway directory and never touches the
 * developer's real `~/.lebop/config.yaml`.
 *
 * Also stubs `Bun.file` + `Bun.write` to forward to node:fs primitives —
 * vitest runs under Node, not Bun.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

interface ConfigWriteModule {
  setWorkspaceDefaultTeam: typeof import("../src/lib/configWrite.ts").setWorkspaceDefaultTeam;
}
interface PathsModule {
  CONFIG_FILE: string;
}

let home: string;
let originalHome: string | undefined;
let prevBun: unknown;
let mod: ConfigWriteModule;
let paths: PathsModule;

async function importFresh(): Promise<void> {
  vi.resetModules();
  paths = (await import("../src/lib/paths.ts")) as unknown as PathsModule;
  mod = (await import("../src/lib/configWrite.ts")) as unknown as ConfigWriteModule;
}

beforeEach(async () => {
  originalHome = process.env.LEBOP_HOME;
  home = mkdtempSync(join(tmpdir(), "lebop-cw-test-"));
  process.env.LEBOP_HOME = home;
  mkdirSync(home, { recursive: true });

  // Bun.file + Bun.write shim — minimal, forwards to fs.
  prevBun = (globalThis as { Bun?: unknown }).Bun;
  (globalThis as { Bun?: unknown }).Bun = {
    file: (path: string) => ({
      exists: async () => existsSync(path),
      text: async () => readFileSync(path, "utf8"),
    }),
    write: async (path: string, content: string) => {
      writeFileSync(path, content);
    },
  };

  await importFresh();
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.LEBOP_HOME;
  } else {
    process.env.LEBOP_HOME = originalHome;
  }
  (globalThis as { Bun?: unknown }).Bun = prevBun;
  rmSync(home, { recursive: true, force: true });
});

describe("setWorkspaceDefaultTeam", () => {
  it("creates the config file with the workspace_team_defaults entry", async () => {
    await mod.setWorkspaceDefaultTeam("unlink-xyz", "UE");
    const parsed = parseYaml(readFileSync(paths.CONFIG_FILE, "utf8")) as {
      workspace_team_defaults?: Record<string, string>;
    };
    expect(parsed.workspace_team_defaults).toEqual({ "unlink-xyz": "UE" });
  });

  it("preserves prior workspace entries and updates the named one in place", async () => {
    await mod.setWorkspaceDefaultTeam("a", "AAA");
    await mod.setWorkspaceDefaultTeam("b", "BBB");
    await mod.setWorkspaceDefaultTeam("a", "AAA2"); // change

    const parsed = parseYaml(readFileSync(paths.CONFIG_FILE, "utf8")) as {
      workspace_team_defaults: Record<string, string>;
    };
    expect(parsed.workspace_team_defaults).toEqual({ a: "AAA2", b: "BBB" });
  });

  it("throws structured ValidationError when existing config has malformed YAML", async () => {
    // Pre-write a tabs-indented YAML file — yaml package's parseDocument
    // doesn't throw on parse failure (it collects errors on doc.errors).
    // The lib must detect doc.errors.length > 0 BEFORE attempting toString(),
    // which would otherwise surface a bare Error("Document with errors
    // cannot be stringified") that lacks an actionable hint.
    const { ValidationError } = await import("../src/lib/errors.ts");
    writeFileSync(paths.CONFIG_FILE, "\troot:\n\t  bad: indent\n");

    const err = await mod.setWorkspaceDefaultTeam("ws", "NOX").catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("invalid YAML"),
      hint: expect.stringContaining("fix the YAML"),
    });
  });
});
