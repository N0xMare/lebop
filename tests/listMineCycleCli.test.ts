import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveConfig: vi.fn(),
  getTeam: vi.fn(),
  listIssuesWithMetadata: vi.fn(),
  listCycles: vi.fn(),
}));

vi.mock("../src/lib/config.ts", () => ({
  resolveConfig: mocks.resolveConfig,
}));

vi.mock("../src/lib/teams.ts", () => ({
  getTeam: mocks.getTeam,
}));

vi.mock("../src/lib/listIssues.ts", () => ({
  listIssuesWithMetadata: mocks.listIssuesWithMetadata,
}));

vi.mock("../src/lib/cycles.ts", () => ({
  listCycles: mocks.listCycles,
}));

import { registerCycle } from "../src/commands/cycle.ts";
import { registerList } from "../src/commands/list.ts";
import { registerMine } from "../src/commands/mine.ts";

describe("CLI all-teams issue/cycle commands", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mocks.resolveConfig.mockRejectedValue(new Error("resolveConfig should not be called"));
    mocks.getTeam.mockResolvedValue({ id: "team-nox", key: "NOX" });
    mocks.listIssuesWithMetadata.mockResolvedValue({
      issues: [],
      count: 0,
      limit: 50,
      has_more: false,
      next_cursor: null,
      truncated: false,
    });
    mocks.listCycles.mockResolvedValue([]);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it("list --all-teams does not require a configured default team", async () => {
    const program = new Command();
    registerList(program);

    await program.parseAsync(["list", "--all-teams", "--json"], { from: "user" });

    expect(mocks.resolveConfig).not.toHaveBeenCalled();
    expect(mocks.listIssuesWithMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedTeam: undefined, allTeams: true }),
    );
  });

  it("list forwards cursor to the page-aware issue helper", async () => {
    const program = new Command();
    registerList(program);

    await program.parseAsync(["list", "--all-teams", "--cursor", "cursor-1", "--json"], {
      from: "user",
    });

    expect(mocks.listIssuesWithMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ after: "cursor-1" }),
    );
  });

  it("mine --all-teams does not require a configured default team", async () => {
    const program = new Command();
    registerMine(program);

    await program.parseAsync(["mine", "--all-teams", "--json"], { from: "user" });

    expect(mocks.resolveConfig).not.toHaveBeenCalled();
    expect(mocks.listIssuesWithMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedTeam: undefined, allTeams: true, assignee: "me" }),
    );
  });

  it("mine forwards cursor to the page-aware issue helper", async () => {
    const program = new Command();
    registerMine(program);

    await program.parseAsync(["mine", "--all-teams", "--cursor", "cursor-2", "--json"], {
      from: "user",
    });

    expect(mocks.listIssuesWithMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ after: "cursor-2", assignee: "me" }),
    );
  });

  it("mine --json includes explicit scope and all_teams fields", async () => {
    mocks.resolveConfig.mockResolvedValue({ team: "NOX" });
    const program = new Command();
    registerMine(program);

    await program.parseAsync(["mine", "--team", "NOX", "--json"], { from: "user" });

    const body = JSON.parse(
      stdoutSpy.mock.calls.map((call: [unknown, ...unknown[]]) => String(call[0])).join(""),
    );
    expect(body).toMatchObject({
      scope: { type: "team", team: "NOX" },
      team: "NOX",
      all_teams: false,
    });
  });

  it("cycle list --all-teams does not require a configured default team", async () => {
    const program = new Command();
    registerCycle(program);

    await program.parseAsync(["cycle", "list", "--all-teams", "--json"], { from: "user" });

    expect(mocks.resolveConfig).not.toHaveBeenCalled();
    expect(mocks.listCycles).toHaveBeenCalledWith(expect.objectContaining({ team: undefined }));
  });

  it("cycle list --team rejects unknown teams instead of returning an empty list", async () => {
    mocks.resolveConfig.mockResolvedValue({ team: "BAD" });
    mocks.getTeam.mockResolvedValue(null);
    const program = new Command();
    registerCycle(program);

    await expect(
      program.parseAsync(["cycle", "list", "--team", "BAD", "--json"], { from: "user" }),
    ).rejects.toThrow("team not found: BAD");

    expect(mocks.listCycles).not.toHaveBeenCalled();
  });

  it("mine --team rejects unknown teams instead of returning an empty list", async () => {
    mocks.resolveConfig.mockResolvedValue({ team: "BAD" });
    mocks.getTeam.mockResolvedValue(null);
    const program = new Command();
    registerMine(program);

    await expect(
      program.parseAsync(["mine", "--team", "BAD", "--json"], { from: "user" }),
    ).rejects.toThrow("team not found: BAD");

    expect(mocks.listIssuesWithMetadata).not.toHaveBeenCalled();
  });
});
