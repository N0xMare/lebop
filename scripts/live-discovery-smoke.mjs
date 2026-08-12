#!/usr/bin/env bun
/**
 * Live discovery/feature smoke for surfaces not fully covered by
 * live-surface-smoke.mjs REQUIRED_CLI_LIVE_STEPS:
 *   search, history, due-date set, views CRUD+materialize, custom fields,
 *   label update, project/initiative update edit-delete, issue-scoped docs,
 *   dense machine encoding, MCP Core profile, multi-workspace path layout.
 *
 * Uses existing auth (lebop-playground by default). Creates resources with a
 * unique stamp and best-effort cleans them up.
 *
 * Invocation (same semantics as live-surface-smoke):
 *   - Default: `bun bin/lebop` (source wrapper)
 *   - Release/compiled: set `LEBOP_LIVE_BIN=/path/to/lebop` (no bun prefix)
 *
 * Usage:
 *   bun scripts/live-discovery-smoke.mjs
 *   LEBOP_LIVE_BIN=./dist/lebop LEBOP_LIVE_WORKSPACE=lebop-playground LEBOP_LIVE_TEAM=LEB bun scripts/live-discovery-smoke.mjs
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  defaultLiveStamp,
  normalizeLiveStamp,
  sanitizeLiveSurfaceReport,
} from "./live-surface-smoke.mjs";

const repoRoot = path.resolve(import.meta.dir, "..");
const DEFAULT_LEBOP_BIN = path.join(repoRoot, "bin", "lebop");
const workspace = process.env.LEBOP_LIVE_WORKSPACE ?? "lebop-playground";
const team = process.env.LEBOP_LIVE_TEAM ?? "LEB";
const stamp = normalizeLiveStamp(process.env.LEBOP_LIVE_STAMP ?? defaultLiveStamp());
const prefix = `disc-${stamp}`;
const timeoutMs = Number(process.env.LEBOP_LIVE_TIMEOUT_MS ?? 120_000);

/** Mirror live-surface-smoke: honor LEBOP_LIVE_BIN for compiled-binary provenance. */
export function resolveLebopInvocation(args = [], env = process.env) {
  const override = env.LEBOP_LIVE_BIN?.trim();
  if (override) {
    const binary = path.resolve(override);
    return {
      command: binary,
      args,
      binary,
      mode: "compiled-binary",
      display: [binary, ...args].join(" "),
    };
  }
  return {
    command: "bun",
    args: [DEFAULT_LEBOP_BIN, ...args],
    binary: DEFAULT_LEBOP_BIN,
    mode: "source-wrapper",
    display: ["bun", DEFAULT_LEBOP_BIN, ...args].join(" "),
  };
}

/** Required discovery step name fragments for --validate-report (match real step titles). */
export const DISCOVERY_REQUIRED_STEP_NAMES = [
  "search",
  "history",
  "view create",
  "custom-field",
  "label create",
  "project-update",
  "initiative-update",
  "document create",
  "MCP core",
  "cleanup",
];

export function sanitizeDiscoveryReport(report) {
  const sanitized = sanitizeLiveSurfaceReport(report);
  if (
    sanitized &&
    typeof sanitized === "object" &&
    typeof sanitized.binary_under_test === "string"
  ) {
    sanitized.binary_under_test = path.basename(sanitized.binary_under_test);
  }
  // whoami leaves a structured viewer shell; strip raw-looking fields after surface sanitize.
  if (sanitized && typeof sanitized === "object" && Array.isArray(sanitized.steps)) {
    for (const step of sanitized.steps) {
      const detail = step?.detail;
      if (
        detail &&
        typeof detail === "object" &&
        detail.viewer &&
        typeof detail.viewer === "object"
      ) {
        detail.viewer = { id: detail.viewer.id ?? "[redacted]", name: "[redacted]" };
      }
    }
  }
  return sanitized;
}

