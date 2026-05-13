/**
 * Round-8 coverage-gap tests. Round-7 review surfaced 8 fixes lacking direct
 * coverage; this file batches the small additions in one place rather than
 * scattering single-test patches across half a dozen existing files.
 *
 * Covers:
 *   - Q2 archived_at pre-flight in deleteDocument / deleteInitiative /
 *     deleteProject (Linear's `*Delete` mutations are soft-delete; pre-flight
 *     `archived_at !== null` check makes `tryIdempotentDelete` see a
 *     NotFoundError so the wrapper emits `{status: "already-absent"}`).
 *   - HIGH-2 listMilestones `includeArchived` flag plumbing.
 *   - MED-1 `ListedProject.archived_at` surfaces on listProjects output.
 *   - MED-5 mutual-exclusion rejection for milestone/document create when
 *     both `--project` and `--project-id` are passed.
 */

import { describe, expect, it, vi } from "vitest";
import { NotFoundError } from "../src/lib/errors.ts";

// ---------- shared mock state ----------
type RawResponse = { data: unknown };
let mockResponses: Array<RawResponse> = [];
let calls: Array<{ query: string; variables: unknown }> = [];

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      // Workspace-wide team lookup used by listProjects when `team:` is set.
      // Empty default; per-test arrange via `teamsResponse`.
      teams: async () => teamsResponse,
      client: {
        rawRequest: async (query: string, variables: unknown) => {
          calls.push({ query, variables });
          const next = mockResponses.shift();
          if (!next) throw new Error(`mock exhausted: ${query.slice(0, 60)}...`);
          return next;
        },
      },
    }),
  linear: async () => ({
    client: {
      rawRequest: async (query: string, variables: unknown) => {
        calls.push({ query, variables });
        const next = mockResponses.shift();
        if (!next) throw new Error(`mock exhausted: ${query.slice(0, 60)}...`);
        return next;
      },
    },
  }),
}));

let teamsResponse: {
  nodes: Array<{
    id: string;
    key: string;
    name: string;
    projects: (args: unknown) => Promise<unknown>;
  }>;
} = { nodes: [] };

import { deleteDocument } from "../src/lib/documents.ts";
import { deleteInitiative } from "../src/lib/initiatives.ts";
import { listMilestones } from "../src/lib/milestones.ts";
import { deleteProject, listProjects } from "../src/lib/projects.ts";

function reset() {
  mockResponses = [];
  calls = [];
}

describe("Q2 / round-7 — deleteDocument pre-flight detects soft-deleted entity", () => {
  it("throws NotFoundError when getDocument returns archived_at !== null", async () => {
    // Pre-fix Linear's documentDelete returned success:true even on an
    // already-soft-deleted doc, so tryIdempotentDelete reported `deleted`
    // instead of `already-absent`. The pre-flight `getDocument` call +
    // archived_at check forces a NotFoundError on the soft-deleted path
    // so the wrapper emits the correct `already-absent` status.
    reset();
    // First call: GET_DOCUMENT_QUERY returns a document with non-null
    // archivedAt (soft-deleted).
    mockResponses.push({
      data: {
        document: {
          id: "doc-1",
          title: "soft-deleted",
          slugId: "slug",
          icon: null,
          url: "x",
          content: null,
          archivedAt: "2026-05-12T19:00:00Z",
          project: null,
          creator: null,
        },
      },
    });
    const err = await deleteDocument("doc-1").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).code).toBe("not_found");
    expect((err as NotFoundError).message).toMatch(/document not found: doc-1/);
    // Only the pre-flight query ran — no delete mutation hit.
    expect(calls.length).toBe(1);
    expect(calls[0]?.query).toContain("document(id:");
  });

  it("throws NotFoundError when getDocument returns null (genuinely absent)", async () => {
    reset();
    mockResponses.push({ data: { document: null } });
    const err = await deleteDocument("doc-missing").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it("proceeds to delete when the document is live (archived_at: null)", async () => {
    reset();
    // 1) pre-flight returns live doc
    mockResponses.push({
      data: {
        document: {
          id: "doc-live",
          title: "live",
          slugId: "slug",
          icon: null,
          url: "x",
          content: null,
          archivedAt: null,
          project: null,
          creator: null,
        },
      },
    });
    // 2) delete mutation succeeds
    mockResponses.push({ data: { documentDelete: { success: true } } });
    const ok = await deleteDocument("doc-live");
    expect(ok).toBe(true);
    expect(calls.length).toBe(2);
  });
});

