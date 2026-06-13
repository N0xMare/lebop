/**
 * Sanity-check that every registered MCP tool declares
 * an `annotations` block. We don't link against the MCP SDK at test time (the
 * registration helper is internal to the server module), so assertions use
 * `collectMcpToolDefinitions()` instead of parsing registration source.
 *
 * All MCP tools should advertise hints. This smoke test catches regressions
 * where a newly-added tool forgets the annotation block; it is not deep
 * validation of the hint values.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_MCP_CONFIRM_TOOLS,
  REQUIRED_MCP_CONFIRM_TOOLS,
} from "../src/lib/toolSurfaceManifest.ts";
import { collectMcpToolDefinitions } from "../src/mcp/server.ts";
import { WORKSPACE_EXPLORE_SEARCH_KIND_INPUTS } from "../src/surface/workspace.ts";

const specPath = join(__dirname, "..", "docs", "spec.md");
const spec = readFileSync(specPath, "utf8");
const mcpDefinitions = collectMcpToolDefinitions();
const mcpDefinitionByName = new Map(
  mcpDefinitions.map((definition) => [definition.name, definition]),
);

function listToolNames(): string[] {
  return mcpDefinitions.map((definition) => definition.name);
}

function annotationFor(toolName: string): {
  annotations: Record<string, unknown>;
  hints: Record<string, boolean>;
} | null {
  const annotations = mcpDefinitionByName.get(toolName)?.config.annotations;
  if (!annotations) return null;
  const hints: Record<string, boolean> = {};
  for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
    const value = annotations[hint];
    if (typeof value === "boolean") hints[hint] = value;
  }
  return { annotations, hints };
}

function inputDescription(toolName: string, field: string): string {
  const schema = mcpDefinitionByName.get(toolName)?.config.inputSchema ?? {};
  const fieldSchema = (schema as Record<string, { description?: string }>)[field];
  return fieldSchema?.description ?? "";
}

describe("MCP tool annotations", () => {
  const allTools = listToolNames();

  it("registers exactly 85 tools", () => {
    expect(allTools.length).toBe(85);
  });

  it("docs/spec.md shipped-tool inventory exactly matches server registrations", () => {
    const section = /#### Shipped tools \(85\)([\s\S]*?)#### MCP tool inventory/.exec(spec)?.[1];
    expect(section).toBeDefined();
    const documented = Array.from(
      new Set([...(section ?? "").matchAll(/`([a-z_]+)`/g)].map((m) => m[1])),
    );
    expect(documented.toSorted()).toEqual(allTools.toSorted());
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
      if (typeof ann.annotations.title !== "string") {
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
      "cache_status",
      "diff_issue",
      "diff_project",
      "plan_validate",
      "plan_diff",
      "list_workspaces",
      "list_teams",
    ]) {
      const ann = annotationFor(name);
      expect(ann?.hints).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
  });

  it("lint_text is local-only in-memory linting", () => {
    const ann = annotationFor("lint_text");
    expect(ann?.hints).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("lint_files is local filesystem linting", () => {
    const ann = annotationFor("lint_files");
    expect(ann?.hints).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("explore_linear_workspace is read-only and idempotent", () => {
    const ann = annotationFor("explore_linear_workspace");
    expect(ann?.hints).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("explore_linear_workspace accepts singular and plural search kinds", () => {
    for (const kind of [
      "project",
      "projects",
      "issue",
      "issues",
      "initiative",
      "initiatives",
      "document",
      "documents",
      "cycle",
      "cycles",
      "milestone",
      "milestones",
      "agent-session",
      "agent-sessions",
      "agent_session",
      "agent_sessions",
    ]) {
      expect(WORKSPACE_EXPLORE_SEARCH_KIND_INPUTS).toContain(kind);
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
      "delete_relation",
    ]) {
      const ann = annotationFor(name);
      expect(ann?.hints.destructiveHint).toBe(true);
      expect(ann?.hints.readOnlyHint).toBe(false);
    }
  });

  it("manifest-required destructive tools require an explicit confirm input", () => {
    for (const name of REQUIRED_MCP_CONFIRM_TOOLS) {
      const schema = mcpDefinitionByName.get(name)?.config.inputSchema ?? {};
      expect(schema, `${name} missing confirm input`).toHaveProperty("confirm");
      expect(inputDescription(name, "confirm"), `${name} missing confirm description`).toContain(
        "Required true",
      );
    }
  });

  it("conditional destructive tools expose confirm input", () => {
    for (const name of CONDITIONAL_MCP_CONFIRM_TOOLS) {
      const schema = mcpDefinitionByName.get(name)?.config.inputSchema ?? {};
      expect(schema, `${name} missing confirm input`).toHaveProperty("confirm");
      expect(inputDescription(name, "confirm"), `${name} missing confirm description`).toContain(
        "Required true",
      );
    }
  });

  it("conditional destructive tools advertise conservative destructive hints", () => {
    for (const name of CONDITIONAL_MCP_CONFIRM_TOOLS) {
      const ann = annotationFor(name);
      expect(ann?.hints.destructiveHint, name).toBe(true);
      expect(ann?.hints.readOnlyHint, name).toBe(false);
    }
  });

  it("raw_graphql advertises conservative mutation-capable safety hints", () => {
    const ann = annotationFor("raw_graphql");
    expect(ann?.hints).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
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
      "pull_project",
      "add_relation",
      "update_relations",
      "plan_pull",
      "plan_lint",
      "refresh_whoami",
    ]) {
      const ann = annotationFor(name);
      expect(ann?.hints).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
    }
  });

  it("local-writing fetch and publish apply are non-idempotent", () => {
    for (const name of ["fetch_linear_workspace", "publish_linear_changes", "plan_apply"]) {
      const ann = annotationFor(name);
      expect(ann?.hints).toMatchObject({
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: true,
      });
    }
  });

  it("review_linear_changes is not idempotent because it creates a review record", () => {
    const ann = annotationFor("review_linear_changes");
    expect(ann?.hints).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
});
