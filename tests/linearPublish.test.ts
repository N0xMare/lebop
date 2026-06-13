import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findGitRoot, hashRepoRoot } from "../src/lib/config.ts";

let home: string;
let planDir: string;
let prevHome: string | undefined;
let prevBun: unknown;

const teamMetadata = {
  team_id: "team-ue",
  team_key: "UE",
  fetched_at: "2026-06-05T00:00:00.000Z",
  states: [],
  labels: [],
  members: [],
  projects: [],
};

async function loadPublishLib() {
  vi.resetModules();
  vi.doMock("../src/lib/resolve.ts", async () => {
    const actual =
      await vi.importActual<typeof import("../src/lib/resolve.ts")>("../src/lib/resolve.ts");
    return {
      ...actual,
      getTeamMetadata: async () => teamMetadata,
    };
  });
  vi.doMock("../src/lib/sdk.ts", () => ({
    linear: async () => ({
      client: {
        rawRequest: handleRawRequest,
      },
    }),
    withClient: async <T>(fn: (client: { client: { rawRequest: typeof handleRawRequest } }) => T) =>
      fn({ client: { rawRequest: handleRawRequest } }),
  }));
  return await import("../src/lib/linearPublish.ts");
}

async function loadPublishLibWithPlanApplyMock(
  applyResult: unknown = {
    project: { name: "No Verify Plan", status: "created", linearId: "project-1" },
    issues: [],
    relations: [],
  },
  options: {
    rawRequest?: typeof handleRawRequest;
    onDryRun?: () => void;
  } = {},
) {
  vi.resetModules();
  const rawRequest = options.rawRequest ?? handleRawRequest;
  vi.doMock("../src/lib/resolve.ts", async () => {
    const actual =
      await vi.importActual<typeof import("../src/lib/resolve.ts")>("../src/lib/resolve.ts");
    return {
      ...actual,
      getTeamMetadata: async () => teamMetadata,
    };
  });
  vi.doMock("../src/lib/planDiff.ts", () => ({
    diffPlan: async () => ({
      project: {
        name: "No Verify Plan",
        status: "not-yet-applied",
        field_changes: [],
      },
      issues: [],
      extra_remote_issues: [],
      has_drift: false,
      has_blockers: false,
      has_incomplete_scan: false,
    }),
  }));
  vi.doMock("../src/lib/planApply.ts", () => ({
    preflightPlanApply: async () => ({ ready: true, blockers: [] }),
    applyPlan: async (_plan: unknown, _teamMetadata: unknown, opts: { dryRun?: boolean }) => {
      if (opts.dryRun) {
        options.onDryRun?.();
        return {
          project: { name: "No Verify Plan", status: "created", linearId: "project-1" },
          issues: [],
          relations: [],
        };
      }
      return applyResult;
    },
  }));
  vi.doMock("../src/lib/sdk.ts", () => ({
    withClient: async <T>(fn: (client: { client: { rawRequest: typeof handleRawRequest } }) => T) =>
      fn({ client: { rawRequest } }),
  }));
  return await import("../src/lib/linearPublish.ts");
}