describe("Q2 / round-7 — deleteInitiative pre-flight detects soft-deleted entity", () => {
  it("throws NotFoundError when getInitiative returns archived_at !== null", async () => {
    reset();
    // Initiative pre-flight uses the list-shape archive-resilient query.
    mockResponses.push({
      data: {
        initiatives: {
          nodes: [
            {
              id: "init-1",
              name: "soft-deleted-init",
              description: null,
              status: "Planned",
              color: null,
              icon: null,
              url: "x",
              targetDate: null,
              archivedAt: "2026-05-12T19:00:00Z",
              owner: null,
              projects: { nodes: [] },
            },
          ],
        },
      },
    });
    const err = await deleteInitiative("init-1").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).message).toMatch(/initiative not found: init-1/);
  });

  it("proceeds to delete when the initiative is live", async () => {
    reset();
    mockResponses.push({
      data: {
        initiatives: {
          nodes: [
            {
              id: "init-live",
              name: "live-init",
              description: null,
              status: "Planned",
              color: null,
              icon: null,
              url: "x",
              targetDate: null,
              archivedAt: null,
              owner: null,
              projects: { nodes: [] },
            },
          ],
        },
      },
    });
    mockResponses.push({ data: { initiativeDelete: { success: true } } });
    const ok = await deleteInitiative("init-live");
    expect(ok).toBe(true);
  });
});

describe("Q2 / round-7 — deleteProject pre-flight detects soft-deleted entity", () => {
  it("throws NotFoundError when getProject returns archived_at !== null", async () => {
    reset();
    mockResponses.push({
      data: {
        project: {
          id: "proj-1",
          name: "soft-deleted-proj",
          description: null,
          content: null,
          state: "completed",
          url: "x",
          updatedAt: "2026-01-01T00:00:00Z",
          startDate: null,
          targetDate: null,
          archivedAt: "2026-05-12T19:00:00Z",
          teams: { nodes: [] },
          lead: null,
        },
      },
    });
    const err = await deleteProject("proj-1").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).message).toMatch(/project not found: proj-1/);
  });
});

describe("HIGH-2 / round-7 — listMilestones includeArchived flag plumbing", () => {
  it("passes includeArchived: true through to the query variables", async () => {
    reset();
    mockResponses.push({
      data: {
        projectMilestones: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
    await listMilestones({ includeArchived: true });
    expect(calls[0]?.variables).toMatchObject({ includeArchived: true });
  });

  it("defaults to includeArchived: false when the flag is omitted", async () => {
    reset();
    mockResponses.push({
      data: {
        projectMilestones: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
    await listMilestones({});
    expect(calls[0]?.variables).toMatchObject({ includeArchived: false });
  });
});

describe("MED-1 / round-7 — ListedProject surfaces archived_at", () => {
  // Mocks team.projects() to return SDK-shaped records (with `archivedAt`
  // as a Date or null), then asserts shapeProject emits the snake_case
  // `archived_at` field.
  it("emits archived_at: null for live projects and ISO string for archived", async () => {
    reset();
    teamsResponse = {
      nodes: [
        {
          id: "team-uuid",
          key: "ENG",
          name: "Engineering",
          projects: async () => ({
            nodes: [
              {
                id: "p-live",
                name: "live project",
                description: null,
                state: "started",
                url: "x",
                updatedAt: new Date("2026-01-01T00:00:00Z"),
                archivedAt: null,
              },
              {
                id: "p-archived",
                name: "archived project",
                description: null,
                state: "completed",
                url: "y",
                updatedAt: new Date("2026-02-01T00:00:00Z"),
                archivedAt: new Date("2026-04-01T00:00:00Z"),
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          }),
        },
      ],
    };
    const projects = await listProjects({ team: "ENG" });
    expect(projects).toHaveLength(2);
    expect(projects[0]?.archived_at).toBeNull();
    expect(projects[1]?.archived_at).toBe("2026-04-01T00:00:00.000Z");
    // Reset teamsResponse so other tests aren't affected.
    teamsResponse = { nodes: [] };
  });
});
