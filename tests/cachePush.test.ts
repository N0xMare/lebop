import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueMetadata, ProjectMetadata } from "../src/lib/cache.ts";

const rawRequest = vi.fn();
let home: string;
let prevHome: string | undefined;
let prevBun: unknown;

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (client: { client: { rawRequest: typeof rawRequest } }) => T) =>
    fn({ client: { rawRequest } }),
}));

describe("cache push remote safety", () => {
  beforeEach(() => {
    rawRequest.mockReset();
    vi.resetModules();
    prevHome = process.env.LEBOP_HOME;
    prevBun = (globalThis as { Bun?: unknown }).Bun;
    (
      globalThis as unknown as {
        Bun?: {
          write: (path: string, content: string) => Promise<number>;
          file: (path: string) => { text: () => Promise<string> };
        };
      }
    ).Bun = {
      write: async (path: string, content: string) => {
        writeFileSync(path, content);
        return content.length;
      },
      file: (path: string) => ({
        text: async () => readFileSync(path, "utf8"),
      }),
    };
    home = mkdtempSync(join(tmpdir(), "lebop-cache-push-test-"));
    process.env.LEBOP_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.LEBOP_HOME;
    else process.env.LEBOP_HOME = prevHome;
    (globalThis as { Bun?: unknown }).Bun = prevBun;
  });

  it("records missing remotes in cache publish snapshots", async () => {
    rawRequest.mockResolvedValueOnce({ data: { a0: null } });
    const { collectCacheRemoteSnapshot } = await import("../src/lib/cachePush.ts");

    const snapshot = await collectCacheRemoteSnapshot([
      {
        kind: "issue",
        identifier: "NOX-404",
        metadata: issueMetadata("NOX-404"),
        description: "changed body",
        changes: [{ field: "description", from: "old", to: "changed body" }],
        cache_path: "/tmp/cache/NOX-404",
      },
    ]);

    expect(snapshot).toMatchObject({
      issues: [],
      projects: [],
      missing: [{ kind: "issue", target: "NOX-404" }],
    });
  });

  it("fails implicit plan collection when cache rows have integrity problems", async () => {
    const { repoCacheDir } = await import("../src/lib/cache.ts");
    const issuePath = join(repoCacheDir("_global"), "issues", "NOX-999");
    mkdirSync(issuePath, { recursive: true });
    writeFileSync(join(issuePath, "metadata.yaml"), "{}");
    const { collectCachePushPlans } = await import("../src/lib/cachePush.ts");

    const err = await collectCachePushPlans("_global").catch((e) => e);

    expect(err).toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("cache has 1 integrity problem"),
    });
    expect(err.hint).toContain("lebop pull NOX-999 --refresh --yes");
  });

  it("blocks missing remotes during cache push preview", async () => {
    rawRequest.mockResolvedValueOnce({ data: { a0: null } });
    const { applyCachePushPlans } = await import("../src/lib/cachePush.ts");

    const preview = await applyCachePushPlans({
      repoHash: "_global",
      team: "NOX",
      dryRun: true,
      plans: [
        {
          kind: "issue",
          identifier: "NOX-404",
          metadata: issueMetadata("NOX-404"),
          description: "changed body",
          changes: [{ field: "description", from: "old", to: "changed body" }],
          cache_path: "/tmp/cache/NOX-404",
        },
      ],
      lintCtx: {},
    });

    expect(preview.summary).toMatchObject({ total: 1, applied: 0, failed: 1 });
    expect(preview.results[0]).toMatchObject({
      target: "NOX-404",
      kind: "issue",
      status: "remote-missing",
    });
  });

  it("verifies cache push results by refetching current remote issues", async () => {
    rawRequest.mockResolvedValueOnce({
      data: { a0: fetchedIssue({ title: "Cached issue", description: "changed body" }) },
    });
    const { verifyCachePushPlansClean } = await import("../src/lib/cachePush.ts");

    const verification = await verifyCachePushPlansClean("_global", [
      {
        kind: "issue",
        identifier: "NOX-404",
        metadata: issueMetadata("NOX-404"),
        description: "changed body",
        changes: [{ field: "description", from: "old", to: "changed body" }],
        cache_path: "/tmp/cache/NOX-404",
      },
    ]);

    expect(verification).toEqual({ clean: true, dirty: [] });
    expect(rawRequest).toHaveBeenCalledOnce();
    expect(rawRequest.mock.calls[0]?.[0]).toContain("query PullIssues");
  });

  it("reports dirty cache push verification when fresh remote content differs", async () => {
    rawRequest.mockResolvedValueOnce({
      data: { a0: fetchedIssue({ title: "Remote edited", description: "changed body" }) },
    });
    const { verifyCachePushPlansClean } = await import("../src/lib/cachePush.ts");

    const verification = await verifyCachePushPlansClean("_global", [
      {
        kind: "issue",
        identifier: "NOX-404",
        metadata: issueMetadata("NOX-404"),
        description: "changed body",
        changes: [{ field: "title", from: "old", to: "Cached issue" }],
        cache_path: "/tmp/cache/NOX-404",
      },
    ]);

    expect(verification).toEqual({ clean: false, dirty: ["NOX-404"] });
  });

  it("accepts Linear trailing-newline normalization for reviewed issue content", async () => {
    rawRequest.mockResolvedValueOnce({
      data: { a0: fetchedIssue({ title: "Cached issue", description: "changed body" }) },
    });
    const { verifyCachePushPlansClean } = await import("../src/lib/cachePush.ts");

    const verification = await verifyCachePushPlansClean("_global", [
      {
        kind: "issue",
        identifier: "NOX-404",
        metadata: issueMetadata("NOX-404"),
        description: "changed body\n",
        changes: [{ field: "description", from: "old", to: "changed body\n" }],
        cache_path: "/tmp/cache/NOX-404",
      },
    ]);

    expect(verification).toEqual({ clean: true, dirty: [] });
  });

  it("accepts Linear trailing-newline normalization for reviewed project content", async () => {
    const projectId = "11111111-1111-1111-1111-111111111111";
    rawRequest.mockResolvedValueOnce({
      data: {
        project: fetchedProject({
          id: projectId,
          name: "Cached project",
          content: "reviewed project content",
        }),
      },
    });
    const { verifyCachePushPlansClean } = await import("../src/lib/cachePush.ts");

    const verification = await verifyCachePushPlansClean("_global", [
      {
        kind: "project",
        id: projectId,
        metadata: projectMetadata(projectId),
        content: "reviewed project content\n",
        changes: [{ field: "content", from: "old", to: "reviewed project content\n" }],
        cache_path: `/tmp/cache/${projectId}`,
      },
    ]);

    expect(verification).toEqual({ clean: true, dirty: [] });
  });

  it("can retry cache push verification when a fresh project read is briefly stale", async () => {
    const projectId = "11111111-1111-1111-1111-111111111111";
    rawRequest
      .mockResolvedValueOnce({
        data: {
          project: fetchedProject({
            id: projectId,
            name: "Cached project",
            content: "old project content",
          }),
        },
      })
      .mockResolvedValueOnce({
        data: {
          project: fetchedProject({
            id: projectId,
            name: "Cached project",
            content: "reviewed project content",
          }),
        },
      });
    const { verifyCachePushPlansClean } = await import("../src/lib/cachePush.ts");

    const verification = await verifyCachePushPlansClean(
      "_global",
      [
        {
          kind: "project",
          id: projectId,
          metadata: projectMetadata(projectId),
          content: "reviewed project content",
          changes: [{ field: "content", from: "old", to: "reviewed project content" }],
          cache_path: `/tmp/cache/${projectId}`,
        },
      ],
      { attempts: 2, delayMs: 0 },
    );

    expect(verification).toEqual({ clean: true, dirty: [] });
    expect(rawRequest).toHaveBeenCalledTimes(2);
  });

  it("verifies issue publish against the reviewed plan, not post-apply cache content", async () => {
    rawRequest.mockResolvedValueOnce({
      data: {
        a0: fetchedIssue({
          title: "Cached issue",
          description: "server normalized body",
        }),
      },
    });
    const { writeIssue } = await import("../src/lib/cache.ts");
    const { verifyCachePushPlansClean } = await import("../src/lib/cachePush.ts");
    await writeIssue("_global", issueMetadata("NOX-404"), "server normalized body");

    const verification = await verifyCachePushPlansClean("_global", [
      {
        kind: "issue",
        identifier: "NOX-404",
        metadata: issueMetadata("NOX-404"),
        description: "pre-apply body",
        changes: [{ field: "description", from: "old", to: "pre-apply body" }],
        cache_path: "/tmp/cache/NOX-404",
      },
    ]);

    expect(verification).toEqual({ clean: false, dirty: ["NOX-404"] });
  });

  it("verifies project publish against the reviewed plan, not post-apply cache content", async () => {
    const projectId = "11111111-1111-1111-1111-111111111111";
    rawRequest.mockResolvedValueOnce({
      data: {
        project: fetchedProject({
          id: projectId,
          name: "Cached project",
          content: "server normalized content",
        }),
      },
    });
    const { writeProject } = await import("../src/lib/cache.ts");
    const { verifyCachePushPlansClean } = await import("../src/lib/cachePush.ts");
    await writeProject("_global", projectMetadata(projectId), "server normalized content");

    const verification = await verifyCachePushPlansClean("_global", [
      {
        kind: "project",
        id: projectId,
        metadata: projectMetadata(projectId),
        content: "reviewed project content",
        changes: [{ field: "content", from: "old", to: "reviewed project content" }],
        cache_path: `/tmp/cache/${projectId}`,
      },
    ]);

    expect(verification).toEqual({ clean: false, dirty: [`project/${projectId}`] });
  });

  it("reports cache writeback failure separately after a successful remote issue update", async () => {
    vi.doMock("../src/lib/resolve.ts", () => ({
      getTeamMetadata: async () => ({
        team_id: "team-nox",
        team_key: "NOX",
        fetched_at: "2026-06-05T00:00:00.000Z",
        states: [],
        labels: [],
        members: [],
        projects: [],
      }),
      withFreshMetadataOnMiss: async <T>(
        fetch: () => Promise<unknown>,
        use: (metadata: unknown) => Promise<T>,
      ) => use(await fetch()),
    }));
    rawRequest
      .mockResolvedValueOnce({
        data: {
          a0: { id: "issue-uuid", identifier: "NOX-404", updatedAt: "2026-06-04T00:00:00.000Z" },
        },
      })
      .mockResolvedValueOnce({
        data: {
          a0: { id: "issue-uuid", identifier: "NOX-404", updatedAt: "2026-06-04T00:00:00.000Z" },
        },
      })
      .mockResolvedValueOnce({
        data: {
          issueUpdate: {
            success: true,
            issue: fetchedIssue({ title: "Updated cached issue", description: "changed body" }),
          },
        },
      });
    (
      globalThis as unknown as {
        Bun: {
          write: (path: string, content: string) => Promise<number>;
          file: (path: string) => { text: () => Promise<string> };
        };
      }
    ).Bun.write = async () => {
      throw new Error("disk full");
    };
    const { applyCachePushPlans } = await import("../src/lib/cachePush.ts");

    const result = await applyCachePushPlans({
      repoHash: "_global",
      team: "NOX",
      plans: [
        {
          kind: "issue",
          identifier: "NOX-404",
          metadata: issueMetadata("NOX-404", { title: "Updated cached issue" }),
          description: "changed body",
          changes: [{ field: "title", from: "Cached issue", to: "Updated cached issue" }],
          cache_path: "/tmp/cache/NOX-404",
        },
      ],
      lintCtx: {},
    });

    expect(result.summary).toEqual({
      total: 1,
      applied: 1,
      skipped: 0,
      failed: 0,
      writeback_failed: 1,
    });
    expect(result.results[0]).toMatchObject({
      target: "NOX-404",
      kind: "issue",
      status: "pushed-writeback-failed",
      fields: ["title"],
      error: expect.stringContaining("pushed to Linear but local cache writeback failed"),
    });
  });

  it("stops remaining cache push mutations after an issue writeback failure", async () => {
    vi.doMock("../src/lib/resolve.ts", () => ({
      getTeamMetadata: async () => ({
        team_id: "team-nox",
        team_key: "NOX",
        fetched_at: "2026-06-05T00:00:00.000Z",
        states: [],
        labels: [],
        members: [],
        projects: [],
      }),
      withFreshMetadataOnMiss: async <T>(
        fetch: () => Promise<unknown>,
        use: (metadata: unknown) => Promise<T>,
      ) => use(await fetch()),
    }));
    rawRequest
      .mockResolvedValueOnce({
        data: {
          a0: {
            id: "issue-uuid-404",
            identifier: "NOX-404",
            updatedAt: "2026-06-04T00:00:00.000Z",
          },
          a1: {
            id: "issue-uuid-405",
            identifier: "NOX-405",
            updatedAt: "2026-06-04T00:00:00.000Z",
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          a0: {
            id: "issue-uuid-404",
            identifier: "NOX-404",
            updatedAt: "2026-06-04T00:00:00.000Z",
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          issueUpdate: {
            success: true,
            issue: fetchedIssue({ title: "Updated cached issue", description: "changed body" }),
          },
        },
      });
    (
      globalThis as unknown as {
        Bun: {
          write: (path: string, content: string) => Promise<number>;
          file: (path: string) => { text: () => Promise<string> };
        };
      }
    ).Bun.write = async () => {
      throw new Error("disk full");
    };
    const { applyCachePushPlans } = await import("../src/lib/cachePush.ts");

    const result = await applyCachePushPlans({
      repoHash: "_global",
      team: "NOX",
      plans: [
        {
          kind: "issue",
          identifier: "NOX-404",
          metadata: issueMetadata("NOX-404", { title: "Updated cached issue" }),
          description: "changed body",
          changes: [{ field: "title", from: "Cached issue", to: "Updated cached issue" }],
          cache_path: "/tmp/cache/NOX-404",
        },
        {
          kind: "issue",
          identifier: "NOX-405",
          metadata: issueMetadata("NOX-405", { title: "Second cached issue" }),
          description: "second body",
          changes: [{ field: "title", from: "Cached issue", to: "Second cached issue" }],
          cache_path: "/tmp/cache/NOX-405",
        },
      ],
      lintCtx: {},
    });

    expect(result.summary).toEqual({
      total: 2,
      applied: 1,
      skipped: 0,
      failed: 1,
      writeback_failed: 1,
    });
    expect(result.results[0]).toMatchObject({ status: "pushed-writeback-failed" });
    expect(result.results[1]).toMatchObject({
      target: "NOX-405",
      status: "error",
      error: expect.stringContaining("skipped because cache writeback failed"),
    });
    expect(rawRequest).toHaveBeenCalledTimes(3);
  });

  it("stops remaining project cache push mutations after project writeback failure", async () => {
    const projectOne = "11111111-1111-1111-1111-111111111111";
    const projectTwo = "22222222-2222-2222-2222-222222222222";
    rawRequest
      .mockResolvedValueOnce({
        data: {
          p0: { id: projectOne, updatedAt: "2026-06-04T00:00:00.000Z" },
          p1: { id: projectTwo, updatedAt: "2026-06-04T00:00:00.000Z" },
        },
      })
      .mockResolvedValueOnce({
        data: {
          p0: { id: projectOne, updatedAt: "2026-06-04T00:00:00.000Z" },
        },
      })
      .mockResolvedValueOnce({
        data: {
          projectUpdate: {
            success: true,
            project: fetchedProject({
              id: projectOne,
              name: "Updated cached project",
              content: "project body",
            }),
          },
        },
      });
    (
      globalThis as unknown as {
        Bun: {
          write: (path: string, content: string) => Promise<number>;
          file: (path: string) => { text: () => Promise<string> };
        };
      }
    ).Bun.write = async () => {
      throw new Error("disk full");
    };
    const { applyCachePushPlans } = await import("../src/lib/cachePush.ts");

    const result = await applyCachePushPlans({
      repoHash: "_global",
      team: "NOX",
      plans: [
        {
          kind: "project",
          id: projectOne,
          metadata: projectMetadata(projectOne, { name: "Updated cached project" }),
          content: "project body",
          changes: [{ field: "name", from: "Cached project", to: "Updated cached project" }],
          cache_path: `/tmp/cache/${projectOne}`,
        },
        {
          kind: "project",
          id: projectTwo,
          metadata: projectMetadata(projectTwo, { name: "Second cached project" }),
          content: "second body",
          changes: [{ field: "name", from: "Cached project", to: "Second cached project" }],
          cache_path: `/tmp/cache/${projectTwo}`,
        },
      ],
      lintCtx: {},
    });

    expect(result.summary).toEqual({
      total: 2,
      applied: 1,
      skipped: 0,
      failed: 1,
      writeback_failed: 1,
    });
    expect(result.results[0]).toMatchObject({ status: "pushed-writeback-failed" });
    expect(result.results[1]).toMatchObject({
      target: "Second cached project",
      status: "error",
      error: expect.stringContaining("skipped because cache writeback failed"),
    });
    expect(rawRequest).toHaveBeenCalledTimes(3);
  });

  it("blocks emoji project icons before cache push preview", async () => {
    const projectId = "11111111-1111-1111-1111-111111111111";
    rawRequest.mockResolvedValueOnce({
      data: {
        p0: { id: projectId, updatedAt: "2026-06-04T00:00:00.000Z" },
      },
    });
    const { applyCachePushPlans } = await import("../src/lib/cachePush.ts");

    const result = await applyCachePushPlans({
      repoHash: "_global",
      team: "NOX",
      dryRun: true,
      plans: [
        {
          kind: "project",
          id: projectId,
          metadata: projectMetadata(projectId, { icon: "🚀" }),
          content: "project body",
          changes: [{ field: "icon", from: null, to: "🚀" }],
          cache_path: `/tmp/cache/${projectId}`,
        },
      ],
      lintCtx: {},
    });

    expect(result.summary).toMatchObject({ total: 1, applied: 0, failed: 1 });
    expect(result.results[0]).toMatchObject({
      target: "Cached project",
      kind: "project",
      status: "error",
      fields: ["icon"],
      error: expect.stringContaining("looks like an emoji"),
    });
    expect(rawRequest).toHaveBeenCalledOnce();
  });

  it("pushes project start and target dates from the reviewed cache source", async () => {
    const projectId = "11111111-1111-1111-1111-111111111111";
    rawRequest
      .mockResolvedValueOnce({
        data: {
          p0: { id: projectId, updatedAt: "2026-06-04T00:00:00.000Z" },
        },
      })
      .mockResolvedValueOnce({
        data: {
          p0: { id: projectId, updatedAt: "2026-06-04T00:00:00.000Z" },
        },
      })
      .mockResolvedValueOnce({
        data: {
          projectUpdate: {
            success: true,
            project: fetchedProject({
              id: projectId,
              name: "Cached project",
              content: "project body",
              startDate: "2026-06-10",
              targetDate: "2026-06-20",
            }),
          },
        },
      });
    const { applyCachePushPlans } = await import("../src/lib/cachePush.ts");

    const result = await applyCachePushPlans({
      repoHash: "_global",
      team: "NOX",
      plans: [
        {
          kind: "project",
          id: projectId,
          metadata: projectMetadata(projectId, {
            start_date: "2026-06-10",
            target_date: "2026-06-20",
          }),
          content: "project body",
          changes: [
            { field: "start_date", from: null, to: "2026-06-10" },
            { field: "target_date", from: null, to: "2026-06-20" },
          ],
          cache_path: `/tmp/cache/${projectId}`,
        },
      ],
      lintCtx: {},
    });

    expect(result.summary).toMatchObject({ total: 1, applied: 1, failed: 0 });
    expect(result.results[0]).toMatchObject({
      target: "Cached project",
      kind: "project",
      status: "pushed",
      fields: ["start_date", "target_date"],
    });
    expect(rawRequest.mock.calls[2]?.[0]).toContain("mutation ProjectUpdate");
    expect(rawRequest.mock.calls[2]?.[1]).toMatchObject({
      id: projectId,
      input: { startDate: "2026-06-10", targetDate: "2026-06-20" },
    });
  });

  it("blocks issue cache push when Linear changes after preflight but before mutation", async () => {
    vi.doMock("../src/lib/resolve.ts", () => ({
      getTeamMetadata: async () => ({
        team_id: "team-nox",
        team_key: "NOX",
        fetched_at: "2026-06-05T00:00:00.000Z",
        states: [],
        labels: [],
        members: [],
        projects: [],
      }),
      withFreshMetadataOnMiss: async <T>(
        fetch: () => Promise<unknown>,
        use: (metadata: unknown) => Promise<T>,
      ) => use(await fetch()),
    }));
    rawRequest
      .mockResolvedValueOnce({
        data: {
          a0: { id: "issue-uuid", identifier: "NOX-404", updatedAt: "2026-06-04T00:00:00.000Z" },
        },
      })
      .mockResolvedValueOnce({
        data: {
          a0: { id: "issue-uuid", identifier: "NOX-404", updatedAt: "2026-06-05T00:00:00.000Z" },
        },
      });
    const { applyCachePushPlans } = await import("../src/lib/cachePush.ts");

    const result = await applyCachePushPlans({
      repoHash: "_global",
      team: "NOX",
      plans: [
        {
          kind: "issue",
          identifier: "NOX-404",
          metadata: issueMetadata("NOX-404", { title: "Updated cached issue" }),
          description: "changed body",
          changes: [{ field: "title", from: "Cached issue", to: "Updated cached issue" }],
          cache_path: "/tmp/cache/NOX-404",
        },
      ],
      lintCtx: {},
    });

    expect(result.summary).toMatchObject({ total: 1, applied: 0, failed: 1 });
    expect(result.results[0]).toMatchObject({
      target: "NOX-404",
      status: "stale",
      fields: ["title"],
      error: expect.stringContaining("remote updated since pull"),
    });
    expect(rawRequest).toHaveBeenCalledTimes(2);
    expect(rawRequest.mock.calls.some((call) => String(call[0]).includes("issueUpdate"))).toBe(
      false,
    );
  });

  it("treats any issue _server.updated_at mismatch as stale", async () => {
    const baseMetadata = issueMetadata("NOX-404");
    rawRequest.mockResolvedValueOnce({
      data: {
        a0: { id: "issue-uuid", identifier: "NOX-404", updatedAt: "2026-06-04T00:00:00.000Z" },
      },
    });
    const { applyCachePushPlans } = await import("../src/lib/cachePush.ts");

    const result = await applyCachePushPlans({
      repoHash: "_global",
      team: "NOX",
      plans: [
        {
          kind: "issue",
          identifier: "NOX-404",
          metadata: {
            ...baseMetadata,
            _server: { ...baseMetadata._server, updated_at: "2026-06-05T00:00:00.000Z" },
          },
          description: "changed body",
          changes: [{ field: "description", from: "old", to: "changed body" }],
          cache_path: "/tmp/cache/NOX-404",
        },
      ],
      lintCtx: {},
    });

    expect(result.summary).toMatchObject({ total: 1, applied: 0, failed: 1 });
    expect(result.results[0]).toMatchObject({ status: "stale" });
    expect(rawRequest).toHaveBeenCalledOnce();
  });

  it("fails closed when local issue _server.updated_at is invalid", async () => {
    const baseMetadata = issueMetadata("NOX-404");
    rawRequest.mockResolvedValueOnce({
      data: {
        a0: { id: "issue-uuid", identifier: "NOX-404", updatedAt: "2026-06-04T00:00:00.000Z" },
      },
    });
    const { applyCachePushPlans } = await import("../src/lib/cachePush.ts");

    const result = await applyCachePushPlans({
      repoHash: "_global",
      team: "NOX",
      plans: [
        {
          kind: "issue",
          identifier: "NOX-404",
          metadata: {
            ...baseMetadata,
            _server: { ...baseMetadata._server, updated_at: "not-a-date" },
          } as never,
          description: "changed body",
          changes: [{ field: "description", from: "old", to: "changed body" }],
          cache_path: "/tmp/cache/NOX-404",
        },
      ],
      lintCtx: {},
    });

    expect(result.summary).toMatchObject({ total: 1, applied: 0, failed: 1 });
    expect(result.results[0]).toMatchObject({
      status: "error",
      error: expect.stringContaining("invalid updatedAt stale-guard timestamp"),
    });
    expect(rawRequest).toHaveBeenCalledOnce();
  });

  it("treats issueUpdate success:false as an error before local cache writeback", async () => {
    vi.doMock("../src/lib/resolve.ts", () => ({
      getTeamMetadata: async () => ({
        team_id: "team-nox",
        team_key: "NOX",
        fetched_at: "2026-06-05T00:00:00.000Z",
        states: [],
        labels: [],
        members: [],
        projects: [],
      }),
      withFreshMetadataOnMiss: async <T>(
        fetch: () => Promise<unknown>,
        use: (metadata: unknown) => Promise<T>,
      ) => use(await fetch()),
    }));
    rawRequest
      .mockResolvedValueOnce({
        data: {
          a0: { id: "issue-uuid", identifier: "NOX-404", updatedAt: "2026-06-04T00:00:00.000Z" },
        },
      })
      .mockResolvedValueOnce({
        data: {
          a0: { id: "issue-uuid", identifier: "NOX-404", updatedAt: "2026-06-04T00:00:00.000Z" },
        },
      })
      .mockResolvedValueOnce({
        data: {
          issueUpdate: {
            success: false,
            issue: fetchedIssue({ title: "Updated cached issue", description: "changed body" }),
          },
        },
      });
    const { applyCachePushPlans } = await import("../src/lib/cachePush.ts");

    const result = await applyCachePushPlans({
      repoHash: "_global",
      team: "NOX",
      plans: [
        {
          kind: "issue",
          identifier: "NOX-404",
          metadata: issueMetadata("NOX-404", { title: "Updated cached issue" }),
          description: "changed body",
          changes: [{ field: "title", from: "Cached issue", to: "Updated cached issue" }],
          cache_path: "/tmp/cache/NOX-404",
        },
      ],
      lintCtx: {},
    });

    expect(result.summary).toMatchObject({ total: 1, applied: 0, failed: 1 });
    expect(result.results[0]).toMatchObject({
      status: "error",
      error: "issueUpdate failed",
    });
  });
});

