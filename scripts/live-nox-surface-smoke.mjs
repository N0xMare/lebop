#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateExplorePayloadContract,
  validateFetchPayloadContract,
  validatePublishPayloadContract,
} from "../src/lib/toolBehaviorContracts.ts";
import {
  CONDITIONAL_MCP_CONFIRM_TOOLS,
  MCP_SURFACE_MANIFEST,
  REQUIRED_CLI_LIVE_STEPS,
  REQUIRED_MCP_CONFIRM_TOOLS,
} from "../src/lib/toolSurfaceManifest.ts";
import { LEBOP_VERSION } from "../src/lib/version.ts";

export { REQUIRED_CLI_LIVE_STEPS };

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
export const DEFAULT_LEBOP_BIN = path.join(repoRoot, "bin", "lebop");
const workspace = process.env.LEBOP_LIVE_WORKSPACE ?? "noxor";
const team = process.env.LEBOP_LIVE_TEAM ?? "NOX";
export function defaultLiveStamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
}

export function normalizeLiveStamp(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error("LEBOP_LIVE_STAMP must not be empty");
  }
  if (
    normalized !== path.basename(normalized) ||
    normalized.includes("/") ||
    normalized.includes("\\")
  ) {
    throw new Error("LEBOP_LIVE_STAMP must be a filename basename, not a path");
  }
  if (normalized === "." || normalized === "..") {
    throw new Error("LEBOP_LIVE_STAMP must not be '.' or '..'");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(normalized)) {
    throw new Error(
      "LEBOP_LIVE_STAMP must be 1-80 safe filename characters: letters, numbers, '.', '_', '-'",
    );
  }
  return normalized;
}

const stamp = normalizeLiveStamp(process.env.LEBOP_LIVE_STAMP ?? defaultLiveStamp());
const prefix = `lebop-surface-${stamp}`;
const timeoutMs = Number(process.env.LEBOP_LIVE_TIMEOUT_MS ?? 90_000);
const timeoutKillGraceMs = Number(process.env.LEBOP_LIVE_TIMEOUT_KILL_GRACE_MS ?? 5_000);

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

export const GAP_ALLOWLIST = {
  "cli:cycle view --json": {
    reason: "NOX currently has no cycles, so cycle view has no valid UUID fixture.",
    expires: "2026-07-31",
  },
  "cli:workspace explore cycle issues --json": {
    reason: "NOX currently has no cycles, so cycle issue exploration has no valid fixture.",
    expires: "2026-07-31",
  },
  "cli:workspace fetch cycle --json": {
    reason: "NOX currently has no cycles, so cycle workspace fetch has no valid fixture.",
    expires: "2026-07-31",
  },
  "cli:agent-session view --json": {
    reason: "NOX currently has no agent sessions, so agent-session view has no valid fixture.",
    expires: "2026-07-31",
  },
  "cli:workspace fetch agent-session --json": {
    reason:
      "NOX currently has no agent sessions, so concrete agent-session fetch has no valid fixture.",
    expires: "2026-07-31",
  },
  "mcp:get_cycle": {
    reason: "NOX currently has no cycles, so get_cycle has no valid UUID fixture.",
    expires: "2026-07-31",
  },
  "mcp:explore_linear_workspace cycle issues": {
    reason: "NOX currently has no cycles, so cycle issue exploration has no valid fixture.",
    expires: "2026-07-31",
  },
  "mcp:fetch_linear_workspace cycle": {
    reason: "NOX currently has no cycles, so cycle workspace fetch has no valid fixture.",
    expires: "2026-07-31",
  },
  "mcp:get_agent_session": {
    reason: "NOX currently has no agent sessions, so get_agent_session has no valid fixture.",
    expires: "2026-07-31",
  },
  "mcp:fetch_linear_workspace agent-session": {
    reason:
      "NOX currently has no agent sessions, so concrete agent-session fetch has no valid fixture.",
    expires: "2026-07-31",
  },
};

const BASE_REQUIRED_SEMANTIC_LIVE_STEPS = [
  "cli:project create --json",
  "cli:project update --json",
  "cli:milestone create --json",
  "cli:milestone update --json",
  "cli:new --description-file --json",
  "cli:set description --json",
  "cli:set project --json",
  "cli:set milestone --json",
  "cli:set cycle --json",
  "cli:bulk update --json",
  "cli:workspace explore projects cursor page 1 --json",
  "cli:workspace explore projects cursor page 2 --json",
  "cli:workspace explore project search --json",
  "cli:workspace explore initiative search --json",
  "cli:workspace explore cycle issues --json",
  "cli:workspace explore milestone issues --json",
  "cli:workspace fetch document --json",
  "cli:workspace fetch milestone --json",
  "cli:workspace fetch cycle --json",
  "cli:workspace fetch agent-session --json",
  "cli:workspace explore issue documents --json",
  "cli:workspace fetch issue documents --json",
  "cli:workspace fetch issue agent-sessions --json",
  "cli:push issue --json",
  "cli:publish review cache issue --json",
  "cli:publish apply cache issue --json",
  "cli:publish review cache project --json",
  "cli:publish apply cache project --json",
  "cli:publish review --plan --json",
  "cli:publish apply --json",
  "cli:archive issue final --json",
  "cli:archive primary evidence issue --json",
  "cli:document delete --json",
  "cli:milestone delete --json",
  "cli:initiative delete --json",
  "cli:label delete --json",
  "cli:project delete --json",
  "mcp:create_issue",
  "mcp:update_issue",
  "mcp:bulk_update_issues",
  "mcp:explore_linear_workspace",
  "mcp:explore_linear_workspace projects cursor page 1",
  "mcp:explore_linear_workspace projects cursor page 2",
  "mcp:explore_linear_workspace project search",
  "mcp:explore_linear_workspace initiative search",
  "mcp:explore_linear_workspace cycle issues",
  "mcp:explore_linear_workspace issue documents",
  "mcp:fetch_linear_workspace",
  "mcp:fetch_linear_workspace cycle",
  "mcp:fetch_linear_workspace agent-session",
  "mcp:fetch_linear_workspace document",
  "mcp:fetch_linear_workspace issue documents",
  "mcp:fetch_linear_workspace issue agent-sessions",
  "mcp:lint_files fix",
  "mcp:lint_text fix",
  "mcp:pull_project export",
  "mcp:pull_issues export",
  "mcp:push_changes",
  "mcp:review_linear_changes",
  "mcp:publish_linear_changes cache issue",
  "mcp:publish_linear_changes cache project",
  "mcp:publish_linear_changes plan",
];

export const REQUIRED_DESTRUCTIVE_MCP_LIVE_STEPS = REQUIRED_MCP_CONFIRM_TOOLS.map(
  (tool) => `mcp:${tool}`,
);

export const REQUIRED_CONDITIONAL_MCP_LIVE_STEPS = [
  "mcp:bulk_update_issues",
  "mcp:pull_project refresh",
  "mcp:pull_issues refresh",
  "mcp:push_changes force",
  "mcp:plan_apply force",
  "mcp:plan_pull force",
  "mcp:cache_gc delete temp cache",
  "mcp:add_relation replacement confirm",
  "mcp:update_relations remove confirm",
  "mcp:raw_graphql mutation confirm",
];

export const REQUIRED_SEMANTIC_LIVE_STEPS = [
  ...new Set([
    ...BASE_REQUIRED_SEMANTIC_LIVE_STEPS,
    ...REQUIRED_DESTRUCTIVE_MCP_LIVE_STEPS,
    ...REQUIRED_CONDITIONAL_MCP_LIVE_STEPS,
  ]),
];

function isLinearApiProofStep(name) {
  return (
    name.startsWith("cli:workspace explore ") ||
    name.startsWith("cli:workspace fetch ") ||
    name.startsWith("mcp:explore_linear_workspace ") ||
    name === "mcp:fetch_linear_workspace" ||
    name.startsWith("mcp:fetch_linear_workspace ")
  );
}

export const REQUIRED_LINEAR_API_PROOF_STEPS =
  REQUIRED_SEMANTIC_LIVE_STEPS.filter(isLinearApiProofStep);

export const PUBLISH_VERIFIED_PROOF_LABELS = [
  "status=verified",
  "summary.ready=true",
  "verification present",
  "no blockers",
  "no drift",
];

export const LINEAR_API_PROOF_LABELS = [
  "linear_api.request_count present",
  "linear_api.requests.remaining present",
  "linear_api.complexity.remaining present",
];

export const FIELD_UPDATE_PROOF_LABELS = {
  "cli:set description --json": ["remote description contains CLI set description marker"],
  "cli:set project --json": ["remote project matches CLI set project"],
  "cli:set milestone --json": ["remote milestone matches CLI set milestone"],
  "cli:set cycle --json": ["remote cycle cleared by CLI set cycle"],
  "mcp:update_issue": [
    "remote description contains MCP update_issue marker",
    "remote project matches MCP update_issue",
    "remote milestone matches MCP update_issue",
    "remote cycle cleared by MCP update_issue",
  ],
};

export const REQUIRED_PUBLISH_PROOF_STEPS = [
  "cli:publish apply cache issue --json",
  "cli:publish apply cache project --json",
  "cli:publish apply --json",
  "mcp:publish_linear_changes cache issue",
  "mcp:publish_linear_changes cache project",
  "mcp:publish_linear_changes plan",
];

export const MANIFEST_SEMANTIC_LIVE_STEPS = {
  bulk_update_issues: ["mcp:bulk_update_issues"],
  create_issue: ["mcp:create_issue"],
  explore_linear_workspace: ["mcp:explore_linear_workspace"],
  fetch_linear_workspace: ["mcp:fetch_linear_workspace"],
  publish_linear_changes: [
    "mcp:publish_linear_changes cache issue",
    "mcp:publish_linear_changes cache project",
    "mcp:publish_linear_changes plan",
  ],
  pull_issues: ["mcp:pull_issues export"],
  pull_project: ["mcp:pull_project export"],
  review_linear_changes: ["mcp:review_linear_changes"],
  update_issue: ["mcp:update_issue"],
  update_relations: ["mcp:update_relations remove confirm"],
};

export const REQUIRED_MANIFEST_SEMANTIC_TOOLS = MCP_SURFACE_MANIFEST.filter(
  (entry) => entry.live_semantics === "required",
).map((entry) => entry.tool);

export const REQUIRED_MCP_LIVE_TOOLS = MCP_SURFACE_MANIFEST.map((entry) => entry.tool).sort();
const initialLebopInvocation = resolveLebopInvocation();

const report = {
  started_at: new Date().toISOString(),
  workspace,
  team,
  stamp,
  prefix,
  binary_under_test: {
    path: initialLebopInvocation.binary,
    mode: initialLebopInvocation.mode,
    platform: process.platform,
    arch: process.arch,
  },
  temp_home: null,
  evidence_issue: null,
  created: {},
  cleanup: [],
  results: [],
  gaps: [],
  coverage: {},
};

let lebopHome = "";
let mcp = null;
let tempAuthReady = false;
const cleanupActions = [];
const remoteAuditTargets = new Map();
const MCP_NO_WORKSPACE_ARG = new Set([
  "list_workspaces",
  "set_default_workspace",
  "set_workspace_default_team",
  "lint_text",
  "cache_gc",
]);

function record(name, status, detail = {}) {
  const gapAllowlist = status === "gap" ? GAP_ALLOWLIST[name] : undefined;
  report.results.push({
    name,
    status,
    ...(gapAllowlist ? { allowlist: gapAllowlist } : {}),
    ...detail,
    at: new Date().toISOString(),
  });
  const marker = status === "pass" ? "PASS" : status === "gap" ? "GAP" : "FAIL";
  console.log(`${marker} ${name}`);
  if (status === "gap") report.gaps.push({ name, allowlist: gapAllowlist ?? null, ...detail });
}

function stableRedaction(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

const LIVE_NOX_TEMP_PATH_PATTERN =
  /(?:[A-Za-z]:)?(?:[^\s"']*[\\/])?lebop-live-nox-[^\\/\s"']+(?:[\\/][^\s"']*)?/g;
const LIVE_NOX_TEMP_SEGMENT_PATTERN = /lebop-live-nox-[^\\/\s"']+/;
const LINEAR_UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LINEAR_UUID_SCAN_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const LINEAR_ISSUE_IDENTIFIER_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const LINEAR_ISSUE_IDENTIFIER_SCAN_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/;

function redactSensitiveString(value) {
  return value
    .replace(/query\s*\{\s*viewer\s*\{[^}]*\}\s*\}/gi, "query { viewer [redacted] }")
    .replace(/"viewer"\s*:\s*\{[^}]*"email"[^}]*\}/gi, '"viewer":"[redacted]"')
    .replace(LIVE_NOX_TEMP_PATH_PATTERN, "[redacted-temp-home]")
    .replace(/\/tmp\/lebop-[^\s"']+/g, "[redacted-temp-path]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\blin_[A-Za-z0-9_-]{8,}\b/g, "[redacted-token]")
    .replace(
      /\bLinearPersonalApiKey\s+[A-Za-z0-9._-]+\b/gi,
      "LinearPersonalApiKey [redacted-token]",
    )
    .replace(LINEAR_UUID_PATTERN, (id) => `redacted-uuid-${stableRedaction(id)}`)
    .replace(
      LINEAR_ISSUE_IDENTIFIER_PATTERN,
      (identifier) => `redacted-issue-${stableRedaction(identifier)}`,
    );
}

function redactCreatedIdentifierString(value) {
  return redactSensitiveString(value);
}

function sanitizeCreatedReportValue(value) {
  if (typeof value === "string") return redactCreatedIdentifierString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeCreatedReportValue(item));
  if (value && typeof value === "object") {
    const next = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      next[entryKey] = sanitizeCreatedReportValue(entryValue);
    }
    return next;
  }
  return value;
}

function sanitizeReportValue(value, key = "") {
  if (typeof value === "string") {
    if (
      key === "command" ||
      key === "stdout_preview" ||
      key === "stderr_preview" ||
      key === "response_preview" ||
      key === "stdout_line"
    ) {
      return undefined;
    }
    if (key === "temp_home" || key === "viewer_email") return undefined;
    if (key === "id" || key === "key") return `redacted-${stableRedaction(value)}`;
    if (key === "label") return "[redacted]";
    return redactSensitiveString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeReportValue(item)).filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const next = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      const sanitized = sanitizeReportValue(entryValue, entryKey);
      if (sanitized !== undefined) next[entryKey] = sanitized;
    }
    return next;
  }
  return value;
}

export function sanitizeLiveSurfaceReport(targetReport) {
  const sanitized = sanitizeReportValue(targetReport);
  if (
    sanitized &&
    typeof sanitized === "object" &&
    sanitized.binary_under_test &&
    typeof sanitized.binary_under_test === "object" &&
    typeof sanitized.binary_under_test.path === "string"
  ) {
    sanitized.binary_under_test.path = path.basename(sanitized.binary_under_test.path);
  }
  if (sanitized && typeof sanitized === "object" && sanitized.created) {
    sanitized.created = sanitizeCreatedReportValue(sanitized.created);
  }
  return sanitized;
}

