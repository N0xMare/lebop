import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CachedComment, IssueMetadata, ProjectMetadata } from "../src/lib/cache.ts";
import { commentFileName } from "../src/lib/cache.ts";
import { writeIssueExport, writeProjectExport } from "../src/lib/pullExport.ts";

const metadata: IssueMetadata = {
  identifier: "NOX-1",
  title: "Exported issue",
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
    id: "issue-1",
    identifier: "NOX-1",
    url: "https://linear.app/noxor/issue/NOX-1",
    state_id: "state-1",
    state_name: "Todo",
    state_type: "unstarted",
    priority: 0,
    estimate: null,
    label_ids: [],
    assignee_id: null,
    assignee_name: null,
    assignee_email: null,
    title: "Exported issue",
    description_hash: "hash",
    project_id: null,
    project_name: null,
    project_milestone_id: null,
    project_milestone_name: null,
    cycle_id: null,
    cycle_name: null,
    parent_id: null,
    parent_identifier: null,
    updated_at: "2026-06-07T00:00:00.000Z",
  },
};

const projectMetadata: ProjectMetadata = {
  name: "Exported project",
  description: "Project description",
  icon: null,
  start_date: null,
  target_date: null,
  state: "started",
  _server: {
    id: "project-1",
    url: "https://linear.app/noxor/project/project-1",
    state: "started",
    name: "Exported project",
    description: "Project description",
    icon: null,
    start_date: null,
    target_date: null,
    content_hash: "hash",
    updated_at: "2026-06-07T00:00:00.000Z",
  },
};

function comment(id: string, body: string): CachedComment {
  return {
    frontmatter: {
      id,
      author: "user-1",
      author_name: "User One",
      created_at: "2026-06-07T00:00:00.000Z",
      updated_at: "2026-06-07T00:00:00.000Z",
    },
    body,
  };
}

describe("writeIssueExport", () => {
  beforeEach(() => {
    vi.stubGlobal("Bun", { write: writeFile });
  });

  it("removes stale comment files when rewriting an issue export", async () => {
    const out = await mkdtemp(join(tmpdir(), "lebop-pull-export-comments-"));
    try {
      await writeIssueExport(out, "NOX-1", metadata, "first body", [
        comment("comment-a", "first comment"),
        comment("comment-b", "stale comment"),
      ]);

      await writeIssueExport(out, "NOX-1", metadata, "second body", [
        comment("comment-a", "updated comment"),
      ]);

      await expect(
        readFile(join(out, "NOX-1", "comments", "comment-b.md"), "utf8"),
      ).rejects.toThrow();
      await expect(
        readFile(join(out, "NOX-1", "comments", "comment-a.md"), "utf8"),
      ).resolves.toContain("updated comment");

      await writeIssueExport(out, "NOX-1", metadata, "third body", []);
      await expect(
        readFile(join(out, "NOX-1", "comments", "comment-a.md"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("refuses to rewrite through a symlinked comments export directory", async () => {
    const out = await mkdtemp(join(tmpdir(), "lebop-pull-export-comments-link-"));
    const outside = await mkdtemp(join(tmpdir(), "lebop-pull-export-comments-outside-"));
    try {
      await mkdir(join(out, "NOX-1"), { recursive: true });
      await symlink(outside, join(out, "NOX-1", "comments"), "dir");

      await expect(
        writeIssueExport(out, "NOX-1", metadata, "body", [comment("comment-a", "comment")]),
      ).rejects.toMatchObject({
        code: "validation_error",
        message: expect.stringContaining("symlinked comments export directory"),
      });
      await writeFile(join(outside, "kept.txt"), "kept");
      await expect(readFile(join(outside, "kept.txt"), "utf8")).resolves.toBe("kept");
    } finally {
      await rm(out, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("encodes traversal-shaped comment ids before writing export comment files", async () => {
    const out = await mkdtemp(join(tmpdir(), "lebop-pull-export-comment-id-"));
    try {
      const dir = await writeIssueExport(out, "NOX-1", metadata, "body", [
        comment("../outside", "unsafe export comment"),
      ]);
      const encoded = commentFileName("../outside");

      await expect(readdir(join(dir, "comments"))).resolves.toEqual([encoded]);
      await expect(readFile(join(dir, "outside.md"), "utf8")).rejects.toThrow();
      await expect(readFile(join(dir, "comments", encoded), "utf8")).resolves.toContain(
        "unsafe export comment",
      );
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("rejects traversal-shaped issue identifiers before resolving export directories", async () => {
    const out = await mkdtemp(join(tmpdir(), "lebop-pull-export-issue-id-"));
    try {
      await expect(writeIssueExport(out, "../outside", metadata, "body", [])).rejects.toMatchObject(
        {
          code: "validation_error",
          message: expect.stringContaining("invalid export issue identifier"),
        },
      );
      await expect(
        readFile(join(dirname(out), "outside", "description.md"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("rejects traversal-shaped project ids before resolving export directories", async () => {
    const out = await mkdtemp(join(tmpdir(), "lebop-pull-export-project-id-"));
    try {
      await expect(
        writeProjectExport(out, "foo/../../outside", projectMetadata, "project content"),
      ).rejects.toMatchObject({
        code: "validation_error",
        message: expect.stringContaining("invalid export project id"),
      });
      await expect(readFile(join(dirname(out), "outside", "content.md"), "utf8")).rejects.toThrow();
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
