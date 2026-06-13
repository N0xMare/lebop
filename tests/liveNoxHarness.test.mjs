import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertFullSurfaceReport,
  assertLiveSurfaceReportSanitized,
  assertNoUnexpectedGaps,
  assertSemanticCoverage,
  assertSurfaceCoverage,
  buildConditionalConfirmSemanticCoverage,
  buildFieldUpdateProofCoverage,
  buildLinearApiProofCoverage,
  buildManifestSemanticCoverage,
  buildMcpStdoutFailureResult,
  buildPublishProofCoverage,
  buildRemoteDestructiveAuditCoverage,
  buildSemanticCoverage,
  buildSurfaceCoverage,
  evaluateGaps,
  FIELD_UPDATE_PROOF_LABELS,
  finalizeLiveReportStatus,
  isRemoteAuditNotFoundError,
  LINEAR_API_PROOF_LABELS,
  normalizeLiveStamp,
  PUBLISH_VERIFIED_PROOF_LABELS,
  parseMcpStdoutLine,
  REQUIRED_CLI_LIVE_STEPS,
  REQUIRED_CONDITIONAL_MCP_LIVE_STEPS,
  REQUIRED_DESTRUCTIVE_MCP_LIVE_STEPS,
  REQUIRED_MANIFEST_SEMANTIC_TOOLS,
  REQUIRED_MCP_LIVE_TOOLS,
  REQUIRED_PUBLISH_PROOF_STEPS,
  REQUIRED_SEMANTIC_LIVE_STEPS,
  resolveLebopInvocation,
  sanitizeLiveSurfaceReport,
  shouldFailLiveHarnessProcess,
  validateReportFile,
  writeLiveSurfaceReport,
} from "../scripts/live-nox-surface-smoke.mjs";

function remoteAuditFixture() {
  const target = {
    key: "archived_issue:NOX-1",
    kind: "archived_issue",
    id: "NOX-1",
    label: "test issue",
  };
  return {
    name: "remote destructive audit",
    status: "pass",
    checked: 1,
    expected: 1,
    expected_targets: [target],
    audited_targets: [{ ...target, proof: "archivedAt=2026-06-06T00:00:00.000Z" }],
    proofs: ["test issue: archivedAt=2026-06-06T00:00:00.000Z"],
  };
}

function reportWithCliSteps(extraResults = []) {
  return {
    status: "completed",
    results: [
      ...REQUIRED_CLI_LIVE_STEPS.map((name) => ({ name, status: "pass" })),
      ...extraResults,
    ],
    cleanup: [remoteAuditFixture()],
    gaps: [],
    coverage: { mcp: { advertised: [] } },
    created: {},
  };
}

function semanticResults() {
  return REQUIRED_SEMANTIC_LIVE_STEPS.map((name) => ({
    name,
    status: "pass",
    semantic_assertions: REQUIRED_PUBLISH_PROOF_STEPS.includes(name)
      ? PUBLISH_VERIFIED_PROOF_LABELS
      : FIELD_UPDATE_PROOF_LABELS[name]
        ? FIELD_UPDATE_PROOF_LABELS[name]
        : isWorkspaceResearchStep(name)
          ? LINEAR_API_PROOF_LABELS
          : ["semantic proof"],
  }));
}

function isWorkspaceResearchStep(name) {
  return (
    name.startsWith("cli:workspace explore ") ||
    name.startsWith("cli:workspace fetch ") ||
    name.startsWith("mcp:explore_linear_workspace ") ||
    name === "mcp:fetch_linear_workspace" ||
    name.startsWith("mcp:fetch_linear_workspace ")
  );
}

function mcpManifestResults() {
  return REQUIRED_MCP_LIVE_TOOLS.map((tool) => ({
    name: `mcp:${tool}`,
    status: "pass",
    tool,
  }));
}

function reportWithFullSurface(extraResults = []) {
  const report = reportWithCliSteps([
    ...mcpManifestResults(),
    ...semanticResults(),
    ...extraResults,
  ]);
  report.created.mcp_tools = [...REQUIRED_MCP_LIVE_TOOLS];
  return report;
}

function compiledBinaryProvenance() {
  return {
    mode: "compiled-binary",
    path: "./dist/lebop",
    sha256: "a".repeat(64),
    size_bytes: 123456,
    version: "0.0.3",
    platform: "darwin",
    arch: "arm64",
  };
}

