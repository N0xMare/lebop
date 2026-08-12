import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyContentPolicy,
  DEFAULT_CONTENT_MAX_BYTES,
  truncateUtf8Prefix,
  utf8ByteLength,
} from "../src/lib/contentSize.ts";

const tmpRoot = join(process.cwd(), "docs/local/.tmp-content-size-test");

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("contentSize policy", () => {
  it("exports 64 KiB default", () => {
    expect(DEFAULT_CONTENT_MAX_BYTES).toBe(65_536);
  });

  it("passes small text through on default", async () => {
    const applied = await applyContentPolicy({ text: "hello", maxBytes: 100 });
    expect(applied).toMatchObject({
      value: "hello",
      truncated: false,
      body_source: "wire",
      original_bytes: 5,
    });
  });

  it("truncates large text under default mode", async () => {
    const big = `${"line\n".repeat(20_000)}END`;
    const applied = await applyContentPolicy({ text: big, maxBytes: 200 });
    expect(applied.truncated).toBe(true);
    expect(applied.body_source).toBe("truncated_wire");
    expect(utf8ByteLength(applied.value)).toBeLessThanOrEqual(200);
    expect(applied.original_bytes).toBeGreaterThan(200);
    expect(applied.value.includes("END")).toBe(false);
  });

  it("fullContent returns full body", async () => {
    const big = "x".repeat(500);
    const applied = await applyContentPolicy({ text: big, fullContent: true, maxBytes: 50 });
    expect(applied.truncated).toBe(false);
    expect(applied.value).toBe(big);
    expect(applied.body_source).toBe("wire");
  });

  it("contentFile writes full body and keeps dense wire", async () => {
    mkdirSync(tmpRoot, { recursive: true });
    const path = join(tmpRoot, "issue.md");
    const big = `${"para\n".repeat(5_000)}TAIL`;
    const applied = await applyContentPolicy({ text: big, contentFile: path, maxBytes: 100 });
    expect(applied.body_source).toBe("file");
    expect(applied.truncated).toBe(false);
    expect(applied.content_file).toBe(path);
    expect(readFileSync(path, "utf8")).toBe(big);
    expect(utf8ByteLength(applied.value)).toBeLessThanOrEqual(100);
  });

  it("truncateUtf8Prefix prefers newline cuts", () => {
    const text = `${"a".repeat(40)}\n${"b".repeat(40)}`;
    const { text: out } = truncateUtf8Prefix(text, 50);
    expect(out.endsWith("\n") || out.length < 50).toBe(true);
  });
});
