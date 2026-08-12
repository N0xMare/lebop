import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  detectPlatform,
  isReleaseBinary,
  resolveInstallTarget,
  versionFromTag,
} from "../src/lib/selfUpdate.ts";

describe("selfUpdate helpers", () => {
  it("compareVersions orders dotted versions", () => {
    expect(compareVersions("0.0.3", "0.0.5")).toBeLessThan(0);
    expect(compareVersions("0.0.5", "0.0.5")).toBe(0);
    expect(compareVersions("0.1.0", "0.0.9")).toBeGreaterThan(0);
    expect(compareVersions("v0.0.5", "0.0.5")).toBe(0);
  });

  it("versionFromTag strips v prefix", () => {
    expect(versionFromTag("v0.0.5")).toBe("0.0.5");
    expect(versionFromTag("0.0.5")).toBe("0.0.5");
  });

  it("detectPlatform maps node process.platform/arch", () => {
    const p = detectPlatform("darwin", "arm64");
    expect(p).toEqual({ os: "darwin", arch: "arm64", asset: "lebop-darwin-arm64" });
    expect(detectPlatform("linux", "x64").asset).toBe("lebop-linux-x64");
  });

  it("isReleaseBinary rejects shebang scripts", () => {
    const dir = mkdtempSync(join(tmpdir(), "lebop-upd-"));
    const script = join(dir, "lebop");
    writeFileSync(script, "#!/usr/bin/env bun\nconsole.log(1)\n");
    expect(isReleaseBinary(script)).toBe(false);
    const bin = join(dir, "bin");
    writeFileSync(bin, Buffer.from([0xcf, 0xfa, 0xed, 0xfe])); // fake Mach-O-ish
    expect(isReleaseBinary(bin)).toBe(true);
  });

  it("resolveInstallTarget prefers LEBOP_INSTALL_DIR", () => {
    const dir = mkdtempSync(join(tmpdir(), "lebop-inst-"));
    mkdirSync(dir, { recursive: true });
    const r = resolveInstallTarget({
      installDir: dir,
      execPath: "/usr/bin/bun",
      argv1: join(dir, "wrapper"),
      home: dir,
    });
    expect(r.install_target).toBe(join(dir, "lebop"));
  });
});