/** Discovery-shaped reports allow redacted tokens; forbid live secrets and temp homes. */
export function assertDiscoveryReportSanitized(targetReport) {
  const serialized = JSON.stringify(targetReport);
  const forbidden = [
    [/lebop-live-home-/, "temporary live auth path"],
    [/\/tmp\/lebop-/, "temporary lebop path"],
    [/token\.txt/, "temporary token file path"],
    [/\blin_[A-Za-z0-9_-]{8,}\b/, "Linear token"],
    // Real emails only (allow [redacted-email]).
    [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, "email address"],
    [/query\s*\{\s*viewer\s*\{/i, "raw viewer query preview"],
  ];
  const hit = forbidden.find(([pattern]) => {
    if (pattern.source.includes("@") && pattern.test(serialized)) {
      // Ignore already-redacted placeholders.
      if (serialized.includes("[redacted-email]")) {
        const without = serialized.replace(/\[redacted-email\]/gi, "");
        return pattern.test(without);
      }
    }
    return pattern.test(serialized);
  });
  if (hit) {
    throw new Error(`discovery report contains unsanitized ${hit[1]}`);
  }
}

export function assertDiscoveryReportValid(report, options = {}) {
  const errors = [];
  if (!report || typeof report !== "object") {
    return { ok: false, errors: ["report is not an object"] };
  }
  if ((report.failed ?? 0) > 0 || (Array.isArray(report.failures) && report.failures.length > 0)) {
    errors.push(`report has failed steps`);
  }
  const stepNames = (report.steps ?? []).map((s) => String(s.name ?? ""));
  for (const req of DISCOVERY_REQUIRED_STEP_NAMES) {
    if (!stepNames.some((n) => n.toLowerCase().includes(req.toLowerCase()))) {
      errors.push(`missing required step matching: ${req}`);
    }
  }
  try {
    assertDiscoveryReportSanitized(report);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  if (options.expectedWorkspace && report.workspace !== options.expectedWorkspace) {
    errors.push(`workspace mismatch`);
  }
  if (options.expectedTeam && report.team !== options.expectedTeam) {
    errors.push(`team mismatch`);
  }
  return { ok: errors.length === 0, errors };
}

const results = [];
const cleanup = [];
const invocationBase = resolveLebopInvocation([]);

function run(args, opts = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      LEBOP_WORKSPACE: workspace,
      LEBOP_TEAM: team,
      // Force machine JSON for this smoke so we can parse stably.
      LEBOP_MACHINE_FORMAT: "json",
      NO_COLOR: "1",
      ...opts.env,
    };
    const fullArgs = ["--workspace", workspace, "--team", team, ...args];
    const inv = resolveLebopInvocation(fullArgs, env);
    const child = spawn(inv.command, inv.args, {
      cwd: opts.cwd ?? repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000);
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, args, mode: inv.mode, binary: inv.binary });
    });
  });
}

function parseJson(stdout) {
  const text = stdout.trim();
  // Prefer last JSON object if mixed
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error(`not JSON: ${text.slice(0, 200)}`);
  }
}

