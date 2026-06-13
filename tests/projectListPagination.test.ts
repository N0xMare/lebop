import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidationError } from "../src/lib/errors.ts";
import type { ListedProject } from "../src/lib/projects.ts";
import { executeProjectList } from "../src/surface/projects.ts";

const mocks = vi.hoisted(() => ({
  listProjectsPage: vi.fn(),
  listProjects: vi.fn(),
}));

vi.mock("../src/lib/projects.ts", () => ({
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  getProject: vi.fn(),
  listProjects: mocks.listProjects,
  listProjectsPage: mocks.listProjectsPage,
  updateProject: vi.fn(),
}));

describe("executeProjectList pagination safety", () => {
  beforeEach(() => {
    mocks.listProjectsPage.mockReset();
    mocks.listProjects.mockReset();
  });

  it("rejects repeated continuation cursors", async () => {
    mocks.listProjectsPage
      .mockResolvedValueOnce({
        nodes: [project("project-1")],
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
      })
      .mockResolvedValueOnce({
        nodes: [project("project-2")],
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
      });

    await expect(
      executeProjectList({ allTeams: true, max: 3 }, { resolveTeam: async () => "NOX" }),
    ).rejects.toMatchObject({
      code: "validation_error",
      message: "project list pagination returned a repeated cursor",
    } satisfies Partial<ValidationError>);
  });

  it("rejects continuation pages that report no cursor", async () => {
    mocks.listProjectsPage.mockResolvedValueOnce({
      nodes: [project("project-1")],
      pageInfo: { hasNextPage: true, endCursor: null },
    });

    await expect(
      executeProjectList({ allTeams: true, max: 3 }, { resolveTeam: async () => "NOX" }),
    ).rejects.toMatchObject({
      code: "validation_error",
      message: "project list pagination reported more pages without a continuation cursor",
    } satisfies Partial<ValidationError>);
  });

  it("rejects zero-progress continuation pages", async () => {
    mocks.listProjectsPage
      .mockResolvedValueOnce({
        nodes: [project("project-1")],
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
      })
      .mockResolvedValueOnce({
        nodes: [],
        pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
      });

    await expect(
      executeProjectList({ allTeams: true, max: 3 }, { resolveTeam: async () => "NOX" }),
    ).rejects.toMatchObject({
      code: "validation_error",
      message: "project list pagination made no progress",
    } satisfies Partial<ValidationError>);
  });
});

function project(id: string): ListedProject {
  return {
    id,
    name: id,
    description: null,
    icon: null,
    state: "planned",
    url: `https://linear.app/nox/project/${id}`,
    updated_at: "2026-06-05T00:00:00.000Z",
    archived_at: null,
  };
}
