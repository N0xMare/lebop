import { describe, expect, it } from "vitest";
import {
  CLI_SURFACE_MANIFEST,
  MCP_SURFACE_MANIFEST,
  REQUIRED_MCP_CONFIRM_TOOLS,
} from "../src/lib/toolSurfaceManifest.ts";
import { collectMcpToolDefinitions } from "../src/mcp/server.ts";
import {
  deriveSurfaceCliManifestExpectations,
  deriveSurfaceMcpManifestExpectations,
  deriveSurfaceRequiredMcpConfirmTools,
  SURFACE_OPERATIONS,
  surfaceConfirmPolicy,
  surfaceMcpAnnotationExpectation,
} from "../src/surface/index.ts";

const mcpDefinitions = collectMcpToolDefinitions();
const mcpDefinitionByName = new Map(
  mcpDefinitions.map((definition) => [definition.name, definition]),
);

describe("surface operation contracts", () => {
  it("keeps migrated operation ids and metadata complete", () => {
    const ids = SURFACE_OPERATIONS.map((operation) => operation.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const operation of SURFACE_OPERATIONS) {
      expect(operation.domain, `${operation.id} domain`).toMatch(
        /^(workspace|issues|projects|pull|publish)$/,
      );
      expect(operation.resource, `${operation.id} resource`).toBeTruthy();
      expect(operation.action, `${operation.id} action`).toBeTruthy();
      expect(operation.title, `${operation.id} title`).toBeTruthy();
      expect(operation.description, `${operation.id} description`).toBeTruthy();
      const aliasOf = "aliasOf" in operation ? operation.aliasOf : undefined;
      if (aliasOf) {
        expect(ids, `${operation.id} alias target`).toContain(aliasOf);
      }
      if (operation.mcp) {
        expect(operation.mcp.title, `${operation.id} MCP title`).toBeTruthy();
        expect(operation.mcp.description, `${operation.id} MCP description`).toBeTruthy();
        expect(operation.mcp.annotations?.title, `${operation.id} MCP annotation title`).toBe(
          operation.mcp.title,
        );
      }
    }
  });

  it("attaches bulk update's dependency-aware MCP adapter to the surface contract", () => {
    const operation = SURFACE_OPERATIONS.find((entry) => entry.id === "issues.bulk_update");

    expect(operation?.mcp?.tool).toBe("bulk_update_issues");
    expect(operation && "fromMcp" in operation && typeof operation.fromMcp === "function").toBe(
      true,
    );
  });

  it("derives migrated CLI and MCP manifest rows from contract metadata", () => {
    const cliRows = new Map(CLI_SURFACE_MANIFEST.map((entry) => [entry.command, entry]));
    for (const expected of deriveSurfaceCliManifestExpectations(SURFACE_OPERATIONS)) {
      const row = cliRows.get(expected.command);
      expect(row, `${expected.operationId} CLI row`).toBeDefined();
      expect(row?.maps_to, `${expected.operationId} CLI maps_to`).toEqual({
        type: "mcp",
        tools: [...expected.mcpTools],
      });
    }

    const mcpRows = new Map(MCP_SURFACE_MANIFEST.map((entry) => [entry.tool, entry]));
    for (const expected of deriveSurfaceMcpManifestExpectations(SURFACE_OPERATIONS)) {
      const row = mcpRows.get(expected.tool);
      expect(row, `${expected.tool} MCP row`).toBeDefined();
      expect(row?.maps_to.type, `${expected.tool} MCP maps_to type`).toBe("cli");
      if (row?.maps_to.type === "cli") {
        expect(row.maps_to.tools.toSorted(), `${expected.tool} MCP CLI tools`).toEqual(
          [...expected.cliCommands].toSorted(),
        );
      }
      expect(row?.destructive_confirm ?? "not_required", `${expected.tool} confirm`).toBe(
        expected.confirm,
      );
      expect(row?.live_semantics, `${expected.tool} live semantics`).toBe(expected.liveSemantics);
    }
  });

  it("keeps migrated destructive confirm policy aligned with the MCP manifest", () => {
    expect(deriveSurfaceRequiredMcpConfirmTools(SURFACE_OPERATIONS)).toEqual([
      "archive_issue",
      "delete_project",
    ]);

    const requiredConfirmTools = new Set(REQUIRED_MCP_CONFIRM_TOOLS);
    for (const operation of SURFACE_OPERATIONS) {
      if (!operation.mcp) continue;
      if (surfaceConfirmPolicy(operation) === "required") {
        expect(requiredConfirmTools.has(operation.mcp.tool), `${operation.id} confirm`).toBe(true);
      } else {
        expect(requiredConfirmTools.has(operation.mcp.tool), `${operation.id} confirm`).toBe(false);
      }
    }
  });

  it("keeps migrated safety metadata aligned with declared MCP annotations", () => {
    for (const operation of SURFACE_OPERATIONS) {
      if (!operation.mcp) continue;
      const annotations: Record<string, unknown> = operation.mcp.annotations ?? {};
      const expected = surfaceMcpAnnotationExpectation(operation);

      expect(annotations.title, `${operation.id} annotation title`).toBe(expected.title);
      expect(Boolean(annotations.readOnlyHint), `${operation.id} readOnlyHint`).toBe(
        expected.readOnlyHint,
      );
      expect(Boolean(annotations.destructiveHint), `${operation.id} destructiveHint`).toBe(
        expected.destructiveHint,
      );
      expect(Boolean(annotations.idempotentHint), `${operation.id} idempotentHint`).toBe(
        expected.idempotentHint,
      );
      expect(Boolean(annotations.openWorldHint), `${operation.id} openWorldHint`).toBe(
        expected.openWorldHint,
      );
    }
  });

  it("keeps registered migrated MCP metadata aligned with surface operations", () => {
    for (const operation of SURFACE_OPERATIONS) {
      if (!operation.mcp) continue;

      const definition = mcpDefinitionByName.get(operation.mcp.tool);
      expect(definition, `${operation.id} MCP registration`).toBeDefined();
      expect(definition?.config.title, `${operation.id} MCP title`).toBe(
        operation.mcp.title ?? operation.title,
      );
      expect(definition?.config.description, `${operation.id} MCP description`).toBe(
        operation.mcp.description ?? operation.description,
      );
      expect(definition?.config.annotations, `${operation.id} MCP annotations`).toEqual(
        operation.mcp.annotations,
      );
    }
  });

  it("registers migrated operation ids beside workspace operations", () => {
    expect(SURFACE_OPERATIONS.map((operation) => operation.id)).toEqual([
      "workspace.explore",
      "workspace.fetch",
      "issues.list",
      "issues.mine",
      "issues.get",
      "issues.create",
      "issues.update",
      "issues.relations_update",
      "issues.archive",
      "issues.unarchive",
      "issues.bulk_update",
      "projects.list",
      "projects.list.alias",
      "projects.get",
      "projects.create",
      "projects.update",
      "projects.delete",
      "pull.issues",
      "pull.project",
      "publish.review",
      "publish.apply",
    ]);
    expect(SURFACE_OPERATIONS.map((operation) => operation.mcp?.tool)).toEqual([
      "explore_linear_workspace",
      "fetch_linear_workspace",
      "list_issues",
      "list_issues",
      "get_issue",
      "create_issue",
      "update_issue",
      "update_relations",
      "archive_issue",
      "unarchive_issue",
      "bulk_update_issues",
      "list_projects",
      "list_projects",
      "get_project",
      "create_project",
      "update_project",
      "delete_project",
      "pull_issues",
      "pull_project",
      "review_linear_changes",
      "publish_linear_changes",
    ]);
  });
});