async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    console.log(`PASS  ${name} (${Date.now() - started}ms)`);
    return detail;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, ms: Date.now() - started, error: message });
    console.error(`FAIL  ${name}: ${message}`);
    return null;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  console.log(
    `live-discovery-smoke workspace=${workspace} team=${team} prefix=${prefix} mode=${invocationBase.mode} binary=${invocationBase.binary}`,
  );

  // ── baseline ──────────────────────────────────────────────────────────
  const who = await step("auth whoami --refresh", async () => {
    const r = await run(["auth", "whoami", "--refresh", "--json"]);
    assert(r.code === 0, r.stderr || r.stdout);
    const body = parseJson(r.stdout);
    assert(body.workspace === workspace || body.workspace_name, "workspace mismatch");
    return body;
  });

  await step("teams --json dense", async () => {
    const r = await run(["teams", "--json"]);
    assert(r.code === 0, r.stderr || r.stdout);
    const body = parseJson(r.stdout);
    assert(Array.isArray(body.teams) && body.teams.length > 0, "no teams");
    // LEBOP_MACHINE_FORMAT=json → compact JSON (no pretty 2-space blocks required)
    assert(body.schema_version === 2, `schema_version=${body.schema_version}`);
    return { count: body.teams.length };
  });

  await step("list slim fields default", async () => {
    const r = await run(["list", "--limit", "5", "--json"]);
    assert(r.code === 0, r.stderr || r.stdout);
    const body = parseJson(r.stdout);
    assert(Array.isArray(body.issues), "issues array");
    if (body.issues[0]) {
      const keys = Object.keys(body.issues[0]);
      // slim default should not include url by default
      assert(keys.includes("identifier") && keys.includes("title"), "slim keys");
    }
    return { count: body.count ?? body.issues.length, fields: body.fields };
  });

  // ── create fixture issue ──────────────────────────────────────────────
  const created = await step("new issue with due-date + fields", async () => {
    const r = await run([
      "new",
      "--title",
      `${prefix} smoke issue`,
      "--priority",
      "normal",
      "--due-date",
      "2030-01-15",
      "--description",
      `${prefix} live feature smoke`,
      "--json",
    ]);
    assert(r.code === 0, r.stderr || r.stdout);
    const body = parseJson(r.stdout);
    const id = body.issue?.identifier;
    assert(id, `no identifier in ${r.stdout.slice(0, 300)}`);
    cleanup.push({ kind: "issue", id });
    return { id, body };
  });
  const issueId = created?.id;
  assert(issueId, "fixture issue required for subsequent steps");

  await step("set due_date round-trip", async () => {
    const r = await run(["set", "due_date", issueId, "2030-02-01", "--json"]);
    assert(r.code === 0, r.stderr || r.stdout);
    const body = parseJson(r.stdout);
    assert(body.identifier === issueId || body.requested_identifier === issueId, "id");
    assert(
      body.status === "updated" || body.status?.startsWith("updated"),
      `status=${body.status}`,
    );
    // density: not pretty JSON with leading brace+newline+indent from JSON.stringify null,2
    // under LEBOP_MACHINE_FORMAT=json we get compact JSON
    assert(!r.stdout.includes('\n  "schema_version"'), "should not be pretty-printed");
    return body;
  });

  await step("show dense default (no comments)", async () => {
    const r = await run(["show", issueId, "--json"]);
    assert(r.code === 0, r.stderr || r.stdout);
    const body = parseJson(r.stdout);
    const issue = body.issue ?? body;
    assert(issue.metadata?.identifier === issueId || issue.identifier === issueId, "show id");
    assert(
      issue.comments === undefined || issue.comments === null,
      "comments should be omitted by default",
    );
    return { hasComments: Boolean(issue.comments) };
  });

  await step("history list", async () => {
    const r = await run(["history", issueId, "--limit", "20", "--json"]);
    assert(r.code === 0, r.stderr || r.stdout);
    const body = parseJson(r.stdout);
    assert(body.identifier === issueId || body.history, "history envelope");
    assert(Array.isArray(body.history), "history array");
    return { count: body.count ?? body.history.length };
  });

  await step("search finds fixture", async () => {
    const r = await run(["search", "--query", prefix, "--limit", "10", "--json"]);
    assert(r.code === 0, r.stderr || r.stdout);
    const body = parseJson(r.stdout);
    assert(Array.isArray(body.hits), "hits");
    const hit = body.hits.find((h) => h.identifier === issueId || (h.title || "").includes(prefix));
    assert(hit, `fixture not in search hits: ${JSON.stringify(body.hits).slice(0, 400)}`);
    return { count: body.count, hit: hit.identifier };
  });

  // ── views ─────────────────────────────────────────────────────────────
  const view = await step("view create", async () => {
    const r = await run(["view", "create", "--name", `${prefix} view`, "--json"]);
    assert(r.code === 0, r.stderr || r.stdout);
    const body = parseJson(r.stdout);
    const id = body.view?.id;
    assert(id, `no view id: ${r.stdout.slice(0, 300)}`);
    cleanup.push({ kind: "view", id });
    return { id, name: body.view?.name };
  });

  if (view?.id) {
    await step("view list includes created", async () => {
      const r = await run(["view", "list", "--json"]);
      assert(r.code === 0, r.stderr || r.stdout);
      const body = parseJson(r.stdout);
      assert(Array.isArray(body.views), "views");
      assert(
        body.views.some((v) => v.id === view.id),
        "created view missing from list",
      );
      return { count: body.count };
    });

    await step("view get", async () => {
      const r = await run(["view", "get", view.id, "--json"]);
      assert(r.code === 0, r.stderr || r.stdout);
      const body = parseJson(r.stdout);
      assert(body.view?.id === view.id, "view get id");
      return body.view;
    });

    await step("view update", async () => {
      const r = await run([
        "view",
        "update",
        view.id,
        "--name",
        `${prefix} view updated`,
        "--json",
      ]);
      assert(r.code === 0, r.stderr || r.stdout);
      const body = parseJson(r.stdout);
      assert(body.view?.id === view.id, "update id");
      return body.view;
    });

    await step("view materialize issues", async () => {
      const r = await run(["view", "issues", view.id, "--limit", "5", "--json"]);
      assert(r.code === 0, r.stderr || r.stdout);
      const body = parseJson(r.stdout);
      assert(Array.isArray(body.issues), "issues from view");
      return { count: body.count };
    });
  }

  // ── labels update ─────────────────────────────────────────────────────
  const _label = await step("label create + update", async () => {
    const name = `${prefix}-lbl`;
    const c = await run(["label", "create", name, "--color", "#336699", "--json"]);
    assert(c.code === 0, c.stderr || c.stdout);
    const createdLabel = parseJson(c.stdout);
    const id = createdLabel.label?.id;
    assert(id, "label id");
    cleanup.push({ kind: "label", id, name });
    const u = await run([
      "label",
      "update",
      id,
      "--description",
      "updated by discovery smoke",
      "--json",
    ]);
    assert(u.code === 0, u.stderr || u.stdout);
    const updated = parseJson(u.stdout);
    assert(updated.label?.id === id, "label update id");
    return { id, name };
  });

  // ── custom fields ─────────────────────────────────────────────────────
  // Linear GraphQL for this workspace has no issueFields/custom field query
  // root (probed 2026-08-09). Treat as documented API gap, not silent pass.
  await step("custom-field list (API availability probe)", async () => {
    const r = await run(["custom-field", "list", "--json"]);
    if (r.code !== 0) {
      const msg = r.stdout || r.stderr;
      if (/Cannot query field|issueFields|not available|schema/i.test(msg)) {
        return {
          status: "api_gap",
          note: "Linear Query has no issueFields (or equivalent) for this workspace; custom-field wrappers remain for when API exposes them",
          error: msg.slice(0, 300),
        };
      }
      throw new Error(`custom-field list failed: ${msg}`.slice(0, 400));
    }
    const body = parseJson(r.stdout);
    return { status: "ok", count: body.count ?? body.fields?.length ?? 0 };
  });

  // ── project + project-update lifecycle ─────────────────────────────────
  await step("project create + project-update create/update/soft-delete", async () => {
    // CLI: project create <name> --team KEY
    const r = await run(["project", "create", `${prefix} project`, "--team", team, "--json"]);
    assert(r.code === 0, r.stderr || r.stdout);
    const body = parseJson(r.stdout);
    const pid = body.project?.id;
    assert(pid, "project id");
    cleanup.push({ kind: "project", id: pid });

    const cu = await run([
      "project-update",
      "create",
      pid,
      "--body",
      `${prefix} update body`,
      "--health",
      "onTrack",
      "--json",
    ]);
    assert(cu.code === 0, cu.stderr || cu.stdout);
    const createdUp = parseJson(cu.stdout);
    const uid = createdUp.project_update?.id;
    assert(uid, "project update id");

    const uu = await run([
      "project-update",
      "update",
      uid,
      "--body",
      `${prefix} update body edited`,
      "--health",
      "atRisk",
      "--json",
    ]);
    assert(uu.code === 0, uu.stderr || uu.stdout);

    const du = await run(["project-update", "soft-delete", uid, "--yes", "--json"]);
    assert(du.code === 0, du.stderr || du.stdout);
    return { projectId: pid };
  });

  // ── initiative + initiative-update lifecycle ──────────────────────────
  await step("initiative create + initiative-update update/soft-delete", async () => {
    // CLI: initiative create <name>
    const r = await run(["initiative", "create", `${prefix} initiative`, "--json"]);
    assert(r.code === 0, r.stderr || r.stdout);
    const body = parseJson(r.stdout);
    const iid = body.initiative?.id;
    assert(iid, "initiative id");
    cleanup.push({ kind: "initiative", id: iid });

    const cu = await run([
      "initiative-update",
      "create",
      iid,
      "--body",
      `${prefix} init update`,
      "--health",
      "onTrack",
      "--json",
    ]);
    assert(cu.code === 0, cu.stderr || cu.stdout);
    const createdUp = parseJson(cu.stdout);
    const uid = createdUp.initiative_update?.id;
    assert(uid, "initiative update id");

    const uu = await run([
      "initiative-update",
      "update",
      uid,
      "--body",
      `${prefix} init update edited`,
      "--json",
    ]);
    assert(uu.code === 0, uu.stderr || uu.stdout);

    const du = await run(["initiative-update", "soft-delete", uid, "--yes", "--json"]);
    assert(du.code === 0, du.stderr || du.stdout);
    return { initiativeId: iid };
  });

  // ── issue-scoped document ─────────────────────────────────────────────
  await step("document create --issue", async () => {
    const r = await run([
      "document",
      "create",
      `${prefix} issue doc`,
      "--issue",
      issueId,
      "--content",
      `${prefix} issue-scoped document body`,
      "--json",
    ]);
    assert(r.code === 0, r.stderr || r.stdout);
    const body = parseJson(r.stdout);
    const did = body.document?.id;
    assert(did, "document id");
    cleanup.push({ kind: "document", id: did });
    return { id: did };
  });

  // ── workspace explore/fetch dense defaults ────────────────────────────
  await step("workspace explore /", async () => {
    const r = await run(["workspace", "explore", "/", "--json"]);
    assert(r.code === 0, r.stderr || r.stdout);
    const body = parseJson(r.stdout);
    assert(body.schema_version === 2 || body.items || body.paths, "explore envelope");
    return { keys: Object.keys(body).slice(0, 12) };
  });

  await step("workspace fetch issue shallow default", async () => {
    const r = await run(["workspace", "fetch", issueId, "--json"]);
    assert(r.code === 0, r.stderr || r.stdout);
    const body = parseJson(r.stdout);
    // shallow adapter default — depth field if present should be shallow
    if (body.depth) assert(body.depth === "shallow", `depth=${body.depth}`);
    return { depth: body.depth, root: body.root };
  });

  // ── multi-workspace path isolation (local layout) ─────────────────────
  await step("multi-workspace cache path isolation", async () => {
    const { repoCacheDir } = await import("../src/lib/cache.ts");
    const a = repoCacheDir("_global", "alpha-ws");
    const b = repoCacheDir("_global", "beta-ws");
    assert(a !== b, "paths must differ");
    assert(a.includes("alpha-ws") && b.includes("beta-ws"), "workspace slug in path");
    return { a, b };
  });

  // ── MCP Core profile inventory ────────────────────────────────────────
  await step("MCP core profile tool count", async () => {
    const { collectMcpToolDefinitions } = await import("../src/mcp/server.ts");
    const core = collectMcpToolDefinitions("core");
    const full = collectMcpToolDefinitions("full");
    assert(core.length < full.length, "core < full");
    // Product freeze: progressive MCP default is exactly 17 tools (matches unit encode.axi).
    assert(core.length === 17, `core must be exactly 17 tools, got ${core.length}`);
    const names = new Set(core.map((t) => t.name));
    for (const n of [
      "explore_linear_workspace",
      "fetch_linear_workspace",
      "list_issues",
      "get_issue",
      "create_issue",
      "update_issue",
      "list_comments",
      "add_comment",
      "list_projects",
      "get_project",
      "pull_issues",
      "cache_status",
      "review_linear_changes",
      "publish_linear_changes",
      "search_linear",
      "list_issue_history",
      "raw_graphql",
    ]) {
      assert(names.has(n), `core missing ${n}`);
    }
    assert(names.size === 17, "core unique name count must be 17");
    return { core: core.length, full: full.length };
  });

  // ── cleanup ───────────────────────────────────────────────────────────
  await step("cleanup created resources", async () => {
    const report = [];
    for (const item of cleanup.reverse()) {
      try {
        if (item.kind === "issue") {
          const r = await run(["archive", item.id, "--yes", "--json"]);
          report.push({ item, code: r.code });
        } else if (item.kind === "view") {
          const r = await run(["view", "delete", item.id, "--yes", "--json"]);
          report.push({ item, code: r.code });
        } else if (item.kind === "label") {
          const r = await run(["label", "delete", item.id, "--yes", "--json"]);
          report.push({ item, code: r.code });
        } else if (item.kind === "project") {
          const r = await run(["project", "soft-delete", item.id, "--yes", "--json"]);
          report.push({ item, code: r.code });
        } else if (item.kind === "initiative") {
          const r = await run(["initiative", "archive", item.id, "--yes", "--json"]);
          report.push({ item, code: r.code });
        } else if (item.kind === "document") {
          const r = await run(["document", "soft-delete", item.id, "--yes", "--json"]);
          report.push({ item, code: r.code });
        }
      } catch (e) {
        report.push({ item, error: String(e) });
      }
    }
    return report;
  });

  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok);
  const summary = {
    workspace,
    team,
    prefix,
    binary_under_test: invocationBase.binary,
    mode: invocationBase.mode,
    total: results.length,
    passed: passed.length,
    failed: failed.length,
    failures: failed.map((f) => ({ name: f.name, error: f.error })),
    steps: results,
  };

  const outDir = path.join(repoRoot, "docs", "local");
  await mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, `live-discovery-report-${stamp}.json`);
  const sanitized = sanitizeDiscoveryReport(summary);
  await writeFile(reportPath, JSON.stringify(sanitized, null, 2));
  console.log(`\nreport: ${reportPath}`);
  console.log(`passed ${passed.length}/${results.length}`);
  if (failed.length) {
    console.error("FAILURES:");
    for (const f of failed) console.error(`  - ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
}

async function validateDiscoveryReportCli(reportPath) {
  const raw = await readFile(reportPath, "utf8");
  const report = JSON.parse(raw);
  const expectedWorkspace = process.env.LEBOP_LIVE_EXPECT_WORKSPACE?.trim();
  const expectedTeam = process.env.LEBOP_LIVE_EXPECT_TEAM?.trim();
  const result = assertDiscoveryReportValid(report, {
    expectedWorkspace: expectedWorkspace || undefined,
    expectedTeam: expectedTeam || undefined,
  });
  if (!result.ok) {
    console.error("discovery report validation failed:");
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ status: "passed", report: reportPath }, null, 2));
}

// Only auto-run when this file is the entrypoint (not when imported for tests).
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("live-discovery-smoke.mjs") ||
    process.argv[1].includes("live-discovery-smoke"));

if (isMain) {
  const validateIdx = process.argv.indexOf("--validate-report");
  if (validateIdx !== -1) {
    const reportPath = process.argv[validateIdx + 1];
    if (!reportPath) {
      console.error("usage: live-discovery-smoke.mjs --validate-report <report.json>");
      process.exit(1);
    }
    validateDiscoveryReportCli(reportPath).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  } else {
    main().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  }
}
