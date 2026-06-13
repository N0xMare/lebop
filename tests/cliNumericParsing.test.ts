import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bulkUpdateIssues: vi.fn(),
  gcCache: vi.fn(),
  statusAction: vi.fn(),
  createMilestone: vi.fn(),
  updateMilestone: vi.fn(),
  deleteMilestone: vi.fn(),
  getMilestone: vi.fn(),
  listMilestones: vi.fn(),
  resolveProjectId: vi.fn(),
  archiveInitiative: vi.fn(),
  createInitiative: vi.fn(),
  deleteInitiative: vi.fn(),
  getInitiative: vi.fn(),
  initiativeAddProject: vi.fn(),
  initiativeRemoveProject: vi.fn(),
  listInitiatives: vi.fn(),
  resolveInitiativeId: vi.fn(),
  unarchiveInitiative: vi.fn(),
  updateInitiative: vi.fn(),
}));

vi.mock("../src/lib/bulk.ts", () => ({
  bulkUpdateIssues: mocks.bulkUpdateIssues,
}));

vi.mock("../src/lib/cache.ts", () => ({
  gcCache: mocks.gcCache,
}));

vi.mock("../src/commands/status.ts", () => ({
  statusAction: mocks.statusAction,
}));

vi.mock("../src/lib/milestones.ts", () => ({
  createMilestone: mocks.createMilestone,
  updateMilestone: mocks.updateMilestone,
  deleteMilestone: mocks.deleteMilestone,
  getMilestone: mocks.getMilestone,
  listMilestones: mocks.listMilestones,
  resolveProjectId: mocks.resolveProjectId,
}));

vi.mock("../src/lib/initiatives.ts", () => ({
  archiveInitiative: mocks.archiveInitiative,
  createInitiative: mocks.createInitiative,
  deleteInitiative: mocks.deleteInitiative,
  getInitiative: mocks.getInitiative,
  initiativeAddProject: mocks.initiativeAddProject,
  initiativeRemoveProject: mocks.initiativeRemoveProject,
  listInitiatives: mocks.listInitiatives,
  resolveInitiativeId: mocks.resolveInitiativeId,
  unarchiveInitiative: mocks.unarchiveInitiative,
  updateInitiative: mocks.updateInitiative,
}));

import { registerBulk } from "../src/commands/bulk.ts";
import { registerCache } from "../src/commands/cache.ts";
import { registerInitiative } from "../src/commands/initiative.ts";
import { registerMilestone } from "../src/commands/milestone.ts";

