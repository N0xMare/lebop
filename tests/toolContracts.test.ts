import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildCliProgram } from "../src/cli.ts";
import {
  assertSemanticProofs,
  validateDestructiveMcpArgsContract,
  validateExplorePayloadContract,
  validateFetchPayloadContract,
  validateJsonErrorEnvelopeContract,
  validatePublishPayloadContract,
} from "../src/lib/toolBehaviorContracts.ts";
import {
  CLI_LIVE_COVERAGE_MANIFEST,
  CLI_SET_ISSUE_FIELDS,
  CLI_SURFACE_MANIFEST,
  CONDITIONAL_MCP_CONFIRM_TOOLS,
  MCP_SURFACE_MANIFEST,
  MCP_UPDATE_ISSUE_FIELDS,
  REQUIRED_CLI_LIVE_STEPS,
  REQUIRED_MCP_CONFIRM_TOOLS,
} from "../src/lib/toolSurfaceManifest.ts";
import { collectMcpToolDefinitions } from "../src/mcp/server.ts";

const mcpDefinitions = collectMcpToolDefinitions();
const mcpDefinitionByName = new Map(
  mcpDefinitions.map((definition) => [definition.name, definition]),
);

function registeredMcpTools(): string[] {
  return mcpDefinitions.map((definition) => definition.name);
}

function registeredMcpToolDefinition(toolName: string) {
  const definition = mcpDefinitionByName.get(toolName);
  expect(definition, `missing MCP tool registration for ${toolName}`).toBeDefined();
  return definition as NonNullable<typeof definition>;
}

