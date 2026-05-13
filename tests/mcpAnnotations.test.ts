/**
 * Wave-2 / item #13 — sanity-check that every registered MCP tool in
 * `src/mcp/server.ts` declares an `annotations` block. We don't link against
 * the MCP SDK at test time (the registration helper is internal to the
 * server module), so the assertion is source-level: count
 * `server.registerTool(` calls and verify each has a matching `annotations:`
 * block before the corresponding `safe(` handler.
 *
 * The intent of the wave-2 work is that all 73 tools advertise hints — this
 * smoke test catches regressions where a newly-added tool forgets the
 * annotation block, *not* deep validation of the hint values.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const serverPath = join(__dirname, "..", "src", "mcp", "server.ts");
const src = readFileSync(serverPath, "utf8");

const TOOL_PATTERN = /server\.registerTool\(\n\s+"([a-z_]+)",\n\s+\{/g;

function listToolNames(): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(TOOL_PATTERN)) {
    names.push(m[1] as string);
  }
  return names;
}

function annotationFor(toolName: string): {
  raw: string;
  hints: Record<string, boolean>;
} | null {
  // Slice from the registration opener to the `},\n    safe(` closer.
  const opener = `server.registerTool(\n    "${toolName}",\n    {`;
  const startIdx = src.indexOf(opener);
  if (startIdx === -1) return null;
  const closeMarker = "\n    },\n    safe(";
  const endIdx = src.indexOf(closeMarker, startIdx);
  if (endIdx === -1) return null;
  const block = src.slice(startIdx, endIdx);
  const annMatch = /annotations:\s*\{([\s\S]*?)\n\s+\},/.exec(block);
  if (!annMatch) return null;
  const annBody = annMatch[1] as string;
  const hints: Record<string, boolean> = {};
  for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
    const m = new RegExp(`${hint}:\\s*(true|false)`).exec(annBody);
    if (m) hints[hint] = m[1] === "true";
  }
  return { raw: annBody, hints };
}

describe("MCP tool annotations (wave-2 item #13)", () => {
  const allTools = listToolNames();

  it("registers exactly 73 tools", () => {
    expect(allTools.length).toBe(73);
  });

  it("every tool has an annotations block with a title", () => {
    const missing: string[] = [];
    const noTitle: string[] = [];
    for (const name of allTools) {
      const ann = annotationFor(name);
      if (!ann) {
        missing.push(name);
        continue;
      }
      if (!/title:\s*"/.test(ann.raw)) {
        noTitle.push(name);
      }
    }
    expect(missing).toEqual([]);
    expect(noTitle).toEqual([]);
  });

  // Sampling per the brief: assert specific representative tools have the
  // expected hint shape. If these regress, the category-bucket logic broke.
  it("read tools advertise read-only + idempotent", () => {
    for (const name of [
      "list_issues",
      "get_issue",
      "list_labels",
      "lint_text",
      "cache_status",
      "diff_issue",
      "plan_validate",
      "list_workspaces",
    ]) {
      const ann = annotationFor(name);
      expect(ann?.hints).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
  });

  it("destructive tools advertise destructive: true", () => {
    for (const name of [
      "delete_issue".replace("issue", "label"), // delete_label
      "delete_project",
      "archive_initiative",
      "cache_gc",
      "initiative_remove_project",
      "archive_issue",
    ]) {
      const ann = annotationFor(name);
      expect(ann?.hints.destructiveHint).toBe(true);
      expect(ann?.hints.readOnlyHint).toBe(false);
    }
  });

  it("create_* tools are non-idempotent", () => {
    for (const name of [
      "create_issue",
      "create_label",
      "create_project",
      "create_initiative",
      "create_document",
      "create_milestone",
    ]) {
      const ann = annotationFor(name);
      expect(ann?.hints.idempotentHint).toBe(false);
      expect(ann?.hints.readOnlyHint).toBe(false);
    }
  });

  it("update_* + push_changes + pull_issues + add_relation are idempotent mutators", () => {
    for (const name of [
      "update_issue",
      "update_label".replace("update_label", "update_milestone"),
      "update_project",
      "update_document",
      "push_changes",
      "pull_issues",
      "add_relation",
      "plan_apply",
      "plan_pull",
    ]) {
      const ann = annotationFor(name);
      expect(ann?.hints).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
    }
  });
});
