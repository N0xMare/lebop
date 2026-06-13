import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commentFileName,
  type IssueMetadata,
  issueDir,
  type ProjectMetadata,
  projectDir,
  repoCacheDir,
  teamCacheFile,
} from "../src/lib/cache.ts";
import { ValidationError } from "../src/lib/errors.ts";
import { assertNoSymlinkedExistingAncestorsSync } from "../src/lib/stateSafety.ts";

describe("cache path safety", () => {
  it("accepts canonical cache keys", () => {
    expect(repoCacheDir("_global")).toContain("_global");
    expect(issueDir("_global", "NOX-180")).toContain("NOX-180");
    expect(issueDir("_global", "A1-42")).toContain("A1-42");
    expect(projectDir("_global", "project-uuid_1.2")).toContain("project-uuid_1.2");
    expect(teamCacheFile("_global", "NOX")).toContain("NOX.yaml");
    expect(commentFileName("comment-a")).toBe("comment-a.md");
  });

  it("rejects traversal-shaped cache keys", () => {
    expect(() => repoCacheDir("../outside")).toThrow(ValidationError);
    expect(() => issueDir("_global", "../NOX-1")).toThrow(ValidationError);
    expect(() => projectDir("_global", "../../project")).toThrow(ValidationError);
    expect(() => projectDir("_global", ".")).toThrow(ValidationError);
    expect(() => projectDir("_global", "..")).toThrow(ValidationError);
    expect(() => teamCacheFile("_global", "NOX/../../x")).toThrow(ValidationError);
    expect(commentFileName("../outside")).toMatch(/^comment-[a-f0-9]{32}\.md$/);
  });

  it("documents the root-level symlink ancestor exception used for platform temp dirs", () => {
    const tmpStat = lstatSync("/tmp", { throwIfNoEntry: false });
    if (!tmpStat?.isSymbolicLink()) {
      expect(tmpStat?.isSymbolicLink()).toBe(false);
      return;
    }

    expect(() =>
      assertNoSymlinkedExistingAncestorsSync("/tmp/lebop-root-symlink-policy/file", {
        label: "test state",
      }),
    ).not.toThrow();
  });
});