async function loadPublishLibWithCacheMocks(
  options: {
    verification?: { clean: boolean; dirty: string[] };
    snapshotValidationError?: { message: string; hint: string };
    assertCacheRemoteSnapshotCurrent?: () => Promise<void>;
    applyCachePushPlans?: (input: { dryRun?: boolean }) => Promise<{
      results: Array<{
        target: string;
        kind: "issue" | "project";
        status: string;
        fields?: string[];
        error?: string;
      }>;
      summary: {
        total: number;
        applied: number;
        skipped: number;
        failed: number;
        writeback_failed?: number;
      };
    }>;
    plans?: unknown[];
  } = {},
) {
  vi.resetModules();
  const errors = options.snapshotValidationError ? await import("../src/lib/errors.ts") : null;
  const verifyCachePushPlansClean = vi.fn(
    async () => options.verification ?? { clean: true, dirty: [] },
  );
  const assertCacheRemoteSnapshotCurrent = vi.fn(
    options.assertCacheRemoteSnapshotCurrent ??
      (async () => {
        if (errors && options.snapshotValidationError) {
          throw new errors.ValidationError(
            options.snapshotValidationError.message,
            options.snapshotValidationError.hint,
          );
        }
      }),
  );
  const applyCachePushPlans = vi.fn(
    options.applyCachePushPlans ??
      (async () => ({
        results: [{ target: "NOX-1", kind: "issue", status: "pushed", fields: ["title"] }],
        summary: { total: 1, applied: 1, skipped: 0, failed: 0 },
      })),
  );
  const collectCachePushPlans = vi.fn(
    async () =>
      options.plans ?? [
        {
          kind: "issue",
          identifier: "NOX-1",
          metadata: {},
          description: "",
          changes: [{ field: "title", from: "Old", to: "New" }],
          cache_path: "/tmp/cache/NOX-1",
        },
      ],
  );
  vi.doMock("../src/lib/cachePush.ts", () => ({
    collectCachePushPlans,
    collectCacheRemoteSnapshot: async () => ({ issues: [], projects: [], missing: [] }),
    assertCacheRemoteSnapshotCurrent,
    hashCachePushPlans: () => "0".repeat(64),
    applyCachePushPlans,
    verifyCachePushPlansClean,
  }));
  return {
    publish: await import("../src/lib/linearPublish.ts"),
    store: await import("../src/lib/publishStore.ts"),
    verifyCachePushPlansClean,
    assertCacheRemoteSnapshotCurrent,
    applyCachePushPlans,
    collectCachePushPlans,
  };
}

async function handleRawRequest(query: string): Promise<unknown> {
  if (query.includes("PullIssues")) {
    return { data: { a0: null } };
  }
  throw new Error(`unexpected Linear mock query: ${query.slice(0, 80)}`);
}

function writeAuthAndConfig() {
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify(
      {
        schema_version: 2,
        workspaces: {
          test: {
            slug: "test",
            name: "Test Workspace",
            url_key: "test",
            token: "lin_api_test_publish",
            viewer: { id: "viewer", email: "viewer@example.com", name: "Viewer" },
            created_at: "2026-06-05T00:00:00.000Z",
          },
        },
        default: "test",
      },
      null,
      2,
    ),
  );
  writeFileSync(join(home, "config.yaml"), "default_team: UE\n");
}

function writePlan() {
  writeFileSync(join(planDir, "_project.md"), "---\nname: Missing Remote Plan\nteam: UE\n---\n");
  writeFileSync(
    join(planDir, "01-missing.md"),
    "---\ntitle: Missing issue\nlinear_id: UE-1\n---\n\nLocal body.\n",
  );
}

