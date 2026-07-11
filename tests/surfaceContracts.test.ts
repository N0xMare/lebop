import { describe, expect, it } from "vitest";
import {
  CLI_LIVE_COVERAGE_MANIFEST,
  CLI_SURFACE_MANIFEST,
  CONDITIONAL_MCP_CONFIRM_TOOLS,
  MCP_SURFACE_MANIFEST,
  REQUIRED_MCP_CONFIRM_TOOLS,
} from "../src/lib/toolSurfaceManifest.ts";
import { collectMcpToolDefinitions } from "../src/mcp/server.ts";
import type { SurfaceOperationMetadata } from "../src/surface/contracts.ts";
import {
  deriveCliLiveCoverageManifest,
  deriveCliSurfaceManifest,
  deriveMcpSurfaceManifest,
  deriveSurfaceCliManifestExpectations,
  deriveSurfaceMcpManifestExpectations,
  deriveSurfaceRequiredMcpConfirmTools,
  SURFACE_OPERATIONS,
  surfaceConfirmPolicy,
  surfaceMcpAnnotationExpectation,
} from "../src/surface/index.ts";

/** Metadata view — cli_only ops omit `mcp`, so the const union needs a shared shape. */
const SURFACE_OPS = SURFACE_OPERATIONS as readonly SurfaceOperationMetadata[];

const mcpDefinitions = collectMcpToolDefinitions();
const mcpDefinitionByName = new Map(
  mcpDefinitions.map((definition) => [definition.name, definition]),
);

