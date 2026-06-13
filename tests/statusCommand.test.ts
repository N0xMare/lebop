import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collectCacheStatus: vi.fn(),
  resolveConfig: vi.fn(),
}));

vi.mock("../src/lib/cacheStatus.ts", () => ({
  collectCacheStatus: mocks.collectCacheStatus,
}));

vi.mock("../src/lib/config.ts", () => ({
  resolveConfig: mocks.resolveConfig,
}));

import { statusAction } from "../src/commands/status.ts";

describe("status command", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let output: string;

  beforeEach(() => {
    vi.clearAllMocks();
    output = "";
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    mocks.resolveConfig.mockResolvedValue({
      team: "NOX",
      repoRoot: "/repo",
      repoHash: "repo-hash",
    });
    mocks.collectCacheStatus.mockResolvedValue({
      schema_version: 1,
      team: "NOX",
      repo_root: "/repo",
      repo_hash: "repo-hash",
      modified: { issues: [], projects: [] },
      stale: [
        { kind: "issue", identifier: "NOX-1" },
        { kind: "project", id: "project-1", name: "Project One" },
      ],
      remote_conflicts: [],
      stale_check: "ok",
      clean: { issues: [], projects: [] },
      integrity: { ok: true, problems: [] },
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it("prints stale issue and project refresh selectors separately", async () => {
    await statusAction({});

    expect(output).toContain("NOX-1");
    expect(output).toContain("project/Project One");
    expect(output).toContain("issue rows: run `lebop pull TEAM-123 --refresh --yes`");
    expect(output).toContain("project rows: run `lebop pull --project-id <uuid> --refresh --yes`");
    expect(output).not.toContain("run `lebop pull <id> --refresh --yes`");
  });
});
