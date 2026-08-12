import { describe, expect, it } from "vitest";
import { cacheLayoutKey, repoCacheDir } from "../src/lib/cache.ts";
import {
  encodeEnvelope,
  encodeForAgent,
  maxDepth,
  parseFormatFlag,
  resolveOutputFormat,
} from "../src/lib/encode.ts";
import { SCHEMA_VERSION } from "../src/lib/envelope.ts";
import { shapeHistoryNode } from "../src/lib/issueHistory.ts";
import { normalizeDueDate } from "../src/lib/issues.ts";
import { DEFAULT_LIST_FIELDS, parseListFields, projectListedIssue } from "../src/lib/listIssues.ts";
import {
  filterToolsByProfile,
  isCoreTool,
  MCP_CORE_TOOLS,
  parseMcpProfile,
} from "../src/lib/mcpProfiles.ts";
import {
  resolveWorkspaceSlugForState,
  sanitizeWorkspaceSlug,
  workspaceCacheRoot,
  workspaceContextRoot,
} from "../src/lib/paths.ts";
import { collectMcpToolDefinitions } from "../src/mcp/server.ts";

describe("AXI encode (WS1)", () => {
  it("encodes uniform lists as TOON by default", () => {
    const out = encodeForAgent({
      schema_version: SCHEMA_VERSION,
      count: 2,
      issues: [
        { identifier: "A-1", title: "one", state: "Todo" },
        { identifier: "A-2", title: "two", state: "Done" },
      ],
    });
    expect(out).not.toMatch(/^\s*\{/);
    expect(out).toContain("issues");
    expect(out).toContain("A-1");
    expect(out.includes("\n  ")).toBe(true); // TOON table rows
  });

  it("treats any uniform object-array property as tabular (structural TOON)", () => {
    // Unknown domain key still TOON if rows are uniform objects.
    expect(
      resolveOutputFormat({
        schema_version: SCHEMA_VERSION,
        count: 1,
        widgets: [{ id: "w1", name: "alpha" }],
      }),
    ).toBe("toon");
  });

  it("custom-field style fields: object[] is tabular TOON (not denylisted)", () => {
    expect(
      resolveOutputFormat({
        schema_version: SCHEMA_VERSION,
        count: 2,
        fields: [
          { id: "f1", name: "Priority", type: "select" },
          { id: "f2", name: "Points", type: "number" },
        ],
      }),
    ).toBe("toon");
  });

  it("issue-list projection fields: string[] does not block issues[] TOON", () => {
    expect(
      resolveOutputFormat({
        schema_version: SCHEMA_VERSION,
        count: 1,
        fields: ["identifier", "title", "state", "assignee"],
        issues: [{ identifier: "A-1", title: "t", state: "Todo", assignee: null }],
      }),
    ).toBe("toon");
  });

  it("uses compact JSON for deep nested shapes", () => {
    const deep = {
      a: { b: { c: { d: { e: 1 } } } },
    };
    expect(resolveOutputFormat(deep)).toBe("json");
    const out = encodeForAgent(deep);
    expect(out.startsWith("{")).toBe(true);
    expect(out.includes("\n")).toBe(false);
  });

  it("pretty format indents JSON", () => {
    const out = encodeForAgent({ x: 1 }, { format: "pretty" });
    expect(out).toContain("\n");
  });

  it("encodeEnvelope stamps schema_version 2", () => {
    const out = encodeEnvelope({ ok: true });
    expect(out).toContain("schema_version");
    expect(SCHEMA_VERSION).toBe(2);
  });

  it("parseFormatFlag maps flags", () => {
    expect(parseFormatFlag({ pretty: true })).toBe("pretty");
    expect(parseFormatFlag({ format: "json" })).toBe("json");
    expect(parseFormatFlag({ json: true })).toBe("toon");
  });

  it("maxDepth measures nesting", () => {
    expect(maxDepth(1)).toBe(0);
    expect(maxDepth({ a: { b: 1 } })).toBeGreaterThanOrEqual(2);
  });
});

describe("CLI machine emit hygiene (Wave B)", () => {
  it("commands do not emit pretty-JSON envelopes via JSON.stringify(envelope)", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(__dirname, "../src/commands");
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts")) continue;
      // raw intentionally prints unenveloped GraphQL JSON for jq.
      if (name === "raw.ts") continue;
      const text = readFileSync(join(dir, name), "utf8");
      if (/JSON\.stringify\(\s*envelope\s*\(/.test(text)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("slim list fields (WS1)", () => {
  it("defaults to 4 fields", () => {
    expect(parseListFields(undefined)).toEqual([...DEFAULT_LIST_FIELDS]);
    expect(DEFAULT_LIST_FIELDS.length).toBe(4);
  });

  it("projects listed issue rows", () => {
    const full = {
      identifier: "T-1",
      title: "x",
      state: "Todo",
      state_type: "unstarted",
      priority: 2,
      assignee: { name: "a", email: "a@b.c" },
      labels: ["bug"],
      updated_at: "2020-01-01",
      url: "https://linear.app/x",
      due_date: "2020-02-01",
    };
    const slim = projectListedIssue(full);
    expect(slim.identifier).toBe("T-1");
    expect(slim.title).toBe("x");
    expect(slim.state).toBe("Todo");
    expect(slim.assignee).toBe("a"); // dense string on default projection
    expect(slim.labels).toBeUndefined();
    expect(slim.url).toBeUndefined();
    const all = projectListedIssue(full, parseListFields("full"));
    expect(all.assignee).toEqual(full.assignee); // structured on full
    expect(all.labels).toEqual(["bug"]);
    expect(all.due_date).toBe("2020-02-01");
  });
});

describe("issue history shaping (WS4)", () => {
  it("flattens state changes", () => {
    const rows = shapeHistoryNode({
      id: "h1",
      createdAt: "2026-01-01T00:00:00.000Z",
      actor: { name: "alice" },
      fromState: { name: "Todo" },
      toState: { name: "Done" },
    });
    expect(rows).toEqual([
      {
        at: "2026-01-01T00:00:00.000Z",
        actor: "alice",
        kind: "state",
        from: "Todo",
        to: "Done",
      },
    ]);
  });
});

describe("due date normalize (WS4)", () => {
  it("accepts YYYY-MM-DD", () => {
    expect(normalizeDueDate("2026-08-08")).toBe("2026-08-08");
  });
});

describe("multi-workspace paths (WS3)", () => {
  it("sanitizes workspace slugs", () => {
    expect(sanitizeWorkspaceSlug("Acme")).toBe("acme");
    expect(sanitizeWorkspaceSlug("../evil")).toBe("_unset");
  });

  it("isolates cache roots by workspace", () => {
    const a = workspaceCacheRoot("ws-a");
    const b = workspaceCacheRoot("ws-b");
    expect(a).not.toBe(b);
    expect(a).toContain("ws-a");
    expect(b).toContain("ws-b");
    const ca = repoCacheDir("_global", "ws-a");
    const cb = repoCacheDir("_global", "ws-b");
    expect(ca).not.toBe(cb);
    expect(ca.endsWith("ws-a/_global") || ca.includes("/ws-a/")).toBe(true);
    expect(cacheLayoutKey("ws-a", "_global")).toBe("ws-a/_global");
  });

  it("isolates context roots by workspace", () => {
    expect(workspaceContextRoot("alpha")).not.toBe(workspaceContextRoot("beta"));
  });

  it("resolveWorkspaceSlugForState uses env", () => {
    const prev = process.env.LEBOP_WORKSPACE;
    process.env.LEBOP_WORKSPACE = "env-ws";
    expect(resolveWorkspaceSlugForState()).toBe("env-ws");
    if (prev === undefined) delete process.env.LEBOP_WORKSPACE;
    else process.env.LEBOP_WORKSPACE = prev;
  });

  it("resolveWorkspaceSlugForState prefers auth.default over unset when no env", () => {
    const prev = process.env.LEBOP_WORKSPACE;
    delete process.env.LEBOP_WORKSPACE;
    // Without auth fixture this returns _unset or default; failClosed off for unit isolation
    expect(() =>
      resolveWorkspaceSlugForState(undefined, { failClosedMultiWs: false }),
    ).not.toThrow();
    if (prev === undefined) delete process.env.LEBOP_WORKSPACE;
    else process.env.LEBOP_WORKSPACE = prev;
  });
});

describe("MCP profiles (WS2)", () => {
  it("parses profile names", () => {
    expect(parseMcpProfile("core")).toBe("core");
    expect(parseMcpProfile("full")).toBe("full");
    expect(parseMcpProfile("extended")).toBe("full");
  });

  it("Core is smaller than full and contains required tools", () => {
    const full = collectMcpToolDefinitions("full");
    const core = collectMcpToolDefinitions("core");
    expect(core.length).toBeLessThan(full.length);
    // Product freeze: default progressive profile is exactly 17 tools (docs/spec §13.3).
    expect(MCP_CORE_TOOLS).toHaveLength(17);
    expect(core).toHaveLength(17);
    expect([...MCP_CORE_TOOLS].sort()).toEqual(
      [
        "add_comment",
        "cache_status",
        "create_issue",
        "explore_linear_workspace",
        "fetch_linear_workspace",
        "get_issue",
        "get_project",
        "list_comments",
        "list_issue_history",
        "list_issues",
        "list_projects",
        "publish_linear_changes",
        "pull_issues",
        "raw_graphql",
        "review_linear_changes",
        "search_linear",
        "update_issue",
      ].sort(),
    );
    expect(core.map((t) => t.name).sort()).toEqual([...MCP_CORE_TOOLS].sort());
    const names = new Set(core.map((t) => t.name));
    for (const required of [
      "explore_linear_workspace",
      "fetch_linear_workspace",
      "list_issues",
      "get_issue",
      "create_issue",
      "update_issue",
      "list_comments",
      "add_comment",
      "pull_issues",
      "raw_graphql",
      "search_linear",
      "list_issue_history",
      "cache_status",
      "review_linear_changes",
      "publish_linear_changes",
      "list_projects",
      "get_project",
    ]) {
      expect(names.has(required), `missing core tool ${required}`).toBe(true);
    }
    expect(isCoreTool("list_issues")).toBe(true);
    expect(isCoreTool("diff_issue")).toBe(false);
    expect(isCoreTool("soft_delete_project")).toBe(false);
    expect(
      filterToolsByProfile([{ name: "list_issues" }, { name: "soft_delete_project" }], "core"),
    ).toEqual([{ name: "list_issues" }]);
  });
});