describe("cache integrity", () => {
  let home: string;
  let originalHome: string | undefined;
  let cache: typeof import("../src/lib/cache.ts");

  beforeEach(async () => {
    originalHome = process.env.LEBOP_HOME;
    home = mkdtempSync(join(tmpdir(), "lebop-cache-integrity-"));
    process.env.LEBOP_HOME = home;
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
    vi.resetModules();
    cache = await import("../src/lib/cache.ts");
  });

  afterEach(() => {
    vi.doUnmock("../src/lib/pushMutations.ts");
    if (originalHome === undefined) {
      delete process.env.LEBOP_HOME;
    } else {
      process.env.LEBOP_HOME = originalHome;
    }
    delete (globalThis as { Bun?: unknown }).Bun;
    rmSync(home, { recursive: true, force: true });
  });

  it("reports incomplete issue and project cache rows", async () => {
    mkdirSync(join(home, "cache", "_global", "issues", "NOX-1"), { recursive: true });
    writeFileSync(join(home, "cache", "_global", "issues", "NOX-1", "metadata.yaml"), "{}");
    mkdirSync(join(home, "cache", "_global", "projects", "project-1"), { recursive: true });
    writeFileSync(join(home, "cache", "_global", "projects", "project-1", "content.md"), "");

    await expect(cache.inspectCacheIntegrity("_global")).resolves.toEqual([
      expect.objectContaining({
        kind: "issue",
        id: "NOX-1",
        problem: "incomplete-row",
        missing_files: ["description.md"],
        repair_hint: expect.stringContaining("--refresh --yes"),
      }),
      expect.objectContaining({
        kind: "project",
        id: "project-1",
        problem: "incomplete-row",
        missing_files: ["metadata.yaml"],
        repair_hint: expect.stringContaining("--refresh --yes"),
      }),
    ]);
  });

  it("refuses writes through a symlinked cache subroot", async () => {
    const realCache = mkdtempSync(join(tmpdir(), "lebop-cache-real-"));
    symlinkSync(realCache, join(home, "cache"), "dir");

    await expect(
      cache.writeIssue(
        "_global",
        issueMetadata("NOX-1", {
          title: "NOX-1",
          description: "body",
          updatedAt: "2026-06-04T00:00:00.000Z",
        }),
        "body",
      ),
    ).rejects.toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("symlinked ancestor"),
    });
    expect(() =>
      readFileSync(join(realCache, "_global", "issues", "NOX-1", "metadata.yaml")),
    ).toThrow();
    rmSync(realCache, { recursive: true, force: true });
  });

  it("encodes traversal-shaped comment ids before writing cache comment files", async () => {
    await cache.writeIssue(
      "_global",
      issueMetadata("NOX-7", {
        title: "Comment path safety",
        description: "body",
        updatedAt: "2026-06-04T00:00:00.000Z",
      }),
      "body",
    );

    await cache.writeComment("_global", "NOX-7", {
      frontmatter: {
        id: "../outside",
        author: "user-1",
        author_name: "User One",
        created_at: "2026-06-04T00:00:00.000Z",
        updated_at: "2026-06-04T00:00:00.000Z",
      },
      body: "unsafe id stayed in frontmatter only",
    });

    const commentsDir = join(home, "cache", "_global", "issues", "NOX-7", "comments");
    const encoded = cache.commentFileName("../outside");
    expect(readdirSync(commentsDir)).toEqual([encoded]);
    expect(() =>
      readFileSync(join(home, "cache", "_global", "issues", "NOX-7", "outside.md")),
    ).toThrow();
    expect(readFileSync(join(commentsDir, encoded), "utf8")).toContain(
      "unsafe id stayed in frontmatter only",
    );
  });

  it("surfaces invalid cache directories while list helpers filter them", async () => {
    await cache.writeProject(
      "_global",
      projectMetadata("project-1", {
        name: "Project 1",
        description: "",
        content: "",
        updatedAt: "2026-06-04T00:00:00.000Z",
      }),
      "",
    );
    mkdirSync(join(home, "cache", "_global", "projects", "bad project"), { recursive: true });

    await expect(cache.listCachedProjectIds("_global")).resolves.toEqual(["project-1"]);
    await expect(cache.inspectCacheIntegrity("_global")).resolves.toEqual([
      expect.objectContaining({
        kind: "project",
        id: "bad project",
        problem: "invalid-key",
      }),
    ]);
  });

  it("reports valid YAML with invalid issue metadata shape as an integrity problem", async () => {
    mkdirSync(join(home, "cache", "_global", "issues", "NOX-5"), { recursive: true });
    writeFileSync(join(home, "cache", "_global", "issues", "NOX-5", "metadata.yaml"), "{}\n");
    writeFileSync(join(home, "cache", "_global", "issues", "NOX-5", "description.md"), "body");

    await expect(cache.inspectCacheIntegrity("_global")).resolves.toEqual([
      expect.objectContaining({
        kind: "issue",
        id: "NOX-5",
        problem: "invalid-metadata",
      }),
    ]);
    await expect(cache.readIssue("_global", "NOX-5")).rejects.toMatchObject({
      code: "validation_error",
    });
  });

  it("reports valid YAML with invalid project metadata shape as an integrity problem", async () => {
    mkdirSync(join(home, "cache", "_global", "projects", "project-invalid"), { recursive: true });
    writeFileSync(
      join(home, "cache", "_global", "projects", "project-invalid", "metadata.yaml"),
      "{}\n",
    );
    writeFileSync(
      join(home, "cache", "_global", "projects", "project-invalid", "content.md"),
      "content",
    );

    await expect(cache.inspectCacheIntegrity("_global")).resolves.toEqual([
      expect.objectContaining({
        kind: "project",
        id: "project-invalid",
        problem: "invalid-metadata",
      }),
    ]);
    await expect(cache.readProject("_global", "project-invalid")).rejects.toMatchObject({
      code: "validation_error",
    });
  });

  it("rejects issue cache rows whose metadata identity does not match the selected directory", async () => {
    mkdirSync(join(home, "cache", "_global", "issues", "NOX-1"), { recursive: true });
    const metadata = issueMetadata("NOX-2", {
      title: "Wrong row",
      description: "body",
      updatedAt: "2026-06-04T00:00:00.000Z",
    });
    writeFileSync(
      join(home, "cache", "_global", "issues", "NOX-1", "metadata.yaml"),
      [
        `identifier: ${metadata.identifier}`,
        `title: ${metadata.title}`,
        `state: ${metadata.state}`,
        `priority: ${metadata.priority}`,
        "estimate: null",
        "labels: []",
        "assignee: null",
        "project: null",
        "parent: null",
        "_server:",
        `  id: ${metadata._server.id}`,
        `  identifier: ${metadata._server.identifier}`,
        `  url: ${metadata._server.url}`,
        `  state_id: ${metadata._server.state_id}`,
        `  state_name: ${metadata._server.state_name}`,
        `  state_type: ${metadata._server.state_type}`,
        `  priority: ${metadata._server.priority}`,
        "  estimate: null",
        "  label_ids: []",
        "  assignee_id: null",
        "  assignee_name: null",
        "  assignee_email: null",
        `  title: ${metadata._server.title}`,
        `  description_hash: ${metadata._server.description_hash}`,
        "  project_id: null",
        "  project_name: null",
        "  parent_id: null",
        "  parent_identifier: null",
        `  updated_at: ${metadata._server.updated_at}`,
        "",
      ].join("\n"),
    );
    writeFileSync(join(home, "cache", "_global", "issues", "NOX-1", "description.md"), "body");

    await expect(cache.readIssue("_global", "NOX-1")).rejects.toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("cache issue identity mismatch"),
    });
  });

  it("rejects project cache rows whose metadata identity does not match the selected directory", async () => {
    mkdirSync(join(home, "cache", "_global", "projects", "project-a"), { recursive: true });
    const metadata = projectMetadata("project-b", {
      name: "Wrong project",
      description: "",
      content: "",
      updatedAt: "2026-06-04T00:00:00.000Z",
    });
    writeFileSync(
      join(home, "cache", "_global", "projects", "project-a", "metadata.yaml"),
      [
        `name: ${metadata.name}`,
        `description: ${JSON.stringify(metadata.description)}`,
        "icon: null",
        `state: ${metadata.state}`,
        "_server:",
        `  id: ${metadata._server.id}`,
        `  url: ${metadata._server.url}`,
        `  state: ${metadata._server.state}`,
        `  name: ${metadata._server.name}`,
        `  description: ${JSON.stringify(metadata._server.description)}`,
        "  icon: null",
        `  content_hash: ${metadata._server.content_hash}`,
        `  updated_at: ${metadata._server.updated_at}`,
        "",
      ].join("\n"),
    );
    writeFileSync(join(home, "cache", "_global", "projects", "project-a", "content.md"), "");

    await expect(cache.readProject("_global", "project-a")).rejects.toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("cache project identity mismatch"),
    });
  });

  it("reports malformed metadata as a cache integrity problem", async () => {
    mkdirSync(join(home, "cache", "_global", "issues", "NOX-3"), { recursive: true });
    writeFileSync(join(home, "cache", "_global", "issues", "NOX-3", "metadata.yaml"), "\tbad\n");
    writeFileSync(join(home, "cache", "_global", "issues", "NOX-3", "description.md"), "");

    await expect(cache.inspectCacheIntegrity("_global")).resolves.toEqual([
      expect.objectContaining({
        kind: "issue",
        id: "NOX-3",
        problem: "invalid-metadata",
      }),
    ]);
  });

  it("includes cache integrity problems in shared status output", async () => {
    mkdirSync(join(home, "cache", "_global", "issues", "NOX-2"), { recursive: true });
    writeFileSync(join(home, "cache", "_global", "issues", "NOX-2", "description.md"), "");
    const { collectCacheStatus } = await import("../src/lib/cacheStatus.ts");

    const status = await collectCacheStatus({
      team: "NOX",
      repoRoot: null,
      repoHash: "_global",
      checkRemote: false,
    });

    expect(status.integrity.ok).toBe(false);
    expect(status.integrity.problems).toEqual([
      expect.objectContaining({
        kind: "issue",
        id: "NOX-2",
        problem: "incomplete-row",
        missing_files: ["metadata.yaml"],
        repair_hint: expect.stringContaining("--refresh --yes"),
      }),
    ]);
    expect(status.clean.issues).toEqual([]);
    expect(status.modified.issues).toEqual([]);
  });

  it("blocks implicit cache push plans on invalid metadata shape", async () => {
    mkdirSync(join(home, "cache", "_global", "issues", "NOX-6"), { recursive: true });
    writeFileSync(join(home, "cache", "_global", "issues", "NOX-6", "metadata.yaml"), "{}\n");
    writeFileSync(join(home, "cache", "_global", "issues", "NOX-6", "description.md"), "body");
    const { collectCachePushPlans } = await import("../src/lib/cachePush.ts");

    await expect(collectCachePushPlans("_global")).rejects.toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("integrity problem"),
    });
  });

  it("reports remote conflicts for modified rows and missing clean remotes", async () => {
    vi.doMock("../src/lib/pushMutations.ts", () => ({
      fetchIssueCasStates: async () => ({
        "NOX-3": {
          id: "issue-uuid-3",
          updatedAt: "2026-06-06T00:00:00.000Z",
        },
      }),
      fetchProjectCasStates: async () => ({}),
    }));
    await cache.writeIssue(
      "_global",
      issueMetadata("NOX-3", {
        title: "Remote-safe",
        description: "server body",
        updatedAt: "2026-06-04T00:00:00.000Z",
      }),
      "locally edited body",
    );
    await cache.writeIssue(
      "_global",
      issueMetadata("NOX-4", {
        title: "Missing remote",
        description: "clean body",
        updatedAt: "2026-06-04T00:00:00.000Z",
      }),
      "clean body",
    );
    const { collectCacheStatus } = await import("../src/lib/cacheStatus.ts");

    const status = await collectCacheStatus({
      team: "NOX",
      repoRoot: null,
      repoHash: "_global",
      checkRemote: true,
    });

    expect(status.modified.issues).toEqual([{ identifier: "NOX-3", fields: ["description"] }]);
    expect(status.remote_conflicts).toEqual([
      expect.objectContaining({
        kind: "issue",
        identifier: "NOX-3",
        local_status: "modified",
        reason: "remote-changed",
        fields: ["description"],
      }),
      expect.objectContaining({
        kind: "issue",
        identifier: "NOX-4",
        local_status: "clean",
        reason: "remote-missing",
      }),
    ]);
    expect(status.clean.issues).toEqual([]);
  });
});

