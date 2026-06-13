import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exploreLinearWorkspace: vi.fn(),
  fetchLinearWorkspace: vi.fn(),
}));

vi.mock("../src/lib/workspaceExplore.ts", () => ({
  exploreLinearWorkspace: mocks.exploreLinearWorkspace,
}));

vi.mock("../src/lib/workspaceFetch.ts", () => ({
  fetchLinearWorkspace: mocks.fetchLinearWorkspace,
}));

import { registerWorkspace } from "../src/commands/workspace.ts";
import { runWithRequestContext } from "../src/lib/requestContext.ts";

describe("workspace command adapter", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mocks.fetchLinearWorkspace.mockResolvedValue({
      root: "/tmp/lebop-context",
      index_file: "/tmp/lebop-context/index.md",
      manifest_file: "/tmp/lebop-context/manifest.json",
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("does not forward root --team context to workspace fetch", async () => {
    const program = new Command();
    registerWorkspace(program);

    await runWithRequestContext({ team: "NOX" }, () =>
      program.parseAsync(["workspace", "fetch", "/projects/project-1", "--json"], { from: "user" }),
    );

    expect(mocks.fetchLinearWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ target: "/projects/project-1" }),
    );
    expect(mocks.fetchLinearWorkspace).toHaveBeenCalledWith(
      expect.not.objectContaining({ team: expect.anything() }),
    );
  });

  it("rejects workspace fetch --team because fetch targets are concrete paths", async () => {
    const program = new Command();
    program.exitOverride();
    registerWorkspace(program);

    await expect(
      runWithRequestContext({ team: "NOX" }, () =>
        program.parseAsync(
          ["workspace", "fetch", "/projects/project-1", "--team", "ENG", "--json"],
          {
            from: "user",
          },
        ),
      ),
    ).rejects.toThrow(/unknown option '--team'/);

    expect(mocks.fetchLinearWorkspace).not.toHaveBeenCalled();
  });
});