describe("live Noxor harness validation helpers", () => {
  it("allows only explicitly allowlisted, unexpired gaps", () => {
    const gaps = [{ name: "mcp:get_cycle", reason: "fixture unavailable" }];

    expect(evaluateGaps(gaps, new Date("2026-06-05T00:00:00.000Z"))).toEqual([
      {
        name: "mcp:get_cycle",
        allowed: true,
        reason: "NOX currently has no cycles, so get_cycle has no valid UUID fixture.",
        expires: "2026-07-31",
        detail_reason: "fixture unavailable",
      },
    ]);
    expect(() => assertNoUnexpectedGaps({ gaps }, new Date("2026-08-01T00:00:00.000Z"))).toThrow(
      /unallowlisted or expired gaps/,
    );
  });

  it("keeps allowed gaps release-blocking for full-surface validation", () => {
    const report = reportWithCliSteps(semanticResults());
    report.created.mcp_tools = [];
    report.gaps = [{ name: "mcp:get_cycle", reason: "fixture unavailable" }];
    report.results.push({ name: "mcp:get_cycle", status: "gap" });

    expect(() =>
      assertNoUnexpectedGaps(report, new Date("2026-06-05T00:00:00.000Z")),
    ).not.toThrow();
    expect(() => assertFullSurfaceReport(report)).toThrow(/live gaps recorded/);
  });

  it("can target a compiled binary through LEBOP_LIVE_BIN", () => {
    const source = resolveLebopInvocation(["--version"], {});
    expect(source.command).toBe("bun");
    expect(source.args.at(-1)).toBe("--version");
    expect(source.mode).toBe("source-wrapper");

    const compiled = resolveLebopInvocation(["--version"], { LEBOP_LIVE_BIN: "./dist/lebop" });
    expect(compiled.command).toMatch(/dist\/lebop$/);
    expect(compiled.args).toEqual(["--version"]);
    expect(compiled.mode).toBe("compiled-binary");
  });

  it("requires compiled-binary mode when validating compiled release reports", () => {
    const sourceReport = reportWithFullSurface();
    sourceReport.binary_under_test = { mode: "source-wrapper", path: "./bin/lebop" };

    expect(() =>
      assertFullSurfaceReport(sourceReport, { expectedBinaryMode: "compiled-binary" }),
    ).toThrow(/binary_under_test\.mode/);

    sourceReport.binary_under_test = compiledBinaryProvenance();
    expect(
      assertFullSurfaceReport(sourceReport, { expectedBinaryMode: "compiled-binary" }).ok,
    ).toBe(true);
  });

  it("requires compiled-binary provenance when validating release reports", () => {
    const report = reportWithFullSurface();
    report.binary_under_test = { mode: "compiled-binary", path: "./dist/lebop" };

    expect(() =>
      assertFullSurfaceReport(report, { expectedBinaryMode: "compiled-binary" }),
    ).toThrow(/binary_under_test\.sha256/);

    report.binary_under_test = { ...compiledBinaryProvenance(), sha256: "not-a-sha" };
    expect(() =>
      assertFullSurfaceReport(report, { expectedBinaryMode: "compiled-binary" }),
    ).toThrow(/binary_under_test\.sha256/);

    report.binary_under_test = { ...compiledBinaryProvenance(), size_bytes: 0 };
    expect(() =>
      assertFullSurfaceReport(report, { expectedBinaryMode: "compiled-binary" }),
    ).toThrow(/binary_under_test\.size_bytes/);
  });

  it("requires compiled-binary version parity when validating release reports", () => {
    const report = reportWithFullSurface();
    report.binary_under_test = { ...compiledBinaryProvenance(), version: "0.0.2" };

    expect(() =>
      assertFullSurfaceReport(report, {
        expectedBinaryMode: "compiled-binary",
        expectedBinaryVersion: "0.0.3",
      }),
    ).toThrow(/binary_under_test\.version/);
  });

  it("can require exact live report workspace, team, stamp, and binary hash", () => {
    const report = reportWithFullSurface();
    report.workspace = "noxor";
    report.team = "NOX";
    report.stamp = "release-proof";
    report.prefix = "lebop-surface-release-proof";
    report.binary_under_test = compiledBinaryProvenance();

    expect(
      assertFullSurfaceReport(report, {
        expectedWorkspace: "noxor",
        expectedTeam: "NOX",
        expectedStamp: "release-proof",
        expectedBinaryMode: "compiled-binary",
        expectedBinarySha256: "a".repeat(64),
      }).ok,
    ).toBe(true);

    expect(() =>
      assertFullSurfaceReport(
        {
          ...report,
          workspace: "other",
          team: "ABC",
          stamp: "wrong",
          prefix: "lebop-surface-wrong",
          binary_under_test: { ...compiledBinaryProvenance(), sha256: "b".repeat(64) },
        },
        {
          expectedWorkspace: "noxor",
          expectedTeam: "NOX",
          expectedStamp: "release-proof",
          expectedBinaryMode: "compiled-binary",
          expectedBinarySha256: "a".repeat(64),
        },
      ),
    ).toThrow(/workspace[\s\S]*team[\s\S]*stamp[\s\S]*prefix[\s\S]*binary_under_test\.sha256/);
  });

  it("parses MCP stdout strictly and records protocol pollution as a failed result", () => {
    expect(parseMcpStdoutLine('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
    expect(() => parseMcpStdoutLine("debug log")).toThrow(/non-JSON stdout/);
    expect(() => parseMcpStdoutLine('{"message":"debug log"}')).toThrow(/non-JSON-RPC stdout/);

    const failure = buildMcpStdoutFailureResult(
      "debug log",
      new Error("MCP server wrote non-JSON stdout"),
      new Date("2026-06-06T00:00:00.000Z"),
    );
    expect(failure).toMatchObject({
      name: "mcp:stdout protocol",
      status: "fail",
      stdout_line: "debug log",
      at: "2026-06-06T00:00:00.000Z",
    });
  });

  it("fails unallowlisted gaps", () => {
    expect(() =>
      assertNoUnexpectedGaps({
        gaps: [{ name: "mcp:new_uncovered_tool", reason: "not implemented" }],
      }),
    ).toThrow(/mcp:new_uncovered_tool/);
  });

  it("builds a mechanical MCP coverage matrix from advertised tool names", () => {
    const report = reportWithCliSteps([{ name: "mcp:list_issues", status: "pass" }]);
    const coverage = buildSurfaceCoverage(report, ["list_issues", "create_issue"]);

    expect(coverage.cli.missing).toEqual([]);
    expect(coverage.mcp.covered).toEqual(["list_issues"]);
    expect(coverage.mcp.missing).toEqual(["create_issue"]);
    expect(() => assertSurfaceCoverage(report, ["list_issues", "create_issue"])).toThrow(
      /create_issue/,
    );
  });

  it("passes when all required CLI steps and advertised MCP tools are covered", () => {
    const report = reportWithCliSteps([
      { name: "mcp:list_issues", status: "pass" },
      { name: "mcp:create_issue", status: "pass" },
    ]);

    assertSurfaceCoverage(report, ["list_issues", "create_issue"]);
    expect(report.coverage.mcp.missing).toEqual([]);
    expect(report.coverage.cli.missing).toEqual([]);
  });

  it("requires deterministic project cursor page-two live coverage", () => {
    const cliPage2 = "cli:workspace explore projects cursor page 2 --json";
    const mcpPage2 = "mcp:explore_linear_workspace projects cursor page 2";
    expect(REQUIRED_CLI_LIVE_STEPS).toContain(cliPage2);
    expect(REQUIRED_SEMANTIC_LIVE_STEPS).toContain(mcpPage2);

    const report = {
      status: "completed",
      results: REQUIRED_CLI_LIVE_STEPS.filter((name) => name !== cliPage2).map((name) => ({
        name,
        status: "pass",
      })),
      cleanup: [],
      gaps: [],
      coverage: { mcp: { advertised: [] } },
      created: {},
    };

    const surfaceCoverage = buildSurfaceCoverage(report, []);
    expect(surfaceCoverage.cli.missing).toContain(cliPage2);
    expect(() => assertSurfaceCoverage(report, [])).toThrow(/cursor page 2/);

    const semanticReport = reportWithCliSteps(
      semanticResults().filter((result) => result.name !== mcpPage2),
    );
    const semanticCoverage = buildSemanticCoverage(semanticReport);
    expect(semanticCoverage.missing).toContain(mcpPage2);
    expect(() => assertSemanticCoverage(semanticReport)).toThrow(/cursor page 2/);
  });

  it("requires document context fetch proof in the full live harness", () => {
    expect(REQUIRED_CLI_LIVE_STEPS).toContain("cli:workspace fetch document --json");
    expect(REQUIRED_SEMANTIC_LIVE_STEPS).toContain("cli:workspace fetch document --json");
    expect(REQUIRED_SEMANTIC_LIVE_STEPS).toContain("mcp:fetch_linear_workspace document");

    const report = reportWithCliSteps(
      semanticResults().filter(
        (result) =>
          result.name !== "cli:workspace fetch document --json" &&
          result.name !== "mcp:fetch_linear_workspace document",
      ),
    );

    const coverage = buildSemanticCoverage(report);
    expect(coverage.missing).toEqual(
      expect.arrayContaining([
        "cli:workspace fetch document --json",
        "mcp:fetch_linear_workspace document",
      ]),
    );
    expect(() => assertSemanticCoverage(report)).toThrow(/workspace fetch document/);
  });

  it("requires direct non-dry-run cache push proof in the full live harness", () => {
    expect(REQUIRED_CLI_LIVE_STEPS).toContain("cli:push issue --json");
    expect(REQUIRED_SEMANTIC_LIVE_STEPS).toContain("cli:push issue --json");
    expect(REQUIRED_SEMANTIC_LIVE_STEPS).toContain("mcp:push_changes");

    const report = reportWithCliSteps(
      semanticResults().filter(
        (result) => result.name !== "cli:push issue --json" && result.name !== "mcp:push_changes",
      ),
    );

    const coverage = buildSemanticCoverage(report);
    expect(coverage.missing).toEqual(
      expect.arrayContaining(["cli:push issue --json", "mcp:push_changes"]),
    );
    expect(() => assertSemanticCoverage(report)).toThrow(/push/);
  });

  it("requires issue agent-session fetch policy proof in the full live harness", () => {
    expect(REQUIRED_CLI_LIVE_STEPS).toContain("cli:workspace fetch issue agent-sessions --json");
    expect(REQUIRED_SEMANTIC_LIVE_STEPS).toContain(
      "cli:workspace fetch issue agent-sessions --json",
    );
    expect(REQUIRED_SEMANTIC_LIVE_STEPS).toContain(
      "mcp:fetch_linear_workspace issue agent-sessions",
    );

    const report = reportWithCliSteps(
      semanticResults().filter(
        (result) =>
          result.name !== "cli:workspace fetch issue agent-sessions --json" &&
          result.name !== "mcp:fetch_linear_workspace issue agent-sessions",
      ),
    );

    const coverage = buildSemanticCoverage(report);
    expect(coverage.missing).toEqual(
      expect.arrayContaining([
        "cli:workspace fetch issue agent-sessions --json",
        "mcp:fetch_linear_workspace issue agent-sessions",
      ]),
    );
    expect(() => assertSemanticCoverage(report)).toThrow(/agent-sessions/);
  });

  it("requires issue document explore/fetch proof in the full live harness", () => {
    expect(REQUIRED_CLI_LIVE_STEPS).toContain("cli:workspace explore issue documents --json");
    expect(REQUIRED_CLI_LIVE_STEPS).toContain("cli:workspace fetch issue documents --json");
    expect(REQUIRED_SEMANTIC_LIVE_STEPS).toContain("cli:workspace explore issue documents --json");
    expect(REQUIRED_SEMANTIC_LIVE_STEPS).toContain("cli:workspace fetch issue documents --json");
    expect(REQUIRED_SEMANTIC_LIVE_STEPS).toContain("mcp:explore_linear_workspace issue documents");
    expect(REQUIRED_SEMANTIC_LIVE_STEPS).toContain("mcp:fetch_linear_workspace issue documents");

    const omitted = new Set([
      "cli:workspace explore issue documents --json",
      "cli:workspace fetch issue documents --json",
      "mcp:explore_linear_workspace issue documents",
      "mcp:fetch_linear_workspace issue documents",
    ]);
    const report = reportWithCliSteps(
      semanticResults().filter((result) => !omitted.has(result.name)),
    );

    const coverage = buildSemanticCoverage(report);
    expect(coverage.missing).toEqual(expect.arrayContaining([...omitted]));
    expect(() => assertSemanticCoverage(report)).toThrow(/issue documents/);
  });

  it("requires project and initiative search proof in the full live harness", () => {
    const omitted = new Set([
      "cli:workspace explore project search --json",
      "cli:workspace explore initiative search --json",
      "mcp:explore_linear_workspace project search",
      "mcp:explore_linear_workspace initiative search",
    ]);
    expect(REQUIRED_CLI_LIVE_STEPS).toEqual(
      expect.arrayContaining([
        "cli:workspace explore project search --json",
        "cli:workspace explore initiative search --json",
      ]),
    );
    for (const step of omitted) {
      expect(REQUIRED_SEMANTIC_LIVE_STEPS).toContain(step);
    }

    const report = reportWithCliSteps(
      semanticResults().filter((result) => !omitted.has(result.name)),
    );

    const coverage = buildSemanticCoverage(report);
    expect(coverage.missing).toEqual(expect.arrayContaining([...omitted]));
    expect(() => assertSemanticCoverage(report)).toThrow(/project search/);
  });

  it("requires concrete cycle and agent-session workspace dossier proof", () => {
    const omitted = new Set([
      "cli:workspace explore cycle issues --json",
      "cli:workspace fetch cycle --json",
      "cli:workspace fetch agent-session --json",
      "mcp:explore_linear_workspace cycle issues",
      "mcp:fetch_linear_workspace cycle",
      "mcp:fetch_linear_workspace agent-session",
    ]);
    expect(REQUIRED_CLI_LIVE_STEPS).toEqual(
      expect.arrayContaining([
        "cli:workspace explore cycle issues --json",
        "cli:workspace fetch cycle --json",
        "cli:workspace fetch agent-session --json",
      ]),
    );
    for (const step of omitted) {
      expect(REQUIRED_SEMANTIC_LIVE_STEPS).toContain(step);
    }

    const report = reportWithCliSteps(
      semanticResults().filter((result) => !omitted.has(result.name)),
    );

    const coverage = buildSemanticCoverage(report);
    expect(coverage.missing).toEqual(expect.arrayContaining([...omitted]));
    expect(() => assertSemanticCoverage(report)).toThrow(/workspace fetch cycle/);
  });

  it("requires MCP lint file and content fix proof in the full live harness", () => {
    expect(REQUIRED_SEMANTIC_LIVE_STEPS).toContain("mcp:lint_files fix");
    expect(REQUIRED_SEMANTIC_LIVE_STEPS).toContain("mcp:lint_text fix");

    const report = reportWithCliSteps(
      semanticResults().filter(
        (result) => result.name !== "mcp:lint_files fix" && result.name !== "mcp:lint_text fix",
      ),
    );

    expect(buildSemanticCoverage(report).missing).toContain("mcp:lint_files fix");
    expect(buildSemanticCoverage(report).missing).toContain("mcp:lint_text fix");
    expect(() => assertSemanticCoverage(report)).toThrow(/lint_files fix/);
  });

  it("requires direct set/update_issue field proof labels in the full live harness", () => {
    expect(REQUIRED_CLI_LIVE_STEPS).toEqual(
      expect.arrayContaining([
        "cli:set description --json",
        "cli:set project --json",
        "cli:set milestone --json",
        "cli:set cycle --json",
      ]),
    );
    expect(REQUIRED_SEMANTIC_LIVE_STEPS).toEqual(
      expect.arrayContaining([
        "cli:set description --json",
        "cli:set project --json",
        "cli:set milestone --json",
        "cli:set cycle --json",
        "mcp:update_issue",
      ]),
    );

    const report = reportWithFullSurface();
    report.results = report.results.map((result) =>
      result.name === "mcp:update_issue" && result.semantic_assertions
        ? { ...result, semantic_assertions: ["semantic proof"] }
        : result,
    );

    const coverage = buildFieldUpdateProofCoverage(report);
    expect(coverage.missing).toContain("mcp:update_issue");
    expect(coverage.rows.find((row) => row.name === "mcp:update_issue")?.missing_labels).toEqual(
      FIELD_UPDATE_PROOF_LABELS["mcp:update_issue"],
    );
    expect(() => assertFullSurfaceReport(report)).toThrow(/field update proof missing/);
    expect(shouldFailLiveHarnessProcess(report)).toBe(true);
  });

  it("requires retained Linear API telemetry proof for workspace research paths", () => {
    const omitted = new Set([
      "cli:workspace fetch document --json",
      "mcp:fetch_linear_workspace document",
    ]);
    const report = reportWithFullSurface();
    report.results = report.results.map((result) =>
      omitted.has(result.name) && result.semantic_assertions
        ? { ...result, semantic_assertions: ["semantic proof"] }
        : result,
    );

    const coverage = buildLinearApiProofCoverage(report);
    expect(coverage.missing).toEqual(expect.arrayContaining([...omitted]));
    expect(
      coverage.rows.find((row) => row.name === "mcp:fetch_linear_workspace document")
        ?.missing_labels,
    ).toEqual(LINEAR_API_PROOF_LABELS);
    expect(() => assertFullSurfaceReport(report)).toThrow(/linear_api proof missing/);
    expect(shouldFailLiveHarnessProcess(report)).toBe(true);
  });

  it("tracks required semantic proof coverage separately from invocation coverage", () => {
    const report = reportWithCliSteps(semanticResults().slice(0, 1));

    const coverage = buildSemanticCoverage(report);

    expect(coverage.covered).toEqual([REQUIRED_SEMANTIC_LIVE_STEPS[0]]);
    expect(coverage.missing).toContain(REQUIRED_SEMANTIC_LIVE_STEPS[1]);
    expect(() => assertSemanticCoverage(report)).toThrow(/live semantic assertions missing/);
  });

  it("derives required semantic live coverage from the MCP surface manifest", () => {
    expect(REQUIRED_MANIFEST_SEMANTIC_TOOLS).toEqual(
      expect.arrayContaining([
        "bulk_update_issues",
        "create_issue",
        "explore_linear_workspace",
        "fetch_linear_workspace",
        "publish_linear_changes",
        "pull_issues",
        "pull_project",
        "review_linear_changes",
        "update_issue",
      ]),
    );

    const coverage = buildManifestSemanticCoverage();

    expect(coverage.missing).toEqual([]);
    for (const row of coverage.configured) {
      expect(row.configured_steps.length, row.tool).toBeGreaterThan(0);
    }
  });

  it("derives semantic proof requirements for destructive confirm MCP tools", () => {
    expect(REQUIRED_DESTRUCTIVE_MCP_LIVE_STEPS).toEqual(
      expect.arrayContaining([
        "mcp:delete_relation",
        "mcp:archive_initiative",
        "mcp:initiative_remove_project",
        "mcp:delete_comment",
        "mcp:delete_attachment",
      ]),
    );
    for (const step of REQUIRED_DESTRUCTIVE_MCP_LIVE_STEPS) {
      expect(REQUIRED_SEMANTIC_LIVE_STEPS).toContain(step);
    }
  });

  it("derives semantic proof requirements for conditional-confirm MCP tools", () => {
    expect(REQUIRED_CONDITIONAL_MCP_LIVE_STEPS).toEqual(
      expect.arrayContaining([
        "mcp:pull_project refresh",
        "mcp:pull_issues refresh",
        "mcp:push_changes force",
        "mcp:plan_apply force",
        "mcp:plan_pull force",
        "mcp:cache_gc delete temp cache",
        "mcp:add_relation replacement confirm",
        "mcp:update_relations remove confirm",
        "mcp:raw_graphql mutation confirm",
      ]),
    );

    const coverage = buildConditionalConfirmSemanticCoverage();
    expect(coverage.missing).toEqual([]);
    for (const row of coverage.configured) {
      expect(row.configured_steps.length, row.tool).toBeGreaterThan(0);
    }
    for (const step of REQUIRED_CONDITIONAL_MCP_LIVE_STEPS) {
      expect(REQUIRED_SEMANTIC_LIVE_STEPS).toContain(step);
    }
  });

  it("requires verified publish proof labels for every publish apply path", () => {
    const report = reportWithFullSurface([
      {
        name: "cli:publish apply --json",
        status: "pass",
        semantic_assertions: ["status=blocked"],
      },
    ]);
    report.results = report.results.filter(
      (result) =>
        result.name !== "cli:publish apply --json" ||
        result.semantic_assertions?.[0] === "status=blocked",
    );

    const coverage = buildPublishProofCoverage(report);
    expect(coverage.missing).toContain("cli:publish apply --json");
    expect(() => assertFullSurfaceReport(report)).toThrow(/verified publish proof missing/);
    expect(shouldFailLiveHarnessProcess(report)).toBe(true);
  });

  it("requires remote destructive cleanup audit proof in full reports", () => {
    const report = reportWithFullSurface();
    report.cleanup = [];

    expect(() => assertFullSurfaceReport(report)).toThrow(/remote destructive cleanup audit/);
  });

  it("requires remote destructive cleanup audit target identity coverage", () => {
    const target = {
      key: "archived_issue:NOX-1",
      kind: "archived_issue",
      id: "NOX-1",
      label: "test issue",
    };
    const report = reportWithFullSurface();
    report.cleanup = [
      {
        name: "remote destructive audit",
        status: "pass",
        checked: 1,
        expected: 2,
        expected_targets: [
          target,
          {
            key: "soft_deleted_project:project-1",
            kind: "soft_deleted_project",
            id: "project-1",
            label: "test project",
          },
        ],
        audited_targets: [{ ...target, proof: "archivedAt=2026-06-06T00:00:00.000Z" }],
      },
    ];

    const coverage = buildRemoteDestructiveAuditCoverage(report);
    expect(coverage.missing).toEqual(["soft_deleted_project:project-1"]);
    expect(() => assertFullSurfaceReport(report)).toThrow(
      /remote destructive cleanup audit missed targets/,
    );
  });

  it("requires proof text for every remote destructive cleanup audit target", () => {
    const audit = remoteAuditFixture();
    const report = reportWithFullSurface();
    report.cleanup = [
      {
        ...audit,
        audited_targets: audit.audited_targets.map(({ proof, ...target }) => target),
      },
    ];

    const coverage = buildRemoteDestructiveAuditCoverage(report);
    expect(coverage.proofless).toEqual(["archived_issue:NOX-1"]);
    expect(() => assertFullSurfaceReport(report)).toThrow(
      /remote destructive cleanup audit missing proof text/,
    );
  });

  it("requires remote destructive cleanup audit count fields to match target lists", () => {
    const report = reportWithFullSurface();
    report.cleanup = [{ ...remoteAuditFixture(), checked: 2 }];

    const coverage = buildRemoteDestructiveAuditCoverage(report);
    expect(coverage.checked).toBe(2);
    expect(coverage.audited.map((target) => target.key)).toEqual(["archived_issue:NOX-1"]);
    expect(() => assertFullSurfaceReport(report)).toThrow(
      /remote destructive cleanup audit count mismatch/,
    );
  });

  it("treats Linear not_found as remote absence proof for deleted target audits", () => {
    expect(
      isRemoteAuditNotFoundError(
        new Error(
          "remote cleanup audit query failed\nSTDERR:\nerror[not_found]: Entity not found: Comment - Could not find referenced Comment.",
        ),
      ),
    ).toBe(true);
    expect(isRemoteAuditNotFoundError(new Error("rate_limit_error"))).toBe(false);
  });

  it("strictly validates a complete full-surface report", () => {
    const report = reportWithFullSurface();

    const validation = assertFullSurfaceReport(report);

    expect(validation.ok).toBe(true);
    expect(validation.coverage.cli.missing).toEqual([]);
    expect(validation.coverage.mcp.missing).toEqual([]);
    expect(validation.coverage.semantic.missing).toEqual([]);
    expect(shouldFailLiveHarnessProcess(report)).toBe(false);
  });

  it("rejects failed, gapped, dirty-cleanup, and incomplete reports", () => {
    const report = reportWithCliSteps([
      { name: "mcp:list_issues", status: "pass" },
      { name: "mcp:get_cycle", status: "gap" },
      { name: "cli:extra failed step", status: "fail" },
    ]);
    report.status = "failed";
    report.gaps = [];
    report.cleanup = [{ name: "delete issue", status: "fail" }];
    report.created.mcp_tools = ["create_issue", "list_issues"];

    expect(() => assertFullSurfaceReport(report)).toThrow(
      /report status is "failed"[\s\S]*failed live steps[\s\S]*live gaps recorded[\s\S]*cleanup failures[\s\S]*MCP manifest tools missing live coverage[\s\S]*live semantic assertions missing/,
    );
  });

  it("validates MCP inventory and coverage against the manifest, not self-reported subsets", () => {
    const omittedTool = REQUIRED_MCP_LIVE_TOOLS.find((tool) => tool !== "list_issues");
    const report = reportWithFullSurface();
    report.created.mcp_tools = REQUIRED_MCP_LIVE_TOOLS.filter((tool) => tool !== omittedTool);
    report.results = report.results.filter((result) => result.tool !== omittedTool);

    expect(() => assertFullSurfaceReport(report)).toThrow(
      new RegExp(`missing manifest tools[\\s\\S]*${omittedTool}`),
    );
  });

  it("sanitizes live report artifacts before serialization", async () => {
    const rawReport = reportWithFullSurface([
      {
        name: "cli:raw",
        status: "pass",
        command:
          "lebop --workspace noxor --team NOX raw 'query { viewer { id email } }' --token-file /tmp/lebop-live-nox-abc/token.txt",
        stdout_preview:
          '{"viewer":{"id":"user-id","email":"agent@example.com"},"token":"lin_secretvalue"}',
      },
      {
        name: "mcp:raw_graphql",
        status: "pass",
        response_preview: '{"viewer":{"email":"agent@example.com"}}',
        semantic_assertions: [
          "remote issue NOX-977 verified",
          "project afc0b9e5-236b-4059-af9d-fa9292569360 verified",
        ],
      },
    ]);
    rawReport.temp_home = "/tmp/lebop-live-nox-abc";
    rawReport.created.viewer_email = "agent@example.com";
    rawReport.created.macos_temp_home = "/var/folders/zz/abc/T/lebop-live-nox-abc";
    rawReport.created.macos_token_path = "/var/folders/zz/abc/T/lebop-live-nox-abc/token.txt";
    rawReport.created.team_id = "7e94287e-95d8-476d-a97f-e69d8ff05d64";
    rawReport.created.cli_project = "afc0b9e5-236b-4059-af9d-fa9292569360";
    rawReport.created.cli_issue_primary = "NOX-977";
    rawReport.binary_under_test = {
      ...compiledBinaryProvenance(),
      path: "/Users/example/dev/unlink/lebop/docs/local/lebop-live-v003-darwin-arm64",
    };

    expect(() => assertLiveSurfaceReportSanitized(rawReport)).toThrow(/unsanitized/);

    const sanitized = sanitizeLiveSurfaceReport(rawReport);
    expect(() => assertLiveSurfaceReportSanitized(sanitized)).not.toThrow();
    expect(sanitized.binary_under_test.path).toBe("lebop-live-v003-darwin-arm64");
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("agent@example.com");
    expect(serialized).not.toContain("/Users/example");
    expect(serialized).not.toContain("/tmp/lebop-live-nox-abc");
    expect(serialized).not.toContain("/var/folders/zz/abc/T/lebop-live-nox-abc");
    expect(serialized).not.toContain("lebop-live-nox-abc");
    expect(serialized).not.toContain("token.txt");
    expect(serialized).not.toContain("lin_secretvalue");
    expect(serialized).not.toContain("7e94287e-95d8-476d-a97f-e69d8ff05d64");
    expect(serialized).not.toContain("afc0b9e5-236b-4059-af9d-fa9292569360");
    expect(serialized).not.toContain("NOX-977");
    expect(serialized).toContain("redacted-uuid-");
    expect(serialized).toContain("redacted-issue-");
    expect(serialized).not.toContain("stdout_preview");
    expect(serialized).not.toContain("response_preview");

    const root = await mkdtemp(path.join(tmpdir(), "lebop-live-report-sanitize-test-"));
    try {
      const reportPath = await writeLiveSurfaceReport(rawReport, {
        reportDir: root,
        stamp: "sanitize",
      });
      const written = await readFile(reportPath, "utf8");
      expect(written).not.toContain("agent@example.com");
      expect(written).not.toContain("/Users/example");
      expect(written).not.toContain("/tmp/lebop-live-nox-abc");
      expect(written).not.toContain("lebop-live-nox-abc");
      expect(written).not.toContain("stdout_preview");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects macOS-style live temp path segments even outside /tmp", () => {
    const rawReport = reportWithFullSurface();
    rawReport.created.macos_temp_home = "/var/folders/zz/abc/T/lebop-live-nox-macos";

    expect(() => assertLiveSurfaceReportSanitized(rawReport)).toThrow(/temporary live auth path/);

    const sanitized = sanitizeLiveSurfaceReport(rawReport);
    expect(() => assertLiveSurfaceReportSanitized(sanitized)).not.toThrow();
    expect(JSON.stringify(sanitized)).not.toContain("lebop-live-nox-macos");
  });

  it("rejects unsanitized artifacts during validate-report", async () => {
    const rawReport = reportWithFullSurface([
      {
        name: "cli:raw",
        status: "pass",
        command:
          "lebop --workspace noxor raw 'query { viewer { id email } }' --token-file /tmp/lebop-live-nox-abc/token.txt",
      },
    ]);
    rawReport.temp_home = "/tmp/lebop-live-nox-abc";
    rawReport.created.viewer_email = "agent@example.com";

    const root = await mkdtemp(path.join(tmpdir(), "lebop-live-report-validate-sanitize-test-"));
    try {
      const reportPath = await writeLiveSurfaceReport(rawReport, {
        reportDir: root,
        stamp: "unsanitized",
        sanitize: false,
      });

      await expect(validateReportFile(reportPath)).rejects.toThrow(/unsanitized/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prints linear_api_missing in validate-report success summaries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lebop-live-report-validate-summary-test-"));
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const reportPath = await writeLiveSurfaceReport(reportWithFullSurface(), {
        reportDir: root,
        stamp: "summary",
      });

      await validateReportFile(reportPath);

      const summary = JSON.parse(String(consoleLog.mock.calls.at(-1)?.[0] ?? "{}"));
      expect(summary.status).toBe("passed");
      expect(summary.linear_api_missing).toEqual([]);
    } finally {
      consoleLog.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes live report stamps and rejects path-like values", async () => {
    expect(normalizeLiveStamp(" 20260605000000 ")).toBe("20260605000000");
    expect(normalizeLiveStamp("release_2026-06.05")).toBe("release_2026-06.05");

    for (const unsafe of ["../report", "nested/report", "nested\\report", ".", ".."]) {
      expect(() => normalizeLiveStamp(unsafe)).toThrow(/basename|must not/);
    }
    expect(() => normalizeLiveStamp("bad stamp")).toThrow(/safe filename/);

    const root = await mkdtemp(path.join(tmpdir(), "lebop-live-report-stamp-test-"));
    try {
      await expect(
        writeLiveSurfaceReport(reportWithFullSurface(), { reportDir: root, stamp: "../escape" }),
      ).rejects.toThrow(/basename/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks final reports as failed when a late failed result is recorded", () => {
    const report = reportWithFullSurface([
      { name: "mcp:stdout protocol", status: "fail", error: "non-JSON stdout" },
    ]);
    report.status = "completed";

    expect(finalizeLiveReportStatus(report)).toBe("failed");
    expect(shouldFailLiveHarnessProcess(report)).toBe(true);
  });

  it("creates the ignored report directory before writing reports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lebop-live-report-test-"));
    const reportDir = path.join(root, "docs", "local");
    try {
      const report = reportWithCliSteps([{ name: "mcp:list_issues", status: "pass" }]);
      report.created.mcp_tools = ["list_issues"];

      const reportPath = await writeLiveSurfaceReport(report, {
        reportDir,
        stamp: "20260605000000",
      });

      expect(reportPath).toBe(path.join(reportDir, "live-nox-surface-report-20260605000000.json"));
      expect(JSON.parse(await readFile(reportPath, "utf8")).status).toBe("completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