function issueMetadata(
  identifier: string,
  input: { title: string; description: string; updatedAt: string },
): IssueMetadata {
  const descriptionHash = cacheSha256(input.description);
  return {
    identifier,
    title: input.title,
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
      id: `uuid-${identifier}`,
      identifier,
      url: `https://linear.app/nox/issue/${identifier}`,
      state_id: "state-todo",
      state_name: "Todo",
      state_type: "unstarted",
      priority: 0,
      estimate: null,
      label_ids: [],
      assignee_id: null,
      assignee_name: null,
      assignee_email: null,
      title: input.title,
      description_hash: descriptionHash,
      project_id: null,
      project_name: null,
      project_milestone_id: null,
      project_milestone_name: null,
      cycle_id: null,
      cycle_name: null,
      parent_id: null,
      parent_identifier: null,
      updated_at: input.updatedAt,
    },
  };
}

function projectMetadata(
  id: string,
  input: { name: string; description: string; content: string; updatedAt: string },
): ProjectMetadata {
  return {
    name: input.name,
    description: input.description,
    icon: null,
    start_date: null,
    target_date: null,
    state: "started",
    _server: {
      id,
      url: `https://linear.app/nox/project/${id}`,
      state: "started",
      name: input.name,
      description: input.description,
      icon: null,
      start_date: null,
      target_date: null,
      content_hash: cacheSha256(input.content),
      updated_at: input.updatedAt,
    },
  };
}

function cacheSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