function issueMetadata(identifier: string, overrides: Partial<IssueMetadata> = {}): IssueMetadata {
  return {
    identifier,
    title: "Cached issue",
    state: "Todo",
    priority: 0,
    estimate: null,
    labels: [],
    assignee: null,
    project: null,
    milestone: null,
    cycle: null,
    parent: null,
    _server: {
      id: "issue-uuid",
      identifier,
      url: "https://linear.app/nox/issue/NOX-404/cached-issue",
      state_id: "state-todo",
      state_name: "Todo",
      state_type: "unstarted",
      priority: 0,
      estimate: null,
      label_ids: [],
      assignee_id: null,
      assignee_name: null,
      assignee_email: null,
      title: "Cached issue",
      updated_at: "2026-06-04T00:00:00.000Z",
      description_hash: "hash",
      project_id: null,
      project_name: null,
      project_milestone_id: null,
      project_milestone_name: null,
      cycle_id: null,
      cycle_name: null,
      parent_id: null,
      parent_identifier: null,
    },
    ...overrides,
  } as IssueMetadata;
}

function fetchedIssue(input: { title: string; description: string }) {
  return {
    id: "issue-uuid",
    identifier: "NOX-404",
    title: input.title,
    description: input.description,
    priority: 0,
    estimate: null,
    url: "https://linear.app/nox/issue/NOX-404/cached-issue",
    updatedAt: "2026-06-05T00:00:00.000Z",
    state: { id: "state-todo", name: "Todo", type: "unstarted" },
    assignee: null,
    project: null,
    team: { id: "team-nox", key: "NOX" },
    parent: null,
    labels: { nodes: [] },
  };
}

function projectMetadata(id: string, overrides: Partial<ProjectMetadata> = {}): ProjectMetadata {
  return {
    name: "Cached project",
    description: "",
    icon: null,
    start_date: null,
    target_date: null,
    state: "planned",
    _server: {
      id,
      url: `https://linear.app/nox/project/${id}`,
      state: "planned",
      name: "Cached project",
      description: "",
      icon: null,
      start_date: null,
      target_date: null,
      content_hash: "hash",
      updated_at: "2026-06-04T00:00:00.000Z",
    },
    ...overrides,
  } as ProjectMetadata;
}

function fetchedProject(input: {
  id: string;
  name: string;
  content: string;
  startDate?: string | null;
  targetDate?: string | null;
}) {
  return {
    id: input.id,
    name: input.name,
    description: "",
    content: input.content,
    icon: null,
    startDate: input.startDate ?? null,
    targetDate: input.targetDate ?? null,
    state: "planned",
    url: `https://linear.app/nox/project/${input.id}`,
    updatedAt: "2026-06-05T00:00:00.000Z",
  };
}
