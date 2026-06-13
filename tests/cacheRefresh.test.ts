import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchedIssue, FetchedProject } from "../src/lib/pullQuery.ts";

let home: string;
let originalHome: string | undefined;
let originalBunDescriptor: PropertyDescriptor | undefined;
let originalBunFile: unknown;
let originalBunWrite: unknown;
let descriptionReads: number;
let contentReads: number;

beforeEach(() => {
  vi.resetModules?.();
  originalHome = process.env.LEBOP_HOME;
  descriptionReads = 0;
  contentReads = 0;
  home = mkdtempSync(join(tmpdir(), "lebop-cache-refresh-"));
  process.env.LEBOP_HOME = home;
  const bunShim = {
    write: async (path: string, content: string) => {
      writeFileSync(path, content);
      return content.length;
    },
    file: (path: string) => ({
      text: async () => {
        if (path.endsWith("description.md")) {
          descriptionReads++;
          if (descriptionReads === 2) writeFileSync(path, "local issue draft");
        }
        if (path.endsWith("content.md")) {
          contentReads++;
          if (contentReads === 2) writeFileSync(path, "local project draft");
        }
        return readFileSync(path, "utf8");
      },
    }),
  };
  originalBunDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Bun");
  const existingBun = (globalThis as { Bun?: typeof bunShim }).Bun;
  if (existingBun) {
    originalBunFile = existingBun.file;
    originalBunWrite = existingBun.write;
    existingBun.file = bunShim.file;
    existingBun.write = bunShim.write;
  } else {
    originalBunFile = undefined;
    originalBunWrite = undefined;
    Object.defineProperty(globalThis, "Bun", {
      value: bunShim,
      configurable: true,
    });
  }
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.LEBOP_HOME;
  else process.env.LEBOP_HOME = originalHome;
  const existingBun = (globalThis as { Bun?: { file: unknown; write: unknown } }).Bun;
  if (existingBun && originalBunFile && originalBunWrite) {
    existingBun.file = originalBunFile;
    existingBun.write = originalBunWrite;
  } else if (originalBunDescriptor) {
    Object.defineProperty(globalThis, "Bun", originalBunDescriptor);
  } else {
    delete (globalThis as { Bun?: unknown }).Bun;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("cache refresh guarded writeback", () => {
  it("does not overwrite issue cache edits that appear after the early dirty check", async () => {
    const { buildIssueMetadata } = await import("../src/lib/build.ts");
    const { readIssue, writeIssue } = await import("../src/lib/cache.ts");
    const { refreshCachedIssueByIdentifier } = await import("../src/lib/cacheRefresh.ts");
    const initial = fetchedIssue({ description: "server body", updatedAt: "2026-06-01T00:00:00Z" });
    const fresh = fetchedIssue({ description: "fresh body", updatedAt: "2026-06-02T00:00:00Z" });
    const initialCache = buildIssueMetadata(initial);
    await writeIssue("_global", initialCache.metadata, initialCache.description);

    const result = await refreshCachedIssueByIdentifier("NOX-1", {
      repoHash: "_global",
      repoRoot: null,
      freshIssue: fresh,
    });

    expect(result).toMatchObject({
      checked: true,
      present: true,
      refreshed: false,
      dirty: { fields: ["description"] },
      error: { code: "cache_dirty" },
    });
    await expect(readIssue("_global", "NOX-1")).resolves.toMatchObject({
      description: "local issue draft",
    });
  });

  it("does not overwrite project cache edits that appear after the early dirty check", async () => {
    const { buildProjectMetadata } = await import("../src/lib/build.ts");
    const { readProject, writeProject } = await import("../src/lib/cache.ts");
    const { refreshCachedProjectAfterUpdate } = await import("../src/lib/cacheRefresh.ts");
    const initial = fetchedProject({
      content: "server content",
      updatedAt: "2026-06-01T00:00:00Z",
    });
    const fresh = fetchedProject({ content: "fresh content", updatedAt: "2026-06-02T00:00:00Z" });
    const initialCache = buildProjectMetadata(initial);
    await writeProject("_global", initialCache.metadata, initialCache.content);

    const result = await refreshCachedProjectAfterUpdate(
      {
        id: fresh.id,
        name: fresh.name,
        description: fresh.description,
        content: fresh.content,
        icon: fresh.icon,
        state: fresh.state,
        start_date: fresh.startDate ?? null,
        target_date: fresh.targetDate ?? null,
        url: fresh.url,
        updated_at: fresh.updatedAt,
        archived_at: null,
        teams: [],
        lead: null,
      },
      { repoHash: "_global", repoRoot: null },
    );

    expect(result).toMatchObject({
      checked: true,
      present: true,
      refreshed: false,
      dirty: { fields: ["content"] },
      error: { code: "cache_dirty" },
    });
    await expect(readProject("_global", "project-1")).resolves.toMatchObject({
      content: "local project draft",
    });
  });
});

function fetchedIssue(overrides: Partial<FetchedIssue> = {}): FetchedIssue {
  return {
    id: "issue-uuid-1",
    identifier: "NOX-1",
    title: "Issue title",
    description: "server body",
    priority: 0,
    estimate: null,
    url: "https://linear.app/noxor/issue/NOX-1/issue-title",
    updatedAt: "2026-06-01T00:00:00Z",
    state: { id: "state-1", name: "Backlog", type: "backlog" },
    labels: { nodes: [] },
    assignee: null,
    project: null,
    projectMilestone: null,
    cycle: null,
    parent: null,
    ...overrides,
  } as FetchedIssue;
}

function fetchedProject(overrides: Partial<FetchedProject> = {}): FetchedProject {
  return {
    id: "project-1",
    name: "Project title",
    description: "Project description",
    content: "server content",
    icon: null,
    state: "started",
    startDate: null,
    targetDate: null,
    url: "https://linear.app/noxor/project/project-title",
    updatedAt: "2026-06-01T00:00:00Z",
    issues: { nodes: [] },
    ...overrides,
  };
}