describe("surface operation contracts", () => {
  it("keeps migrated operation ids and metadata complete", () => {
    const ids = SURFACE_OPS.map((operation) => operation.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const operation of SURFACE_OPS) {
      expect(operation.domain, `${operation.id} domain`).toMatch(
        /^(workspace|issues|projects|milestones|pull|publish|plan|cache|attachments|comments|labels|cycles|agent_sessions|teams|lookups|documents|initiatives|relations|link|auth|raw|lint|other)$/,
      );
      expect(operation.resource, `${operation.id} resource`).toBeTruthy();
      expect(operation.action, `${operation.id} action`).toBeTruthy();
      expect(operation.title, `${operation.id} title`).toBeTruthy();
      expect(operation.description, `${operation.id} description`).toBeTruthy();
      const aliasOf = operation.aliasOf;
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
    const operation = SURFACE_OPS.find((entry) => entry.id === "issues.bulk_update");
    const liveOp = SURFACE_OPERATIONS.find((entry) => entry.id === "issues.bulk_update");

    expect(operation?.mcp?.tool).toBe("bulk_update_issues");
    expect(liveOp && "fromMcp" in liveOp && typeof liveOp.fromMcp === "function").toBe(true);
  });

  it("derives migrated CLI and MCP manifest rows from contract metadata", () => {
    const cliRows = new Map(CLI_SURFACE_MANIFEST.map((entry) => [entry.command, entry]));
    for (const expected of deriveSurfaceCliManifestExpectations(SURFACE_OPS)) {
      const row = cliRows.get(expected.command);
      expect(row, `${expected.operationId} CLI row`).toBeDefined();
      expect(row?.maps_to, `${expected.operationId} CLI maps_to`).toEqual({
        type: "mcp",
        tools: [...expected.mcpTools],
      });
    }

    const mcpRows = new Map(MCP_SURFACE_MANIFEST.map((entry) => [entry.tool, entry]));
    for (const expected of deriveSurfaceMcpManifestExpectations(SURFACE_OPS)) {
      const row = mcpRows.get(expected.tool);
      expect(row, `${expected.tool} MCP row`).toBeDefined();
      if (expected.cliCommands.length === 0) {
        // mcp_only exception ops (e.g. lookup_label_by_name) map to exception rows.
        expect(row?.maps_to.type, `${expected.tool} MCP maps_to type`).toBe("exception");
      } else {
        expect(row?.maps_to.type, `${expected.tool} MCP maps_to type`).toBe("cli");
        if (row?.maps_to.type === "cli") {
          expect(row.maps_to.tools.toSorted(), `${expected.tool} MCP CLI tools`).toEqual(
            [...expected.cliCommands].toSorted(),
          );
        }
      }
      expect(row?.destructive_confirm ?? "not_required", `${expected.tool} confirm`).toBe(
        expected.confirm,
      );
      expect(row?.live_semantics, `${expected.tool} live semantics`).toBe(expected.liveSemantics);
    }
  });

  it("keeps migrated destructive confirm policy aligned with the MCP manifest", () => {
    expect(deriveSurfaceRequiredMcpConfirmTools(SURFACE_OPS)).toEqual([
      "archive_initiative",
      "archive_issue",
      "delete_attachment",
      "delete_comment",
      "delete_document",
      "delete_initiative",
      "delete_label",
      "delete_milestone",
      "delete_project",
      "delete_relation",
      "initiative_remove_project",
    ]);

    const requiredConfirmTools = new Set(REQUIRED_MCP_CONFIRM_TOOLS);
    for (const operation of SURFACE_OPS) {
      if (!operation.mcp) continue;
      if (surfaceConfirmPolicy(operation) === "required") {
        expect(requiredConfirmTools.has(operation.mcp.tool), `${operation.id} confirm`).toBe(true);
      } else {
        expect(requiredConfirmTools.has(operation.mcp.tool), `${operation.id} confirm`).toBe(false);
      }
    }
  });

  it("keeps migrated safety metadata aligned with declared MCP annotations", () => {
    for (const operation of SURFACE_OPS) {
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
    for (const operation of SURFACE_OPS) {
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
    expect(SURFACE_OPS.map((operation) => operation.id)).toEqual([
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
      "milestones.list",
      "milestones.get",
      "milestones.create",
      "milestones.update",
      "milestones.delete",
      "pull.issues",
      "pull.project",
      "publish.review",
      "publish.apply",
      "plan.validate",
      "plan.lint",
      "plan.apply",
      "plan.diff",
      "plan.pull",
      "attachments.list",
      "attachments.update",
      "attachments.delete",
      "comments.list",
      "comments.add",
      "comments.update",
      "comments.delete",
      "labels.list",
      "labels.create",
      "labels.delete",
      "labels.lookup_by_name",
      "cycles.list",
      "cycles.get",
      "agent_sessions.list",
      "agent_sessions.get",
      "teams.list",
      "teams.list_members",
      "teams.get",
      "teams.list_workflow_states",
      "lookups.state_by_name",
      "lookups.user_by_email",
      "documents.list",
      "documents.get",
      "documents.create",
      "documents.update",
      "documents.delete",
      "project_updates.list",
      "project_updates.create",
      "initiatives.list",
      "initiatives.get",
      "initiatives.create",
      "initiatives.update",
      "initiatives.archive",
      "initiatives.unarchive",
      "initiatives.delete",
      "initiatives.add_project",
      "initiatives.remove_project",
      "initiative_updates.list",
      "initiative_updates.create",
      "relations.add",
      "relations.update",
      "relations.list",
      "relations.delete",
      "link.url",
      "cache.status",
      "cache.status.alias",
      "cache.diff_issue",
      "cache.diff_project",
      "cache.push",
      "cache.gc",
      "auth.login",
      "auth.logout",
      "auth.list_workspaces",
      "auth.list_workspaces.default_read",
      "auth.set_default_workspace",
      "auth.token",
      "auth.whoami",
      "auth.refresh_whoami",
      "auth.set_workspace_default_team",
      "raw.graphql",
      "lint.files",
      "lint.text",
      "mcp.start",
      "schema.dump",
      "completions.shell",
    ]);
    expect(SURFACE_OPS.map((operation) => operation.mcp?.tool)).toEqual([
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
      "list_milestones",
      "get_milestone",
      "create_milestone",
      "update_milestone",
      "delete_milestone",
      "pull_issues",
      "pull_project",
      "review_linear_changes",
      "publish_linear_changes",
      "plan_validate",
      "plan_lint",
      "plan_apply",
      "plan_diff",
      "plan_pull",
      "list_attachments",
      "update_attachment",
      "delete_attachment",
      "list_comments",
      "add_comment",
      "update_comment",
      "delete_comment",
      "list_labels",
      "create_label",
      "delete_label",
      "lookup_label_by_name",
      "list_cycles",
      "get_cycle",
      "list_agent_sessions",
      "get_agent_session",
      "list_teams",
      "list_team_members",
      "get_team",
      "list_workflow_states",
      "lookup_state_by_name",
      "lookup_user_by_email",
      "list_documents",
      "get_document",
      "create_document",
      "update_document",
      "delete_document",
      "list_project_updates",
      "create_project_update",
      "list_initiatives",
      "get_initiative",
      "create_initiative",
      "update_initiative",
      "archive_initiative",
      "unarchive_initiative",
      "delete_initiative",
      "initiative_add_project",
      "initiative_remove_project",
      "list_initiative_updates",
      "create_initiative_update",
      "add_relation",
      "update_relations",
      "list_relations",
      "delete_relation",
      "link_url_to_issue",
      "cache_status",
      "cache_status",
      "diff_issue",
      "diff_project",
      "push_changes",
      "cache_gc",
      undefined,
      undefined,
      "list_workspaces",
      "list_workspaces",
      "set_default_workspace",
      undefined,
      "whoami",
      "refresh_whoami",
      "set_workspace_default_team",
      "raw_graphql",
      "lint_files",
      "lint_text",
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("declares auth login/logout/token and mcp/schema/completions as cli_only exception ops", () => {
    const cliOnly = SURFACE_OPS.filter((operation) => operation.exception?.kind === "cli_only");
    expect(cliOnly.map((operation) => operation.id)).toEqual([
      "auth.login",
      "auth.logout",
      "auth.token",
      "mcp.start",
      "schema.dump",
      "completions.shell",
    ]);
    for (const operation of cliOnly) {
      expect(operation.cli?.command, `${operation.id} cli.command`).toBeTruthy();
      expect(operation.mcp, `${operation.id} has no mcp mapping`).toBeUndefined();
    }
  });

  it("makes SURFACE_OPERATIONS the inventory authority (L2 derived manifests)", () => {
    // Live coverage is fully derived (no handwritten list).
    expect(CLI_LIVE_COVERAGE_MANIFEST).toEqual(deriveCliLiveCoverageManifest(SURFACE_OPS));

    // Public CLI/MCP inventories match surface derivation for maps_to / confirm / live_semantics.
    const derivedCli = deriveCliSurfaceManifest(SURFACE_OPS);
    expect(CLI_SURFACE_MANIFEST.map((entry) => entry.command)).toEqual(
      derivedCli.map((entry) => entry.command),
    );
    for (const expected of derivedCli) {
      const row = CLI_SURFACE_MANIFEST.find((entry) => entry.command === expected.command);
      expect(row?.maps_to, `${expected.command} maps_to`).toEqual(expected.maps_to);
    }

    const derivedMcp = deriveMcpSurfaceManifest(SURFACE_OPS);
    expect(MCP_SURFACE_MANIFEST.map((entry) => entry.tool)).toEqual(
      derivedMcp.map((entry) => entry.tool),
    );
    for (const expected of derivedMcp) {
      const row = MCP_SURFACE_MANIFEST.find((entry) => entry.tool === expected.tool);
      expect(row?.maps_to, `${expected.tool} maps_to`).toEqual(expected.maps_to);
      expect(row?.destructive_confirm, `${expected.tool} confirm`).toBe(
        expected.destructive_confirm,
      );
      expect(row?.live_semantics, `${expected.tool} live_semantics`).toBe(expected.live_semantics);
    }

    // Issue field lists stay as small keyed constants, not a second full inventory.
    const setRow = CLI_SURFACE_MANIFEST.find((entry) => entry.command === "set");
    const updateIssue = MCP_SURFACE_MANIFEST.find((entry) => entry.tool === "update_issue");
    expect(setRow?.issue_fields?.length).toBeGreaterThan(0);
    expect(updateIssue?.issue_fields?.length).toBeGreaterThan(0);

    const registeredMcp = collectMcpToolDefinitions()
      .map((definition) => definition.name)
      .toSorted();
    expect(MCP_SURFACE_MANIFEST.map((entry) => entry.tool).toSorted()).toEqual(registeredMcp);

    for (const operation of SURFACE_OPS) {
      if (!operation.mcp) continue;
      expect(
        MCP_SURFACE_MANIFEST.some((entry) => entry.tool === operation.mcp?.tool),
        `${operation.id} mcp.tool missing from derived MCP inventory`,
      ).toBe(true);
      if (operation.cli) {
        expect(
          CLI_SURFACE_MANIFEST.some((entry) => entry.command === operation.cli?.command),
          `${operation.id} cli.command missing from derived CLI inventory`,
        ).toBe(true);
      }
    }

    for (const operation of SURFACE_OPS) {
      if (!operation.cli) continue;
      const coverage = CLI_LIVE_COVERAGE_MANIFEST.find(
        (entry) => entry.command === operation.cli?.command,
      );
      expect(coverage, `${operation.id} missing live coverage row`).toBeDefined();
      if (operation.cli.liveSteps?.length) {
        expect(coverage && "live_steps" in coverage).toBe(true);
        if (coverage && "live_steps" in coverage) {
          for (const step of operation.cli.liveSteps) {
            expect(coverage.live_steps).toContain(step);
          }
        }
      }
      if (operation.cli.nonLiveReason) {
        expect(coverage && "non_live_reason" in coverage).toBe(true);
      }
    }

    expect(REQUIRED_MCP_CONFIRM_TOOLS.toSorted()).toEqual(
      MCP_SURFACE_MANIFEST.filter((entry) => entry.destructive_confirm === "required")
        .map((entry) => entry.tool)
        .toSorted(),
    );
    expect(CONDITIONAL_MCP_CONFIRM_TOOLS.toSorted()).toEqual(
      MCP_SURFACE_MANIFEST.filter((entry) => entry.destructive_confirm === "required_when_mutating")
        .map((entry) => entry.tool)
        .toSorted(),
    );
  });
});
