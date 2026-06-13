/**
 * Wave 3 / structured-error taxonomy: `listProjects` with a team filter that
 * doesn't resolve must surface a NotFoundError, not a raw Error. Mocks the
 * SDK so `teams(filter: { key })` returns an empty nodes array.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError, ValidationError } from "../src/lib/errors.ts";

const rawRequestSpy = vi.fn();
const teamsSpy = vi.fn<() => Promise<{ nodes: Array<{ projects?: unknown }> }>>(async () => ({
  nodes: [],
}));

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      // Always return empty nodes — exercises the "team not found" branch.
      teams: teamsSpy,
      client: { rawRequest: rawRequestSpy },
    }),
  linear: async () => ({
    client: { rawRequest: rawRequestSpy },
  }),
}));

import {
  createProject,
  createProjectUpdate,
  deleteProject,
  getProject,
  listProjects,
  listProjectUpdates,
  updateProject,
} from "../src/lib/projects.ts";

beforeEach(() => {
  rawRequestSpy.mockReset();
  teamsSpy.mockClear();
});

describe("listProjects (structured errors)", () => {
  it("team-not-found is a NotFoundError with code + hint", async () => {
    const err = await listProjects({ team: "NONEXISTENT" }).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toMatchObject({ code: "not_found", hint: expect.any(String) });
    expect(err.message).toMatch(/team not found: NONEXISTENT/);
  });

  it("passes includeArchived through team-scoped project listings", async () => {
    const teamProjectsSpy = vi.fn(async () => ({
      nodes: [projectNode({ updatedAt: new Date("2026-06-04T00:00:00.000Z") })],
      pageInfo: { hasNextPage: false, endCursor: null },
    }));
    teamsSpy.mockResolvedValueOnce({ nodes: [{ projects: teamProjectsSpy }] });

    const projects = await listProjects({ team: "NOX", includeArchived: true, max: 10 });

    expect(projects).toHaveLength(1);
    expect(teamProjectsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ includeArchived: true }),
    );
  });
});

describe("project icon support", () => {
  it("createProject passes icon and returns shaped icon", async () => {
    rawRequestSpy.mockResolvedValueOnce({
      data: {
        projectCreate: {
          success: true,
          project: projectNode({ icon: "Rocket" }),
        },
      },
    });

    const project = await createProject({
      name: "Icon Project",
      teamIds: ["team-1"],
      icon: "Rocket",
    });

    expect(rawRequestSpy.mock.calls[0]?.[1]).toMatchObject({
      input: { name: "Icon Project", teamIds: ["team-1"], icon: "Rocket" },
    });
    expect(project.icon).toBe("Rocket");
  });

  it("createProject rejects success:false before shaping the project", async () => {
    rawRequestSpy.mockResolvedValueOnce({
      data: { projectCreate: { success: false, project: projectNode() } },
    });

    const err = await createProject({ name: "Failed Project", teamIds: ["team-1"] }).catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("projectCreate failed");
  });

  it("updateProject passes icon clear and returns shaped icon", async () => {
    rawRequestSpy.mockResolvedValueOnce({
      data: {
        projectUpdate: {
          success: true,
          project: projectNode({ icon: null }),
        },
      },
    });

    const project = await updateProject("proj-1", { icon: null });

    expect(rawRequestSpy.mock.calls[0]?.[1]).toMatchObject({
      id: "proj-1",
      input: { icon: null },
    });
    expect(project.icon).toBeNull();
  });

  it("updateProject rejects success:false before shaping the project", async () => {
    rawRequestSpy.mockResolvedValueOnce({
      data: { projectUpdate: { success: false, project: projectNode() } },
    });

    const err = await updateProject("proj-1", { name: "Nope" }).catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("projectUpdate failed");
  });

  it("getProject returns icon", async () => {
    rawRequestSpy.mockResolvedValueOnce({
      data: {
        project: projectNode({ icon: "BarChart" }),
      },
    });

    const project = await getProject("proj-1");

    expect(project?.icon).toBe("BarChart");
  });
});

describe("project mutation truthfulness", () => {
  it("deleteProject rejects success:false after the live preflight", async () => {
    rawRequestSpy.mockResolvedValueOnce({ data: { project: projectNode() } });
    rawRequestSpy.mockResolvedValueOnce({ data: { projectDelete: { success: false } } });

    const err = await deleteProject("proj-1").catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("projectDelete failed");
  });

  it("createProjectUpdate rejects success:false before shaping the update", async () => {
    rawRequestSpy.mockResolvedValueOnce({
      data: {
        projectUpdateCreate: {
          success: false,
          projectUpdate: {
            id: "pu-1",
            body: "blocked",
            health: "onTrack",
            createdAt: "2026-06-04T00:00:00.000Z",
            user: null,
          },
        },
      },
    });

    const err = await createProjectUpdate({ projectId: "proj-1", body: "blocked" }).catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("projectUpdateCreate failed");
  });

  it("createProjectUpdate rejects an empty body before Linear I/O", async () => {
    const err = await createProjectUpdate({ projectId: "proj-1", body: " \n\t" }).catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("empty project update body");
    expect(rawRequestSpy).not.toHaveBeenCalled();
  });

  it("listProjectUpdates throws not_found when the parent project is missing", async () => {
    rawRequestSpy.mockResolvedValueOnce({ data: { project: null } });

    await expect(listProjectUpdates("project-missing")).rejects.toMatchObject({
      code: "not_found",
      message: "project not found: project-missing",
    });
  });
});

function projectNode(overrides: Record<string, unknown> = {}) {
  return { ...baseProjectNode(), ...overrides };
}

function baseProjectNode() {
  return {
    id: "proj-1",
    name: "Icon Project",
    description: null,
    content: null,
    icon: null,
    state: "backlog",
    url: "https://linear.app/test/project/icon-project",
    updatedAt: "2026-06-04T00:00:00.000Z",
    startDate: null,
    targetDate: null,
    archivedAt: null,
    teams: { nodes: [{ id: "team-1", key: "NOX", name: "Noxor" }] },
    lead: null,
  };
}