function registeredMcpInputKeys(toolName: string): string[] {
  return Object.keys(registeredMcpToolDefinition(toolName).config.inputSchema ?? {}).toSorted();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

const INTENTIONAL_DUPLICATE_CLI_LIVE_STEPS = new Map<string, string[]>([
  [
    "cli:archive/unarchive issue --json",
    [
      "archive",
      "unarchive",
      "One round-trip proves both commands against the same deterministic issue.",
    ],
  ],
  [
    "cli:relation add/list/delete --json",
    [
      "relation add",
      "relation list",
      "relation delete",
      "One relation lifecycle proves add visibility, list visibility, and delete cleanup.",
    ],
  ],
]);

function isHiddenCommand(command: Command): boolean {
  return Boolean((command as unknown as { _hidden?: boolean })._hidden);
}

function registeredCliLeafCommands(command: Command, parents: string[] = []): string[] {
  const visibleChildren = command.commands.filter((child) => !isHiddenCommand(child));
  if (parents.length > 0 && visibleChildren.length === 0) return [parents.join(" ")];

  return visibleChildren.flatMap((child) =>
    registeredCliLeafCommands(child, [...parents, child.name()]),
  );
}

describe("CLI/MCP parity manifest", () => {
  it("has one entry for every registered MCP tool and no stale tool names", () => {
    const registered = registeredMcpTools().toSorted();
    const manifested = MCP_SURFACE_MANIFEST.map((entry) => entry.tool).toSorted();

    expect(manifested).toEqual(registered);
    expect(unique(manifested)).toHaveLength(manifested.length);
  });

  it("has one entry for every non-hidden CLI leaf command and no stale command rows", () => {
    const registered = registeredCliLeafCommands(buildCliProgram()).toSorted();
    const manifested = CLI_SURFACE_MANIFEST.map((entry) => entry.command).toSorted();

    expect(manifested).toEqual(registered);
    expect(unique(manifested)).toHaveLength(manifested.length);
  });

  it("does not contain duplicate CLI command rows", () => {
    const commands = CLI_SURFACE_MANIFEST.map((entry) => entry.command);
    expect(unique(commands)).toHaveLength(commands.length);
  });

  it("requires every CLI command to have an explicit live coverage policy", () => {
    const registered = CLI_SURFACE_MANIFEST.map((entry) => entry.command).toSorted();
    const covered = CLI_LIVE_COVERAGE_MANIFEST.map((entry) => entry.command).toSorted();

    expect(covered).toEqual(registered);
    expect(unique(covered)).toHaveLength(covered.length);

    for (const entry of CLI_LIVE_COVERAGE_MANIFEST) {
      if ("live_steps" in entry) {
        expect(entry.live_steps.length, `${entry.command} has no live steps`).toBeGreaterThan(0);
        for (const step of entry.live_steps) {
          expect(step, `${entry.command} has non-CLI live step`).toMatch(/^cli:/);
        }
      } else {
        expect(entry.non_live_reason.trim(), `${entry.command} has no non-live reason`).not.toBe(
          "",
        );
      }
    }

    expect(REQUIRED_CLI_LIVE_STEPS).toEqual(unique(REQUIRED_CLI_LIVE_STEPS));
    expect(REQUIRED_CLI_LIVE_STEPS).toContain("cli:cache gc dry-run --json");
    expect(REQUIRED_CLI_LIVE_STEPS).not.toContain("cli:auth logout temp");
  });

  it("keeps duplicate CLI live steps explicit and intentional", () => {
    const stepToCommands = new Map<string, string[]>();
    for (const entry of CLI_LIVE_COVERAGE_MANIFEST) {
      if (!("live_steps" in entry)) continue;
      for (const step of entry.live_steps) {
        stepToCommands.set(step, [...(stepToCommands.get(step) ?? []), entry.command]);
      }
    }

    const duplicates = [...stepToCommands.entries()]
      .filter(([, commands]) => commands.length > 1)
      .map(([step, commands]) => [step, commands.toSorted()] as const)
      .toSorted(([left], [right]) => left.localeCompare(right));
    const allowed = [...INTENTIONAL_DUPLICATE_CLI_LIVE_STEPS.entries()]
      .map(
        ([step, commandsAndReason]) => [step, commandsAndReason.slice(0, -1).toSorted()] as const,
      )
      .toSorted(([left], [right]) => left.localeCompare(right));

    expect(duplicates).toEqual(allowed);
    for (const [step, commandsAndReason] of INTENTIONAL_DUPLICATE_CLI_LIVE_STEPS) {
      expect(commandsAndReason.at(-1), `${step} is missing a reason`).toMatch(/\S/);
    }
  });

  it("only references existing MCP tools from CLI mappings", () => {
    const registered = new Set(registeredMcpTools());
    const referenced = CLI_SURFACE_MANIFEST.flatMap((entry) =>
      entry.maps_to.type === "mcp" ? entry.maps_to.tools : [],
    );

    expect(referenced.filter((tool) => !registered.has(tool))).toEqual([]);
  });

  it("only references manifest CLI commands from MCP reverse mappings", () => {
    const commands = new Set(CLI_SURFACE_MANIFEST.map((entry) => entry.command));
    const referenced = MCP_SURFACE_MANIFEST.flatMap((entry) =>
      entry.maps_to.type === "cli" ? entry.maps_to.tools : [],
    );

    expect(referenced.filter((command) => !commands.has(command))).toEqual([]);
  });

  it("locks set/update_issue direct issue field parity", () => {
    const cliSet = CLI_SURFACE_MANIFEST.find((entry) => entry.command === "set");
    const mcpUpdateIssue = MCP_SURFACE_MANIFEST.find((entry) => entry.tool === "update_issue");

    expect(cliSet?.issue_update_mode).toBe("one_field_per_call");
    expect(mcpUpdateIssue?.issue_update_mode).toBe("multi_field_per_call");
    expect(cliSet?.issue_fields).toEqual(CLI_SET_ISSUE_FIELDS);
    expect(mcpUpdateIssue?.issue_fields).toEqual(MCP_UPDATE_ISSUE_FIELDS);

    for (const field of ["description", "project", "milestone", "cycle"]) {
      expect(CLI_SET_ISSUE_FIELDS).toContain(field);
      expect(MCP_UPDATE_ISSUE_FIELDS).toContain(field);
    }

    expect(CLI_SET_ISSUE_FIELDS).toContain("links");
    expect(MCP_UPDATE_ISSUE_FIELDS).not.toContain("links");
    expect(MCP_UPDATE_ISSUE_FIELDS).toEqual(
      expect.arrayContaining(["labels", "labels_add", "labels_remove"]),
    );
    expect(CLI_SET_ISSUE_FIELDS).not.toContain("content");
    expect(MCP_UPDATE_ISSUE_FIELDS).not.toContain("content");
    const mcpComparableFields = MCP_UPDATE_ISSUE_FIELDS.filter(
      (field) => field !== "labels_add" && field !== "labels_remove",
    );
    expect(CLI_SET_ISSUE_FIELDS.filter((field) => field !== "links").toSorted()).toEqual(
      mcpComparableFields.toSorted(),
    );
    expect(cliSet?.maps_to).toEqual({
      type: "mcp",
      tools: ["update_issue", "update_relations"],
    });
  });

  it("requires explicit confirm:true for destructive MCP Linear operations", () => {
    expect(REQUIRED_MCP_CONFIRM_TOOLS).toEqual(
      expect.arrayContaining([
        "delete_label",
        "delete_project",
        "delete_document",
        "delete_attachment",
        "archive_issue",
      ]),
    );
    const registered = new Set(registeredMcpTools());
    for (const toolName of REQUIRED_MCP_CONFIRM_TOOLS) {
      expect(registered.has(toolName), `${toolName} is not registered`).toBe(true);
      const definition = registeredMcpToolDefinition(toolName);
      expect(definition.config.inputSchema, `${toolName} missing input schema`).toHaveProperty(
        "confirm",
      );
    }

    expect(
      validateDestructiveMcpArgsContract("delete_project", { id: "project-id" }, [
        "delete_project",
      ]),
    ).toEqual([
      {
        contract: "mcp_destructive.confirm_true_required",
        message: "delete_project requires confirm:true for destructive execution",
      },
    ]);
    expect(
      validateDestructiveMcpArgsContract("delete_project", { id: "project-id", confirm: true }, [
        "delete_project",
      ]),
    ).toEqual([]);
  });

  it("documents conditional confirm:true for conditionally destructive MCP tools", () => {
    expect(CONDITIONAL_MCP_CONFIRM_TOOLS.toSorted()).toEqual([
      "add_relation",
      "bulk_update_issues",
      "cache_gc",
      "plan_apply",
      "plan_pull",
      "pull_issues",
      "pull_project",
      "push_changes",
      "raw_graphql",
      "update_relations",
    ]);
    for (const toolName of CONDITIONAL_MCP_CONFIRM_TOOLS) {
      const definition = registeredMcpToolDefinition(toolName);
      expect(definition.config.inputSchema, `${toolName} missing confirm input`).toHaveProperty(
        "confirm",
      );
    }
    expect(registeredMcpToolDefinition("cache_gc").config.inputSchema).toHaveProperty("dry_run");
  });

  it("does not expose confirm on read-only MCP tools", () => {
    for (const toolName of registeredMcpTools()) {
      const definition = registeredMcpToolDefinition(toolName);
      if (definition.config.annotations?.readOnlyHint !== true) continue;
      expect(
        definition.config.inputSchema ?? {},
        `${toolName} is read-only but exposes confirm`,
      ).not.toHaveProperty("confirm");
    }
  });

  it("keeps MCP workspace selection available except for documented local/auth exceptions", () => {
    const withoutWorkspace = registeredMcpTools()
      .filter((toolName) => !registeredMcpInputKeys(toolName).includes("workspace"))
      .toSorted();

    expect(withoutWorkspace).toEqual([
      "cache_gc",
      "lint_text",
      "list_workspaces",
      "set_default_workspace",
      "set_workspace_default_team",
    ]);
    expect(registeredMcpInputKeys("set_workspace_default_team")).toContain("workspace_slug");
  });

  it("keeps get_issue aligned with the show --json read contract", () => {
    const definition = registeredMcpToolDefinition("get_issue");
    expect(registeredMcpInputKeys("get_issue")).toEqual([
      "identifier",
      "include_comments",
      "include_relations",
      "workspace",
    ]);
    expect(definition.config.description).toContain("lebop show --json");
    expect(definition.config.description).toContain("metadata");
    expect(definition.config.description).toContain("description");
    expect(definition.config.description).toContain("comments");
    expect(definition.config.description).toContain("relation");
  });

  it("locks high-value CLI/MCP argument contracts for agent context and publish tools", () => {
    expect(registeredMcpInputKeys("explore_linear_workspace")).toEqual([
      "cursor",
      "include_archived",
      "kinds",
      "limit",
      "path",
      "query",
      "team",
      "workspace",
    ]);
    expect(registeredMcpInputKeys("fetch_linear_workspace")).toEqual([
      "cursor",
      "depth",
      "include",
      "limit",
      "repo_root",
      "target",
      "to",
      "workspace",
    ]);
    expect(registeredMcpInputKeys("pull_issues")).toEqual([
      "confirm",
      "identifiers",
      "include_comments",
      "refresh",
      "repo_root",
      "team",
      "to",
      "workspace",
    ]);
    expect(registeredMcpInputKeys("pull_project")).toEqual([
      "confirm",
      "extra_identifiers",
      "include_comments",
      "project",
      "project_id",
      "refresh",
      "repo_root",
      "team",
      "to",
      "workspace",
    ]);
    expect(registeredMcpInputKeys("update_issue")).toEqual([
      "assignee",
      "cycle",
      "description",
      "estimate",
      "identifier",
      "labels",
      "labels_add",
      "labels_remove",
      "milestone",
      "parent",
      "priority",
      "project",
      "repo_root",
      "state",
      "team",
      "title",
      "workspace",
    ]);
    expect(registeredMcpInputKeys("update_relations")).toEqual([
      "confirm",
      "deltas",
      "from",
      "repo_root",
      "workspace",
    ]);
    expect(registeredMcpInputKeys("lint_files")).toEqual([
      "fix",
      "paths",
      "repo_root",
      "strict",
      "team",
      "workspace",
    ]);
    expect(registeredMcpInputKeys("lint_text")).toEqual(["content", "fix"]);
    expect(registeredMcpInputKeys("whoami")).toEqual(["for_workspace", "workspace"]);
    expect(registeredMcpInputKeys("refresh_whoami")).toEqual(["for_workspace", "workspace"]);
    expect(registeredMcpInputKeys("review_linear_changes")).toEqual([
      "source",
      "strict",
      "team",
      "workspace",
    ]);
    expect(registeredMcpInputKeys("publish_linear_changes")).toEqual([
      "review_id",
      "verify",
      "workspace",
    ]);
  });

  it("keeps cache publish registration order stable through central specs", () => {
    const names = registeredMcpTools();
    const start = names.indexOf("diff_project");
    const end = names.indexOf("plan_validate");

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(names.slice(start, end + 1)).toEqual([
      "diff_project",
      "pull_issues",
      "pull_project",
      "push_changes",
      "review_linear_changes",
      "publish_linear_changes",
      "plan_validate",
    ]);
  });
});

describe("high-risk behavior contracts", () => {
  it("rejects successful publish statuses when summary.ready is false", () => {
    expect(
      validatePublishPayloadContract({
        status: "verified",
        summary: { ready: false },
        result: { ok: true },
      }),
    ).toEqual([
      {
        contract: "publish.no_verified_when_not_ready",
        message: "publish result cannot be status=verified when summary.ready=false",
      },
    ]);
  });

  it("requires capped explore results to advertise truncation and continuation semantics", () => {
    expect(
      validateExplorePayloadContract({
        has_more: false,
        next_cursor: null,
        truncated: false,
        page: {
          bounded: {
            returned: 25,
            limit: 25,
            may_have_more: true,
            continuation: "not_available",
          },
        },
      }),
    ).toEqual([
      {
        contract: "explore.capped_results_are_truncated",
        message: "bounded explore results with may_have_more=true must set truncated=true",
      },
    ]);
  });

  it("requires fetch truncation to include an actionable continuation or unavailable marker", () => {
    expect(
      validateFetchPayloadContract({
        completeness: {
          issue_comments: {
            returned: 100,
            limit: 100,
            complete: false,
            truncated: true,
            reason: "limit",
          },
        },
        continuations: [],
      }),
    ).toEqual([
      {
        contract: "fetch.truncation_requires_continuation",
        message:
          "fetch completeness entry issue_comments is truncated without an actionable continuation or unavailable marker",
      },
    ]);
  });

  it("locks --json error envelope shape", () => {
    expect(validateJsonErrorEnvelopeContract({ ok: false, error: { message: "nope" } })).toEqual([
      {
        contract: "cli_json_errors.use_envelope",
        message: "--json failures must emit {ok:false,schema_version:1,error:{code,message}}",
      },
    ]);
    expect(
      validateJsonErrorEnvelopeContract({
        ok: false,
        schema_version: 1,
        error: { code: "validation_error", message: "nope" },
      }),
    ).toEqual([]);
  });

  it("requires semantic proof arrays where live validation asks for them", () => {
    expect(() => assertSemanticProofs("cli:publish apply --json", [])).toThrow(
      /did not record semantic assertions/,
    );
    expect(() =>
      assertSemanticProofs("cli:publish apply --json", ["status verified"]),
    ).not.toThrow();
  });
});