describe("strict numeric CLI parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it("rejects malformed bulk update --estimate before mutating", async () => {
    const program = new Command();
    registerBulk(program);

    await expect(
      program.parseAsync(["bulk", "update", "NOX-1", "--estimate", "1abc"], { from: "user" }),
    ).rejects.toThrow(/invalid --estimate value "1abc"/);

    expect(mocks.bulkUpdateIssues).not.toHaveBeenCalled();
  });

  it("bulk update --json sets a failing exit code for row failures", async () => {
    mocks.bulkUpdateIssues.mockResolvedValueOnce({
      results: [
        {
          identifier: "NOX-1",
          status: "failed",
          error: { code: "not_found", message: "not found" },
        },
      ],
      summary: { updated: 0, would_update: 0, failed: 1, total: 1, dry_run: false },
      cache: {
        checked: true,
        policy: "refresh-updated-rows-if-cached",
        refreshed: 0,
        failed: 0,
        not_cached: 0,
        rows: [],
      },
    });
    const output: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      const program = new Command();
      registerBulk(program);

      await program.parseAsync(
        ["bulk", "update", "NOX-1", "--priority", "high", "--yes", "--json"],
        {
          from: "user",
        },
      );
    } finally {
      stdout.mockRestore();
    }

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(output.join("")).summary.failed).toBe(1);
  });

  it("bulk update rejects a real mutation without --yes or --confirm", async () => {
    const program = new Command();
    registerBulk(program);

    await expect(
      program.parseAsync(["bulk", "update", "NOX-1", "--priority", "high", "--json"], {
        from: "user",
      }),
    ).rejects.toThrow(/without --yes/);

    expect(mocks.bulkUpdateIssues).not.toHaveBeenCalled();
  });

  it("bulk update --json sets a failing exit code for cache refresh failures", async () => {
    mocks.bulkUpdateIssues.mockResolvedValueOnce({
      results: [{ identifier: "NOX-1", status: "updated", fields: ["priority"] }],
      summary: { updated: 1, would_update: 0, failed: 0, total: 1, dry_run: false },
      cache: {
        checked: true,
        policy: "refresh-updated-rows-if-cached",
        refreshed: 0,
        failed: 1,
        not_cached: 0,
        rows: [
          {
            identifier: "NOX-1",
            present: true,
            refreshed: false,
            error: "writeback failed",
          },
        ],
      },
    });
    const output: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      const program = new Command();
      registerBulk(program);

      await program.parseAsync(
        ["bulk", "update", "NOX-1", "--priority", "high", "--yes", "--json"],
        {
          from: "user",
        },
      );
    } finally {
      stdout.mockRestore();
    }

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(output.join("")).cache.failed).toBe(1);
  });

  it("rejects malformed milestone create --sort-order before resolving project", async () => {
    const program = new Command();
    registerMilestone(program);

    await expect(
      program.parseAsync(
        ["milestone", "create", "M1", "--project-id", "proj-1", "--sort-order", "5abc"],
        { from: "user" },
      ),
    ).rejects.toThrow(/invalid --sort-order value "5abc"/);

    expect(mocks.resolveProjectId).not.toHaveBeenCalled();
    expect(mocks.createMilestone).not.toHaveBeenCalled();
  });

  it("rejects malformed milestone update --sort-order before mutating", async () => {
    const program = new Command();
    registerMilestone(program);

    await expect(
      program.parseAsync(["milestone", "update", "milestone-1", "--sort-order", "Infinity"], {
        from: "user",
      }),
    ).rejects.toThrow(/invalid --sort-order value "Infinity"/);

    expect(mocks.updateMilestone).not.toHaveBeenCalled();
  });

  it("rejects malformed initiative add-project --sort-order before resolving ids", async () => {
    const program = new Command();
    registerInitiative(program);

    await expect(
      program.parseAsync(
        ["initiative", "add-project", "init-1", "proj-1", "--sort-order", "1abc"],
        { from: "user" },
      ),
    ).rejects.toThrow(/invalid --sort-order value "1abc"/);

    expect(mocks.resolveInitiativeId).not.toHaveBeenCalled();
    expect(mocks.resolveProjectId).not.toHaveBeenCalled();
    expect(mocks.initiativeAddProject).not.toHaveBeenCalled();
  });

  it("rejects malformed cache gc numeric options before deleting", async () => {
    const program = new Command();
    registerCache(program);

    await expect(
      program.parseAsync(["cache", "gc", "--max-age", "0x10", "--no-dry-run"], {
        from: "user",
      }),
    ).rejects.toThrow(/invalid --max-age value "0x10"/);

    expect(mocks.gcCache).not.toHaveBeenCalled();
  });

  it("requires --yes before cache gc deletes", async () => {
    const program = new Command();
    registerCache(program);

    await expect(
      program.parseAsync(["cache", "gc", "--hash", "repo-hash", "--no-dry-run"], {
        from: "user",
      }),
    ).rejects.toThrow(/cache gc deletion requires --yes/);

    expect(mocks.gcCache).not.toHaveBeenCalled();
  });

  it("allows confirmed cache gc deletion", async () => {
    mocks.gcCache.mockResolvedValueOnce({
      totalSizeBeforeMb: 1,
      totalSizeAfterMb: 0,
      candidates: [],
      removed: [],
      errors: [],
    });
    let stdoutText = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutText += String(chunk);
      return true;
    });
    const program = new Command();
    registerCache(program);

    try {
      await program.parseAsync(
        ["cache", "gc", "--hash", "repo-hash", "--no-dry-run", "--yes", "--json"],
        { from: "user" },
      );
    } finally {
      stdout.mockRestore();
    }

    expect(mocks.gcCache).toHaveBeenCalledWith(
      expect.objectContaining({ hash: "repo-hash", dryRun: false }),
    );
    expect(JSON.parse(stdoutText)).toMatchObject({
      schema_version: 1,
      dry_run: false,
      totalSizeBeforeMb: 1,
      totalSizeAfterMb: 0,
    });
  });
});