describe("linear publish review", () => {
  beforeEach(() => {
    prevHome = process.env.LEBOP_HOME;
    home = mkdtempSync(join(tmpdir(), "lebop-publish-home-"));
    planDir = mkdtempSync(join(tmpdir(), "lebop-publish-plan-"));
    process.env.LEBOP_HOME = home;
    prevBun = (globalThis as { Bun?: unknown }).Bun;
    (globalThis as { Bun?: unknown }).Bun = {
      file: (path: string) => ({
        exists: async () => existsSync(path),
        text: async () => readFileSync(path, "utf8"),
        json: async () => JSON.parse(readFileSync(path, "utf8")),
      }),
      write: async (path: string, content: string) => {
        writeFileSync(path, content);
      },
    };
    writeAuthAndConfig();
    writePlan();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(planDir, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.LEBOP_HOME;
    else process.env.LEBOP_HOME = prevHome;
    (globalThis as { Bun?: unknown }).Bun = prevBun;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("blocks plan reviews and publish when a local linear_id no longer exists remotely", async () => {
    const { publishLinearChanges, reviewLinearChanges } = await loadPublishLib();
    const store = await import("../src/lib/publishStore.ts");

    const review = await reviewLinearChanges({ source: { kind: "plan", dir: planDir } });

    expect(review.ready).toBe(false);
    expect(review.preview).toBeNull();
    expect(review.next).toBeUndefined();
    expect(review.summary.blockers).toContain("issue/UE-1: remote issue is missing");
    const record = await store.readPublishReviewRecord(review.review_id);
    expect(record.remote_snapshot?.missing).toEqual([{ kind: "issue", target: "UE-1" }]);

    const published = await publishLinearChanges({ reviewId: review.review_id });
    expect(published.status).toBe("blocked");
    expect(published.result).toBeNull();
    expect(published.summary.blockers).toContain("issue/UE-1: remote issue is missing");
  });

  it("does not publish a review record that was originally blocked", async () => {
    const { publishLinearChanges } = await loadPublishLibWithPlanApplyMock({
      project: { name: "No Verify Plan", status: "created", linearId: "project-should-not-apply" },
      issues: [],
      relations: [],
    });
    const store = await import("../src/lib/publishStore.ts");
    const record = await store.createPublishReviewRecord({
      dir: planDir,
      team: "UE",
      workspace: { url_key: "test", name: "Test Workspace" },
      remoteSnapshot: {},
      review: {
        ready: false,
        blockers: ["issue/UE-1: remote issue is missing"],
      },
    });

    const published = await publishLinearChanges({ reviewId: record.review_id });

    expect(published.status).toBe("blocked");
    expect(published.result).toBeNull();
    expect(published.summary.ready).toBe(false);
    expect(published.summary.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining("was created while blocked"),
        "issue/UE-1: remote issue is missing",
      ]),
    );
    const blockedRecord = await store.readPublishReviewRecord(record.review_id);
    expect(blockedRecord.review).toMatchObject({
      ready: false,
      status: "blocked",
      error: expect.stringContaining("was created while blocked"),
    });
    expect(blockedRecord.review?.attempt_started_at).toEqual(expect.any(String));
    expect(blockedRecord.review?.completed_at).toEqual(expect.any(String));
  });

  it("marks stale plan publish attempts blocked before throwing", async () => {
    const { publishLinearChanges } = await loadPublishLibWithPlanApplyMock();
    const store = await import("../src/lib/publishStore.ts");
    const record = await store.createPublishReviewRecord({
      dir: planDir,
      team: "UE",
      workspace: { url_key: "test", name: "Test Workspace" },
      remoteSnapshot: {},
    });
    writeFileSync(
      join(planDir, "01-missing.md"),
      "---\ntitle: Changed issue\nlinear_id: UE-1\n---\n\nChanged body.\n",
    );

    await expect(publishLinearChanges({ reviewId: record.review_id })).rejects.toThrow(/is stale/);
    const blockedRecord = await store.readPublishReviewRecord(record.review_id);

    expect(blockedRecord.review).toMatchObject({
      ready: false,
      status: "blocked",
      error: expect.stringContaining("is stale"),
    });
    expect(blockedRecord.review?.attempt_started_at).toEqual(expect.any(String));
    expect(blockedRecord.review?.completed_at).toEqual(expect.any(String));
  });

  it("returns published_unverified for plan publish when verification is skipped", async () => {
    const { publishLinearChanges } = await loadPublishLibWithPlanApplyMock();
    const store = await import("../src/lib/publishStore.ts");
    const record = await store.createPublishReviewRecord({
      dir: planDir,
      team: "UE",
      workspace: { url_key: "test", name: "Test Workspace" },
      remoteSnapshot: {},
    });

    const published = await publishLinearChanges({ reviewId: record.review_id, verify: false });

    expect(published.status).toBe("published_unverified");
    expect(published.verification).toBeNull();
  });

  it("returns published_with_drift when a plan update writeback fails", async () => {
    const { publishLinearChanges } = await loadPublishLibWithPlanApplyMock({
      project: {
        name: "No Verify Plan",
        status: "updated-writeback-failed",
        linearId: "project-1",
        error: "cache write failed",
      },
      issues: [
        {
          slug: "issue-one",
          path: "issues/issue-one.md",
          linearId: "UE-1",
          status: "updated-writeback-failed",
          error: "issue cache write failed",
        },
      ],
      relations: [],
    });
    const store = await import("../src/lib/publishStore.ts");
    const record = await store.createPublishReviewRecord({
      dir: planDir,
      team: "UE",
      workspace: { url_key: "test", name: "Test Workspace" },
      remoteSnapshot: {},
    });

    const published = await publishLinearChanges({ reviewId: record.review_id, verify: false });

    expect(published.status).toBe("published_with_drift");
    expect(published.summary.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining("project/No Verify Plan: cache write failed"),
        expect.stringContaining("issue/UE-1: issue cache write failed"),
      ]),
    );
  });

  it("blocks plan review when Linear changes between the review baseline and stored snapshot", async () => {
    let remoteUpdatedAt = "2026-06-04T00:00:00.000Z";
    const rawRequest = vi.fn(async (query: string): Promise<unknown> => {
      if (query.includes("PullIssues")) {
        return {
          data: {
            a0: {
              id: "issue-uuid",
              identifier: "UE-1",
              updatedAt: remoteUpdatedAt,
            },
          },
        };
      }
      throw new Error(`unexpected Linear mock query: ${query.slice(0, 80)}`);
    });
    const { publishLinearChanges, reviewLinearChanges } = await loadPublishLibWithPlanApplyMock(
      undefined,
      {
        rawRequest,
        onDryRun: () => {
          remoteUpdatedAt = "2026-06-04T00:01:00.000Z";
        },
      },
    );
    const store = await import("../src/lib/publishStore.ts");

    const review = await reviewLinearChanges({ source: { kind: "plan", dir: planDir } });

    expect(review.ready).toBe(false);
    expect(review.next).toBeUndefined();
    expect(review.summary.blockers.join("\n")).toContain(
      "plan publish review preflight: Linear changed after publish review: UE-1",
    );
    const record = await store.readPublishReviewRecord(review.review_id);
    expect(record.remote_snapshot?.issues).toEqual([
      {
        identifier: "UE-1",
        id: "issue-uuid",
        updated_at: "2026-06-04T00:00:00.000Z",
      },
    ]);

    const published = await publishLinearChanges({ reviewId: review.review_id });
    expect(published.status).toBe("blocked");
    expect(published.result).toBeNull();
    expect(published.summary.blockers.join("\n")).toContain(
      "Linear changed after publish review: UE-1",
    );
    const blockedRecord = await store.readPublishReviewRecord(review.review_id);
    expect(blockedRecord.review).toMatchObject({
      ready: false,
      status: "blocked",
      error: expect.stringContaining("was created while blocked"),
    });
  });

  it("returns blocked for plan publish when reviewed remotes changed after review", async () => {
    const { publishLinearChanges } = await loadPublishLibWithPlanApplyMock();
    const store = await import("../src/lib/publishStore.ts");
    const record = await store.createPublishReviewRecord({
      dir: planDir,
      team: "UE",
      workspace: { url_key: "test", name: "Test Workspace" },
      remoteSnapshot: {
        issues: [
          {
            identifier: "UE-1",
            id: "issue-uuid",
            updated_at: "2026-06-04T00:00:00.000Z",
          },
        ],
      },
    });

    const published = await publishLinearChanges({ reviewId: record.review_id });

    expect(published.status).toBe("blocked");
    expect(published.summary.ready).toBe(false);
    expect(published.summary.blockers.join("\n")).toContain(
      "plan publish preflight: Linear changed after publish review: UE-1",
    );
    const result = published.result as { project: { status: string } } | null;
    expect(result?.project.status).toBe("created");
    const blockedRecord = await store.readPublishReviewRecord(record.review_id);
    expect(blockedRecord.review).toMatchObject({
      ready: false,
      status: "blocked",
      error: expect.stringContaining("plan publish preflight"),
    });
    expect(blockedRecord.review?.attempt_started_at).toEqual(expect.any(String));
    expect(blockedRecord.review?.completed_at).toEqual(expect.any(String));
  });

  it("returns published_unverified for cache publish when verification is skipped", async () => {
    const { publish, store, verifyCachePushPlansClean } = await loadPublishLibWithCacheMocks();
    const repoRoot = findGitRoot(process.cwd());
    const repoHash = repoRoot ? hashRepoRoot(repoRoot) : "_global";
    const record = await store.createCachePublishReviewRecord({
      source: {
        kind: "cache",
        repo_hash: repoHash,
        identifiers: [],
        project_ids: [],
      },
      team: "UE",
      contentHash: "0".repeat(64),
      workspace: { url_key: "test", name: "Test Workspace" },
      remoteSnapshot: { issues: [], projects: [], missing: [] },
    });

    const published = await publish.publishLinearChanges({
      reviewId: record.review_id,
      verify: false,
    });

    expect(published.status).toBe("published_unverified");
    expect(published.verification).toBeNull();
    expect(verifyCachePushPlansClean).not.toHaveBeenCalled();
  });

  it("returns verified for cache publish only after clean fresh verification", async () => {
    const { publish, store, verifyCachePushPlansClean } = await loadPublishLibWithCacheMocks();
    const repoRoot = findGitRoot(process.cwd());
    const repoHash = repoRoot ? hashRepoRoot(repoRoot) : "_global";
    const record = await store.createCachePublishReviewRecord({
      source: {
        kind: "cache",
        repo_hash: repoHash,
        identifiers: [],
        project_ids: [],
      },
      team: "UE",
      contentHash: "0".repeat(64),
      workspace: { url_key: "test", name: "Test Workspace" },
      remoteSnapshot: { issues: [], projects: [], missing: [] },
    });

    const published = await publish.publishLinearChanges({ reviewId: record.review_id });

    expect(published.status).toBe("verified");
    expect(published.verification).toEqual({ clean: true, dirty: [] });
    expect(verifyCachePushPlansClean).toHaveBeenCalledOnce();
  });

  it("returns published_with_drift when fresh cache verification finds remote drift", async () => {
    const { publish, store } = await loadPublishLibWithCacheMocks({
      verification: { clean: false, dirty: ["NOX-1"] },
    });
    const repoRoot = findGitRoot(process.cwd());
    const repoHash = repoRoot ? hashRepoRoot(repoRoot) : "_global";
    const record = await store.createCachePublishReviewRecord({
      source: {
        kind: "cache",
        repo_hash: repoHash,
        identifiers: [],
        project_ids: [],
      },
      team: "UE",
      contentHash: "0".repeat(64),
      workspace: { url_key: "test", name: "Test Workspace" },
      remoteSnapshot: { issues: [], projects: [], missing: [] },
    });

    const published = await publish.publishLinearChanges({ reviewId: record.review_id });

    expect(published.status).toBe("published_with_drift");
    expect(published.verification).toEqual({ clean: false, dirty: ["NOX-1"] });
  });

  it("returns published_with_drift when cache push mutated Linear but cache writeback failed", async () => {
    const { publish, store, verifyCachePushPlansClean } = await loadPublishLibWithCacheMocks({
      applyCachePushPlans: async () => ({
        results: [
          {
            target: "NOX-1",
            kind: "issue",
            status: "pushed-writeback-failed",
            fields: ["title"],
            error: "pushed to Linear but local cache writeback failed: disk full",
          },
        ],
        summary: { total: 1, applied: 1, skipped: 0, failed: 0, writeback_failed: 1 },
      }),
    });
    const repoRoot = findGitRoot(process.cwd());
    const repoHash = repoRoot ? hashRepoRoot(repoRoot) : "_global";
    const record = await store.createCachePublishReviewRecord({
      source: {
        kind: "cache",
        repo_hash: repoHash,
        identifiers: [],
        project_ids: [],
      },
      team: "UE",
      contentHash: "0".repeat(64),
      workspace: { url_key: "test", name: "Test Workspace" },
      remoteSnapshot: { issues: [], projects: [], missing: [] },
    });

    const published = await publish.publishLinearChanges({ reviewId: record.review_id });

    expect(published.status).toBe("published_with_drift");
    expect(published.summary.ready).toBe(false);
    expect(published.summary.drift).toBe(true);
    expect(published.summary.blockers.join("\n")).toContain(
      "issue/NOX-1: pushed to Linear but local cache writeback failed: disk full",
    );
    const result = published.result as { summary: Record<string, unknown> } | null;
    expect(result?.summary).toMatchObject({
      total: 1,
      applied: 1,
      failed: 0,
      writeback_failed: 1,
    });
    expect(verifyCachePushPlansClean).not.toHaveBeenCalled();
  });

  it("returns published_with_drift when cache publish has mixed applied and failed rows", async () => {
    const { publish, store, verifyCachePushPlansClean } = await loadPublishLibWithCacheMocks({
      applyCachePushPlans: async () => ({
        results: [
          {
            target: "NOX-1",
            kind: "issue",
            status: "pushed",
            fields: ["title"],
          },
          {
            target: "NOX-2",
            kind: "issue",
            status: "error",
            fields: ["title"],
            error: "issueUpdate failed",
          },
        ],
        summary: { total: 2, applied: 1, skipped: 0, failed: 1 },
      }),
    });
    const repoRoot = findGitRoot(process.cwd());
    const repoHash = repoRoot ? hashRepoRoot(repoRoot) : "_global";
    const record = await store.createCachePublishReviewRecord({
      source: {
        kind: "cache",
        repo_hash: repoHash,
        identifiers: [],
        project_ids: [],
      },
      team: "UE",
      contentHash: "0".repeat(64),
      workspace: { url_key: "test", name: "Test Workspace" },
      remoteSnapshot: { issues: [], projects: [], missing: [] },
    });

    const published = await publish.publishLinearChanges({ reviewId: record.review_id });

    expect(published.status).toBe("published_with_drift");
    expect(published.summary.ready).toBe(false);
    expect(published.summary.blockers.join("\n")).toContain("issue/NOX-2: issueUpdate failed");
    expect(verifyCachePushPlansClean).not.toHaveBeenCalled();
  });

  it("returns blocked for cache publish when review-time remote snapshot preflight fails", async () => {
    const { publish, store, applyCachePushPlans } = await loadPublishLibWithCacheMocks({
      snapshotValidationError: {
        message: "Linear remote rows were missing during publish review: issue/NOX-404",
        hint: "pull the latest cache or remove the missing row from the publish review target",
      },
      applyCachePushPlans: async (input) => ({
        results: [
          {
            target: "NOX-404",
            kind: "issue",
            status: input.dryRun === true ? "remote-missing" : "pushed",
            fields: ["title"],
            error: "remote issue is missing or inaccessible",
          },
        ],
        summary:
          input.dryRun === true
            ? { total: 1, applied: 0, skipped: 0, failed: 1 }
            : { total: 1, applied: 1, skipped: 0, failed: 0 },
      }),
    });
    const repoRoot = findGitRoot(process.cwd());
    const repoHash = repoRoot ? hashRepoRoot(repoRoot) : "_global";
    const record = await store.createCachePublishReviewRecord({
      source: {
        kind: "cache",
        repo_hash: repoHash,
        identifiers: [],
        project_ids: [],
      },
      team: "UE",
      contentHash: "0".repeat(64),
      workspace: { url_key: "test", name: "Test Workspace" },
      remoteSnapshot: { issues: [], projects: [], missing: [{ kind: "issue", target: "NOX-404" }] },
    });

    const published = await publish.publishLinearChanges({ reviewId: record.review_id });
    const result = published.result as {
      summary: { total: number; applied: number; skipped: number; failed: number };
    };

    expect(published.status).toBe("blocked");
    expect(result.summary).toEqual({ total: 1, applied: 0, skipped: 0, failed: 1 });
    expect(published.summary.blockers.join("\n")).toContain("cache publish preflight");
    expect(applyCachePushPlans).toHaveBeenCalledOnce();
    expect(applyCachePushPlans.mock.calls[0]?.[0]).toMatchObject({ dryRun: true });
    const blockedRecord = await store.readPublishReviewRecord(record.review_id);
    expect(blockedRecord.review).toMatchObject({
      ready: false,
      status: "blocked",
      error: expect.stringContaining("cache publish preflight"),
    });
    expect(blockedRecord.review?.attempt_started_at).toEqual(expect.any(String));
    expect(blockedRecord.review?.completed_at).toEqual(expect.any(String));
  });

  it("rejects cache publish reviews that mix all_modified with explicit targets", async () => {
    const { publish, collectCachePushPlans } = await loadPublishLibWithCacheMocks();
    mkdirSync(join(planDir, ".git"));

    await expect(
      publish.reviewLinearChanges({
        source: {
          kind: "cache",
          repo_root: planDir,
          identifiers: ["nox-1"],
          project_ids: ["project-1"],
          all_modified: true,
        },
        team: "UE",
      }),
    ).rejects.toThrow("cache publish review cannot mix all_modified with explicit targets");
    expect(collectCachePushPlans).not.toHaveBeenCalled();
  });

  it("binds explicit unchanged cache publish targets into the reviewed source", async () => {
    const { publish, store, collectCachePushPlans } = await loadPublishLibWithCacheMocks({
      plans: [
        {
          kind: "issue",
          identifier: "NOX-1",
          metadata: {},
          description: "",
          changes: [],
          cache_path: "/tmp/cache/NOX-1",
        },
        {
          kind: "project",
          id: "project-1",
          metadata: { name: "Project 1" },
          content: "",
          changes: [],
          cache_path: "/tmp/cache/projects/project-1",
        },
      ],
      applyCachePushPlans: async () => ({
        results: [
          { target: "NOX-1", kind: "issue", status: "unchanged" },
          { target: "Project 1", kind: "project", status: "unchanged" },
        ],
        summary: { total: 2, applied: 0, skipped: 2, failed: 0 },
      }),
    });
    mkdirSync(join(planDir, ".git"));
    const repoHash = hashRepoRoot(planDir);

    const review = await publish.reviewLinearChanges({
      source: {
        kind: "cache",
        repo_root: planDir,
        identifiers: ["nox-1", ""],
        project_ids: ["project-1"],
      },
      team: "UE",
    });

    expect(review.source).toMatchObject({
      kind: "cache",
      repo_hash: repoHash,
      repo_root: planDir,
      identifiers: ["NOX-1"],
      project_ids: ["project-1"],
    });
    expect(review.requested_source).toMatchObject({
      kind: "cache",
      repo_hash: repoHash,
      repo_root: planDir,
      identifiers: ["NOX-1"],
      project_ids: ["project-1"],
      all_modified: false,
    });
    const record = await store.readPublishReviewRecord(review.review_id);
    expect(record.source).toMatchObject(review.source);
    expect(record.requested_source).toMatchObject(review.requested_source ?? {});
    expect(review.next?.arguments.workspace).toBe("test");
    expect(collectCachePushPlans).toHaveBeenCalledWith(
      repoHash,
      expect.objectContaining({
        identifiers: ["NOX-1"],
        projectIds: ["project-1"],
        includeUnchanged: true,
      }),
    );

    await publish.publishLinearChanges({ reviewId: review.review_id });
    expect(collectCachePushPlans).toHaveBeenLastCalledWith(
      repoHash,
      expect.objectContaining({
        identifiers: ["NOX-1"],
        projectIds: ["project-1"],
        includeUnchanged: true,
      }),
    );
  });

  it("expands cache publish issue ranges before planning and storing requested source", async () => {
    const { publish, collectCachePushPlans } = await loadPublishLibWithCacheMocks({
      plans: [
        {
          kind: "issue",
          identifier: "NOX-1",
          metadata: {},
          description: "",
          changes: [],
          cache_path: "/tmp/cache/NOX-1",
        },
        {
          kind: "issue",
          identifier: "NOX-2",
          metadata: {},
          description: "",
          changes: [],
          cache_path: "/tmp/cache/NOX-2",
        },
      ],
    });
    mkdirSync(join(planDir, ".git"));
    const repoHash = hashRepoRoot(planDir);

    const review = await publish.reviewLinearChanges({
      source: { kind: "cache", repo_root: planDir, identifiers: ["nox-1..nox-2"] },
      team: "UE",
    });

    expect(review.requested_source).toMatchObject({
      identifiers: ["NOX-1", "NOX-2"],
    });
    expect(collectCachePushPlans).toHaveBeenCalledWith(
      repoHash,
      expect.objectContaining({
        identifiers: ["NOX-1", "NOX-2"],
        includeUnchanged: true,
      }),
    );
  });

  it("returns blocked for cache publish when the reviewed cache source is empty", async () => {
    const { publish, store, verifyCachePushPlansClean } = await loadPublishLibWithCacheMocks({
      plans: [],
      applyCachePushPlans: async () => ({
        results: [],
        summary: { total: 0, applied: 0, skipped: 0, failed: 0 },
      }),
    });
    const repoRoot = findGitRoot(process.cwd());
    const repoHash = repoRoot ? hashRepoRoot(repoRoot) : "_global";
    const record = await store.createCachePublishReviewRecord({
      source: {
        kind: "cache",
        repo_hash: repoHash,
        identifiers: [],
        project_ids: [],
      },
      team: "UE",
      contentHash: "0".repeat(64),
      workspace: { url_key: "test", name: "Test Workspace" },
      remoteSnapshot: { issues: [], projects: [], missing: [] },
    });

    const published = await publish.publishLinearChanges({ reviewId: record.review_id });

    expect(published.status).toBe("blocked");
    expect(published.summary.ready).toBe(false);
    expect(published.summary.blockers).toContain("no modified cache rows selected");
    expect(verifyCachePushPlansClean).not.toHaveBeenCalled();
  });
});
