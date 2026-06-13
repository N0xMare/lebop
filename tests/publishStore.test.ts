import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string | null = null;
let planDir: string | null = null;
let prevHome: string | undefined;
let prevBun: unknown;

async function loadStore() {
  vi.resetModules();
  return await import("../src/lib/publishStore.ts");
}

function writePlan(contents: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lebop-publish-store-plan-"));
  for (const [name, content] of Object.entries(contents)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe("publish review store safety", () => {
  beforeEach(() => {
    prevHome = process.env.LEBOP_HOME;
    home = mkdtempSync(join(tmpdir(), "lebop-publish-store-home-"));
    process.env.LEBOP_HOME = home;
    prevBun = (globalThis as { Bun?: unknown }).Bun;
    (globalThis as { Bun?: unknown }).Bun = {
      file: (path: string) => ({
        exists: async () => existsSync(path),
        text: async () => readFileSync(path, "utf8"),
      }),
      write: async (path: string, content: string) => {
        writeFileSync(path, content);
      },
    };
  });

  afterEach(() => {
    if (planDir) {
      rmSync(planDir, { recursive: true, force: true });
      planDir = null;
    }
    if (home) {
      rmSync(home, { recursive: true, force: true });
      home = null;
    }
    if (prevHome === undefined) delete process.env.LEBOP_HOME;
    else process.env.LEBOP_HOME = prevHome;
    (globalThis as { Bun?: unknown }).Bun = prevBun;
  });

  it("creates collision-resistant review ids for identical reviewed content", async () => {
    const store = await loadStore();
    planDir = writePlan({
      "_project.md": "---\nname: Test\nteam: UE\n---\n",
      "01-first.md": "---\ntitle: First\n---\n",
    });

    const first = await store.createPublishReviewRecord({ dir: planDir, team: "UE" });
    const second = await store.createPublishReviewRecord({ dir: planDir, team: "UE" });

    expect(first.review_id).not.toBe(second.review_id);
    expect(first.review_id).toMatch(
      /^pub_\d{14}_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(await store.readPublishReviewRecord(first.review_id)).toMatchObject({
      review_id: first.review_id,
      content_hash: first.content_hash,
      source: { kind: "plan", dir: planDir },
    });
  });

  it("hashes only parsed plan files, not ignored sibling docs", async () => {
    const store = await loadStore();
    planDir = writePlan({
      "_project.md": "---\nname: Test\nteam: UE\n---\n",
      "01-first.md": "---\ntitle: First\n---\n",
      "README.md": "ignored before\n",
    });

    const before = await store.hashPlanDir(planDir);
    writeFileSync(join(planDir, "README.md"), "ignored after\n");
    expect(await store.hashPlanDir(planDir)).toBe(before);
    writeFileSync(join(planDir, "01-first.md"), "---\ntitle: Changed\n---\n");
    expect(await store.hashPlanDir(planDir)).not.toBe(before);
  });

  it("rejects unsafe review ids before path construction", async () => {
    const store = await loadStore();

    expect(() => store.reviewPath("../pub_20260604123456_bad")).toThrow(
      /invalid publish review id/,
    );
    await expect(store.readPublishReviewRecord("../pub_20260604123456_bad")).rejects.toThrow(
      /invalid publish review id/,
    );
  });

  it("schema-validates local review records on read", async () => {
    const store = await loadStore();
    const reviewId = "pub_20260604123456_00000000-0000-4000-8000-000000000000";
    const file = store.reviewPath(reviewId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        review_id: reviewId,
        source: { kind: "plan", dir: "/tmp/plan" },
        team: "UE",
        strict: false,
        content_hash: "not-a-sha",
        created_at: "2026-06-04T00:00:00.000Z",
      }),
    );

    await expect(store.readPublishReviewRecord(reviewId)).rejects.toThrow(
      /publish review record is invalid/,
    );
  });

  it("stores and validates cache-source review records", async () => {
    const store = await loadStore();
    const record = await store.createCachePublishReviewRecord({
      source: {
        kind: "cache",
        repo_hash: "repo123",
        repo_root: "/tmp/repo",
        identifiers: ["NOX-1"],
        project_ids: ["00000000-0000-4000-8000-000000000001"],
      },
      requestedSource: {
        kind: "cache",
        repo_hash: "repo123",
        repo_root: "/tmp/repo",
        identifiers: ["NOX-1", "NOX-2"],
        project_ids: ["00000000-0000-4000-8000-000000000001"],
        all_modified: true,
      },
      team: "NOX",
      contentHash: "0".repeat(64),
      remoteSnapshot: {
        issues: [{ identifier: "NOX-1", id: "issue-1", updated_at: "2026-06-04T00:00:00.000Z" }],
        projects: [
          { id: "00000000-0000-4000-8000-000000000001", updated_at: "2026-06-04T00:00:00.000Z" },
        ],
      },
    });

    expect(await store.readPublishReviewRecord(record.review_id)).toMatchObject({
      source: {
        kind: "cache",
        repo_hash: "repo123",
        identifiers: ["NOX-1"],
        project_ids: ["00000000-0000-4000-8000-000000000001"],
      },
      requested_source: {
        kind: "cache",
        repo_hash: "repo123",
        identifiers: ["NOX-1", "NOX-2"],
        project_ids: ["00000000-0000-4000-8000-000000000001"],
        all_modified: true,
      },
      remote_snapshot: {
        issues: [{ identifier: "NOX-1" }],
        projects: [{ id: "00000000-0000-4000-8000-000000000001" }],
      },
    });
  });

  it("refuses writes through a symlinked publish review root", async () => {
    const store = await loadStore();
    const realRoot = mkdtempSync(join(tmpdir(), "lebop-publish-real-root-"));
    symlinkSync(realRoot, join(home ?? "", "publish-reviews"), "dir");
    planDir = writePlan({
      "_project.md": "---\nname: Test\nteam: UE\n---\n",
      "01-first.md": "---\ntitle: First\n---\n",
    });

    await expect(
      store.createPublishReviewRecord({
        dir: planDir,
        team: "UE",
        review: { ready: true, blockers: [], status: "ready" },
      }),
    ).rejects.toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("unsafe state directory"),
    });
    expect(readdirSync(realRoot)).toEqual([]);
    rmSync(realRoot, { recursive: true, force: true });
  });

  it("marks ready review records applying and then applied", async () => {
    const store = await loadStore();
    planDir = writePlan({
      "_project.md": "---\nname: Test\nteam: UE\n---\n",
      "01-first.md": "---\ntitle: First\n---\n",
    });
    const record = await store.createPublishReviewRecord({
      dir: planDir,
      team: "UE",
      review: { ready: true, blockers: [], status: "ready" },
    });

    const applying = await store.markPublishReviewApplying(record.review_id);
    expect(applying.review?.status).toBe("applying");
    expect(applying.review?.attempt_started_at).toEqual(expect.any(String));

    await store.markPublishReviewCompleted(record.review_id, "applied");
    const finished = await store.readPublishReviewRecord(record.review_id);
    expect(finished.review?.status).toBe("applied");
    expect(finished.review?.completed_at).toEqual(expect.any(String));
  });

  it("marks ready review records blocked and single-use", async () => {
    const store = await loadStore();
    planDir = writePlan({
      "_project.md": "---\nname: Test\nteam: UE\n---\n",
      "01-first.md": "---\ntitle: First\n---\n",
    });
    const record = await store.createPublishReviewRecord({
      dir: planDir,
      team: "UE",
      review: { ready: true, blockers: [], status: "ready" },
    });

    await store.markPublishReviewBlocked(record.review_id, "plan publish blocked", [
      "issue/UE-1: remote issue is missing",
    ]);
    const blocked = await store.readPublishReviewRecord(record.review_id);

    expect(blocked.review).toMatchObject({
      ready: false,
      status: "blocked",
      error: "plan publish blocked",
      blockers: ["issue/UE-1: remote issue is missing", "plan publish blocked"],
    });
    expect(blocked.review?.attempt_started_at).toEqual(expect.any(String));
    expect(blocked.review?.completed_at).toEqual(expect.any(String));
    await expect(store.markPublishReviewApplying(record.review_id)).rejects.toThrow(
      /already blocked/,
    );
  });

  it("refuses to start an already applying/applied/failed review", async () => {
    const store = await loadStore();
    planDir = writePlan({
      "_project.md": "---\nname: Test\nteam: UE\n---\n",
      "01-first.md": "---\ntitle: First\n---\n",
    });
    const record = await store.createPublishReviewRecord({
      dir: planDir,
      team: "UE",
      review: { ready: true, blockers: [], status: "ready" },
    });

    await store.markPublishReviewApplying(record.review_id);
    await expect(store.markPublishReviewApplying(record.review_id)).rejects.toThrow(
      /already applying/,
    );
    await store.markPublishReviewCompleted(record.review_id, "failed", "disk full");
    await expect(store.markPublishReviewApplying(record.review_id)).rejects.toThrow(
      /already failed/,
    );
  });

  it("re-reads review status under an interprocess apply lock", async () => {
    const store = await loadStore();
    planDir = writePlan({
      "_project.md": "---\nname: Test\nteam: UE\n---\n",
      "01-first.md": "---\ntitle: First\n---\n",
    });
    const record = await store.createPublishReviewRecord({
      dir: planDir,
      team: "UE",
      review: { ready: true, blockers: [], status: "ready" },
    });
    const recordPath = store.reviewPath(record.review_id);
    const lockPath = `${recordPath}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });

    const child = spawn(
      "bun",
      [
        "-e",
        `
const store = await import("./src/lib/publishStore.ts");
try {
  await store.markPublishReviewApplying(${JSON.stringify(record.review_id)});
  console.log("applied");
} catch (err) {
  console.error((err && err.message) || String(err));
  process.exitCode = 1;
}
`,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, LEBOP_HOME: home ?? "" },
      },
    );
    const result = collectChildResult(child);

    await sleep(150);
    expect(child.exitCode).toBeNull();

    const onDisk = JSON.parse(readFileSync(recordPath, "utf8"));
    onDisk.review = {
      ...(onDisk.review ?? { ready: true, blockers: [] }),
      status: "applying",
      attempt_started_at: new Date().toISOString(),
    };
    writeFileSync(recordPath, `${JSON.stringify(onDisk, null, 2)}\n`);
    rmSync(lockPath, { force: true });

    await expect(result).resolves.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("already applying"),
    });
  });

  it("lets only one process reclaim a stale apply lock", async () => {
    const store = await loadStore();
    planDir = writePlan({
      "_project.md": "---\nname: Test\nteam: UE\n---\n",
      "01-first.md": "---\ntitle: First\n---\n",
    });
    const record = await store.createPublishReviewRecord({
      dir: planDir,
      team: "UE",
      review: { ready: true, blockers: [], status: "ready" },
    });
    const recordPath = store.reviewPath(record.review_id);
    const lockPath = `${recordPath}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: 1, acquired_at: "2026-01-01T00:00:00.000Z" }), {
      flag: "wx",
      mode: 0o600,
    });
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lockPath, staleTime, staleTime);

    const script = `
const store = await import("./src/lib/publishStore.ts");
try {
  await store.markPublishReviewApplying(${JSON.stringify(record.review_id)});
  console.log("applied");
} catch (err) {
  console.error((err && err.message) || String(err));
  process.exitCode = 1;
}
`;
    const children = [
      spawn("bun", ["-e", script], {
        cwd: process.cwd(),
        env: { ...process.env, LEBOP_HOME: home ?? "" },
      }),
      spawn("bun", ["-e", script], {
        cwd: process.cwd(),
        env: { ...process.env, LEBOP_HOME: home ?? "" },
      }),
    ];

    const results = await Promise.all(children.map((child) => collectChildResult(child)));
    const successes = results.filter((result) => result.code === 0);
    const failures = results.filter((result) => result.code !== 0);

    expect(successes).toHaveLength(1);
    expect(successes[0]?.stdout).toContain("applied");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.stderr).toContain("already applying");
    expect(readdirSync(dirname(recordPath)).filter((name) => name.includes(".reclaim"))).toEqual(
      [],
    );
  });

  it("recovers stale apply locks even when a stale reclaim lock was left behind", async () => {
    const store = await loadStore();
    planDir = writePlan({
      "_project.md": "---\nname: Test\nteam: UE\n---\n",
      "01-first.md": "---\ntitle: First\n---\n",
    });
    const record = await store.createPublishReviewRecord({
      dir: planDir,
      team: "UE",
      review: { ready: true, blockers: [], status: "ready" },
    });
    const recordPath = store.reviewPath(record.review_id);
    const lockPath = `${recordPath}.lock`;
    const reclaimPath = `${lockPath}.reclaim`;
    writeFileSync(lockPath, JSON.stringify({ pid: 1, acquired_at: "2026-01-01T00:00:00.000Z" }), {
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(
      reclaimPath,
      JSON.stringify({ pid: 2, reclaiming_at: "2026-01-01T00:00:00.000Z" }),
      { flag: "wx", mode: 0o600 },
    );
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lockPath, staleTime, staleTime);
    utimesSync(reclaimPath, staleTime, staleTime);

    const applying = await store.markPublishReviewApplying(record.review_id);

    expect(applying.review?.status).toBe("applying");
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(reclaimPath)).toBe(false);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectChildResult(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve) => {
    child.on("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