export function assertLiveSurfaceReportSanitized(targetReport) {
  const serialized = JSON.stringify(targetReport);
  const forbidden = [
    [/stdout_preview|stderr_preview|response_preview|stdout_line/, "CLI/MCP preview fields"],
    [LIVE_NOX_TEMP_SEGMENT_PATTERN, "temporary live auth path"],
    [/token\.txt/, "temporary token file path"],
    [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, "email address"],
    [/\blin_[A-Za-z0-9_-]{8,}\b/, "Linear token"],
    [/"viewer"\s*:\s*\{[^}]*"email"/, "raw viewer payload"],
    [/query\s*\{\s*viewer\s*\{/i, "raw viewer query preview"],
    [LINEAR_UUID_SCAN_PATTERN, "Linear UUID"],
    [LINEAR_ISSUE_IDENTIFIER_SCAN_PATTERN, "Linear issue identifier"],
  ];
  const hit = forbidden.find(([pattern]) => pattern.test(serialized));
  if (hit) {
    throw new Error(`live surface report contains unsanitized ${hit[1]}`);
  }
}

function registerCleanup(name, fn) {
  const action = { name, fn, done: false };
  cleanupActions.push(action);
  return () => {
    action.done = true;
  };
}

function registerRemoteAudit(kind, id, label) {
  if (!id) return;
  const key = remoteAuditTargetKey(kind, id);
  remoteAuditTargets.set(key, { key, kind, id, label: label ?? `${kind} ${id}` });
}

function remoteAuditTargetKey(kind, id) {
  return `${kind}:${id}`;
}

function remoteAuditTargetReport(target) {
  return {
    key: target.key ?? remoteAuditTargetKey(target.kind, target.id),
    kind: target.kind,
    id: target.id,
    label: target.label,
  };
}

async function cliCleanup(name, args) {
  if (!lebopHome) throw new Error("LEBOP_HOME is not initialized");
  const fullArgs = ["--workspace", workspace, "--team", team, ...args];
  const invocation = resolveLebopInvocation(fullArgs);
  const result = await runProc(invocation.command, invocation.args, {
    env: { LEBOP_HOME: lebopHome },
    timeoutMs,
  });
  if (result.code !== 0) {
    throw new Error(
      `${name} cleanup failed (${result.code})\n$ ${invocation.display}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }
}

async function cliCleanupRetried(name, args, options = {}) {
  const { attempts = 3, retryDelayMs = 1_500 } = options;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await cliCleanup(name, args);
    } catch (err) {
      lastError = err;
      if (attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
  throw lastError;
}

function registerCliCleanup(name, args) {
  return registerCleanup(name, () => cliCleanup(name, args));
}

async function runCleanupActions() {
  for (let i = cleanupActions.length - 1; i >= 0; i--) {
    const action = cleanupActions[i];
    if (action.done) continue;
    try {
      await action.fn();
      action.done = true;
      report.cleanup.push({ name: action.name, status: "pass", at: new Date().toISOString() });
      console.log(`CLEANUP PASS ${action.name}`);
    } catch (err) {
      report.cleanup.push({
        name: action.name,
        status: "fail",
        error: err.stack ?? err.message ?? String(err),
        at: new Date().toISOString(),
      });
      console.error(`CLEANUP FAIL ${action.name}`);
    }
  }
}

async function auditRaw(query, variables = {}) {
  const variableArgs = Object.entries(variables).flatMap(([k, v]) => [
    "--variable",
    `${k}=${JSON.stringify(v)}`,
  ]);
  const fullArgs = ["--workspace", workspace, "--team", team, "raw", query, ...variableArgs];
  const invocation = resolveLebopInvocation(fullArgs);
  const result = await runProc(invocation.command, invocation.args, {
    env: { LEBOP_HOME: lebopHome },
    timeoutMs,
  });
  if (result.code !== 0) {
    throw new Error(
      `remote cleanup audit query failed (${result.code})\n$ ${invocation.display}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }
  return parseJson(result.stdout);
}

export function isRemoteAuditNotFoundError(err) {
  const text =
    err && typeof err === "object" ? (err.stack ?? err.message ?? String(err)) : String(err);
  return /error\[not_found\]|Entity not found|Could not find referenced/i.test(text);
}

async function auditRawAllowNotFound(query, variables = {}) {
  try {
    return await auditRaw(query, variables);
  } catch (err) {
    if (isRemoteAuditNotFoundError(err)) return null;
    throw err;
  }
}

function archivedOrAbsentProof(target, node) {
  if (!node) return `${target.label} absent`;
  expect(node.archivedAt, `${target.label}: still live on Linear`);
  return `${target.label} archivedAt=${node.archivedAt}`;
}

async function auditRemoteTarget(target) {
  if (target.kind === "soft_deleted_project") {
    const payload = await auditRaw(
      "query AuditProject($id: String!) { project(id: $id) { id archivedAt } }",
      { id: target.id },
    );
    return archivedOrAbsentProof(target, payload?.project);
  }
  if (target.kind === "soft_deleted_document") {
    const payload = await auditRaw(
      "query AuditDocument($id: String!) { document(id: $id) { id archivedAt } }",
      { id: target.id },
    );
    return archivedOrAbsentProof(target, payload?.document);
  }
  if (target.kind === "soft_deleted_initiative") {
    const payload = await auditRaw(
      "query AuditInitiative($id: ID!) { initiatives(filter: { id: { eq: $id } }, includeArchived: true, first: 1) { nodes { id archivedAt } } }",
      { id: target.id },
    );
    return archivedOrAbsentProof(target, payload?.initiatives?.nodes?.[0]);
  }
  if (target.kind === "deleted_milestone") {
    const payload = await auditRaw(
      "query AuditMilestone($id: ID!) { projectMilestones(filter: { id: { eq: $id } }, includeArchived: true, first: 1) { nodes { id archivedAt } } }",
      { id: target.id },
    );
    return archivedOrAbsentProof(target, payload?.projectMilestones?.nodes?.[0]);
  }
  if (target.kind === "deleted_label") {
    const payload = await auditRaw(
      "query AuditLabel($id: ID!) { issueLabels(filter: { id: { eq: $id } }, first: 1) { nodes { id } } }",
      { id: target.id },
    );
    const nodes = payload?.issueLabels?.nodes ?? [];
    expect(nodes.length === 0, `${target.label}: label still visible on Linear`);
    return `${target.label} absent`;
  }
  if (target.kind === "deleted_comment") {
    const payload = await auditRawAllowNotFound(
      "query AuditComment($id: String!) { comment(id: $id) { id } }",
      { id: target.id },
    );
    expect(!payload?.comment, `${target.label}: comment still visible on Linear`);
    return `${target.label} absent`;
  }
  if (target.kind === "deleted_attachment") {
    const payload = await auditRawAllowNotFound(
      "query AuditAttachment($id: String!) { attachment(id: $id) { id } }",
      { id: target.id },
    );
    expect(!payload?.attachment, `${target.label}: attachment still visible on Linear`);
    return `${target.label} absent`;
  }
  if (target.kind === "archived_issue") {
    const payload = await auditRaw(
      "query AuditIssue($id: String!) { issue(id: $id) { id identifier archivedAt } }",
      { id: target.id },
    );
    const issue = payload?.issue;
    expect(issue, `${target.label}: issue missing instead of archived`);
    expect(issue.archivedAt, `${target.label}: issue still active on Linear`);
    return `${target.label} archivedAt=${issue.archivedAt}`;
  }
  throw new Error(`unknown remote audit target kind: ${target.kind}`);
}

async function runRemoteDestructiveAudit() {
  if (remoteAuditTargets.size === 0) return;
  const expectedTargets = [...remoteAuditTargets.values()].map(remoteAuditTargetReport);
  const auditedTargets = [];
  for (const target of remoteAuditTargets.values()) {
    const proof = await auditRemoteTarget(target);
    auditedTargets.push({ ...remoteAuditTargetReport(target), proof });
  }
  report.cleanup.push({
    name: "remote destructive audit",
    status: "pass",
    checked: auditedTargets.length,
    expected: expectedTargets.length,
    expected_targets: expectedTargets,
    audited_targets: auditedTargets,
    proofs: auditedTargets.map((target) => `${target.label}: ${target.proof}`),
    at: new Date().toISOString(),
  });
  console.log(`CLEANUP PASS remote destructive audit (${auditedTargets.length} checks)`);
}

function parseJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

export function parseMcpStdoutLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    const message = err?.message ?? String(err);
    throw new Error(`MCP server wrote non-JSON stdout: ${trimmed.slice(0, 500)} (${message})`);
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") {
    throw new Error(`MCP server wrote non-JSON-RPC stdout: ${trimmed.slice(0, 500)}`);
  }
  return msg;
}

export function buildMcpStdoutFailureResult(line, error, now = new Date()) {
  const errorText =
    error && typeof error === "object"
      ? (error.stack ?? error.message ?? String(error))
      : String(error);
  return {
    name: "mcp:stdout protocol",
    status: "fail",
    error: errorText,
    stdout_line: line.slice(0, 500),
    at: now.toISOString(),
  };
}

function runProc(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd ?? repoRoot,
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    const effectiveTimeoutMs = options.timeoutMs ?? timeoutMs;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      fn(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, options.killGraceMs ?? timeoutKillGraceMs);
    }, effectiveTimeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      settle(reject, err);
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        settle(
          reject,
          new Error(
            `${cmd} ${args.join(" ")} timed out after ${effectiveTimeoutMs}ms; closed with signal ${signal ?? "none"}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
          ),
        );
        return;
      }
      settle(resolve, { code, signal, stdout, stderr });
    });
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

async function populateBinaryUnderTest(targetReport = report) {
  const binaryPath = targetReport.binary_under_test?.path ?? resolveLebopInvocation().binary;
  const versionInvocation = resolveLebopInvocation(["--version"]);
  const binary = await readFile(binaryPath);
  const binaryStat = await stat(binaryPath);
  targetReport.binary_under_test = {
    ...(targetReport.binary_under_test ?? {}),
    path: binaryPath,
    mode: resolveLebopInvocation().mode,
    sha256: createHash("sha256").update(binary).digest("hex"),
    size_bytes: binaryStat.size,
    platform: process.platform,
    arch: process.arch,
  };

  const versionResult = await runProc(versionInvocation.command, versionInvocation.args, {
    timeoutMs: Math.min(timeoutMs, 15_000),
  });
  if (versionResult.code !== 0) {
    throw new Error(
      `could not read lebop version from binary under test (${versionResult.code})\n$ ${versionInvocation.display}\nSTDOUT:\n${versionResult.stdout}\nSTDERR:\n${versionResult.stderr}`,
    );
  }
  targetReport.binary_under_test.version = versionResult.stdout.trim();
  return targetReport.binary_under_test;
}

async function cli(name, args, options = {}) {
  const fullArgs = ["--workspace", workspace, "--team", team, ...args];
  const invocation = resolveLebopInvocation(fullArgs);
  const result = await runProc(invocation.command, invocation.args, {
    ...options,
    env: { LEBOP_HOME: lebopHome, ...(options.env ?? {}) },
  });
  const allowedExitCodes = options.allowExitCodes ?? [0];
  if (!allowedExitCodes.includes(result.code)) {
    throw new Error(
      `${name} failed (${result.code})\n$ ${invocation.display}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }
  const parsed = options.json ? parseJson(result.stdout) : null;
  const semanticAssertions = options.assert
    ? await options.assert(parsed ?? result.stdout)
    : undefined;
  record(`cli:${name}`, "pass", {
    command: `lebop ${fullArgs.join(" ")}`,
    stdout_preview: result.stdout.trim().slice(0, 500),
    ...(semanticAssertions ? { semantic_assertions: semanticAssertions } : {}),
  });
  return options.json ? parsed : result.stdout;
}

async function cliRetried(name, args, options = {}) {
  const { attempts = 3, retryDelayMs = 1_500, ...cliOptions } = options;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await cli(name, args, cliOptions);
    } catch (err) {
      lastError = err;
      if (attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
  throw lastError;
}

async function cliExpectFail(name, args, options = {}) {
  const fullArgs = ["--workspace", workspace, "--team", team, ...args];
  const invocation = resolveLebopInvocation(fullArgs);
  const result = await runProc(invocation.command, invocation.args, {
    ...options,
    env: { LEBOP_HOME: lebopHome, ...(options.env ?? {}) },
  });
  if (result.code === 0) {
    throw new Error(`${name} unexpectedly passed\nSTDOUT:\n${result.stdout}`);
  }
  record(`cli:${name}`, "pass", {
    command: `lebop ${fullArgs.join(" ")}`,
    exit_code: result.code,
    stderr_preview: result.stderr.trim().slice(0, 300),
  });
  return result;
}

async function raw(query, variables = {}) {
  const variableArgs = Object.entries(variables).flatMap(([k, v]) => [
    "--variable",
    `${k}=${JSON.stringify(v)}`,
  ]);
  return cli("raw", ["raw", query, ...variableArgs], { json: true });
}

const ISSUE_DOCUMENT_CREATE_MUTATION = /* GraphQL */ `
  mutation CreateLiveIssueDocument($input: DocumentCreateInput!) {
    documentCreate(input: $input) {
      success
      document {
        id
        title
        content
        url
        archivedAt
        issue { id identifier title }
      }
    }
  }
`;

function assertIssueDocumentCreatePayload(payload, label, expectedTitle) {
  const proofs = requireFields(
    payload,
    ["documentCreate.success", "documentCreate.document.id"],
    label,
  );
  expect(payload.documentCreate.success === true, `${label}: documentCreate success was not true`);
  expect(
    payload.documentCreate.document.title === expectedTitle,
    `${label}: expected title ${expectedTitle}, got ${payload.documentCreate.document.title}`,
  );
  proofs.push("documentCreate.success=true");
  proofs.push("document.id present");
  return proofs;
}

async function createIssueDocumentFixtureViaCli(issueId, title, content) {
  const input = { issueId, title, content, icon: "BookOpen" };
  const payload = await cli(
    "raw create CLI issue document fixture",
    [
      "raw",
      ISSUE_DOCUMENT_CREATE_MUTATION,
      "--variable",
      `input=${JSON.stringify(input)}`,
      "--allow-mutation",
      "--yes",
    ],
    {
      json: true,
      assert: (parsed) =>
        assertIssueDocumentCreatePayload(parsed, "CLI issue document fixture", title),
    },
  );
  return payload.documentCreate.document;
}

async function createIssueDocumentFixtureViaMcp(issueId, title, content) {
  const payload = await mcp.call(
    "raw_graphql",
    {
      query: ISSUE_DOCUMENT_CREATE_MUTATION,
      variables: { input: { issueId, title, content, icon: "BookOpen" } },
      allow_mutation: true,
      confirm: true,
    },
    {
      recordName: "mcp:raw_graphql issue document fixture",
      assert: (parsed) =>
        assertIssueDocumentCreatePayload(parsed.data, "MCP issue document fixture", title),
    },
  );
  return payload.data.documentCreate.document;
}

async function readRemoteIssueUpdateState(identifier) {
  const payload = await auditRaw(
    `query LiveIssueUpdateState($id: String!) {
      issue(id: $id) {
        id
        identifier
        description
        project { id name }
        projectMilestone { id name }
        cycle { id name }
      }
    }`,
    { id: identifier },
  );
  return payload?.issue ?? null;
}

async function assertRemoteIssueDescriptionContains(identifier, snippet, label, proofLabel) {
  let lastDescription = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const issue = await readRemoteIssueUpdateState(identifier);
    lastDescription = issue?.description ?? "";
    if (lastDescription.includes(snippet)) {
      return proofLabel ?? `remote description contains ${snippet}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
  }
  throw new Error(
    `${label}: remote issue ${identifier} description missing ${JSON.stringify(
      snippet,
    )}; latest description preview: ${lastDescription.slice(0, 300)}`,
  );
}

async function assertRemoteIssueUpdateState(identifier, expectations, label) {
  let lastIssue = null;
  let lastErrors = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const issue = await readRemoteIssueUpdateState(identifier);
    lastIssue = issue;
    lastErrors = [];
    if (!issue) {
      lastErrors.push("issue missing");
    }
    if (expectations.descriptionContains !== undefined) {
      const description = issue?.description ?? "";
      if (!description.includes(expectations.descriptionContains)) {
        lastErrors.push(`description missing ${JSON.stringify(expectations.descriptionContains)}`);
      }
    }
    if (expectations.projectId !== undefined) {
      const actual = issue?.project?.id ?? null;
      if (actual !== expectations.projectId) {
        lastErrors.push(`project id ${actual ?? "null"} != ${expectations.projectId}`);
      }
    }
    if (expectations.milestoneId !== undefined) {
      const actual = issue?.projectMilestone?.id ?? null;
      if (actual !== expectations.milestoneId) {
        lastErrors.push(`milestone id ${actual ?? "null"} != ${expectations.milestoneId}`);
      }
    }
    if (expectations.cycleId !== undefined) {
      const actual = issue?.cycle?.id ?? null;
      if (actual !== expectations.cycleId) {
        lastErrors.push(`cycle id ${actual ?? "null"} != ${expectations.cycleId}`);
      }
    }
    if (lastErrors.length === 0) return expectations.proofs ?? [];
    await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
  }
  throw new Error(
    `${label}: remote issue ${identifier} state mismatch: ${lastErrors.join("; ")}; latest state ${JSON.stringify(
      lastIssue,
    ).slice(0, 500)}`,
  );
}

function expect(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function assertNoBehaviorContractErrors(label, errors) {
  if (errors.length > 0) {
    throw new Error(
      `${label} violated behavior contracts: ${errors.map((e) => e.message).join("; ")}`,
    );
  }
}

function requireFields(payload, fields, label) {
  const proofs = [];
  for (const field of fields) {
    const value = field.split(".").reduce((current, key) => current?.[key], payload);
    expect(value !== undefined && value !== null && value !== "", `${label}: missing ${field}`);
    proofs.push(`${field} present`);
  }
  return proofs;
}

function assertPublishReviewPayload(payload, label) {
  const proofs = requireFields(payload, ["review_id", "ready", "summary"], label);
  expect(payload.summary.ready === payload.ready, `${label}: ready disagrees with summary.ready`);
  proofs.push(`summary.ready=${payload.summary.ready}`);
  if (payload.ready === true) {
    expect(payload.next?.tool === "publish_linear_changes", `${label}: next publish tool missing`);
    proofs.push("next publish tool present");
  }
  return proofs;
}

function assertPublishApplyPayload(payload, label) {
  assertNoBehaviorContractErrors(label, validatePublishPayloadContract(payload));
  const proofs = requireFields(payload, ["review_id", "status", "summary"], label);
  expect(
    payload.status === "verified",
    `${label}: publish did not verify cleanly; expected status=verified, got ${payload.status}`,
  );
  expect(payload.summary.ready === true, `${label}: expected summary.ready=true`);
  const blockers = Array.isArray(payload.summary.blockers) ? payload.summary.blockers : [];
  expect(blockers.length === 0, `${label}: publish returned blockers: ${blockers.join("; ")}`);
  expect(payload.verification, `${label}: verified publish missing verification payload`);
  if (typeof payload.verification.has_drift === "boolean") {
    expect(payload.verification.has_drift === false, `${label}: verification reported plan drift`);
  } else if (typeof payload.verification.clean === "boolean") {
    const dirty = Array.isArray(payload.verification.dirty) ? payload.verification.dirty : [];
    expect(payload.verification.clean === true, `${label}: verification reported dirty cache rows`);
    expect(dirty.length === 0, `${label}: verification dirty rows: ${dirty.join(", ")}`);
  } else {
    throw new Error(`${label}: verification payload does not expose drift/clean proof`);
  }
  proofs.push(...PUBLISH_VERIFIED_PROOF_LABELS);
  return proofs;
}

function assertDeletePayload(payload, label, expectedId) {
  const proofs = requireFields(payload, ["id", "status", "success"], label);
  if (expectedId !== undefined) {
    expect(payload.id === expectedId, `${label}: expected id ${expectedId}, got ${payload.id}`);
    proofs.push(`id=${expectedId}`);
  }
  expect(payload.status === "deleted", `${label}: expected status=deleted, got ${payload.status}`);
  expect(payload.success === true, `${label}: expected success=true`);
  proofs.push("status=deleted");
  proofs.push("success=true");
  return proofs;
}

function assertLifecyclePayload(payload, label, expectedIdentifiers) {
  const proofs = requireFields(payload, ["results"], label);
  expect(Array.isArray(payload.results), `${label}: results is not an array`);
  const identifiers = new Set(expectedIdentifiers);
  for (const result of payload.results) {
    expect(result.status === "ok", `${label}: ${result.identifier} status ${result.status}`);
    expect(
      identifiers.has(result.identifier),
      `${label}: unexpected identifier ${result.identifier}`,
    );
  }
  expect(payload.results.length === identifiers.size, `${label}: result count mismatch`);
  proofs.push(`results=${payload.results.length}`);
  proofs.push("all statuses ok");
  return proofs;
}

function assertRelationDeletePayload(payload, label, expected) {
  const proofs = requireFields(payload, ["op", "from", "kind", "to", "status"], label);
  expect(payload.op === "delete", `${label}: expected op=delete, got ${payload.op}`);
  expect(
    payload.from === expected.from,
    `${label}: expected from=${expected.from}, got ${payload.from}`,
  );
  expect(
    payload.kind === expected.kind,
    `${label}: expected kind=${expected.kind}, got ${payload.kind}`,
  );
  expect(payload.to === expected.to, `${label}: expected to=${expected.to}, got ${payload.to}`);
  expect(payload.status === "deleted", `${label}: expected status=deleted, got ${payload.status}`);
  proofs.push("status=deleted");
  proofs.push(`from=${expected.from}`);
  proofs.push(`to=${expected.to}`);
  return proofs;
}

function assertRelationAddPayload(payload, label, expected) {
  const proofs = requireFields(payload, ["from", "kind", "to", "status", "relation_id"], label);
  expect(
    payload.from === expected.from || payload.requested_from === expected.from,
    `${label}: expected from=${expected.from}, got ${payload.from}`,
  );
  expect(
    payload.kind === expected.kind,
    `${label}: expected kind=${expected.kind}, got ${payload.kind}`,
  );
  expect(payload.to === expected.to, `${label}: expected to=${expected.to}, got ${payload.to}`);
  expect(
    payload.status === "created" || payload.status === "updated",
    `${label}: expected created/updated status, got ${payload.status}`,
  );
  proofs.push(`from=${expected.from}`);
  proofs.push(`kind=${expected.kind}`);
  proofs.push(`to=${expected.to}`);
  proofs.push(`status=${payload.status}`);
  proofs.push("relation_id present");
  return proofs;
}

function assertRelationUpdatePayload(payload, label, expected) {
  const proofs = requireFields(payload, ["from", "results"], label);
  expect(
    payload.from === expected.from,
    `${label}: expected from=${expected.from}, got ${payload.from}`,
  );
  expect(Array.isArray(payload.results), `${label}: results is not an array`);
  const created = payload.results.find(
    (row) => row.op === "+" && row.kind === expected.kind && row.to === expected.to,
  );
  const removed = payload.results.find(
    (row) => row.op === "-" && row.kind === expected.kind && row.to === expected.to,
  );
  expect(created, `${label}: missing add delta row`);
  expect(removed, `${label}: missing remove delta row`);
  expect(
    created.status === "created" || created.status === "updated" || created.status === "unchanged",
    `${label}: unexpected add status ${created.status}`,
  );
  expect(
    removed.status === "deleted" || removed.status === "already-absent",
    `${label}: unexpected remove status ${removed.status}`,
  );
  proofs.push(`from=${expected.from}`);
  proofs.push(`kind=${expected.kind}`);
  proofs.push(`to=${expected.to}`);
  proofs.push(`add.status=${created.status}`);
  proofs.push(`remove.status=${removed.status}`);
  return proofs;
}

function assertBulkUpdatePayload(payload, label, expected) {
  const proofs = requireFields(payload, ["results", "summary"], label);
  expect(Array.isArray(payload.results), `${label}: results is not an array`);
  const expectedIdentifiers = new Set(expected.identifiers);
  expect(
    payload.summary?.total === expected.identifiers.length,
    `${label}: expected total=${expected.identifiers.length}, got ${payload.summary?.total}`,
  );
  expect(
    payload.summary?.updated === expected.identifiers.length,
    `${label}: expected updated=${expected.identifiers.length}, got ${payload.summary?.updated}`,
  );
  expect(
    payload.summary?.failed === 0,
    `${label}: expected failed=0, got ${payload.summary?.failed}`,
  );
  for (const identifier of expectedIdentifiers) {
    const row = payload.results.find((result) => result.identifier === identifier);
    expect(row, `${label}: missing result row for ${identifier}`);
    expect(row.status === "updated", `${label}: ${identifier} status ${row.status}`);
    const fields = new Set(row.fields ?? []);
    for (const field of expected.fields) {
      expect(fields.has(field), `${label}: ${identifier} missing field ${field}`);
    }
  }
  proofs.push(`summary.total=${expected.identifiers.length}`);
  proofs.push(`summary.updated=${expected.identifiers.length}`);
  proofs.push("summary.failed=0");
  proofs.push("all target rows updated");
  for (const field of expected.fields) proofs.push(`field=${field}`);
  return proofs;
}

function assertArchivePayload(payload, label, expectedId) {
  const proofs = requireFields(payload, ["id", "success"], label);
  expect(payload.id === expectedId, `${label}: expected id ${expectedId}, got ${payload.id}`);
  expect(payload.success === true, `${label}: expected success=true`);
  proofs.push(`id=${expectedId}`);
  proofs.push("success=true");
  return proofs;
}

function assertInitiativeRemoveProjectPayload(payload, label) {
  const proofs = requireFields(payload, ["removed"], label);
  expect(payload.removed === true, `${label}: expected removed=true`);
  proofs.push("removed=true");
  return proofs;
}

function assertLinearApiTelemetry(payload, label) {
  const meta = payload?._meta?.linear_api;
  expect(meta && typeof meta === "object", `${label}: missing _meta.linear_api`);
  const requestCount = meta?.request_count;
  expect(
    Number.isInteger(requestCount) && requestCount > 0,
    `${label}: missing linear_api.request_count`,
  );
  const requestsRemaining = meta?.rate_limit?.requests?.remaining;
  expect(
    typeof requestsRemaining === "number",
    `${label}: missing linear_api.rate_limit.requests.remaining`,
  );
  const complexityRemaining = meta?.rate_limit?.complexity?.remaining;
  expect(
    typeof complexityRemaining === "number",
    `${label}: missing linear_api.rate_limit.complexity.remaining`,
  );
  return [...LINEAR_API_PROOF_LABELS];
}

function assertExplorePayload(payload, label, expectedPath) {
  assertNoBehaviorContractErrors(label, validateExplorePayloadContract(payload));
  const proofs = requireFields(payload, ["path", "count", "items", "page"], label);
  if (explorePayloadShouldHaveLinearApiTelemetry(payload, expectedPath)) {
    proofs.push(...assertLinearApiTelemetry(payload, label));
  }
  expect(
    payload.path === expectedPath,
    `${label}: expected path ${expectedPath}, got ${payload.path}`,
  );
  proofs.push(`path=${expectedPath}`);
  if (payload.has_more === true) {
    expect(typeof payload.next_cursor === "string", `${label}: has_more without next_cursor`);
    proofs.push("next_cursor present");
  }
  return proofs;
}

function explorePayloadShouldHaveLinearApiTelemetry(payload, expectedPath) {
  return (
    expectedPath !== "/" || (typeof payload?.query === "string" && payload.query.trim().length > 0)
  );
}

function assertExploreSearchContains(payload, label, expected) {
  const proofs = assertExplorePayload(payload, label, "/");
  const items = Array.isArray(payload.items) ? payload.items : [];
  const expectedPath =
    expected.path ??
    (expected.kind && expected.id
      ? `/${expected.kind === "agent_session" ? "agent-sessions" : `${expected.kind}s`}/${expected.id}`
      : null);
  const found = items.find((item) => {
    if (expected.kind && item?.kind !== expected.kind) return false;
    if (expected.id && item?.id === expected.id) return true;
    if (expectedPath && item?.path === expectedPath) return true;
    if (expected.name && item?.name === expected.name) return true;
    return false;
  });
  expect(
    found,
    `${label}: search results did not include ${expected.kind ?? "item"} ${
      expected.id ?? expected.name ?? expectedPath
    }; returned ${items
      .map((item) => `${item?.kind ?? "unknown"}:${item?.id ?? item?.name ?? item?.path ?? "?"}`)
      .join(", ")}`,
  );
  proofs.push(`${expected.kind ?? "item"} search returned expected fixture`);
  if (expected.id) proofs.push(`id=${expected.id}`);
  if (expected.name) proofs.push(`name=${expected.name}`);
  return proofs;
}

function projectExploreItemId(item) {
  return item?.id ?? item?.path ?? item?.name ?? null;
}

function assertProjectCursorPage1(payload, label) {
  const proofs = assertExplorePayload(payload, label, "/projects");
  expect(payload.items.length === 1, `${label}: expected exactly one project with limit=1`);
  expect(payload.items[0]?.kind === "project", `${label}: first item is not a project`);
  expect(
    payload.has_more === true,
    `${label}: deterministic two-project fixture did not produce has_more`,
  );
  expect(typeof payload.next_cursor === "string", `${label}: missing next_cursor`);
  proofs.push("limit=1 returned one project");
  proofs.push("has_more=true");
  return proofs;
}

function assertProjectCursorPage2(payload, label, firstPage) {
  const proofs = assertExplorePayload(payload, label, "/projects");
  expect(payload.items.length === 1, `${label}: expected exactly one project with limit=1`);
  expect(payload.items[0]?.kind === "project", `${label}: first item is not a project`);
  const firstId = projectExploreItemId(firstPage.items?.[0]);
  const secondId = projectExploreItemId(payload.items?.[0]);
  expect(firstId && secondId, `${label}: could not identify page items`);
  expect(firstId !== secondId, `${label}: page two repeated page-one project ${firstId}`);
  proofs.push("limit=1 returned one project");
  proofs.push("page two project differs from page one");
  return proofs;
}

function assertFetchPayload(payload, label, expectedKind) {
  assertNoBehaviorContractErrors(label, validateFetchPayloadContract(payload));
  const proofs = [
    ...requireFields(payload, ["target", "kind", "root", "manifest_file", "counts"], label),
    ...assertLinearApiTelemetry(payload, label),
  ];
  expect(
    payload.kind === expectedKind,
    `${label}: expected kind ${expectedKind}, got ${payload.kind}`,
  );
  proofs.push(`kind=${expectedKind}`);
  return proofs;
}

function assertCachePushPayload(payload, label, expected) {
  const proofs = requireFields(payload, ["results", "summary"], label);
  expect(Array.isArray(payload.results), `${label}: results is not an array`);
  expect(payload.summary.applied >= 1, `${label}: expected at least one applied row`);
  const row = payload.results.find(
    (candidate) =>
      candidate.kind === expected.kind &&
      candidate.status === "pushed" &&
      (expected.target === undefined || candidate.target === expected.target),
  );
  expect(
    row,
    `${label}: missing pushed ${expected.kind} result for ${expected.target ?? "target"}`,
  );
  for (const field of expected.fields ?? []) {
    expect(row.fields?.includes(field), `${label}: pushed row missing field ${field}`);
  }
  proofs.push("status=pushed");
  proofs.push(`kind=${expected.kind}`);
  if (expected.target) proofs.push(`target=${expected.target}`);
  if (expected.fields?.length) proofs.push(`fields=${expected.fields.join(",")}`);
  return proofs;
}

async function readFetchManifest(payload, label) {
  expect(payload.manifest_file, `${label}: manifest_file missing`);
  return JSON.parse(await readFile(payload.manifest_file, "utf8"));
}

async function assertAgentSessionDefaultOmitted(payload, label, countKey) {
  const manifest = await readFetchManifest(payload, label);
  const selected = manifest.selected_includes ?? [];
  const counts = manifest.counts ?? {};
  expect(
    !selected.includes("agent_sessions"),
    `${label}: default fetch unexpectedly selected agent_sessions`,
  );
  expect(counts[countKey] === undefined, `${label}: default fetch materialized ${countKey}`);
  return ["agent_sessions not selected by default", `${countKey} not materialized by default`];
}

async function assertIssueAgentSessionChildFetch(payload, label, identifier) {
  const manifest = await readFetchManifest(payload, label);
  const selected = manifest.selected_includes ?? [];
  const counts = manifest.counts ?? {};
  const generated = manifest.generated_files ?? [];
  const expectedFile = `issues/${identifier}/agent-sessions.json`;
  expect(selected.includes("agent_sessions"), `${label}: agent_sessions include not selected`);
  expect(
    typeof counts.agent_sessions === "number",
    `${label}: agent_sessions count missing from manifest`,
  );
  expect(generated.includes(expectedFile), `${label}: ${expectedFile} was not generated`);
  return [
    "agent_sessions selected for child path",
    `agent_sessions count=${counts.agent_sessions}`,
    `${expectedFile} generated`,
  ];
}

async function assertIssueDocumentFetch(payload, label, identifier, expectedSnippets = []) {
  const manifest = await readFetchManifest(payload, label);
  const selected = manifest.selected_includes ?? [];
  const counts = manifest.counts ?? {};
  const generated = manifest.generated_files ?? [];
  const expectedListFile = `issues/${identifier}/documents.json`;
  expect(selected.includes("documents"), `${label}: documents include not selected`);
  expect(selected.includes("document_details"), `${label}: document_details include not selected`);
  expect(typeof counts.documents === "number", `${label}: documents count missing from manifest`);
  expect(
    typeof counts.document_details === "number",
    `${label}: document_details count missing from manifest`,
  );
  expect(generated.includes(expectedListFile), `${label}: ${expectedListFile} was not generated`);
  if (expectedSnippets.length > 0) {
    await assertGeneratedIssueDocumentSnippets(
      label,
      payload,
      manifest,
      identifier,
      expectedSnippets,
    );
  }
  return [
    "documents selected for issue context",
    "document_details selected for issue context",
    `documents count=${counts.documents}`,
    `document_details count=${counts.document_details}`,
    `${expectedListFile} generated`,
  ];
}

async function assertAggregateIssueDocumentFetch(
  payload,
  label,
  identifier,
  expectedSnippets = [],
) {
  const manifest = await readFetchManifest(payload, label);
  const selected = manifest.selected_includes ?? [];
  const counts = manifest.counts ?? {};
  const generated = manifest.generated_files ?? [];
  const expectedListFile = `issues/${identifier}/documents.json`;
  expect(selected.includes("issue_documents"), `${label}: issue_documents include not selected`);
  expect(
    selected.includes("issue_document_details"),
    `${label}: issue_document_details include not selected`,
  );
  expect(
    typeof counts.issue_documents === "number" && counts.issue_documents > 0,
    `${label}: issue_documents count missing or zero in manifest`,
  );
  expect(
    typeof counts.issue_document_details === "number" && counts.issue_document_details > 0,
    `${label}: issue_document_details count missing or zero in manifest`,
  );
  expect(generated.includes(expectedListFile), `${label}: ${expectedListFile} was not generated`);
  if (expectedSnippets.length > 0) {
    await assertGeneratedIssueDocumentSnippets(
      label,
      payload,
      manifest,
      identifier,
      expectedSnippets,
    );
  }
  return [
    "issue_documents selected for aggregate context",
    "issue_document_details selected for aggregate context",
    `issue_documents count=${counts.issue_documents}`,
    `issue_document_details count=${counts.issue_document_details}`,
    `${expectedListFile} generated`,
  ];
}

async function assertGeneratedIssueDocumentSnippets(
  label,
  payload,
  manifest,
  identifier,
  expectedSnippets,
) {
  expect(payload.root, `${label}: root missing`);
  const generated = manifest.generated_files ?? [];
  const prefix = `issues/${identifier}/documents`;
  const listFile = `${prefix}.json`;
  const detailFiles = generated.filter(
    (file) => file.startsWith(`${prefix}/`) && file.endsWith("/document.md"),
  );
  expect(generated.includes(listFile), `${label}: ${listFile} was not generated`);
  expect(detailFiles.length > 0, `${label}: issue document detail files missing`);

  const contents = [await readContextFile(label, payload.root, listFile)];
  for (const file of detailFiles) {
    contents.push(await readContextFile(label, payload.root, file));
  }
  const combined = contents.join("\n");
  for (const snippet of expectedSnippets) {
    expect(
      combined.includes(snippet),
      `${label}: generated issue document files missing expected content ${JSON.stringify(snippet)}`,
    );
  }
}

export function evaluateGaps(gaps, now = new Date()) {
  return gaps.map((gap) => {
    const allowlist = gap.allowlist ?? GAP_ALLOWLIST[gap.name];
    const expiry = allowlist?.expires ? new Date(`${allowlist.expires}T23:59:59.999Z`) : null;
    const allowed =
      Boolean(allowlist?.reason) &&
      Boolean(allowlist?.expires) &&
      Boolean(expiry) &&
      expiry.getTime() >= now.getTime();
    return {
      name: gap.name,
      allowed,
      reason: allowlist?.reason ?? null,
      expires: allowlist?.expires ?? null,
      detail_reason: gap.reason ?? null,
    };
  });
}

export function assertNoUnexpectedGaps(targetReport, now = new Date()) {
  const evaluated = evaluateGaps(targetReport.gaps ?? [], now);
  targetReport.coverage = {
    ...(targetReport.coverage ?? {}),
    gaps: evaluated,
  };
  const unexpected = evaluated.filter((gap) => !gap.allowed);
  if (unexpected.length > 0) {
    const names = unexpected.map((gap) => gap.name).join(", ");
    throw new Error(
      `live harness recorded unallowlisted or expired gaps: ${names}. Add an explicit allowlist entry with reason and expiry, or make the surface testable.`,
    );
  }
}

export function buildSurfaceCoverage(targetReport, mcpToolNames = []) {
  const acceptableStatuses = new Set(["pass", "gap"]);
  const resultNames = new Set(
    (targetReport.results ?? [])
      .filter((result) => acceptableStatuses.has(result.status))
      .map((result) => result.name),
  );
  const mcpCoveredTools = new Set();
  for (const result of targetReport.results ?? []) {
    if (!acceptableStatuses.has(result.status)) continue;
    if (!result.name.startsWith("mcp:")) continue;
    const tool =
      typeof result.tool === "string"
        ? result.tool
        : result.name.slice("mcp:".length).replace(/ expected error$/, "");
    if (tool !== "initialize" && tool !== "tools/list") mcpCoveredTools.add(tool);
  }
  return {
    cli: {
      required: REQUIRED_CLI_LIVE_STEPS,
      missing: REQUIRED_CLI_LIVE_STEPS.filter((name) => !resultNames.has(name)),
    },
    mcp: {
      advertised: mcpToolNames,
      covered: [...mcpCoveredTools].sort(),
      missing: mcpToolNames.filter((name) => !mcpCoveredTools.has(name)),
    },
  };
}

function reportMcpToolInventory(targetReport) {
  const names = targetReport.created?.mcp_tools ?? targetReport.coverage?.mcp?.advertised ?? [];
  return Array.isArray(names) ? names.filter((name) => typeof name === "string").sort() : [];
}

export function assertSurfaceCoverage(targetReport, mcpToolNames = []) {
  const coverage = buildSurfaceCoverage(targetReport, mcpToolNames);
  targetReport.coverage = {
    ...(targetReport.coverage ?? {}),
    ...coverage,
  };
  const failures = [];
  if (coverage.cli.missing.length > 0) {
    failures.push(`CLI live steps missing: ${coverage.cli.missing.join(", ")}`);
  }
  if (coverage.mcp.missing.length > 0) {
    failures.push(`MCP tools missing live coverage: ${coverage.mcp.missing.join(", ")}`);
  }
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
}

export function buildSemanticCoverage(targetReport) {
  const results = targetReport.results ?? [];
  const hasSemanticProof = (name) =>
    results.some(
      (result) =>
        result.name === name &&
        result.status === "pass" &&
        Array.isArray(result.semantic_assertions) &&
        result.semantic_assertions.length > 0,
    );
  return {
    required: REQUIRED_SEMANTIC_LIVE_STEPS,
    covered: REQUIRED_SEMANTIC_LIVE_STEPS.filter((name) => hasSemanticProof(name)),
    missing: REQUIRED_SEMANTIC_LIVE_STEPS.filter((name) => !hasSemanticProof(name)),
    manifest: buildManifestSemanticCoverage(),
    conditional_confirm: buildConditionalConfirmSemanticCoverage(),
  };
}

export function buildManifestSemanticCoverage() {
  const requiredStepSet = new Set(REQUIRED_SEMANTIC_LIVE_STEPS);
  const configured = [];
  const missing = [];
  for (const tool of REQUIRED_MANIFEST_SEMANTIC_TOOLS) {
    const steps = MANIFEST_SEMANTIC_LIVE_STEPS[tool] ?? [];
    const configuredSteps = steps.filter((step) => requiredStepSet.has(step));
    const row = { tool, steps, configured_steps: configuredSteps };
    if (configuredSteps.length > 0) {
      configured.push(row);
    } else {
      missing.push(row);
    }
  }
  return {
    required_tools: REQUIRED_MANIFEST_SEMANTIC_TOOLS,
    configured,
    missing,
  };
}

export function buildConditionalConfirmSemanticCoverage() {
  const toolSteps = {
    bulk_update_issues: ["mcp:bulk_update_issues"],
    pull_project: ["mcp:pull_project refresh"],
    pull_issues: ["mcp:pull_issues refresh"],
    push_changes: ["mcp:push_changes force"],
    plan_apply: ["mcp:plan_apply force"],
    plan_pull: ["mcp:plan_pull force"],
    cache_gc: ["mcp:cache_gc delete temp cache"],
    add_relation: ["mcp:add_relation replacement confirm"],
    update_relations: ["mcp:update_relations remove confirm"],
    raw_graphql: ["mcp:raw_graphql mutation confirm"],
  };
  const requiredStepSet = new Set(REQUIRED_SEMANTIC_LIVE_STEPS);
  const configured = [];
  const missing = [];
  for (const tool of CONDITIONAL_MCP_CONFIRM_TOOLS) {
    const steps = toolSteps[tool] ?? [];
    const configuredSteps = steps.filter((step) => requiredStepSet.has(step));
    const row = { tool, steps, configured_steps: configuredSteps };
    if (configuredSteps.length > 0) {
      configured.push(row);
    } else {
      missing.push(row);
    }
  }
  return {
    required_tools: CONDITIONAL_MCP_CONFIRM_TOOLS,
    configured,
    missing,
  };
}

export function assertSemanticCoverage(targetReport) {
  const semantic = buildSemanticCoverage(targetReport);
  targetReport.coverage = {
    ...(targetReport.coverage ?? {}),
    semantic,
  };
  if (semantic.missing.length > 0) {
    throw new Error(`live semantic assertions missing: ${semantic.missing.join(", ")}`);
  }
  if (semantic.manifest.missing.length > 0) {
    throw new Error(
      `manifest-required live semantic tools missing configured steps: ${semantic.manifest.missing
        .map((entry) => entry.tool)
        .join(", ")}`,
    );
  }
  if (semantic.conditional_confirm.missing.length > 0) {
    throw new Error(
      `conditional-confirm live semantic tools missing configured steps: ${semantic.conditional_confirm.missing
        .map((entry) => entry.tool)
        .join(", ")}`,
    );
  }
}

export function buildPublishProofCoverage(targetReport) {
  const results = targetReport.results ?? [];
  const requiredProofs = new Set(PUBLISH_VERIFIED_PROOF_LABELS);
  const rows = REQUIRED_PUBLISH_PROOF_STEPS.map((name) => {
    const matches = results.filter((result) => result.name === name && result.status === "pass");
    const verified = matches.some((result) => {
      const proofs = new Set(result.semantic_assertions ?? []);
      return [...requiredProofs].every((proof) => proofs.has(proof));
    });
    return { name, verified, attempts: matches.length };
  });
  return {
    required: REQUIRED_PUBLISH_PROOF_STEPS,
    verified: rows.filter((row) => row.verified).map((row) => row.name),
    missing: rows.filter((row) => !row.verified).map((row) => row.name),
    rows,
  };
}

export function buildFieldUpdateProofCoverage(targetReport) {
  const results = targetReport.results ?? [];
  const rows = Object.entries(FIELD_UPDATE_PROOF_LABELS).map(([name, requiredLabels]) => {
    const matches = results.filter((result) => result.name === name && result.status === "pass");
    const verified = matches.some((result) => {
      const proofs = new Set(result.semantic_assertions ?? []);
      return requiredLabels.every((proof) => proofs.has(proof));
    });
    return {
      name,
      verified,
      attempts: matches.length,
      missing_labels: requiredLabels.filter(
        (proof) => !matches.some((result) => new Set(result.semantic_assertions ?? []).has(proof)),
      ),
    };
  });
  return {
    required: Object.keys(FIELD_UPDATE_PROOF_LABELS),
    verified: rows.filter((row) => row.verified).map((row) => row.name),
    missing: rows.filter((row) => !row.verified).map((row) => row.name),
    rows,
  };
}

export function buildLinearApiProofCoverage(targetReport) {
  const results = targetReport.results ?? [];
  const requiredProofs = new Set(LINEAR_API_PROOF_LABELS);
  const rows = REQUIRED_LINEAR_API_PROOF_STEPS.map((name) => {
    const matches = results.filter((result) => result.name === name && result.status === "pass");
    const verified = matches.some((result) => {
      const proofs = new Set(result.semantic_assertions ?? []);
      return [...requiredProofs].every((proof) => proofs.has(proof));
    });
    return {
      name,
      surface: name.startsWith("cli:") ? "cli" : "mcp",
      verified,
      attempts: matches.length,
      missing_labels: LINEAR_API_PROOF_LABELS.filter(
        (proof) => !matches.some((result) => new Set(result.semantic_assertions ?? []).has(proof)),
      ),
    };
  });
  const surfaceSummary = (surface) => {
    const surfaceRows = rows.filter((row) => row.surface === surface);
    return {
      required: surfaceRows.map((row) => row.name),
      verified: surfaceRows.filter((row) => row.verified).map((row) => row.name),
      missing: surfaceRows.filter((row) => !row.verified).map((row) => row.name),
    };
  };
  return {
    required: REQUIRED_LINEAR_API_PROOF_STEPS,
    verified: rows.filter((row) => row.verified).map((row) => row.name),
    missing: rows.filter((row) => !row.verified).map((row) => row.name),
    rows,
    surfaces: {
      cli: surfaceSummary("cli"),
      mcp: surfaceSummary("mcp"),
    },
  };
}

export function buildRemoteDestructiveAuditCoverage(targetReport) {
  const auditEntries = (targetReport.cleanup ?? []).filter(
    (entry) => entry.name === "remote destructive audit",
  );
  const passEntry = auditEntries.find((entry) => entry.status === "pass") ?? null;
  const expectedTargets = Array.isArray(passEntry?.expected_targets)
    ? passEntry.expected_targets
    : [];
  const auditedTargets = Array.isArray(passEntry?.audited_targets) ? passEntry.audited_targets : [];
  const expectedKeys = new Set(
    expectedTargets.map((target) => target?.key).filter((key) => typeof key === "string"),
  );
  const auditedKeys = new Set(
    auditedTargets.map((target) => target?.key).filter((key) => typeof key === "string"),
  );
  const proofless = auditedTargets
    .filter((target) => typeof target?.proof !== "string" || target.proof.trim() === "")
    .map((target) => target?.key)
    .filter((key) => typeof key === "string");

  return {
    pass: Boolean(passEntry),
    checked: Number(passEntry?.checked ?? 0),
    expected_count: Number(passEntry?.expected ?? expectedTargets.length),
    expected: expectedTargets,
    audited: auditedTargets,
    missing: [...expectedKeys].filter((key) => !auditedKeys.has(key)),
    unexpected: [...auditedKeys].filter((key) => !expectedKeys.has(key)),
    proofless,
  };
}

export function validateFullSurfaceReport(targetReport, options = {}) {
  const advertisedMcpToolNames = reportMcpToolInventory(targetReport);
  const mcpToolNames = REQUIRED_MCP_LIVE_TOOLS;
  const coverage = buildSurfaceCoverage(targetReport, mcpToolNames);
  coverage.mcp = {
    ...coverage.mcp,
    advertised: advertisedMcpToolNames,
    manifest: mcpToolNames,
    missing_from_advertised: mcpToolNames.filter((name) => !advertisedMcpToolNames.includes(name)),
  };
  const semantic = buildSemanticCoverage(targetReport);
  const publishProof = buildPublishProofCoverage(targetReport);
  const fieldUpdateProof = buildFieldUpdateProofCoverage(targetReport);
  const linearApiProof = buildLinearApiProofCoverage(targetReport);
  const remoteAudit = buildRemoteDestructiveAuditCoverage(targetReport);
  targetReport.coverage = {
    ...(targetReport.coverage ?? {}),
    ...coverage,
    semantic,
    publish: publishProof,
    field_updates: fieldUpdateProof,
    linear_api: linearApiProof,
    remote_audit: remoteAudit,
  };

  const results = targetReport.results ?? [];
  const failedResults = results.filter((result) => result.status === "fail");
  const gappedResults = results.filter((result) => result.status === "gap");
  const unknownStatusResults = results.filter(
    (result) => !["pass", "fail", "gap"].includes(result.status),
  );
  const cleanupFailures = (targetReport.cleanup ?? []).filter((entry) => entry.status === "fail");
  const gaps = targetReport.gaps ?? [];
  const errors = [];

  if (targetReport.status !== "completed") {
    errors.push(`report status is ${JSON.stringify(targetReport.status)}, expected "completed"`);
  }
  if (options.expectedWorkspace && targetReport.workspace !== options.expectedWorkspace) {
    errors.push(
      `workspace is ${JSON.stringify(targetReport.workspace)}, expected ${JSON.stringify(
        options.expectedWorkspace,
      )}`,
    );
  }
  if (options.expectedTeam && targetReport.team !== options.expectedTeam) {
    errors.push(
      `team is ${JSON.stringify(targetReport.team)}, expected ${JSON.stringify(options.expectedTeam)}`,
    );
  }
  if (options.expectedStamp) {
    if (targetReport.stamp !== options.expectedStamp) {
      errors.push(
        `stamp is ${JSON.stringify(targetReport.stamp)}, expected ${JSON.stringify(
          options.expectedStamp,
        )}`,
      );
    }
    const expectedPrefix = `lebop-surface-${options.expectedStamp}`;
    if (targetReport.prefix !== expectedPrefix) {
      errors.push(
        `prefix is ${JSON.stringify(targetReport.prefix)}, expected ${JSON.stringify(
          expectedPrefix,
        )}`,
      );
    }
  }
  if (failedResults.length > 0) {
    errors.push(`failed live steps: ${failedResults.map((result) => result.name).join(", ")}`);
  }
  if (gaps.length > 0 || gappedResults.length > 0) {
    const gapNames = new Set([
      ...gaps.map((gap) => gap.name),
      ...gappedResults.map((result) => result.name),
    ]);
    errors.push(`live gaps recorded: ${[...gapNames].join(", ")}`);
  }
  if (unknownStatusResults.length > 0) {
    errors.push(
      `live steps with unknown status: ${unknownStatusResults
        .map((result) => `${result.name}:${result.status}`)
        .join(", ")}`,
    );
  }
  if (cleanupFailures.length > 0) {
    errors.push(
      `cleanup failures: ${cleanupFailures.map((entry) => entry.name ?? "unnamed").join(", ")}`,
    );
  }
  if (!remoteAudit.pass) {
    errors.push("remote destructive cleanup audit missing or failed");
  } else {
    if (remoteAudit.expected.length === 0) {
      errors.push("remote destructive cleanup audit missing expected target identities");
    }
    if (remoteAudit.checked <= 0 || remoteAudit.audited.length === 0) {
      errors.push("remote destructive cleanup audit missing audited target identities");
    }
    if (remoteAudit.expected_count !== remoteAudit.expected.length) {
      errors.push(
        `remote destructive cleanup audit expected count ${remoteAudit.expected_count} does not match expected target count ${remoteAudit.expected.length}`,
      );
    }
    if (
      remoteAudit.checked !== remoteAudit.expected.length ||
      remoteAudit.checked !== remoteAudit.audited.length
    ) {
      errors.push(
        `remote destructive cleanup audit count mismatch: checked=${remoteAudit.checked}, expected_targets=${remoteAudit.expected.length}, audited_targets=${remoteAudit.audited.length}`,
      );
    }
    if (remoteAudit.missing.length > 0) {
      errors.push(
        `remote destructive cleanup audit missed targets: ${remoteAudit.missing.join(", ")}`,
      );
    }
    if (remoteAudit.unexpected.length > 0) {
      errors.push(
        `remote destructive cleanup audit checked unexpected targets: ${remoteAudit.unexpected.join(", ")}`,
      );
    }
    if (remoteAudit.proofless.length > 0) {
      errors.push(
        `remote destructive cleanup audit missing proof text for targets: ${remoteAudit.proofless.join(", ")}`,
      );
    }
  }
  if (coverage.cli.missing.length > 0) {
    errors.push(`CLI live steps missing: ${coverage.cli.missing.join(", ")}`);
  }
  if (advertisedMcpToolNames.length === 0) {
    errors.push("MCP advertised tool inventory missing from report");
  } else if (coverage.mcp.missing_from_advertised.length > 0) {
    errors.push(
      `MCP advertised tool inventory missing manifest tools: ${coverage.mcp.missing_from_advertised.join(", ")}`,
    );
  }
  if (coverage.mcp.missing.length > 0) {
    errors.push(`MCP manifest tools missing live coverage: ${coverage.mcp.missing.join(", ")}`);
  }
  if (semantic.missing.length > 0) {
    errors.push(`live semantic assertions missing: ${semantic.missing.join(", ")}`);
  }
  if (semantic.manifest.missing.length > 0) {
    errors.push(
      `manifest-required live semantic tools missing configured steps: ${semantic.manifest.missing
        .map((entry) => entry.tool)
        .join(", ")}`,
    );
  }
  if (semantic.conditional_confirm.missing.length > 0) {
    errors.push(
      `conditional-confirm live semantic tools missing configured steps: ${semantic.conditional_confirm.missing
        .map((entry) => entry.tool)
        .join(", ")}`,
    );
  }
  if (publishProof.missing.length > 0) {
    errors.push(`verified publish proof missing: ${publishProof.missing.join(", ")}`);
  }
  if (fieldUpdateProof.missing.length > 0) {
    errors.push(`field update proof missing: ${fieldUpdateProof.missing.join(", ")}`);
  }
  if (linearApiProof.missing.length > 0) {
    errors.push(`linear_api proof missing: ${linearApiProof.missing.join(", ")}`);
  }
  if (
    options.expectedBinaryMode &&
    targetReport.binary_under_test?.mode !== options.expectedBinaryMode
  ) {
    errors.push(
      `binary_under_test.mode is ${JSON.stringify(
        targetReport.binary_under_test?.mode,
      )}, expected ${JSON.stringify(options.expectedBinaryMode)}`,
    );
  }
  if (
    options.expectedBinarySha256 &&
    targetReport.binary_under_test?.sha256 !== options.expectedBinarySha256
  ) {
    errors.push(
      `binary_under_test.sha256 is ${JSON.stringify(
        targetReport.binary_under_test?.sha256,
      )}, expected ${JSON.stringify(options.expectedBinarySha256)}`,
    );
  }
  if (options.expectedBinaryMode === "compiled-binary") {
    const binary = targetReport.binary_under_test ?? {};
    const envExpectedVersion = process.env.LEBOP_LIVE_EXPECT_VERSION?.trim() || undefined;
    const expectedVersion =
      options.expectedBinaryVersion ??
      options.expectedVersion ??
      envExpectedVersion ??
      LEBOP_VERSION;
    if (!/^[a-f0-9]{64}$/.test(binary.sha256 ?? "")) {
      errors.push("binary_under_test.sha256 missing or invalid for compiled-binary report");
    }
    if (!Number.isInteger(binary.size_bytes) || binary.size_bytes <= 0) {
      errors.push("binary_under_test.size_bytes missing or invalid for compiled-binary report");
    }
    for (const field of ["version", "platform", "arch"]) {
      if (typeof binary[field] !== "string" || binary[field].trim() === "") {
        errors.push(`binary_under_test.${field} missing for compiled-binary report`);
      }
    }
    if (
      expectedVersion &&
      typeof binary.version === "string" &&
      binary.version.trim() !== expectedVersion
    ) {
      errors.push(
        `binary_under_test.version is ${JSON.stringify(
          binary.version.trim(),
        )}, expected ${JSON.stringify(expectedVersion)}`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    coverage: targetReport.coverage,
    failed_results: failedResults,
    gaps,
    cleanup_failures: cleanupFailures,
    publish_proof: publishProof,
    field_update_proof: fieldUpdateProof,
    linear_api_proof: linearApiProof,
    remote_audit: remoteAudit,
  };
}

export function assertFullSurfaceReport(targetReport, options = {}) {
  const validation = validateFullSurfaceReport(targetReport, options);
  if (!validation.ok) {
    throw new Error(
      `live Noxor surface report failed validation:\n${validation.errors.join("\n")}`,
    );
  }
  return validation;
}

export function liveReportHasFailedEntries(targetReport) {
  return (
    (targetReport.results ?? []).some((entry) => entry.status === "fail") ||
    (targetReport.cleanup ?? []).some((entry) => entry.status === "fail")
  );
}

export function finalizeLiveReportStatus(targetReport) {
  if (liveReportHasFailedEntries(targetReport)) {
    targetReport.status = "failed";
  } else if (!targetReport.status || targetReport.status === "running") {
    targetReport.status = "completed";
  }
  return targetReport.status;
}

export function validateLiveHarnessProcess(targetReport, options = {}) {
  const validation = validateFullSurfaceReport(targetReport, options);
  targetReport.validation = {
    ok: validation.ok,
    errors: validation.errors,
  };
  return validation;
}

export function shouldFailLiveHarnessProcess(targetReport, options = {}) {
  return !validateLiveHarnessProcess(targetReport, options).ok;
}

export async function writeLiveSurfaceReport(targetReport, options = {}) {
  const reportDir = options.reportDir ?? path.join(repoRoot, "docs", "local");
  const reportStamp = normalizeLiveStamp(options.stamp ?? stamp);
  const artifactReport =
    options.sanitize === false ? targetReport : sanitizeLiveSurfaceReport(targetReport);
  if (options.sanitize !== false) assertLiveSurfaceReportSanitized(artifactReport);
  await mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `live-nox-surface-report-${reportStamp}.json`);
  await writeFile(reportPath, `${JSON.stringify(artifactReport, null, 2)}\n`);
  return reportPath;
}

export async function validateReportFile(reportPath, options = {}) {
  const raw = await readFile(reportPath, "utf8");
  const targetReport = JSON.parse(raw);
  assertLiveSurfaceReportSanitized(targetReport);
  const validation = assertFullSurfaceReport(targetReport, options);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        report: reportPath,
        expected_workspace: options.expectedWorkspace ?? null,
        expected_team: options.expectedTeam ?? null,
        expected_stamp: options.expectedStamp ?? null,
        expected_binary_mode: options.expectedBinaryMode ?? null,
        expected_binary_version: options.expectedBinaryVersion ?? null,
        expected_binary_sha256: options.expectedBinarySha256 ?? null,
        cli_missing: validation.coverage.cli.missing,
        mcp_missing: validation.coverage.mcp.missing,
        semantic_missing: validation.coverage.semantic.missing,
        publish_missing: validation.coverage.publish.missing,
        field_update_missing: validation.coverage.field_updates.missing,
        linear_api_missing: validation.coverage.linear_api.missing,
        remote_audit_missing: validation.coverage.remote_audit.missing,
        gaps: validation.gaps.length,
        failures: validation.failed_results.length,
        cleanup_failures: validation.cleanup_failures.length,
      },
      null,
      2,
    ),
  );
}

async function findFirstFile(dir, predicate) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFirstFile(full, predicate);
      if (nested) return nested;
    } else if (predicate(full)) {
      return full;
    }
  }
  return null;
}

async function assertContextManifest(label, result, expectedKind, expectedSnippets = []) {
  assertNoBehaviorContractErrors(label, validateFetchPayloadContract(result));
  expect(result.root, `${label}: root missing`);
  expect(result.manifest_file, `${label}: manifest_file missing`);
  expect(result.index_file, `${label}: index_file missing`);
  const manifest = JSON.parse(await readFile(result.manifest_file, "utf8"));
  assertNoBehaviorContractErrors(`${label} manifest`, validateFetchPayloadContract(manifest));
  expect(manifest.kind === expectedKind, `${label}: expected kind ${expectedKind}`);
  expect(manifest.counts, `${label}: counts missing`);
  expect(Array.isArray(manifest.generated_files), `${label}: generated_files missing`);
  for (const file of manifest.generated_files) {
    await readContextFile(label, result.root, file);
  }
  const recommendedReads = result.recommended_reads ?? [];
  expect(Array.isArray(recommendedReads), `${label}: recommended_reads missing`);
  expect(recommendedReads.length > 0, `${label}: recommended_reads empty`);
  const generated = new Set(manifest.generated_files);
  const recommendedContents = [];
  for (const file of recommendedReads) {
    expect(generated.has(file), `${label}: recommended read not generated: ${file}`);
    recommendedContents.push(await readContextFile(label, result.root, file));
  }
  const combined = recommendedContents.join("\n");
  for (const snippet of expectedSnippets) {
    expect(
      combined.includes(snippet),
      `${label}: recommended reads missing expected content ${JSON.stringify(snippet)}`,
    );
  }
  return manifest;
}

async function readContextFile(label, root, file) {
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  expect(
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative),
    `${label}: generated file escapes context root: ${file}`,
  );
  return readFile(absolute, "utf8");
}

async function setupTempAuth() {
  lebopHome = await mkdtemp(path.join(tmpdir(), "lebop-live-nox-"));
  report.temp_home = lebopHome;

  const tokenFromEnv = process.env.LEBOP_NOXOR_TOKEN?.trim();
  let token = tokenFromEnv;
  if (!token) {
    const tokenInvocation = resolveLebopInvocation([
      "--workspace",
      workspace,
      "auth",
      "token",
      workspace,
      "--unsafe",
    ]);
    const tokenResult = await runProc(tokenInvocation.command, tokenInvocation.args);
    if (tokenResult.code !== 0) {
      throw new Error(`could not read ${workspace} token from real auth\n${tokenResult.stderr}`);
    }
    token = tokenResult.stdout.trim();
  }
  const tokenFile = path.join(lebopHome, "token.txt");
  await writeFile(tokenFile, token, { mode: 0o600 });

  const loginInvocation = resolveLebopInvocation(["auth", "login", "--token-file", tokenFile]);
  const r = await runProc(loginInvocation.command, loginInvocation.args, {
    env: { LEBOP_HOME: lebopHome },
  });
  if (r.code !== 0) throw new Error(`auth login failed\n${r.stdout}\n${r.stderr}`);
  tempAuthReady = true;
  record("cli:auth login --token-file", "pass");

  await cli("auth list --json", ["auth", "list", "--json"], { json: true });
  await cli("auth default", ["auth", "default", workspace]);
  await cli("auth whoami --json", ["auth", "whoami", workspace, "--json"], { json: true });
  await cli("auth token masked", ["auth", "token", workspace]);
  await cli(
    "auth set-default-team --json",
    ["auth", "set-default-team", workspace, team, "--json"],
    {
      json: true,
    },
  );
}

class McpClient {
  constructor(env = {}) {
    const invocation = resolveLebopInvocation(["mcp"]);
    this.child = spawn(invocation.command, invocation.args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        LEBOP_HOME: lebopHome,
        LEBOP_WORKSPACE: workspace,
        LEBOP_TEAM: team,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buf = "";
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.protocolFailed = false;
    this.child.stderr.on("data", (d) => {
      this.stderr += d.toString();
    });
    this.child.stdout.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      let nl = this.buf.indexOf("\n");
      while (nl !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (line) {
          let msg;
          try {
            msg = parseMcpStdoutLine(line);
          } catch (err) {
            this.failProtocol(line, err);
            nl = this.buf.indexOf("\n");
            continue;
          }
          const waiter = this.pending.get(msg.id);
          if (waiter) {
            this.pending.delete(msg.id);
            clearTimeout(waiter.timer);
            if (msg.error) {
              waiter.reject(new Error(`MCP ${waiter.method} protocol error: ${msg.error.message}`));
            } else {
              waiter.resolve(msg.result);
            }
          }
        }
        nl = this.buf.indexOf("\n");
      }
    });
  }

  failProtocol(line, error) {
    if (this.protocolFailed) return;
    this.protocolFailed = true;
    const failure = buildMcpStdoutFailureResult(line, error);
    report.results.push(failure);
    console.log(`FAIL ${failure.name}`);
    const protocolError = new Error(failure.error);
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(protocolError);
    }
    this.pending.clear();
    this.child.kill("SIGTERM");
  }

  send(method, params = {}, options = {}) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    const label = options.label ?? method;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${label} timed out. stderr:\n${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, {
        method: label,
        timer,
        resolve,
        reject,
      });
    });
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async init() {
    const init = await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "lebop-live-nox-smoke", version: "0.0.1" },
    });
    this.notify("notifications/initialized");
    record("mcp:initialize", "pass", { protocolVersion: init.protocolVersion });
  }

  async listTools() {
    const out = await this.send("tools/list", {});
    const tools = out.tools ?? [];
    report.created.mcp_tools = tools.map((tool) => tool.name).sort();
    record("mcp:tools/list", "pass", { count: tools.length });
    return tools;
  }

  async call(name, args = {}, options = {}) {
    const toolArgs = MCP_NO_WORKSPACE_ARG.has(name) ? args : { workspace, ...args };
    const out = await this.send(
      "tools/call",
      { name, arguments: toolArgs },
      { label: `tools/call:${name}` },
    );
    const first = out.content?.[0]?.text ?? "";
    const parsed = first ? JSON.parse(first) : null;
    if (out.isError) {
      throw new Error(`MCP tool ${name} returned isError\n${first}`);
    }
    const semanticAssertions = options.assert ? await options.assert(parsed) : undefined;
    record(options.recordName ?? `mcp:${name}`, "pass", {
      tool: name,
      response_preview: first.slice(0, 500),
      ...(semanticAssertions ? { semantic_assertions: semanticAssertions } : {}),
    });
    return parsed;
  }

  async expectError(name, args = {}) {
    const toolArgs = MCP_NO_WORKSPACE_ARG.has(name) ? args : { workspace, ...args };
    const out = await this.send(
      "tools/call",
      { name, arguments: toolArgs },
      { label: `tools/call:${name}` },
    );
    const first = out.content?.[0]?.text ?? "";
    if (!out.isError) {
      throw new Error(`MCP tool ${name} unexpectedly succeeded\n${first}`);
    }
    record(`mcp:${name} expected error`, "pass", { response_preview: first.slice(0, 500) });
    return first ? JSON.parse(first) : null;
  }

  async close() {
    this.child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGTERM");
        resolve();
      }, 2000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function runCliSurface() {
  const teamInfo = await cli("team get --json", ["team", "get", team, "--json"], { json: true });
  const teamId = expect(teamInfo.team?.id, "team id missing");
  report.created.team_id = teamId;
  const viewer = await cli(
    "auth whoami --refresh --json",
    ["auth", "whoami", workspace, "--refresh", "--json"],
    {
      json: true,
    },
  );
  const email = viewer.viewer.email;
  report.created.viewer_email = email;

  await cli("teams --json", ["teams", "--json"], { json: true });
  await cli("team members --json", ["team", "members", team, "--json"], { json: true });
  await cli("team workflow-states --json", ["team", "workflow-states", team, "--json"], {
    json: true,
  });
  await cli("lookup state", ["lookup", "state", team, "Backlog", "--json"], { json: true });
  await cli("lookup user", ["lookup", "user", email, "--json"], { json: true });

  const labelName = `${prefix}-label`;
  const label = await cli(
    "label create --json",
    [
      "label",
      "create",
      labelName,
      "--team",
      team,
      "--color",
      "#4f46e5",
      "--description",
      "lebop live smoke label",
      "--json",
    ],
    {
      json: true,
      assert: (payload) => [
        ...requireFields(payload, ["label.id", "label.name"], "CLI label create"),
        "created label payload has id/name",
      ],
    },
  );
  report.created.cli_label = label.label.id;
  registerRemoteAudit("deleted_label", label.label.id, "CLI label");
  const doneCliLabelCleanup = registerCliCleanup("delete CLI label", [
    "label",
    "delete",
    label.label.id,
    "--yes",
    "--json",
  ]);
  await cli("label list --json", ["label", "list", "--team", team, "--json"], { json: true });
  await cli("label list --workspace-only --json", ["label", "list", "--workspace-only", "--json"], {
    json: true,
  });

  const project = await cli(
    "project create --json",
    [
      "project",
      "create",
      `${prefix}-project-cli`,
      "--team-id",
      teamId,
      "--description",
      "lebop live smoke project",
      "--content",
      "Initial project content",
      "--icon",
      "Rocket",
      "--state",
      "backlog",
      "--target-date",
      "2026-12-31",
      "--json",
    ],
    {
      json: true,
      assert: (payload) => [
        ...requireFields(
          payload,
          ["project.id", "project.name", "project.url"],
          "CLI project create",
        ),
        "created project payload has id/name/url",
      ],
    },
  );
  const projectId = project.project.id;
  report.created.cli_project = projectId;
  registerRemoteAudit("soft_deleted_project", projectId, "CLI project");
  const doneCliProjectCleanup = registerCliCleanup("delete CLI project", [
    "project",
    "delete",
    projectId,
    "--yes",
    "--json",
  ]);
  await cli("projects alias --json", ["projects", "--team", team, "--json"], { json: true });
  await cli("project list --json", ["project", "list", "--team", team, "--json"], { json: true });
  await cli("project view --json", ["project", "view", projectId, "--json"], { json: true });
  await cli(
    "project update --json",
    [
      "project",
      "update",
      projectId,
      "--name",
      `${prefix}-project-cli-updated`,
      "--description",
      "updated project description",
      "--content",
      "Updated project content",
      "--icon",
      "BarChart",
      "--state",
      "planned",
      "--start-date",
      "2026-06-04",
      "--target-date",
      "2026-12-30",
      "--json",
    ],
    {
      json: true,
      assert: (payload) => [
        ...requireFields(payload, ["project.id", "project.name"], "CLI project update"),
        "updated project payload has id/name",
      ],
    },
  );
  const cursorFixtureProject = await cli(
    "project create cursor fixture --json",
    [
      "project",
      "create",
      `${prefix}-project-cli-cursor-fixture`,
      "--team-id",
      teamId,
      "--description",
      "lebop live smoke cursor fixture project",
      "--content",
      "Cursor fixture project content",
      "--state",
      "backlog",
      "--json",
    ],
    {
      json: true,
      assert: (payload) => [
        ...requireFields(
          payload,
          ["project.id", "project.name", "project.url"],
          "CLI cursor fixture project create",
        ),
        "created cursor fixture project payload has id/name/url",
      ],
    },
  );
  const cursorFixtureProjectId = cursorFixtureProject.project.id;
  report.created.cli_cursor_project = cursorFixtureProjectId;
  registerRemoteAudit("soft_deleted_project", cursorFixtureProjectId, "CLI cursor fixture project");
  const doneCliCursorProjectCleanup = registerCliCleanup("delete CLI cursor fixture project", [
    "project",
    "delete",
    cursorFixtureProjectId,
    "--yes",
    "--json",
  ]);

  await cli(
    "project-update create --json",
    [
      "project-update",
      "create",
      projectId,
      "--body",
      "Project update from live CLI smoke",
      "--health",
      "onTrack",
      "--json",
    ],
    { json: true },
  );
  await cli("project-update list --json", ["project-update", "list", projectId, "--json"], {
    json: true,
  });

  const milestone = await cli(
    "milestone create --json",
    [
      "milestone",
      "create",
      `${prefix}-milestone-cli`,
      "--project-id",
      projectId,
      "--description",
      "live smoke milestone",
      "--target-date",
      "2026-10-01",
      "--sort-order",
      "1",
      "--json",
    ],
    {
      json: true,
      assert: (payload) => [
        ...requireFields(payload, ["milestone.id", "milestone.name"], "CLI milestone create"),
        "created milestone payload has id/name",
      ],
    },
  );
  const milestoneId = milestone.milestone.id;
  report.created.cli_milestone = milestoneId;
  registerRemoteAudit("deleted_milestone", milestoneId, "CLI milestone");
  const doneCliMilestoneCleanup = registerCliCleanup("delete CLI milestone", [
    "milestone",
    "delete",
    milestoneId,
    "--yes",
    "--json",
  ]);
  await cli("milestone list --json", ["milestone", "list", "--project", projectId, "--json"], {
    json: true,
  });
  await cli("milestone view --json", ["milestone", "view", milestoneId, "--json"], { json: true });
  await cli(
    "milestone update --json",
    [
      "milestone",
      "update",
      milestoneId,
      "--name",
      `${prefix}-milestone-cli-updated`,
      "--description",
      "updated milestone",
      "--target-date",
      "null",
      "--sort-order",
      "2",
      "--json",
    ],
    {
      json: true,
      assert: (payload) => [
        ...requireFields(payload, ["milestone.id", "milestone.name"], "CLI milestone update"),
        "updated milestone payload has id/name",
      ],
    },
  );

  const docContent = path.join(lebopHome, "doc-content.md");
  await writeFile(docContent, "Document content from file.\n");
  const doc = await cli(
    "document create --content-file --json",
    [
      "document",
      "create",
      `${prefix}-doc-cli`,
      "--project-id",
      projectId,
      "--content-file",
      docContent,
      "--icon",
      "BookOpen",
      "--json",
    ],
    { json: true },
  );
  const documentId = doc.document.id;
  report.created.cli_document = documentId;
  registerRemoteAudit("soft_deleted_document", documentId, "CLI document");
  const doneCliDocumentCleanup = registerCliCleanup("delete CLI document", [
    "document",
    "delete",
    documentId,
    "--yes",
    "--json",
  ]);
  await cli("document list --json", ["document", "list", "--project", projectId, "--json"], {
    json: true,
  });
  await cli("document view --json", ["document", "view", documentId, "--json"], { json: true });
  await cli(
    "document update --stdin --json",
    [
      "document",
      "update",
      documentId,
      "--title",
      `${prefix}-doc-cli-updated`,
      "--stdin",
      "--icon",
      "BookOpen",
      "--json",
    ],
    { json: true, stdin: "Updated document content from stdin.\n" },
  );
  await cliRetried(
    "workspace fetch document --json",
    [
      "workspace",
      "fetch",
      `/documents/${documentId}`,
      "--to",
      path.join(lebopHome, "context-cli-document"),
      "--json",
    ],
    {
      json: true,
      attempts: 4,
      retryDelayMs: 1_500,
      assert: async (payload) => {
        const assertions = assertFetchPayload(payload, "CLI document context fetch", "document");
        await assertContextManifest("cli document context", payload, "document", [
          `${prefix}-doc-cli-updated`,
          "Updated document content from stdin.",
        ]);
        return [...assertions, "document context contains updated title/content"];
      },
    },
  );

  const initiative = await cli(
    "initiative create --json",
    [
      "initiative",
      "create",
      `${prefix}-initiative-cli`,
      "--description",
      "live smoke initiative",
      "--target-date",
      "2026-12-31",
      "--color",
      "#10b981",
      "--icon",
      "Rocket",
      "--json",
    ],
    { json: true },
  );
  const initiativeId = initiative.initiative.id;
  report.created.cli_initiative = initiativeId;
  registerRemoteAudit("soft_deleted_initiative", initiativeId, "CLI initiative");
  const doneCliInitiativeCleanup = registerCliCleanup("delete CLI initiative", [
    "initiative",
    "delete",
    initiativeId,
    "--yes",
    "--json",
  ]);
  await cli("initiative list --json", ["initiative", "list", "--json"], { json: true });
  await cli("initiative view --json", ["initiative", "view", initiativeId, "--json"], {
    json: true,
  });
  await cli(
    "initiative update --json",
    [
      "initiative",
      "update",
      initiativeId,
      "--description",
      "updated initiative",
      "--target-date",
      "null",
      "--color",
      "#0ea5e9",
      "--icon",
      "Rocket",
      "--json",
    ],
    { json: true },
  );
  await cli(
    "initiative add-project --json",
    ["initiative", "add-project", initiativeId, projectId, "--sort-order", "1", "--json"],
    { json: true },
  );
  await cli(
    "initiative-update create --json",
    [
      "initiative-update",
      "create",
      initiativeId,
      "--body",
      "Initiative update from live CLI smoke",
      "--health",
      "atRisk",
      "--json",
    ],
    { json: true },
  );
  await cli(
    "initiative-update list --json",
    ["initiative-update", "list", initiativeId, "--json"],
    {
      json: true,
    },
  );
  await cli("workspace explore root --json", ["workspace", "explore", "/", "--json"], {
    json: true,
  });
  const cliProjectsPage1 = await cli(
    "workspace explore projects cursor page 1 --json",
    ["workspace", "explore", "/projects", "--limit", "1", "--json"],
    {
      json: true,
      assert: (payload) => assertProjectCursorPage1(payload, "CLI project cursor page 1"),
    },
  );
  await cli(
    "workspace explore projects cursor page 2 --json",
    [
      "workspace",
      "explore",
      "/projects",
      "--limit",
      "1",
      "--cursor",
      cliProjectsPage1.next_cursor,
      "--json",
    ],
    {
      json: true,
      assert: (payload) =>
        assertProjectCursorPage2(payload, "CLI project cursor page 2", cliProjectsPage1),
    },
  );
  await cli(
    "project delete cursor fixture --json",
    ["project", "delete", cursorFixtureProjectId, "--yes", "--json"],
    {
      json: true,
      assert: (payload) =>
        assertDeletePayload(payload, "CLI cursor fixture project delete", cursorFixtureProjectId),
    },
  );
  doneCliCursorProjectCleanup();
  await cli(
    "workspace explore project search --json",
    ["workspace", "explore", "/", "--query", prefix, "--kind", "project", "--limit", "5", "--json"],
    {
      json: true,
      assert: (payload) =>
        assertExploreSearchContains(payload, "CLI project search", {
          kind: "project",
          id: projectId,
          name: `${prefix}-project-cli-updated`,
        }),
    },
  );
  await cli(
    "workspace explore initiative search --json",
    [
      "workspace",
      "explore",
      "/",
      "--query",
      prefix,
      "--kind",
      "initiative",
      "--limit",
      "5",
      "--json",
    ],
    {
      json: true,
      assert: (payload) =>
        assertExploreSearchContains(payload, "CLI initiative search", {
          kind: "initiative",
          id: initiativeId,
          name: `${prefix}-initiative-cli`,
        }),
    },
  );
  await cli(
    "workspace explore initiative --json",
    ["workspace", "explore", `/initiatives/${initiativeId}`, "--json"],
    {
      json: true,
    },
  );
  const cliInitiativeContext = await cli(
    "workspace fetch initiative --json",
    [
      "workspace",
      "fetch",
      `/initiatives/${initiativeId}`,
      "--to",
      path.join(lebopHome, "context-cli-initiative"),
      "--json",
    ],
    { json: true },
  );
  await assertContextManifest("cli initiative context", cliInitiativeContext, "initiative", [
    `${prefix}-initiative-cli`,
    "updated initiative",
    `${prefix}-project-cli-updated`,
  ]);
  await cli(
    "initiative remove-project --json",
    ["initiative", "remove-project", initiativeId, projectId, "--yes", "--json"],
    { json: true },
  );
  await cli(
    "initiative archive --json",
    ["initiative", "archive", initiativeId, "--yes", "--json"],
    {
      json: true,
    },
  );
  await cli("initiative unarchive --json", ["initiative", "unarchive", initiativeId, "--json"], {
    json: true,
  });

  const descFile = path.join(lebopHome, "issue-description.md");
  await writeFile(descFile, "CLI issue description from file.\n");
  const issue1 = await cli(
    "new --description-file --json",
    [
      "new",
      "--team",
      team,
      "--title",
      `${prefix}-issue-cli-primary`,
      "--project-id",
      projectId,
      "--state",
      "Backlog",
      "--priority",
      "normal",
      "--label",
      labelName,
      "--assignee",
      email,
      "--description-file",
      descFile,
      "--json",
    ],
    {
      json: true,
      assert: (payload) => [
        ...requireFields(
          payload,
          ["issue.id", "issue.identifier", "issue.title"],
          "CLI issue create",
        ),
        "created issue payload has id/identifier/title",
      ],
    },
  );
  const issueId1 = issue1.issue.identifier;
  const issueUuid1 = issue1.issue.id;
  report.created.cli_issue_primary = issueId1;
  registerRemoteAudit("archived_issue", issueId1, "CLI primary issue");
  const doneCliPrimaryIssueCleanup = registerCliCleanup("archive CLI primary issue", [
    "archive",
    issueId1,
    "--yes",
    "--json",
  ]);
  const cliIssueDocumentTitle = `${prefix}-issue-doc-cli`;
  const cliIssueDocumentContent = `CLI issue-scoped document content ${stamp}.`;
  const cliIssueDocument = await createIssueDocumentFixtureViaCli(
    issueUuid1,
    cliIssueDocumentTitle,
    cliIssueDocumentContent,
  );
  const cliIssueDocumentId = cliIssueDocument.id;
  report.created.cli_issue_document = cliIssueDocumentId;
  registerRemoteAudit("soft_deleted_document", cliIssueDocumentId, "CLI issue document");
  const doneCliIssueDocumentCleanup = registerCliCleanup("delete CLI issue document", [
    "document",
    "delete",
    cliIssueDocumentId,
    "--yes",
    "--json",
  ]);

  const issue2 = await cli(
    "new --stdin --json",
    [
      "new",
      "--team",
      team,
      "--title",
      `${prefix}-issue-cli-secondary`,
      "--project",
      `${prefix}-project-cli-updated`,
      "--state",
      "Backlog",
      "--priority",
      "low",
      "--stdin",
      "--json",
    ],
    { json: true, stdin: "Secondary issue description from stdin.\n" },
  );
  const issueId2 = issue2.issue.identifier;
  report.created.cli_issue_secondary = issueId2;
  registerRemoteAudit("archived_issue", issueId2, "CLI secondary issue");
  const doneCliSecondaryIssueCleanup = registerCliCleanup("archive CLI secondary issue", [
    "archive",
    issueId2,
    "--yes",
    "--json",
  ]);

  await cli(
    "list --json",
    ["list", "--team", team, "--search", prefix, "--limit", "10", "--json"],
    {
      json: true,
    },
  );
  await cli("mine --json", ["mine", "--team", team, "--all-states", "--limit", "10", "--json"], {
    json: true,
  });
  await cli("show --json", ["show", issueId1, "--json"], { json: true });

  await cli(
    "set title --json",
    ["set", "title", issueId1, `${prefix}-issue-cli-primary-updated`, "--json"],
    {
      json: true,
    },
  );
  await cli("set state --json", ["set", "state", issueId1, "Todo", "--json"], { json: true });
  await cli("set priority --json", ["set", "priority", issueId1, "high", "--json"], { json: true });
  await cli("set estimate --json", ["set", "estimate", issueId1, "3", "--json"], { json: true });
  await cli("set assignee --json", ["set", "assignee", issueId1, "@me", "--json"], { json: true });
  const cliSetDescriptionMarker = `CLI set description marker ${stamp}.`;
  await cli(
    "set description --json",
    ["set", "description", issueId1, "--description", cliSetDescriptionMarker, "--json"],
    {
      json: true,
      assert: async () => [
        await assertRemoteIssueDescriptionContains(
          issueId1,
          cliSetDescriptionMarker,
          "CLI set description",
          FIELD_UPDATE_PROOF_LABELS["cli:set description --json"][0],
        ),
      ],
    },
  );
  await cli("set project --json", ["set", "project", issueId1, cursorFixtureProjectId, "--json"], {
    json: true,
    assert: async () =>
      assertRemoteIssueUpdateState(
        issueId1,
        {
          projectId: cursorFixtureProjectId,
          proofs: FIELD_UPDATE_PROOF_LABELS["cli:set project --json"],
        },
        "CLI set project",
      ),
  });
  await cli("set project restore --json", ["set", "project", issueId1, projectId, "--json"], {
    json: true,
  });
  await cli("set milestone --json", ["set", "milestone", issueId1, milestoneId, "--json"], {
    json: true,
    assert: async () =>
      assertRemoteIssueUpdateState(
        issueId1,
        {
          milestoneId,
          proofs: FIELD_UPDATE_PROOF_LABELS["cli:set milestone --json"],
        },
        "CLI set milestone",
      ),
  });
  await cli("set cycle --json", ["set", "cycle", issueId1, "null", "--json"], {
    json: true,
    assert: async () =>
      assertRemoteIssueUpdateState(
        issueId1,
        {
          cycleId: null,
          proofs: FIELD_UPDATE_PROOF_LABELS["cli:set cycle --json"],
        },
        "CLI set cycle",
      ),
  });
  await cli("set labels exact --json", ["set", "labels", issueId1, `=${labelName}`, "--json"], {
    json: true,
  });
  await cli("set parent --json", ["set", "parent", issueId1, issueId2, "--json"], { json: true });
  await cli("set parent clear --json", ["set", "parent", issueId1, "null", "--json"], {
    json: true,
  });
  await cli("set links add --json", ["set", "links", issueId1, `+related:${issueId2}`, "--json"], {
    json: true,
  });
  await cli(
    "set links remove --json",
    ["set", "links", issueId1, "--yes", "--json", `-related:${issueId2}`],
    {
      json: true,
    },
  );

  await cli(
    "relation add/list/delete --json",
    ["relation", "add", issueId1, "blocks", issueId2, "--yes", "--json"],
    {
      json: true,
    },
  );
  await cli("relation list --json", ["relation", "list", issueId1, "--json"], { json: true });
  await cli(
    "relation delete --json",
    ["relation", "delete", issueId1, "blocks", issueId2, "--yes", "--json"],
    {
      json: true,
    },
  );

  const c1 = await cli(
    "comment add --json",
    ["comment", "add", issueId1, "--body", "CLI smoke comment", "--json"],
    {
      json: true,
    },
  );
  const commentId = c1.comment.id;
  const doneCliCommentCleanup = registerCliCleanup("delete CLI comment", [
    "comment",
    "delete",
    commentId,
    "--yes",
    "--json",
  ]);
  const c2 = await cli(
    "comment add reply --json",
    ["comment", "add", issueId1, "--body", "CLI smoke reply", "--parent", commentId, "--json"],
    { json: true },
  );
  const doneCliReplyCleanup = registerCliCleanup("delete CLI reply comment", [
    "comment",
    "delete",
    c2.comment.id,
    "--yes",
    "--json",
  ]);
  await cli("comment list --json", ["comment", "list", issueId1, "--json"], { json: true });
  await cli(
    "comment update --json",
    ["comment", "update", commentId, "--body", "Updated CLI smoke comment", "--json"],
    {
      json: true,
    },
  );
  await cli(
    "comment delete reply --json",
    ["comment", "delete", c2.comment.id, "--yes", "--json"],
    {
      json: true,
    },
  );
  registerRemoteAudit("deleted_comment", c2.comment.id, "CLI reply comment");
  doneCliReplyCleanup();
  await cli("comment delete --json", ["comment", "delete", commentId, "--yes", "--json"], {
    json: true,
  });
  registerRemoteAudit("deleted_comment", commentId, "CLI comment");
  doneCliCommentCleanup();

  const attachment = await cli(
    "link --json",
    [
      "link",
      issueId1,
      "https://example.com/lebop-live-smoke",
      "--title",
      "CLI smoke link",
      "--json",
    ],
    { json: true },
  );
  const attachmentId = attachment.attachment.id;
  const doneCliAttachmentCleanup = registerCliCleanup("delete CLI attachment", [
    "attachment",
    "delete",
    attachmentId,
    "--yes",
    "--json",
  ]);
  await cli("attachment list --json", ["attachment", "list", issueId1, "--json"], { json: true });
  await cli(
    "attachment update --json",
    ["attachment", "update", attachmentId, "--title", "CLI smoke link updated", "--json"],
    { json: true },
  );
  await cliExpectFail("attachment update url unsupported --json", [
    "attachment",
    "update",
    attachmentId,
    "--url",
    "https://example.com/lebop-live-smoke-updated",
    "--json",
  ]);
  await cli(
    "workspace explore issue --json",
    ["workspace", "explore", `/issues/${issueId1}`, "--json"],
    {
      json: true,
    },
  );
  await cli(
    "workspace explore issue documents --json",
    ["workspace", "explore", `/issues/${issueId1}/documents`, "--json"],
    {
      json: true,
      assert: (payload) => [
        ...assertExplorePayload(
          payload,
          "CLI issue document explore",
          `/issues/${issueId1}/documents`,
        ),
        "issue document child path explored",
      ],
    },
  );
  const cliIssueContext = await cli(
    "workspace fetch issue --json",
    [
      "workspace",
      "fetch",
      `/issues/${issueId1}`,
      "--to",
      path.join(lebopHome, "context-cli-issue"),
      "--json",
    ],
    {
      json: true,
      assert: async (payload) => [
        ...assertFetchPayload(payload, "CLI issue context fetch", "issue"),
        ...(await assertIssueDocumentFetch(payload, "CLI issue context fetch", issueId1, [
          cliIssueDocumentTitle,
          cliIssueDocumentContent,
        ])),
      ],
    },
  );
  const cliIssueDocumentsContext = await cli(
    "workspace fetch issue documents --json",
    [
      "workspace",
      "fetch",
      `/issues/${issueId1}/documents`,
      "--to",
      path.join(lebopHome, "context-cli-issue-documents"),
      "--json",
    ],
    {
      json: true,
      assert: async (payload) => [
        ...assertFetchPayload(payload, "CLI issue document context fetch", "issue"),
        ...(await assertIssueDocumentFetch(payload, "CLI issue document context fetch", issueId1, [
          cliIssueDocumentTitle,
          cliIssueDocumentContent,
        ])),
      ],
    },
  );
  const cliIssueAgentSessionsContext = await cli(
    "workspace fetch issue agent-sessions --json",
    [
      "workspace",
      "fetch",
      `/issues/${issueId1}/agent-sessions`,
      "--to",
      path.join(lebopHome, "context-cli-issue-agent-sessions"),
      "--json",
    ],
    {
      json: true,
      assert: async (payload) => [
        ...assertFetchPayload(payload, "CLI issue agent-session context fetch", "issue"),
        ...(await assertIssueAgentSessionChildFetch(
          payload,
          "CLI issue agent-session context fetch",
          issueId1,
        )),
      ],
    },
  );
  expect(
    cliIssueAgentSessionsContext.root,
    "CLI issue agent-session context fetch did not return a root",
  );
  await assertContextManifest("cli issue context", cliIssueContext, "issue", [
    issueId1,
    `${prefix}-issue-cli-primary-updated`,
    cliSetDescriptionMarker,
    "CLI smoke link updated",
    cliIssueDocumentTitle,
    cliIssueDocumentContent,
  ]);
  await assertContextManifest("cli issue document context", cliIssueDocumentsContext, "issue", [
    cliIssueDocumentTitle,
    cliIssueDocumentContent,
  ]);
  await cli("attachment delete --json", ["attachment", "delete", attachmentId, "--yes", "--json"], {
    json: true,
  });
  registerRemoteAudit("deleted_attachment", attachmentId, "CLI attachment");
  doneCliAttachmentCleanup();

  await cli(
    "bulk update --json",
    [
      "bulk",
      "update",
      issueId1,
      issueId2,
      "--state",
      "Backlog",
      "--priority",
      "low",
      "--label",
      labelName,
      "--assignee",
      "@me",
      "--estimate",
      "1",
      "--project",
      `${prefix}-project-cli-updated`,
      "--milestone",
      `${prefix}-milestone-cli-updated`,
      "--yes",
      "--json",
    ],
    {
      json: true,
      assert: (payload) =>
        assertBulkUpdatePayload(payload, "CLI bulk update", {
          identifiers: [issueId1, issueId2],
          fields: ["state", "priority", "labels", "assignee", "estimate", "project", "milestone"],
        }),
    },
  );
  const cliMilestoneIssues = await cli(
    "workspace explore milestone issues --json",
    ["workspace", "explore", `/milestones/${milestoneId}/issues`, "--limit", "10", "--json"],
    {
      json: true,
      assert: (payload) =>
        assertExplorePayload(
          payload,
          "CLI milestone issues explore",
          `/milestones/${milestoneId}/issues`,
        ),
    },
  );
  expect(
    cliMilestoneIssues.items.some(
      (item) => item.identifier === issueId1 || item.identifier === issueId2,
    ),
    "milestone issue explore did not include a deterministic live issue fixture",
  );
  const cliMilestoneContext = await cli(
    "workspace fetch milestone --json",
    [
      "workspace",
      "fetch",
      `/milestones/${milestoneId}`,
      "--to",
      path.join(lebopHome, "context-cli-milestone"),
      "--json",
    ],
    {
      json: true,
      assert: (payload) => assertFetchPayload(payload, "CLI milestone context fetch", "milestone"),
    },
  );
  await assertContextManifest("cli milestone context", cliMilestoneContext, "milestone", [
    `${prefix}-milestone-cli-updated`,
    issueId1,
  ]);

  await cli("archive/unarchive issue --json", ["archive", issueId2, "--yes", "--json"], {
    json: true,
  });
  await cli("unarchive issue --json", ["unarchive", issueId2, "--json"], { json: true });

  await cli("pull issue --json", ["pull", issueId1, "--refresh", "--yes", "--json"], {
    json: true,
  });
  await cli("status --json", ["status", "--json"], { json: true });
  await cli("cache status --json", ["cache", "status", "--json"], { json: true });
  await cli("cache gc dry-run --json", ["cache", "gc", "--json"], { json: true });
  const issueMd = await findFirstFile(path.join(lebopHome, "cache"), (p) =>
    p.endsWith(`${issueId1}/description.md`),
  );
  expect(issueMd, "pulled issue description file not found");
  await writeFile(issueMd, `${await readFile(issueMd, "utf8")}\nCLI cache push marker ${stamp}.\n`);
  await cli("diff issue --json", ["diff", issueId1, "--json"], {
    json: true,
    allowExitCodes: [0, 1],
  });
  const cliDirectPushMarker = `CLI direct cache push marker ${stamp}.`;
  await writeFile(issueMd, `${await readFile(issueMd, "utf8")}\n${cliDirectPushMarker}\n`);
  await cli("push issue --json", ["push", issueId1, "--json"], {
    json: true,
    assert: async (payload) => [
      ...assertCachePushPayload(payload, "CLI direct issue cache push", {
        kind: "issue",
        target: issueId1,
        fields: ["description"],
      }),
      await assertRemoteIssueDescriptionContains(
        issueId1,
        cliDirectPushMarker,
        "CLI direct issue cache push",
      ),
    ],
  });
  await writeFile(
    issueMd,
    `${await readFile(issueMd, "utf8")}\nCLI cache publish marker ${stamp}.\n`,
  );
  const cliCacheIssueReview = await cli(
    "publish review cache issue --json",
    ["publish", "review", "--cache", issueId1, "--json"],
    {
      json: true,
      allowExitCodes: [0, 1],
      assert: (payload) => assertPublishReviewPayload(payload, "CLI cache issue publish review"),
    },
  );
  expect(cliCacheIssueReview.review_id, "cache issue review did not return review_id");
  await cli(
    "publish apply cache issue --json",
    ["publish", "apply", cliCacheIssueReview.review_id, "--json"],
    {
      json: true,
      assert: (payload) => assertPublishApplyPayload(payload, "CLI cache issue publish apply"),
    },
  );

  await cli(
    "pull project --json",
    ["pull", "--project-id", projectId, "--refresh", "--yes", "--json"],
    {
      json: true,
    },
  );
  await cli(
    "workspace explore project --json",
    ["workspace", "explore", `/projects/${projectId}`, "--json"],
    {
      json: true,
    },
  );
  await cli(
    "workspace explore project issues --json",
    ["workspace", "explore", `/projects/${projectId}/issues`, "--json"],
    { json: true },
  );
  const cliProjectContext = await cli(
    "workspace fetch project --json",
    [
      "workspace",
      "fetch",
      `/projects/${projectId}`,
      "--to",
      path.join(lebopHome, "context-cli-project"),
      "--json",
    ],
    { json: true },
  );
  await assertContextManifest("cli project context", cliProjectContext, "project", [
    `${prefix}-project-cli-updated`,
    "Updated project content",
    issueId1,
    `${prefix}-doc-cli-updated`,
  ]);
  await assertAggregateIssueDocumentFetch(
    cliProjectContext,
    "CLI project context fetch",
    issueId1,
    [cliIssueDocumentTitle, cliIssueDocumentContent],
  );
  await cli(
    "document delete issue document fixture --json",
    ["document", "delete", cliIssueDocumentId, "--yes", "--json"],
    {
      json: true,
      assert: (payload) =>
        assertDeletePayload(payload, "CLI issue document fixture delete", cliIssueDocumentId),
    },
  );
  doneCliIssueDocumentCleanup();
  const projectContent = await findFirstFile(
    path.join(lebopHome, "cache"),
    (p) => p.includes(`/projects/${projectId}/`) && p.endsWith("content.md"),
  );
  expect(projectContent, "pulled project content.md not found");
  await writeFile(
    projectContent,
    `${await readFile(projectContent, "utf8")}\n\nCLI project cache push marker ${stamp}.\n`,
  );
  const cliCacheProjectReview = await cli(
    "publish review cache project --json",
    ["publish", "review", "--cache", "--project-id", projectId, "--json"],
    {
      json: true,
      allowExitCodes: [0, 1],
      assert: (payload) => assertPublishReviewPayload(payload, "CLI cache project publish review"),
    },
  );
  expect(cliCacheProjectReview.review_id, "cache project review did not return review_id");
  await cli(
    "publish apply cache project --json",
    ["publish", "apply", cliCacheProjectReview.review_id, "--json"],
    {
      json: true,
      assert: (payload) => assertPublishApplyPayload(payload, "CLI cache project publish apply"),
    },
  );

  const exportDir = path.join(lebopHome, "export");
  await cli(
    "pull --to export --json",
    ["pull", issueId1, "--to", exportDir, "--refresh", "--yes", "--json"],
    {
      json: true,
    },
  );

  const planDir = path.join(lebopHome, "plan");
  await writeFile(
    path.join(lebopHome, "lint.md"),
    "# Lint\n\nA bare Linear issue: https://linear.app/noxor/issue/NOX-50/test\n",
  );
  await cli("lint --json", ["lint", path.join(lebopHome, "lint.md"), "--json"], { json: true });
  await cli("completions bash", ["completions", "bash"]);
  await cli("schema --json", ["schema", "--json"], { json: true });
  await raw("query { viewer { id email name } organization { id urlKey name } }");
  await writeFile(path.join(lebopHome, "raw.graphql"), "query { viewer { id email name } }");
  await cli("raw query-file", ["raw", "--query-file", path.join(lebopHome, "raw.graphql")], {
    json: true,
  });

  const donePlanCliCleanup = await runPlanCli(planDir, labelName);
  await cleanupPlanCli(planDir);
  donePlanCliCleanup();
  await runPublishCli(labelName);

  const cycles = await cli("cycle list --json", ["cycle", "list", "--team", team, "--json"], {
    json: true,
  });
  const cycleFixture = cycles.cycles?.[0];
  if (cycleFixture?.id) {
    await cli("cycle view --json", ["cycle", "view", cycleFixture.id, "--json"], {
      json: true,
    });
    await cli(
      "workspace explore cycle issues --json",
      ["workspace", "explore", `/cycles/${cycleFixture.id}/issues`, "--json"],
      {
        json: true,
        assert: (payload) =>
          assertExplorePayload(
            payload,
            "CLI cycle issue explore",
            `/cycles/${cycleFixture.id}/issues`,
          ),
      },
    );
    const cliCycleContext = await cli(
      "workspace fetch cycle --json",
      [
        "workspace",
        "fetch",
        `/cycles/${cycleFixture.id}`,
        "--to",
        path.join(lebopHome, "context-cli-cycle"),
        "--json",
      ],
      {
        json: true,
        assert: (payload) => assertFetchPayload(payload, "CLI cycle context fetch", "cycle"),
      },
    );
    await assertContextManifest("cli cycle context", cliCycleContext, "cycle", [
      cycleFixture.name ?? cycleFixture.id,
    ]);
  } else {
    record("cli:cycle view --json", "gap", {
      reason: "NOX currently has no cycles, so cycle view has no valid UUID fixture.",
    });
    record("cli:workspace explore cycle issues --json", "gap", {
      reason: "NOX currently has no cycles, so cycle issue exploration has no valid fixture.",
    });
    record("cli:workspace fetch cycle --json", "gap", {
      reason: "NOX currently has no cycles, so cycle workspace fetch has no valid fixture.",
    });
  }

  const sessions = await cli(
    "agent-session list --json",
    ["agent-session", "list", "--limit", "1", "--json"],
    {
      json: true,
    },
  );
  const agentSessionFixture = sessions.agent_sessions?.[0];
  if (agentSessionFixture?.id) {
    await cli(
      "agent-session view --json",
      ["agent-session", "view", agentSessionFixture.id, "--json"],
      { json: true },
    );
    const cliAgentSessionContext = await cli(
      "workspace fetch agent-session --json",
      [
        "workspace",
        "fetch",
        `/agent-sessions/${agentSessionFixture.id}`,
        "--to",
        path.join(lebopHome, "context-cli-agent-session"),
        "--json",
      ],
      {
        json: true,
        assert: (payload) =>
          assertFetchPayload(payload, "CLI agent-session context fetch", "agent_session"),
      },
    );
    await assertContextManifest(
      "cli agent-session context",
      cliAgentSessionContext,
      "agent_session",
      [agentSessionFixture.id],
    );
  } else {
    record("cli:agent-session view --json", "gap", {
      reason: "No agent sessions returned by NOX.",
    });
    record("cli:workspace fetch agent-session --json", "gap", {
      reason: "No agent sessions returned by NOX.",
    });
  }

  await cliRetried("archive issue final --json", ["archive", issueId2, "--yes", "--json"], {
    json: true,
    assert: (payload) => assertLifecyclePayload(payload, "CLI secondary issue archive", [issueId2]),
  });
  doneCliSecondaryIssueCleanup();
  await cliRetried(
    "archive primary evidence issue --json",
    ["archive", issueId1, "--yes", "--json"],
    {
      json: true,
      assert: (payload) => assertLifecyclePayload(payload, "CLI primary issue archive", [issueId1]),
    },
  );
  doneCliPrimaryIssueCleanup();
  await cli("document delete --json", ["document", "delete", documentId, "--yes", "--json"], {
    json: true,
    assert: (payload) => assertDeletePayload(payload, "CLI document delete", documentId),
  });
  doneCliDocumentCleanup();
  await cli("milestone delete --json", ["milestone", "delete", milestoneId, "--yes", "--json"], {
    json: true,
    assert: (payload) => assertDeletePayload(payload, "CLI milestone delete", milestoneId),
  });
  doneCliMilestoneCleanup();
  await cli("initiative delete --json", ["initiative", "delete", initiativeId, "--yes", "--json"], {
    json: true,
    assert: (payload) => assertDeletePayload(payload, "CLI initiative delete", initiativeId),
  });
  doneCliInitiativeCleanup();
  await cli("label delete --json", ["label", "delete", label.label.id, "--yes", "--json"], {
    json: true,
    assert: (payload) => assertDeletePayload(payload, "CLI label delete", label.label.id),
  });
  doneCliLabelCleanup();
  await cli("project delete --json", ["project", "delete", projectId, "--yes", "--json"], {
    json: true,
    assert: (payload) => assertDeletePayload(payload, "CLI project delete", projectId),
  });
  doneCliProjectCleanup();

  report.evidence_issue = { id: issueUuid1, identifier: issueId1 };
  return { teamId, email, evidenceIdentifier: issueId1 };
}

async function runPlanCli(planDir, labelName) {
  await mkdir(planDir, { recursive: true });
  await writeFile(
    path.join(planDir, "_project.md"),
    `---\nname: "${prefix}-plan-cli"\ndescription: "live smoke plan"\nstate: backlog\nteam: ${team}\nicon: Rocket\n---\n\nPlan project body.\n`,
  );
  await writeFile(
    path.join(planDir, "01-one.md"),
    `---\ntitle: "${prefix}-plan-cli-one"\nstate: Backlog\npriority: normal\nestimate: 1\nlabels: [${labelName}]\nblocks: [02-two]\n---\n\nPlan issue one body.\n`,
  );
  await writeFile(
    path.join(planDir, "02-two.md"),
    `---\ntitle: "${prefix}-plan-cli-two"\nstate: Backlog\npriority: low\nestimate: 1\nlabels: [${labelName}]\nparent: 01-one\n---\n\nPlan issue two body.\n`,
  );
  await cli("plan validate --json", ["plan", "validate", planDir, "--team", team, "--json"], {
    json: true,
  });
  await cli("plan lint --json", ["plan", "lint", planDir, "--json"], { json: true });
  await cli("plan apply dry-run --json", ["plan", "apply", planDir, "--dry-run", "--json"], {
    json: true,
  });
  const donePlanCleanup = registerPlanDirCleanup("CLI plan", planDir);
  await cli("plan apply --json", ["plan", "apply", planDir, "--json"], { json: true });
  await cli("plan diff --json", ["plan", "diff", planDir, "--json"], { json: true });
  await cli("plan pull --json", ["plan", "pull", planDir, "--force", "--yes", "--json"], {
    json: true,
  });
  return donePlanCleanup;
}

async function cleanupPlanCli(planDir) {
  const { projectId, issueIds } = await readPlanDirLinearIds(planDir);
  if (issueIds.length > 0) {
    for (const issueId of issueIds) {
      registerRemoteAudit("archived_issue", issueId, `CLI plan issue ${issueId}`);
      await cliRetried(
        `plan cleanup archive issue ${issueId} --json`,
        ["archive", issueId, "--yes", "--json"],
        {
          json: true,
          assert: (payload) =>
            assertLifecyclePayload(payload, `CLI plan issue ${issueId} archive`, [issueId]),
        },
      );
    }
  }
  if (projectId) {
    registerRemoteAudit("soft_deleted_project", projectId, "CLI plan project");
    await cli(
      "plan cleanup delete project --json",
      ["project", "delete", projectId, "--yes", "--json"],
      {
        json: true,
        assert: (payload) => assertDeletePayload(payload, "CLI plan project delete", projectId),
      },
    );
  }
}

async function readPlanDirLinearIds(planDir) {
  const projectRaw = await readFile(path.join(planDir, "_project.md"), "utf8").catch(() => "");
  const projectId = projectRaw.match(/linear_id:\s*([0-9a-f-]{36})/i)?.[1];
  const issueIds = [];
  for (const file of await readdir(planDir).catch(() => [])) {
    if (!file.endsWith(".md") || file === "_project.md") continue;
    const raw = await readFile(path.join(planDir, file), "utf8").catch(() => "");
    const id = raw.match(/linear_id:\s*([A-Z]+-\d+)/)?.[1];
    if (id) issueIds.push(id);
  }
  return { projectId, issueIds };
}

async function cleanupPlanDirWithCli(name, planDir) {
  const { projectId, issueIds } = await readPlanDirLinearIds(planDir);
  if (issueIds.length > 0) {
    for (const issueId of issueIds) {
      registerRemoteAudit("archived_issue", issueId, `${name} issue ${issueId}`);
      await cliCleanupRetried(`${name} archive issue ${issueId}`, [
        "archive",
        issueId,
        "--yes",
        "--json",
      ]);
    }
  }
  if (projectId) {
    registerRemoteAudit("soft_deleted_project", projectId, `${name} project`);
    await cliCleanupRetried(`${name} delete project`, [
      "project",
      "delete",
      projectId,
      "--yes",
      "--json",
    ]);
  }
}

function registerPlanDirCleanup(name, planDir) {
  return registerCleanup(name, () => cleanupPlanDirWithCli(name, planDir));
}

async function runPublishCli(labelName) {
  const planDir = path.join(lebopHome, "publish-cli");
  await mkdir(planDir, { recursive: true });
  await writeFile(
    path.join(planDir, "_project.md"),
    `---\nname: "${prefix}-publish-cli"\ndescription: "live publish review cli"\nstate: backlog\nteam: ${team}\nicon: Rocket\n---\n\nCLI publish project body.\n`,
  );
  await writeFile(
    path.join(planDir, "01-one.md"),
    `---\ntitle: "${prefix}-publish-cli-one"\nstate: Backlog\npriority: normal\nlabels: [${labelName}]\n---\n\nCLI publish issue body.\n`,
  );
  const review = await cli(
    "publish review --plan --json",
    ["publish", "review", "--plan", planDir, "--team", team, "--json"],
    {
      json: true,
      assert: (payload) => assertPublishReviewPayload(payload, "CLI plan publish review"),
    },
  );
  expect(review.review_id, "CLI publish review_id missing");
  const donePublishCleanup = registerPlanDirCleanup("CLI publish plan", planDir);
  await cli("publish apply --json", ["publish", "apply", review.review_id, "--json"], {
    json: true,
    assert: (payload) => assertPublishApplyPayload(payload, "CLI plan publish apply"),
  });
  const projectRaw = await readFile(path.join(planDir, "_project.md"), "utf8");
  const projectId = projectRaw.match(/linear_id:\s*([0-9a-f-]{36})/i)?.[1];
  const issueRaw = await readFile(path.join(planDir, "01-one.md"), "utf8");
  const issueId = issueRaw.match(/linear_id:\s*([A-Z]+-\d+)/)?.[1];
  if (issueId) {
    registerRemoteAudit("archived_issue", issueId, `CLI publish issue ${issueId}`);
    await cliRetried(
      "publish cleanup archive issue --json",
      ["archive", issueId, "--yes", "--json"],
      {
        json: true,
        assert: (payload) =>
          assertLifecyclePayload(payload, `CLI publish issue ${issueId} archive`, [issueId]),
      },
    );
  }
  if (projectId) {
    registerRemoteAudit("soft_deleted_project", projectId, "CLI publish project");
    await cli(
      "publish cleanup delete project --json",
      ["project", "delete", projectId, "--yes", "--json"],
      {
        json: true,
        assert: (payload) => assertDeletePayload(payload, "CLI publish project delete", projectId),
      },
    );
  }
  donePublishCleanup();
}

async function runMcpSurface(context) {
  mcp = new McpClient();
  await mcp.init();
  const tools = await mcp.listTools();
  report.created.mcp_tool_count = tools.length;

  await mcp.call("list_workspaces", {});
  await mcp.call("whoami", {});
  await mcp.call("refresh_whoami", {
    for_workspace: workspace,
  });
  await mcp.call("set_default_workspace", { slug: workspace });
  await mcp.call("set_workspace_default_team", { workspace_slug: workspace, team });
  await mcp.call("list_teams", {});
  await mcp.call("get_team", { id: team });
  await mcp.call("list_team_members", { team });
  await mcp.call("list_workflow_states", { team });
  await mcp.call("lookup_state_by_name", { team, name: "Backlog" });
  await mcp.call("lookup_user_by_email", { email: context.email });

  const label = await mcp.call("create_label", {
    name: `${prefix}-label-mcp`,
    team_id: context.teamId,
    color: "#f97316",
    description: "lebop mcp live smoke label",
  });
  const labelId = label.label.id;
  registerRemoteAudit("deleted_label", labelId, "MCP label");
  const doneMcpLabelCleanup = registerCliCleanup("delete MCP label", [
    "label",
    "delete",
    labelId,
    "--yes",
    "--json",
  ]);
  await mcp.call("list_labels", { team });
  await mcp.call("lookup_label_by_name", { name: `${prefix}-label-mcp`, team });

  const project = await mcp.call("create_project", {
    name: `${prefix}-project-mcp`,
    team_ids: [context.teamId],
    description: "mcp smoke project",
    content: "MCP project content",
    icon: "Rocket",
    state: "backlog",
    target_date: "2026-12-31",
  });
  const projectId = project.project.id;
  report.created.mcp_project = projectId;
  registerRemoteAudit("soft_deleted_project", projectId, "MCP project");
  const doneMcpProjectCleanup = registerCliCleanup("delete MCP project", [
    "project",
    "delete",
    projectId,
    "--yes",
    "--json",
  ]);
  await mcp.call("list_projects", { team, limit: 10 });
  await mcp.call("get_project", { id: projectId });
  await mcp.call("update_project", {
    id: projectId,
    name: `${prefix}-project-mcp-updated`,
    description: "updated mcp project",
    content: "Updated MCP project content",
    icon: "BarChart",
    state: "planned",
    start_date: "2026-06-04",
    target_date: null,
  });
  const cursorFixtureProject = await mcp.call("create_project", {
    name: `${prefix}-project-mcp-cursor-fixture`,
    team_ids: [context.teamId],
    description: "lebop mcp live smoke cursor fixture project",
    content: "MCP cursor fixture project content",
    state: "backlog",
  });
  const cursorFixtureProjectId = cursorFixtureProject.project.id;
  report.created.mcp_cursor_project = cursorFixtureProjectId;
  registerRemoteAudit("soft_deleted_project", cursorFixtureProjectId, "MCP cursor fixture project");
  const doneMcpCursorProjectCleanup = registerCliCleanup("delete MCP cursor fixture project", [
    "project",
    "delete",
    cursorFixtureProjectId,
    "--yes",
    "--json",
  ]);
  await mcp.call("create_project_update", {
    project: projectId,
    body: "MCP live smoke project update",
    health: "onTrack",
  });
  await mcp.call("list_project_updates", { project: projectId });

  const milestone = await mcp.call("create_milestone", {
    name: `${prefix}-milestone-mcp`,
    project: projectId,
    description: "mcp milestone",
    target_date: "2026-10-01",
    sort_order: 1,
  });
  const milestoneId = milestone.milestone.id;
  registerRemoteAudit("deleted_milestone", milestoneId, "MCP milestone");
  const doneMcpMilestoneCleanup = registerCliCleanup("delete MCP milestone", [
    "milestone",
    "delete",
    milestoneId,
    "--yes",
    "--json",
  ]);
  await mcp.call("list_milestones", { project: projectId });
  await mcp.call("get_milestone", { id: milestoneId });
  await mcp.call("update_milestone", {
    id: milestoneId,
    name: `${prefix}-milestone-mcp-updated`,
    description: "updated mcp milestone",
    target_date: null,
    sort_order: 2,
  });

  const doc = await mcp.call("create_document", {
    title: `${prefix}-doc-mcp`,
    project: projectId,
    content: "MCP document content",
    icon: "BookOpen",
  });
  const docId = doc.document.id;
  registerRemoteAudit("soft_deleted_document", docId, "MCP document");
  const doneMcpDocumentCleanup = registerCliCleanup("delete MCP document", [
    "document",
    "delete",
    docId,
    "--yes",
    "--json",
  ]);
  await mcp.call("list_documents", { project: projectId, limit: 10 });
  await mcp.call("get_document", { id: docId });
  await mcp.call("update_document", {
    id: docId,
    title: `${prefix}-doc-mcp-updated`,
    content: "Updated MCP document content",
    icon: "BookOpen",
  });
  const mcpDocumentContext = await mcp.call(
    "fetch_linear_workspace",
    {
      target: `/documents/${docId}`,
      to: path.join(lebopHome, "context-mcp-document"),
    },
    {
      recordName: "mcp:fetch_linear_workspace document",
      assert: (payload) => assertFetchPayload(payload, "MCP document context fetch", "document"),
    },
  );
  await assertContextManifest("mcp document context", mcpDocumentContext, "document", [
    `${prefix}-doc-mcp-updated`,
    "Updated MCP document content",
  ]);

  const initiative = await mcp.call("create_initiative", {
    name: `${prefix}-initiative-mcp`,
    description: "mcp initiative",
    target_date: "2026-12-31",
    color: "#22c55e",
    icon: "Rocket",
  });
  const initiativeId = initiative.initiative.id;
  registerRemoteAudit("soft_deleted_initiative", initiativeId, "MCP initiative");
  const doneMcpInitiativeCleanup = registerCliCleanup("delete MCP initiative", [
    "initiative",
    "delete",
    initiativeId,
    "--yes",
    "--json",
  ]);
  await mcp.call("list_initiatives", { limit: 10 });
  await mcp.call("get_initiative", { id: initiativeId });
  await mcp.call("update_initiative", {
    id: initiativeId,
    description: "updated mcp initiative",
    target_date: null,
    color: "#0ea5e9",
    icon: "Rocket",
  });
  await mcp.call("initiative_add_project", {
    initiative: initiativeId,
    project: projectId,
    sort_order: 1,
  });
  await mcp.call("create_initiative_update", {
    initiative: initiativeId,
    body: "MCP live smoke initiative update",
    health: "atRisk",
  });
  await mcp.call("list_initiative_updates", { initiative: initiativeId });
  await mcp.call(
    "explore_linear_workspace",
    { path: "/" },
    { assert: (payload) => assertExplorePayload(payload, "MCP root explore", "/") },
  );
  const mcpProjectsPage1 = await mcp.call(
    "explore_linear_workspace",
    {
      path: "/projects",
      limit: 1,
    },
    {
      recordName: "mcp:explore_linear_workspace projects cursor page 1",
      assert: (payload) => assertProjectCursorPage1(payload, "MCP project cursor page 1"),
    },
  );
  await mcp.call(
    "explore_linear_workspace",
    {
      path: "/projects",
      limit: 1,
      cursor: mcpProjectsPage1.next_cursor,
    },
    {
      recordName: "mcp:explore_linear_workspace projects cursor page 2",
      assert: (payload) =>
        assertProjectCursorPage2(payload, "MCP project cursor page 2", mcpProjectsPage1),
    },
  );
  await mcp.call(
    "delete_project",
    { id: cursorFixtureProjectId, confirm: true },
    {
      assert: (payload) =>
        assertDeletePayload(payload, "MCP cursor fixture project delete", cursorFixtureProjectId),
    },
  );
  doneMcpCursorProjectCleanup();
  await mcp.call(
    "explore_linear_workspace",
    {
      path: "/",
      query: prefix,
      kinds: ["project"],
      limit: 5,
    },
    {
      recordName: "mcp:explore_linear_workspace project search",
      assert: (payload) =>
        assertExploreSearchContains(payload, "MCP project search", {
          kind: "project",
          id: projectId,
          name: `${prefix}-project-mcp-updated`,
        }),
    },
  );
  await mcp.call(
    "explore_linear_workspace",
    {
      path: "/",
      query: prefix,
      kinds: ["initiative"],
      limit: 5,
    },
    {
      recordName: "mcp:explore_linear_workspace initiative search",
      assert: (payload) =>
        assertExploreSearchContains(payload, "MCP initiative search", {
          kind: "initiative",
          id: initiativeId,
          name: `${prefix}-initiative-mcp`,
        }),
    },
  );
  await mcp.call("explore_linear_workspace", { path: `/initiatives/${initiativeId}` });
  const mcpInitiativeContext = await mcp.call(
    "fetch_linear_workspace",
    {
      target: `/initiatives/${initiativeId}`,
      to: path.join(lebopHome, "context-mcp-initiative"),
    },
    {
      assert: (payload) =>
        assertFetchPayload(payload, "MCP initiative context fetch", "initiative"),
    },
  );
  await assertContextManifest("mcp initiative context", mcpInitiativeContext, "initiative", [
    `${prefix}-initiative-mcp`,
    "updated mcp initiative",
    `${prefix}-project-mcp-updated`,
  ]);
  await mcp.call(
    "initiative_remove_project",
    {
      initiative: initiativeId,
      project: projectId,
      confirm: true,
    },
    {
      assert: (payload) =>
        assertInitiativeRemoveProjectPayload(payload, "MCP initiative remove project"),
    },
  );
  await mcp.call(
    "archive_initiative",
    { id: initiativeId, confirm: true },
    {
      assert: (payload) => assertArchivePayload(payload, "MCP initiative archive", initiativeId),
    },
  );
  await mcp.call("unarchive_initiative", { id: initiativeId });

  const issue1 = await mcp.call(
    "create_issue",
    {
      team,
      title: `${prefix}-issue-mcp-primary`,
      description: "MCP primary issue body",
      project_id: projectId,
      labels: [`${prefix}-label-mcp`],
      assignee: context.email,
      state: "Backlog",
      priority: "normal",
    },
    {
      assert: (payload) => [
        ...requireFields(
          payload,
          ["issue.id", "issue.identifier", "issue.title"],
          "MCP issue create",
        ),
        "created issue payload has id/identifier/title",
      ],
    },
  );
  const issueId1 = issue1.issue.identifier;
  const issueUuid1 = issue1.issue.id;
  registerRemoteAudit("archived_issue", issueId1, "MCP primary issue");
  const doneMcpPrimaryIssueCleanup = registerCliCleanup("archive MCP primary issue", [
    "archive",
    issueId1,
    "--yes",
    "--json",
  ]);
  const mcpIssueDocumentTitle = `${prefix}-issue-doc-mcp`;
  const mcpIssueDocumentContent = `MCP issue-scoped document content ${stamp}.`;
  const mcpIssueDocument = await createIssueDocumentFixtureViaMcp(
    issueUuid1,
    mcpIssueDocumentTitle,
    mcpIssueDocumentContent,
  );
  const mcpIssueDocumentId = mcpIssueDocument.id;
  report.created.mcp_issue_document = mcpIssueDocumentId;
  registerRemoteAudit("soft_deleted_document", mcpIssueDocumentId, "MCP issue document");
  const doneMcpIssueDocumentCleanup = registerCliCleanup("delete MCP issue document", [
    "document",
    "delete",
    mcpIssueDocumentId,
    "--yes",
    "--json",
  ]);
  const issue2 = await mcp.call("create_issue", {
    team,
    title: `${prefix}-issue-mcp-secondary`,
    description: "MCP secondary issue body",
    project_id: projectId,
    state: "Backlog",
    priority: "low",
  });
  const issueId2 = issue2.issue.identifier;
  registerRemoteAudit("archived_issue", issueId2, "MCP secondary issue");
  const doneMcpSecondaryIssueCleanup = registerCliCleanup("archive MCP secondary issue", [
    "archive",
    issueId2,
    "--yes",
    "--json",
  ]);
  await mcp.call("list_issues", { team, search: prefix, limit: 20 });
  await mcp.call("get_issue", { identifier: issueId1 });
  const mcpUpdateIssueDescriptionMarker = `MCP update_issue marker ${stamp}.`;
  await mcp.call(
    "update_issue",
    {
      identifier: issueId1,
      title: `${prefix}-issue-mcp-primary-updated`,
      description: mcpUpdateIssueDescriptionMarker,
      state: "Todo",
      priority: "high",
      estimate: 2,
      assignee: "@me",
      labels: [`${prefix}-label-mcp`],
      parent: issueId2,
      project: projectId,
      milestone: milestoneId,
      cycle: null,
    },
    {
      assert: async (payload) => [
        ...requireFields(
          payload,
          ["issue.id", "issue.identifier", "issue.title"],
          "MCP issue update",
        ),
        "updated issue payload has id/identifier/title",
        ...(await assertRemoteIssueUpdateState(
          issueId1,
          {
            descriptionContains: mcpUpdateIssueDescriptionMarker,
            projectId,
            milestoneId,
            cycleId: null,
            proofs: FIELD_UPDATE_PROOF_LABELS["mcp:update_issue"],
          },
          "MCP update_issue",
        )),
      ],
    },
  );
  await mcp.call("update_issue", { identifier: issueId1, parent: null });
  await mcp.call("add_relation", { from: issueId1, kind: "related", to: issueId2 });
  await mcp.call(
    "add_relation",
    { from: issueId1, kind: "blocks", to: issueId2, confirm: true },
    {
      recordName: "mcp:add_relation replacement confirm",
      assert: (payload) =>
        assertRelationAddPayload(payload, "MCP relation replacement confirm", {
          from: issueId1,
          kind: "blocks",
          to: issueId2,
        }),
    },
  );
  await mcp.call("list_relations", { identifier: issueId1 });
  await mcp.call(
    "delete_relation",
    {
      from: issueId1,
      kind: "blocks",
      to: issueId2,
      confirm: true,
    },
    {
      assert: (payload) =>
        assertRelationDeletePayload(payload, "MCP relation delete", {
          from: issueId1,
          kind: "blocks",
          to: issueId2,
        }),
    },
  );
  await mcp.call("list_relations", { identifier: issueId1 });
  await mcp.call(
    "update_relations",
    {
      from: issueId1,
      deltas: [
        { op: "add", kind: "related", to: issueId2 },
        { op: "remove", kind: "related", to: issueId2 },
      ],
      confirm: true,
    },
    {
      recordName: "mcp:update_relations remove confirm",
      assert: (payload) =>
        assertRelationUpdatePayload(payload, "MCP update_relations remove confirm", {
          from: issueId1,
          kind: "related",
          to: issueId2,
        }),
    },
  );
  await mcp.call("list_relations", { identifier: issueId1 });

  const comment = await mcp.call("add_comment", {
    identifier: issueId1,
    body: "MCP smoke comment",
  });
  const commentId = comment.comment.id;
  const doneMcpCommentCleanup = registerCliCleanup("delete MCP comment", [
    "comment",
    "delete",
    commentId,
    "--yes",
    "--json",
  ]);
  await mcp.call("list_comments", { identifier: issueId1 });
  await mcp.call("update_comment", { id: commentId, body: "Updated MCP smoke comment" });
  await mcp.call(
    "delete_comment",
    { id: commentId, confirm: true },
    {
      assert: (payload) => assertDeletePayload(payload, "MCP comment delete", commentId),
    },
  );
  registerRemoteAudit("deleted_comment", commentId, "MCP comment");
  doneMcpCommentCleanup();

  const attachment = await mcp.call("link_url_to_issue", {
    identifier: issueId1,
    url: "https://example.com/lebop-mcp-live-smoke",
    title: "MCP smoke link",
  });
  const attachmentId = attachment.attachment.id;
  const doneMcpAttachmentCleanup = registerCliCleanup("delete MCP attachment", [
    "attachment",
    "delete",
    attachmentId,
    "--yes",
    "--json",
  ]);
  await mcp.call("list_attachments", { identifier: issueId1 });
  await mcp.call("update_attachment", {
    id: attachmentId,
    title: "MCP smoke link updated",
  });
  await mcp.expectError("update_attachment", {
    id: attachmentId,
    url: "https://example.com/lebop-mcp-live-smoke-updated",
  });
  await mcp.call("explore_linear_workspace", { path: `/issues/${issueId1}` });
  await mcp.call(
    "explore_linear_workspace",
    { path: `/issues/${issueId1}/documents` },
    {
      recordName: "mcp:explore_linear_workspace issue documents",
      assert: (payload) => [
        ...assertExplorePayload(
          payload,
          "MCP issue document explore",
          `/issues/${issueId1}/documents`,
        ),
        "issue document child path explored",
      ],
    },
  );
  const mcpIssueContext = await mcp.call(
    "fetch_linear_workspace",
    {
      target: `/issues/${issueId1}`,
      to: path.join(lebopHome, "context-mcp-issue"),
    },
    {
      assert: async (payload) => [
        ...assertFetchPayload(payload, "MCP issue context fetch", "issue"),
        ...(await assertIssueDocumentFetch(payload, "MCP issue context fetch", issueId1, [
          mcpIssueDocumentTitle,
          mcpIssueDocumentContent,
        ])),
        ...(await assertAgentSessionDefaultOmitted(
          payload,
          "MCP issue context fetch",
          "agent_sessions",
        )),
      ],
    },
  );
  const mcpIssueDocumentsContext = await mcp.call(
    "fetch_linear_workspace",
    {
      target: `/issues/${issueId1}/documents`,
      to: path.join(lebopHome, "context-mcp-issue-documents"),
    },
    {
      recordName: "mcp:fetch_linear_workspace issue documents",
      assert: async (payload) => [
        ...assertFetchPayload(payload, "MCP issue document context fetch", "issue"),
        ...(await assertIssueDocumentFetch(payload, "MCP issue document context fetch", issueId1, [
          mcpIssueDocumentTitle,
          mcpIssueDocumentContent,
        ])),
      ],
    },
  );
  const mcpIssueAgentSessionsContext = await mcp.call(
    "fetch_linear_workspace",
    {
      target: `/issues/${issueId1}/agent-sessions`,
      to: path.join(lebopHome, "context-mcp-issue-agent-sessions"),
    },
    {
      recordName: "mcp:fetch_linear_workspace issue agent-sessions",
      assert: async (payload) => [
        ...assertFetchPayload(payload, "MCP issue agent-session context fetch", "issue"),
        ...(await assertIssueAgentSessionChildFetch(
          payload,
          "MCP issue agent-session context fetch",
          issueId1,
        )),
      ],
    },
  );
  expect(
    mcpIssueAgentSessionsContext.root,
    "MCP issue agent-session context fetch did not return a root",
  );
  await assertContextManifest("mcp issue context", mcpIssueContext, "issue", [
    issueId1,
    `${prefix}-issue-mcp-primary-updated`,
    mcpUpdateIssueDescriptionMarker,
    "MCP smoke link updated",
    mcpIssueDocumentTitle,
    mcpIssueDocumentContent,
  ]);
  await assertContextManifest("mcp issue document context", mcpIssueDocumentsContext, "issue", [
    mcpIssueDocumentTitle,
    mcpIssueDocumentContent,
  ]);
  await mcp.call(
    "delete_attachment",
    { id: attachmentId, confirm: true },
    {
      assert: (payload) => assertDeletePayload(payload, "MCP attachment delete", attachmentId),
    },
  );
  registerRemoteAudit("deleted_attachment", attachmentId, "MCP attachment");
  doneMcpAttachmentCleanup();

  await mcp.call(
    "bulk_update_issues",
    {
      identifiers: [issueId1, issueId2],
      confirm: true,
      patch: {
        state: "Backlog",
        priority: "low",
        labels: [`${prefix}-label-mcp`],
        assignee: "@me",
        estimate: 1,
        project: projectId,
        milestone: `${prefix}-milestone-mcp-updated`,
      },
    },
    {
      assert: (payload) =>
        assertBulkUpdatePayload(payload, "MCP bulk update", {
          identifiers: [issueId1, issueId2],
          fields: ["state", "priority", "labels", "assignee", "estimate", "project", "milestone"],
        }),
    },
  );
  const mcpMilestoneIssues = await mcp.call(
    "explore_linear_workspace",
    { path: `/milestones/${milestoneId}/issues`, limit: 10 },
    {
      assert: (payload) =>
        assertExplorePayload(
          payload,
          "MCP milestone issues explore",
          `/milestones/${milestoneId}/issues`,
        ),
    },
  );
  expect(
    mcpMilestoneIssues.items.some(
      (item) => item.identifier === issueId1 || item.identifier === issueId2,
    ),
    "MCP milestone issue explore did not include a deterministic live issue fixture",
  );
  const mcpMilestoneContext = await mcp.call(
    "fetch_linear_workspace",
    {
      target: `/milestones/${milestoneId}`,
      to: path.join(lebopHome, "context-mcp-milestone"),
    },
    {
      assert: (payload) => assertFetchPayload(payload, "MCP milestone context fetch", "milestone"),
    },
  );
  await assertContextManifest("mcp milestone context", mcpMilestoneContext, "milestone", [
    `${prefix}-milestone-mcp-updated`,
    issueId1,
  ]);

  await mcp.call("archive_issue", { identifiers: [issueId2], confirm: true });
  await mcp.call("unarchive_issue", { identifiers: [issueId2] });
  const pulledProject = await mcp.call(
    "pull_project",
    {
      project_id: projectId,
      refresh: true,
      confirm: true,
      include_comments: true,
      team,
    },
    {
      recordName: "mcp:pull_project refresh",
      assert: async (payload) => {
        const proofs = requireFields(
          payload,
          ["mode", "project.cache_path"],
          "MCP pull_project refresh",
        );
        expect(payload.mode === "cache", `MCP pull_project refresh mode=${payload.mode}`);
        const content = await readFile(path.join(payload.project.cache_path, "content.md"), "utf8");
        expect(
          content.includes("Updated MCP project content"),
          "MCP pull_project refresh did not write refreshed project content",
        );
        proofs.push("mode=cache");
        proofs.push("project content refreshed");
        return proofs;
      },
    },
  );
  await mcp.call("explore_linear_workspace", { path: `/projects/${projectId}` });
  await mcp.call("explore_linear_workspace", { path: `/projects/${projectId}/issues` });
  const mcpProjectContext = await mcp.call(
    "fetch_linear_workspace",
    {
      target: `/projects/${projectId}`,
      to: path.join(lebopHome, "context-mcp-project"),
    },
    {
      assert: async (payload) => [
        ...assertFetchPayload(payload, "MCP project context fetch", "project"),
        ...(await assertAgentSessionDefaultOmitted(
          payload,
          "MCP project context fetch",
          "issue_agent_sessions",
        )),
      ],
    },
  );
  await assertContextManifest("mcp project context", mcpProjectContext, "project", [
    `${prefix}-project-mcp-updated`,
    "Updated MCP project content",
    issueId1,
    `${prefix}-doc-mcp-updated`,
  ]);
  await assertAggregateIssueDocumentFetch(
    mcpProjectContext,
    "MCP project context fetch",
    issueId1,
    [mcpIssueDocumentTitle, mcpIssueDocumentContent],
  );
  await cli(
    "document delete MCP issue document fixture --json",
    ["document", "delete", mcpIssueDocumentId, "--yes", "--json"],
    {
      json: true,
      assert: (payload) =>
        assertDeletePayload(payload, "MCP issue document fixture delete", mcpIssueDocumentId),
    },
  );
  doneMcpIssueDocumentCleanup();
  const mcpPullProjectExportDir = path.join(lebopHome, "mcp-pull-project-export");
  await mcp.call(
    "pull_project",
    {
      project_id: projectId,
      include_comments: true,
      team,
      to: mcpPullProjectExportDir,
    },
    {
      recordName: "mcp:pull_project export",
      assert: async (payload) => {
        const projectExportPath = path.join(mcpPullProjectExportDir, `project-${projectId}`);
        const issueExportPath = path.join(mcpPullProjectExportDir, issueId1);
        const projectContent = await readFile(path.join(projectExportPath, "content.md"), "utf8");
        const issueDescription = await readFile(
          path.join(issueExportPath, "description.md"),
          "utf8",
        );
        if (payload.mode !== "export") throw new Error("MCP pull_project export mode mismatch");
        if (payload.project?.cache_path !== null) {
          throw new Error("MCP pull_project export returned cache_path");
        }
        if (!projectContent.includes("Updated MCP project content")) {
          throw new Error("MCP pull_project export did not write project content");
        }
        if (issueDescription.length === 0) {
          throw new Error("MCP pull_project export did not write issue description");
        }
        return [
          "mode=export",
          "project cache_path=null",
          "project content exported",
          "issue description exported",
        ];
      },
    },
  );
  const mcpPullIssueExportDir = path.join(lebopHome, "mcp-pull-issue-export");
  await mcp.call(
    "pull_issues",
    { identifiers: [issueId1], include_comments: true, to: mcpPullIssueExportDir },
    {
      recordName: "mcp:pull_issues export",
      assert: async (payload) => {
        const issueExportPath = path.join(mcpPullIssueExportDir, issueId1);
        const issueDescription = await readFile(
          path.join(issueExportPath, "description.md"),
          "utf8",
        );
        if (payload.mode !== "export") throw new Error("MCP pull_issues export mode mismatch");
        if (payload.issues?.[0]?.cache_path !== null) {
          throw new Error("MCP pull_issues export returned cache_path");
        }
        if (issueDescription.length === 0) {
          throw new Error("MCP pull_issues export did not write issue description");
        }
        return ["mode=export", "issue cache_path=null", "issue description exported"];
      },
    },
  );
  await mcp.call(
    "pull_issues",
    {
      identifiers: [issueId1],
      refresh: true,
      confirm: true,
      include_comments: true,
      team,
    },
    {
      recordName: "mcp:pull_issues refresh",
      assert: async (payload) => {
        const proofs = requireFields(payload, ["mode", "issues"], "MCP pull_issues refresh");
        expect(payload.mode === "cache", `MCP pull_issues refresh mode=${payload.mode}`);
        const issue = payload.issues.find((candidate) => candidate.identifier === issueId1);
        expect(issue?.cache_path, "MCP pull_issues refresh did not return issue cache_path");
        const description = await readFile(path.join(issue.cache_path, "description.md"), "utf8");
        expect(description.length > 0, "MCP pull_issues refresh wrote empty issue description");
        proofs.push("mode=cache");
        proofs.push(`identifier=${issueId1}`);
        proofs.push("issue description refreshed");
        return proofs;
      },
    },
  );
  await mcp.call("cache_status", { team, check_remote: false });
  const issueMd = await findFirstFile(path.join(lebopHome, "cache"), (p) =>
    p.endsWith(`${issueId1}/description.md`),
  );
  if (issueMd)
    await writeFile(
      issueMd,
      `${await readFile(issueMd, "utf8")}\nMCP cache push marker ${stamp}.\n`,
    );
  await mcp.call("diff_issue", { identifier: issueId1 });
  await mcp.call("push_changes", { identifiers: [issueId1], team, dry_run: true });
  const mcpDirectPushMarker = `MCP direct cache push marker ${stamp}.`;
  await writeFile(issueMd, `${await readFile(issueMd, "utf8")}\n${mcpDirectPushMarker}\n`);
  await mcp.call(
    "push_changes",
    { identifiers: [issueId1], team },
    {
      recordName: "mcp:push_changes",
      assert: async (payload) => [
        ...assertCachePushPayload(payload, "MCP direct issue cache push", {
          kind: "issue",
          target: issueId1,
          fields: ["description"],
        }),
        await assertRemoteIssueDescriptionContains(
          issueId1,
          mcpDirectPushMarker,
          "MCP direct issue cache push",
        ),
      ],
    },
  );
  const mcpForcePushMarker = `MCP forced cache push marker ${stamp}.`;
  await writeFile(issueMd, `${await readFile(issueMd, "utf8")}\n${mcpForcePushMarker}\n`);
  await mcp.call(
    "push_changes",
    { identifiers: [issueId1], team, force: true, confirm: true },
    {
      recordName: "mcp:push_changes force",
      assert: async (payload) => [
        ...assertCachePushPayload(payload, "MCP forced issue cache push", {
          kind: "issue",
          target: issueId1,
          fields: ["description"],
        }),
        await assertRemoteIssueDescriptionContains(
          issueId1,
          mcpForcePushMarker,
          "MCP forced issue cache push",
        ),
      ],
    },
  );
  await writeFile(
    issueMd,
    `${await readFile(issueMd, "utf8")}\nMCP cache publish marker ${stamp}.\n`,
  );
  await mcp.call("diff_issue", { identifier: issueId1 });
  const mcpCacheIssueReview = await mcp.call(
    "review_linear_changes",
    {
      source: { kind: "cache", identifiers: [issueId1] },
      team,
    },
    {
      assert: (payload) => assertPublishReviewPayload(payload, "MCP cache issue publish review"),
    },
  );
  expect(mcpCacheIssueReview.review_id, "MCP cache issue review did not return review_id");
  await mcp.call(
    "publish_linear_changes",
    { review_id: mcpCacheIssueReview.review_id },
    {
      recordName: "mcp:publish_linear_changes cache issue",
      assert: (payload) => assertPublishApplyPayload(payload, "MCP cache issue publish apply"),
    },
  );
  const projectContent = pulledProject.project?.cache_path
    ? path.join(pulledProject.project.cache_path, "content.md")
    : null;
  if (!projectContent) throw new Error("pull_project did not return project.cache_path");
  await writeFile(
    projectContent,
    `${await readFile(projectContent, "utf8")}\nMCP project cache push marker ${stamp}.\n`,
  );
  await mcp.call("diff_project", { project_id: projectId, team });
  await mcp.call("cache_gc", { dry_run: true, preserve_cwd_repo: true });
  const tempGcHash = "feedface0000";
  const tempGcDir = path.join(lebopHome, "cache", tempGcHash);
  const tempGcMarker = path.join(tempGcDir, "marker.txt");
  await mkdir(tempGcDir, { recursive: true });
  await writeFile(tempGcMarker, `temporary live GC fixture ${stamp}\n`);
  await mcp.call(
    "cache_gc",
    { hash: tempGcHash, dry_run: false, confirm: true, preserve_cwd_repo: false },
    {
      recordName: "mcp:cache_gc delete temp cache",
      assert: async (payload) => {
        const proofs = requireFields(payload, ["candidates", "removed"], "MCP cache_gc delete");
        expect(
          Array.isArray(payload.removed) && payload.removed.includes(tempGcHash),
          `MCP cache_gc did not remove ${tempGcHash}`,
        );
        let removedFromDisk = false;
        try {
          await readFile(tempGcMarker, "utf8");
        } catch (err) {
          if (err?.code === "ENOENT") removedFromDisk = true;
          else throw err;
        }
        expect(removedFromDisk, "MCP cache_gc marker still exists after deletion");
        proofs.push(`removed=${tempGcHash}`);
        proofs.push("marker removed from disk");
        return proofs;
      },
    },
  );
  const mcpCacheProjectReview = await mcp.call(
    "review_linear_changes",
    {
      source: { kind: "cache", project_ids: [projectId] },
      team,
    },
    {
      assert: (payload) => assertPublishReviewPayload(payload, "MCP cache project publish review"),
    },
  );
  expect(mcpCacheProjectReview.review_id, "MCP cache project review did not return review_id");
  await mcp.call(
    "publish_linear_changes",
    { review_id: mcpCacheProjectReview.review_id },
    {
      recordName: "mcp:publish_linear_changes cache project",
      assert: (payload) => assertPublishApplyPayload(payload, "MCP cache project publish apply"),
    },
  );
  const mcpLintFile = path.join(lebopHome, "mcp-lint-files.md");
  await writeFile(mcpLintFile, "| header |\n| --- |\n| 1. inline list |\n");
  await mcp.call(
    "lint_files",
    {
      paths: [mcpLintFile],
      fix: true,
      strict: true,
    },
    {
      recordName: "mcp:lint_files fix",
      assert: async (payload) => {
        const proofs = requireFields(
          payload,
          ["files", "warning_count", "fixed_count", "strict_failed", "cache_mode"],
          "MCP lint_files fix",
        );
        expect(Array.isArray(payload.files), "MCP lint_files fix files is not an array");
        const row = payload.files.find((file) => file.path === mcpLintFile);
        expect(row, "MCP lint_files fix missing file result");
        expect(row.fixed > 0, `MCP lint_files fix fixed count was ${row.fixed}`);
        expect(
          !row.warnings?.some((warning) => warning.rule === "L001"),
          "MCP lint_files fix returned stale L001 after rewriting file",
        );
        expect(
          payload.warning_count === 0,
          `MCP lint_files warning_count was ${payload.warning_count}`,
        );
        expect(payload.fixed_count > 0, `MCP lint_files fixed_count was ${payload.fixed_count}`);
        expect(
          payload.strict_failed === false,
          "MCP lint_files strict_failed should be false after fix",
        );
        const fixedContent = await readFile(mcpLintFile, "utf8");
        expect(fixedContent.includes("Row 1"), "MCP lint_files did not rewrite file content");
        proofs.push("file fixed in-place");
        proofs.push("warning_count=0");
        proofs.push(`fixed_count=${payload.fixed_count}`);
        proofs.push("strict_failed=false");
        return proofs;
      },
    },
  );
  await mcp.call(
    "lint_text",
    {
      content: "Bare Linear URL https://linear.app/noxor/issue/NOX-50/test",
      fix: true,
    },
    {
      recordName: "mcp:lint_text fix",
      assert: (payload) => {
        const proofs = requireFields(
          payload,
          ["fixed_content", "fix_passes", "remaining_warning_count", "remaining_warnings"],
          "MCP lint_text fix",
        );
        expect(typeof payload.fixed_content === "string", "MCP lint_text fix missing content");
        expect(
          Array.isArray(payload.remaining_warnings),
          "MCP lint_text fix remaining_warnings is not an array",
        );
        proofs.push("fixed_content present");
        proofs.push(`remaining_warning_count=${payload.remaining_warning_count}`);
        return proofs;
      },
    },
  );
  await mcp.call("raw_graphql", {
    query: "query { viewer { id email name } organization { id urlKey name } }",
  });
  const mcpRawMutationMarker = `MCP raw GraphQL mutation marker ${stamp}.`;
  await mcp.call(
    "raw_graphql",
    {
      query:
        "mutation LebopRawIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier description } } }",
      variables: {
        id: issue1.issue.id,
        input: { description: mcpRawMutationMarker },
      },
      allow_mutation: true,
      confirm: true,
    },
    {
      recordName: "mcp:raw_graphql mutation confirm",
      assert: async (payload) => {
        const proofs = requireFields(
          payload,
          ["data.issueUpdate.success", "data.issueUpdate.issue.identifier"],
          "MCP raw_graphql mutation confirm",
        );
        expect(
          payload.data.issueUpdate.success === true,
          "MCP raw_graphql mutation did not report success",
        );
        expect(
          payload.data.issueUpdate.issue.identifier === issueId1,
          `MCP raw_graphql mutation updated ${payload.data.issueUpdate.issue.identifier}`,
        );
        proofs.push("success=true");
        proofs.push(`identifier=${issueId1}`);
        proofs.push(
          await assertRemoteIssueDescriptionContains(
            issueId1,
            mcpRawMutationMarker,
            "MCP raw_graphql mutation confirm",
          ),
        );
        return proofs;
      },
    },
  );

  const cycles = await mcp.call("list_cycles", { team });
  const cycleFixture = cycles.cycles?.[0];
  if (cycleFixture?.id) {
    await mcp.call("get_cycle", { id: cycleFixture.id });
    await mcp.call(
      "explore_linear_workspace",
      { path: `/cycles/${cycleFixture.id}/issues` },
      {
        recordName: "mcp:explore_linear_workspace cycle issues",
        assert: (payload) =>
          assertExplorePayload(
            payload,
            "MCP cycle issue explore",
            `/cycles/${cycleFixture.id}/issues`,
          ),
      },
    );
    const mcpCycleContext = await mcp.call(
      "fetch_linear_workspace",
      {
        target: `/cycles/${cycleFixture.id}`,
        to: path.join(lebopHome, "context-mcp-cycle"),
      },
      {
        recordName: "mcp:fetch_linear_workspace cycle",
        assert: (payload) => assertFetchPayload(payload, "MCP cycle context fetch", "cycle"),
      },
    );
    await assertContextManifest("mcp cycle context", mcpCycleContext, "cycle", [
      cycleFixture.name ?? cycleFixture.id,
    ]);
  } else {
    record("mcp:get_cycle", "gap", {
      reason: "NOX currently has no cycles, so get_cycle has no valid UUID fixture.",
    });
    record("mcp:explore_linear_workspace cycle issues", "gap", {
      reason: "NOX currently has no cycles, so cycle issue exploration has no valid fixture.",
    });
    record("mcp:fetch_linear_workspace cycle", "gap", {
      reason: "NOX currently has no cycles, so cycle workspace fetch has no valid fixture.",
    });
  }

  const sessions = await mcp.call("list_agent_sessions", { limit: 1 });
  const agentSessionFixture = sessions.agent_sessions?.[0];
  if (agentSessionFixture?.id) {
    await mcp.call("get_agent_session", { id: agentSessionFixture.id });
    const mcpAgentSessionContext = await mcp.call(
      "fetch_linear_workspace",
      {
        target: `/agent-sessions/${agentSessionFixture.id}`,
        to: path.join(lebopHome, "context-mcp-agent-session"),
      },
      {
        recordName: "mcp:fetch_linear_workspace agent-session",
        assert: (payload) =>
          assertFetchPayload(payload, "MCP agent-session context fetch", "agent_session"),
      },
    );
    await assertContextManifest(
      "mcp agent-session context",
      mcpAgentSessionContext,
      "agent_session",
      [agentSessionFixture.id],
    );
  } else {
    record("mcp:get_agent_session", "gap", {
      reason: "No agent sessions returned by NOX.",
    });
    record("mcp:fetch_linear_workspace agent-session", "gap", {
      reason: "No agent sessions returned by NOX.",
    });
  }

  const donePlanMcpCleanup = await runPlanMcp(labelId);
  donePlanMcpCleanup();
  await runPublishMcp(labelId);

  await mcp.call(
    "archive_issue",
    { identifiers: [issueId2], confirm: true },
    {
      assert: (payload) =>
        assertLifecyclePayload(payload, "MCP secondary issue archive", [issueId2]),
    },
  );
  doneMcpSecondaryIssueCleanup();
  await mcp.call(
    "archive_issue",
    { identifiers: [issueId1], confirm: true },
    {
      assert: (payload) => assertLifecyclePayload(payload, "MCP primary issue archive", [issueId1]),
    },
  );
  doneMcpPrimaryIssueCleanup();
  await mcp.call(
    "delete_document",
    { id: docId, confirm: true },
    {
      assert: (payload) => assertDeletePayload(payload, "MCP document delete", docId),
    },
  );
  doneMcpDocumentCleanup();
  await mcp.call(
    "delete_milestone",
    { id: milestoneId, confirm: true },
    {
      assert: (payload) => assertDeletePayload(payload, "MCP milestone delete", milestoneId),
    },
  );
  doneMcpMilestoneCleanup();
  await mcp.call(
    "delete_initiative",
    { id: initiativeId, confirm: true },
    {
      assert: (payload) => assertDeletePayload(payload, "MCP initiative delete", initiativeId),
    },
  );
  doneMcpInitiativeCleanup();
  await mcp.call(
    "delete_label",
    { id: labelId, confirm: true },
    {
      assert: (payload) => assertDeletePayload(payload, "MCP label delete", labelId),
    },
  );
  doneMcpLabelCleanup();
  await mcp.call(
    "delete_project",
    { id: projectId, confirm: true },
    {
      assert: (payload) => assertDeletePayload(payload, "MCP project delete", projectId),
    },
  );
  doneMcpProjectCleanup();
}

async function runPlanMcp(_labelId) {
  const planDir = path.join(lebopHome, "plan-mcp");
  await mkdir(planDir, { recursive: true });
  await writeFile(
    path.join(planDir, "_project.md"),
    `---\nname: "${prefix}-plan-mcp"\ndescription: "mcp live smoke plan"\nstate: backlog\nteam: ${team}\nicon: Rocket\n---\n\nMCP plan project body.\n`,
  );
  await writeFile(
    path.join(planDir, "01-one.md"),
    `---\ntitle: "${prefix}-plan-mcp-one"\nstate: Backlog\npriority: normal\nestimate: 1\nrelated: [02-two]\n---\n\nMCP plan issue one body.\n`,
  );
  await writeFile(
    path.join(planDir, "02-two.md"),
    `---\ntitle: "${prefix}-plan-mcp-two"\nstate: Backlog\npriority: low\nestimate: 1\n---\n\nMCP plan issue two body.\n`,
  );
  await mcp.call("plan_validate", { dir: planDir, team });
  await mcp.call("plan_lint", { dir: planDir, team });
  await mcp.call("plan_apply", { dir: planDir, dry_run: true, team });
  const donePlanCleanup = registerPlanDirCleanup("MCP plan", planDir);
  await mcp.call("plan_apply", { dir: planDir, team });
  await mcp.call("plan_diff", { dir: planDir, team });
  await mcp.call(
    "plan_pull",
    { dir: planDir, force: true, confirm: true, team },
    {
      recordName: "mcp:plan_pull force",
      assert: async (payload) => {
        const proofs = requireFields(payload, ["project.status", "issues"], "MCP plan_pull force");
        const projectRaw = await readFile(path.join(planDir, "_project.md"), "utf8");
        const issueRaw = await readFile(path.join(planDir, "01-one.md"), "utf8");
        expect(
          /linear_id:\s*[0-9a-f-]{36}/i.test(projectRaw),
          "MCP plan_pull force did not preserve project linear_id",
        );
        expect(
          /linear_id:\s*[A-Z]+-\d+/.test(issueRaw),
          "MCP plan_pull force did not preserve issue linear_id",
        );
        proofs.push(`project.status=${payload.project.status}`);
        proofs.push("project linear_id present");
        proofs.push("issue linear_id present");
        return proofs;
      },
    },
  );
  const projectRaw = await readFile(path.join(planDir, "_project.md"), "utf8");
  const projectId = projectRaw.match(/linear_id:\s*([0-9a-f-]{36})/i)?.[1];
  const issueIds = [];
  for (const file of ["01-one.md", "02-two.md"]) {
    const raw = await readFile(path.join(planDir, file), "utf8");
    const id = raw.match(/linear_id:\s*([A-Z]+-\d+)/)?.[1];
    if (id) issueIds.push(id);
  }
  if (issueIds.length > 0) {
    const planForceMarker = `MCP plan force apply marker ${stamp}.`;
    const issueOnePath = path.join(planDir, "01-one.md");
    await writeFile(issueOnePath, `${await readFile(issueOnePath, "utf8")}\n${planForceMarker}\n`);
    await mcp.call(
      "plan_apply",
      { dir: planDir, force: true, confirm: true, team },
      {
        recordName: "mcp:plan_apply force",
        assert: async (payload) => {
          const proofs = requireFields(payload, ["project", "issues"], "MCP plan_apply force");
          const row = payload.issues.find((issue) => issue.linearId === issueIds[0]);
          expect(row, `MCP plan_apply force missing issue row for ${issueIds[0]}`);
          expect(
            row.status === "updated" || row.status === "unchanged",
            `MCP plan_apply force unexpected issue status ${row.status}`,
          );
          proofs.push(`issue.status=${row.status}`);
          proofs.push(
            await assertRemoteIssueDescriptionContains(
              issueIds[0],
              planForceMarker,
              "MCP plan_apply force",
            ),
          );
          return proofs;
        },
      },
    );
  }
  if (issueIds.length > 0) {
    for (const issueId of issueIds) {
      registerRemoteAudit("archived_issue", issueId, `MCP plan issue ${issueId}`);
    }
    await mcp.call(
      "archive_issue",
      { identifiers: issueIds, confirm: true },
      {
        assert: (payload) => assertLifecyclePayload(payload, "MCP plan issue archive", issueIds),
      },
    );
  }
  if (projectId) {
    registerRemoteAudit("soft_deleted_project", projectId, "MCP plan project");
    await mcp.call(
      "delete_project",
      { id: projectId, confirm: true },
      {
        assert: (payload) => assertDeletePayload(payload, "MCP plan project delete", projectId),
      },
    );
  }
  return donePlanCleanup;
}

async function runPublishMcp(_labelId) {
  const planDir = path.join(lebopHome, "publish-mcp");
  await mkdir(planDir, { recursive: true });
  await writeFile(
    path.join(planDir, "_project.md"),
    `---\nname: "${prefix}-publish-mcp"\ndescription: "mcp live publish review"\nstate: backlog\nteam: ${team}\nicon: Rocket\n---\n\nMCP publish project body.\n`,
  );
  await writeFile(
    path.join(planDir, "01-one.md"),
    `---\ntitle: "${prefix}-publish-mcp-one"\nstate: Backlog\npriority: normal\n---\n\nMCP publish issue body.\n`,
  );
  const review = await mcp.call(
    "review_linear_changes",
    {
      source: { kind: "plan", dir: planDir },
      team,
    },
    {
      assert: (payload) => assertPublishReviewPayload(payload, "MCP plan publish review"),
    },
  );
  expect(review.review_id, "MCP publish review_id missing");
  const donePublishCleanup = registerPlanDirCleanup("MCP publish plan", planDir);
  await mcp.call(
    "publish_linear_changes",
    { review_id: review.review_id },
    {
      recordName: "mcp:publish_linear_changes plan",
      assert: (payload) => assertPublishApplyPayload(payload, "MCP plan publish apply"),
    },
  );
  await cleanupPlanDirWithCli("MCP publish plan", planDir);
  donePublishCleanup();
}

async function cleanupAuthOnly() {
  await cli("auth logout temp", ["auth", "logout", workspace]);
  tempAuthReady = false;
}

async function main() {
  try {
    await populateBinaryUnderTest(report);
    await setupTempAuth();
    const context = await runCliSurface();
    await runMcpSurface(context);
    assertNoUnexpectedGaps(report);
    if ((report.gaps ?? []).length > 0) {
      throw new Error(
        `live harness recorded fixture gaps: ${report.gaps
          .map((gap) => gap.name)
          .join(
            ", ",
          )}. Full-surface release runs require deterministic fixtures or explicit fixture setup before running.`,
      );
    }
    assertSurfaceCoverage(report, REQUIRED_MCP_LIVE_TOOLS);
    assertSemanticCoverage(report);
    report.finished_at = new Date().toISOString();
    finalizeLiveReportStatus(report);
  } catch (err) {
    record("harness", "fail", { error: err.stack ?? err.message ?? String(err) });
    report.finished_at = new Date().toISOString();
    report.status = "failed";
    process.exitCode = 1;
  } finally {
    if (mcp) await mcp.close().catch(() => {});
    await runCleanupActions();
    if (tempAuthReady) {
      await runRemoteDestructiveAudit().catch((err) => {
        report.cleanup.push({
          name: "remote destructive audit",
          status: "fail",
          error: err.stack ?? err.message ?? String(err),
          at: new Date().toISOString(),
        });
        process.exitCode = 1;
      });
    }
    if (tempAuthReady) {
      await cleanupAuthOnly().catch((err) => {
        report.cleanup.push({
          name: "auth logout temp",
          status: "fail",
          error: err.stack ?? err.message ?? String(err),
          at: new Date().toISOString(),
        });
      });
    }
    if (lebopHome) {
      await rm(lebopHome, { recursive: true, force: true })
        .then(() => {
          report.cleanup.push({
            name: "remove temp LEBOP_HOME",
            status: "pass",
            at: new Date().toISOString(),
          });
        })
        .catch((err) => {
          report.cleanup.push({
            name: "remove temp LEBOP_HOME",
            status: "fail",
            error: err.stack ?? err.message ?? String(err),
            at: new Date().toISOString(),
          });
        });
    }
    report.finished_at = new Date().toISOString();
    finalizeLiveReportStatus(report);
    const finalValidation = validateLiveHarnessProcess(report);
    if (!finalValidation.ok) {
      process.exitCode = 1;
      console.error(
        `FAIL strict live report validation\n${finalValidation.errors
          .map((error) => `- ${error}`)
          .join("\n")}`,
      );
    }
    const reportPath = await writeLiveSurfaceReport(report);
    console.log(`REPORT ${reportPath}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, reportPath] = process.argv.slice(2);
  if (command === "--validate-report") {
    if (!reportPath) {
      console.error("usage: live-nox-surface-smoke.mjs --validate-report <report.json>");
      process.exit(2);
    }
    const expectedBinaryMode = process.env.LEBOP_LIVE_EXPECT_BIN_MODE?.trim() || undefined;
    const expectedBinaryVersion = process.env.LEBOP_LIVE_EXPECT_VERSION?.trim() || undefined;
    const expectedWorkspace = process.env.LEBOP_LIVE_EXPECT_WORKSPACE?.trim() || undefined;
    const expectedTeam = process.env.LEBOP_LIVE_EXPECT_TEAM?.trim() || undefined;
    const expectedStamp = process.env.LEBOP_LIVE_EXPECT_STAMP?.trim() || undefined;
    const expectedBinarySha256 = process.env.LEBOP_LIVE_EXPECT_BIN_SHA256?.trim() || undefined;
    await validateReportFile(path.resolve(reportPath), {
      expectedBinaryMode,
      expectedBinaryVersion,
      expectedWorkspace,
      expectedTeam,
      expectedStamp,
      expectedBinarySha256,
    });
  } else {
    await main();
  }
}
