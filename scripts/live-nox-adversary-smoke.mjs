#!/usr/bin/env node
/**
 * Live Noxor adversary + dual-home concurrency smoke.
 *
 * Complements live-nox-surface-smoke.mjs (happy full surface) with:
 *  1. Stale cache push refusal (Agent A vs Agent B remote write)
 *  2. Stale publish review apply refusal after mid-flight remote change
 *  3. Double publish-apply lock / already-applied safety
 *  4. Pull --refresh without --yes refusal + confirmed refresh recovery
 *  5. CLI set labels +/- deltas live
 *  6. MCP destructive confirm negatives (no confirm:true)
 *  7. Dual LEBOP_HOME (true multi-agent model)
 *
 * Cleanup archives/deletes stamp fixtures. Not a full surface inventory.
 *
 * Usage:
 *   bun scripts/live-nox-adversary-smoke.mjs
 *   LEBOP_LIVE_BIN=/path/to/compiled bun scripts/live-nox-adversary-smoke.mjs
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LEBOP_VERSION } from "../src/lib/version.ts";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_LEBOP_BIN = path.join(repoRoot, "bin", "lebop");
const workspace = process.env.LEBOP_LIVE_WORKSPACE ?? "noxor";
const team = process.env.LEBOP_LIVE_TEAM ?? "NOX";
const timeoutMs = Number(process.env.LEBOP_LIVE_TIMEOUT_MS ?? 90_000);

function defaultLiveStamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
}

function normalizeLiveStamp(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error("LEBOP_LIVE_STAMP must not be empty");
  if (
    normalized !== path.basename(normalized) ||
    normalized.includes("/") ||
    normalized.includes("\\")
  ) {
    throw new Error("LEBOP_LIVE_STAMP must be a filename basename, not a path");
  }
  return normalized;
}

const stamp = normalizeLiveStamp(process.env.LEBOP_LIVE_STAMP ?? `adv-${defaultLiveStamp()}`);
const prefix = `lebop-adv-${stamp}`;

function resolveLebopInvocation(args = [], env = process.env) {
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

const report = {
  kind: "adversary",
  started_at: new Date().toISOString(),
  workspace,
  team,
  stamp,
  prefix,
  version: LEBOP_VERSION,
  binary_under_test: {},
  results: [],
  cleanup: [],
  status: "running",
};

function record(name, status, detail = {}) {
  report.results.push({ name, status, ...detail, at: new Date().toISOString() });
  const marker = status === "pass" ? "PASS" : status === "skip" ? "SKIP" : "FAIL";
  console.log(`${marker} ${name}${detail.note ? ` — ${detail.note}` : ""}`);
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
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, options.timeoutMs ?? timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => settle(reject, err));
    child.on("close", (code, signal) => {
      if (timedOut) {
        settle(
          reject,
          new Error(
            `${cmd} ${args.join(" ")} timed out after ${options.timeoutMs ?? timeoutMs}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
          ),
        );
        return;
      }
      settle(resolve, { code, signal, stdout, stderr });
    });
    if (options.stdin !== undefined) child.stdin.write(options.stdin);
    child.stdin.end();
  });
}

async function lebop(home, args, options = {}) {
  const fullArgs = ["--workspace", workspace, "--team", team, ...args];
  const invocation = resolveLebopInvocation(fullArgs);
  const result = await runProc(invocation.command, invocation.args, {
    ...options,
    env: { LEBOP_HOME: home, ...(options.env ?? {}) },
  });
  return { ...result, display: invocation.display, fullArgs };
}

function parseJson(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) throw new Error("expected JSON stdout, got empty");
  return JSON.parse(text);
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

async function loginHome(home, token) {
  const tokenFile = path.join(home, "token.txt");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const r = await lebop(home, ["auth", "login", "--token-file", tokenFile]);
  expect(r.code === 0, `auth login failed\n${r.stdout}\n${r.stderr}`);
  const def = await lebop(home, ["auth", "default", workspace]);
  expect(def.code === 0, `auth default failed\n${def.stdout}\n${def.stderr}`);
  const teamSet = await lebop(home, ["auth", "set-default-team", workspace, team, "--json"]);
  expect(teamSet.code === 0, `set-default-team failed\n${teamSet.stdout}\n${teamSet.stderr}`);
}

async function readNoxorToken() {
  const fromEnv = process.env.LEBOP_NOXOR_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const invocation = resolveLebopInvocation([
    "--workspace",
    workspace,
    "auth",
    "token",
    workspace,
    "--unsafe",
  ]);
  const result = await runProc(invocation.command, invocation.args);
  expect(result.code === 0, `could not read ${workspace} token\n${result.stderr}`);
  return result.stdout.trim();
}

async function populateBinaryMeta() {
  const inv = resolveLebopInvocation(["--version"]);
  const binaryPath = inv.binary;
  const buf = await readFile(binaryPath);
  const st = await stat(binaryPath);
  const ver = await runProc(inv.command, inv.args, { timeoutMs: 15_000 });
  report.binary_under_test = {
    path: binaryPath,
    mode: inv.mode,
    sha256: createHash("sha256").update(buf).digest("hex"),
    size_bytes: st.size,
    platform: process.platform,
    arch: process.arch,
    version: ver.stdout.trim() || LEBOP_VERSION,
  };
}

/** @type {string[]} */
const cleanupIds = [];

async function createIssue(home, title) {
  const r = await lebop(home, ["new", "--title", title, "--json"]);
  expect(r.code === 0, `new issue failed\n${r.stdout}\n${r.stderr}`);
  const body = parseJson(r.stdout);
  const identifier = body.issue?.identifier ?? body.identifier;
  expect(
    typeof identifier === "string" && identifier.length > 0,
    "create issue missing identifier",
  );
  cleanupIds.push(identifier);
  return { identifier, issue: body.issue ?? body };
}

async function archiveIssue(home, identifier) {
  const r = await lebop(home, ["archive", identifier, "--yes", "--json"]);
  report.cleanup.push({
    name: `archive ${identifier}`,
    status: r.code === 0 ? "pass" : "fail",
    code: r.code,
    at: new Date().toISOString(),
  });
}

async function scenarioStalePush(homeA, homeB) {
  const name = "adv:stale-push dual-home";
  try {
    const created = await createIssue(homeA, `${prefix}-stale-push`);
    const id = created.identifier;

    const pullA = await lebop(homeA, ["pull", id, "--json"]);
    expect(pullA.code === 0, `A pull failed\n${pullA.stdout}\n${pullA.stderr}`);

    // B mutates remote while A holds cache snapshot
    const setB = await lebop(homeB, ["set", "title", id, `${prefix}-stale-push-B-won`, "--json"]);
    expect(setB.code === 0, `B set title failed\n${setB.stdout}\n${setB.stderr}`);

    // A dirties local cache without re-pull
    const pullBody = parseJson(pullA.stdout);
    const issuePath = pullBody.issues?.[0]?.path;
    expect(issuePath, "pull missing issues[0].path");
    const descPath = path.join(issuePath, "description.md");
    await writeFile(descPath, `${await readFile(descPath, "utf8")}\nA local edit ${stamp}\n`);

    const pushA = await lebop(homeA, ["push", id, "--json"]);
    // push may exit 0 with stale status rows, or non-zero — accept either if stale reported
    const out = `${pushA.stdout}\n${pushA.stderr}`;
    const parsed = (() => {
      try {
        return parseJson(pushA.stdout);
      } catch {
        return null;
      }
    })();
    const staleInJson =
      parsed &&
      (parsed.status === "stale" ||
        parsed.results?.some?.((row) => row.status === "stale") ||
        JSON.stringify(parsed).includes('"stale"'));
    const staleInText = /stale/i.test(out);
    expect(
      staleInJson || staleInText || pushA.code !== 0,
      `expected A push to refuse/report stale after B remote write; code=${pushA.code}\n${out}`,
    );

    record(name, "pass", {
      issue: id,
      push_code: pushA.code,
      note: "Agent A push blocked/stale after Agent B remote title change",
    });
  } catch (err) {
    record(name, "fail", { error: err.stack ?? String(err) });
    throw err;
  }
}

async function scenarioStalePublish(homeA, homeB) {
  const name = "adv:stale-publish-apply dual-home";
  try {
    const created = await createIssue(homeA, `${prefix}-stale-publish`);
    const id = created.identifier;
    const pullA = await lebop(homeA, ["pull", id, "--json"]);
    expect(pullA.code === 0, `A pull failed\n${pullA.stdout}\n${pullA.stderr}`);
    const pullBody = parseJson(pullA.stdout);
    const issuePath = pullBody.issues?.[0]?.path;
    const descPath = path.join(issuePath, "description.md");
    await writeFile(descPath, `${await readFile(descPath, "utf8")}\nA publish edit ${stamp}\n`);

    const review = await lebop(homeA, ["publish", "review", "--cache", id, "--json"]);
    expect(review.code === 0, `publish review failed\n${review.stdout}\n${review.stderr}`);
    const reviewBody = parseJson(review.stdout);
    const reviewId = reviewBody.review_id ?? reviewBody.review?.review_id;
    expect(reviewId, "missing review_id");

    // B changes remote after review snapshot
    const setB = await lebop(homeB, ["set", "title", id, `${prefix}-stale-publish-B`, "--json"]);
    expect(setB.code === 0, `B set failed\n${setB.stdout}\n${setB.stderr}`);

    const apply = await lebop(homeA, ["publish", "apply", reviewId, "--json"]);
    const out = `${apply.stdout}\n${apply.stderr}`;
    const blocked =
      apply.code !== 0 ||
      /stale|blocked|refusing/i.test(out) ||
      (() => {
        try {
          const j = parseJson(apply.stdout);
          return (
            j.ok === false ||
            j.status === "blocked" ||
            String(j.error?.message ?? "").includes("stale")
          );
        } catch {
          return false;
        }
      })();
    expect(
      blocked,
      `expected publish apply to block after remote change; code=${apply.code}\n${out}`,
    );

    record(name, "pass", {
      issue: id,
      review_id: reviewId,
      apply_code: apply.code,
      note: "Publish apply refused after B mutated reviewed issue",
    });
  } catch (err) {
    record(name, "fail", { error: err.stack ?? String(err) });
    throw err;
  }
}

async function scenarioDoubleApply(homeA, homeB) {
  const name = "adv:double-publish-apply dual-home";
  try {
    const created = await createIssue(homeA, `${prefix}-double-apply`);
    const id = created.identifier;
    const pullA = await lebop(homeA, ["pull", id, "--json"]);
    expect(pullA.code === 0, `pull failed\n${pullA.stdout}`);
    const issuePath = parseJson(pullA.stdout).issues?.[0]?.path;
    const descPath = path.join(issuePath, "description.md");
    await writeFile(descPath, `${await readFile(descPath, "utf8")}\ndouble-apply ${stamp}\n`);

    const review = await lebop(homeA, ["publish", "review", "--cache", id, "--json"]);
    expect(review.code === 0, `review failed\n${review.stdout}`);
    const reviewId = parseJson(review.stdout).review_id;
    expect(reviewId, "missing review_id");

    // Same-home double-apply (single-use review). Foreign-home apply also checked below.
    const apply1 = await lebop(homeA, ["publish", "apply", reviewId, "--json"]);
    const apply1Body = (() => {
      try {
        return parseJson(apply1.stdout);
      } catch {
        return null;
      }
    })();
    const firstApplied =
      apply1Body &&
      (String(apply1Body.status ?? "").includes("published") ||
        apply1Body.status === "applied" ||
        apply1Body.result?.summary?.applied > 0);
    expect(
      firstApplied,
      `first apply should publish; code=${apply1.code}\n${apply1.stdout}\n${apply1.stderr}`,
    );

    const apply2 = await lebop(homeA, ["publish", "apply", reviewId, "--json"]);
    const out2 = `${apply2.stdout}\n${apply2.stderr}`;
    const secondBlocked =
      apply2.code !== 0 ||
      /already|locked|applied|blocked|stale/i.test(out2) ||
      (() => {
        try {
          const j = parseJson(apply2.stdout);
          return (
            j.ok === false ||
            j.status === "blocked" ||
            String(j.error?.message ?? "").includes("already") ||
            String(j.status ?? "").includes("published") === false
          );
        } catch {
          return false;
        }
      })();
    // Stronger: second must not report applied>0 as a fresh success
    let secondFreshApply = false;
    try {
      const j = parseJson(apply2.stdout);
      secondFreshApply =
        j.result?.summary?.applied > 0 && !String(j.error?.message ?? "").includes("already");
    } catch {
      secondFreshApply = false;
    }
    expect(
      secondBlocked && !secondFreshApply,
      `second apply must not succeed as a fresh apply; code=${apply2.code}\n${out2}`,
    );

    // Also prove B with separate home cannot apply a review id it doesn't own without the store
    const applyB = await lebop(homeB, ["publish", "apply", reviewId, "--json"]);
    expect(
      applyB.code !== 0,
      `homeB apply of foreign review_id should fail; got 0\n${applyB.stdout}`,
    );

    record(name, "pass", {
      issue: id,
      review_id: reviewId,
      apply1_code: apply1.code,
      apply2_code: apply2.code,
      applyB_code: applyB.code,
      note: "Second apply refused; foreign home cannot apply review",
    });
  } catch (err) {
    record(name, "fail", { error: err.stack ?? String(err) });
    throw err;
  }
}

async function scenarioPullRefreshGate(homeA) {
  const name = "adv:pull-refresh-confirm-gate";
  try {
    const created = await createIssue(homeA, `${prefix}-pull-refresh`);
    const id = created.identifier;
    const pull1 = await lebop(homeA, ["pull", id, "--json"]);
    expect(pull1.code === 0, `pull failed\n${pull1.stdout}`);
    const issuePath = parseJson(pull1.stdout).issues?.[0]?.path;
    const descPath = path.join(issuePath, "description.md");
    await writeFile(descPath, `${await readFile(descPath, "utf8")}\nlocal dirty ${stamp}\n`);

    const refreshNo = await lebop(homeA, ["pull", id, "--refresh", "--json"]);
    expect(refreshNo.code !== 0, "pull --refresh without --yes should fail");
    const body = parseJson(refreshNo.stdout);
    expect(body.ok === false, "expected error envelope");
    expect(
      String(body.error?.message ?? "").includes("--yes") ||
        String(body.error?.message ?? "").includes("confirm"),
      `expected confirm message, got ${body.error?.message}`,
    );

    const refreshYes = await lebop(homeA, ["pull", id, "--refresh", "--yes", "--json"]);
    // may succeed or report overwrite conflict resolved — either way confirm path works
    expect(
      refreshYes.code === 0 || /conflict|overwrite/i.test(refreshYes.stdout),
      `pull --refresh --yes unexpected\n${refreshYes.stdout}\n${refreshYes.stderr}`,
    );

    record(name, "pass", {
      issue: id,
      note: "pull --refresh requires --yes; with --yes proceeds",
    });
  } catch (err) {
    record(name, "fail", { error: err.stack ?? String(err) });
    throw err;
  }
}

async function scenarioLabelDeltas(homeA) {
  const name = "adv:cli-set-labels-deltas";
  try {
    const labelName = `${prefix}-lbl`.slice(0, 40);
    const lab = await lebop(homeA, ["label", "create", labelName, "--json"]);
    expect(lab.code === 0, `label create failed\n${lab.stdout}\n${lab.stderr}`);
    const created = await createIssue(homeA, `${prefix}-labels`);
    const id = created.identifier;

    const add = await lebop(homeA, ["set", "labels", id, `+${labelName}`, "--json"]);
    expect(add.code === 0, `set labels + failed\n${add.stdout}\n${add.stderr}`);

    const show1 = await lebop(homeA, ["show", id, "--json"]);
    expect(show1.code === 0, `show failed\n${show1.stdout}`);
    const labels1 = JSON.stringify(parseJson(show1.stdout));
    expect(labels1.includes(labelName), `expected label ${labelName} after +delta`);

    const rem = await lebop(homeA, ["set", "labels", id, "--", `-${labelName}`, "--json"]);
    expect(rem.code === 0, `set labels - failed\n${rem.stdout}\n${rem.stderr}`);

    const delLab = await lebop(homeA, ["label", "delete", labelName, "--yes", "--json"]);
    report.cleanup.push({
      name: `delete label ${labelName}`,
      status: delLab.code === 0 ? "pass" : "fail",
      at: new Date().toISOString(),
    });

    record(name, "pass", { issue: id, label: labelName, note: "CLI + and - label deltas live" });
  } catch (err) {
    record(name, "fail", { error: err.stack ?? String(err) });
    throw err;
  }
}

async function scenarioMcpConfirmNegatives(homeA) {
  const name = "adv:mcp-confirm-negatives";
  try {
    // Drive MCP via CLI raw is hard; use lebop through a one-shot node SDK path:
    // Prefer CLI destructive without --yes as proxy where MCP is integration-tested;
    // plus MCP tool via `bun` invoking a tiny client if server supports stdio one-shot.
    // Use CLI gates for archive (already unit tested) and MCP via direct tool process.

    // CLI negative (live process path)
    const created = await createIssue(homeA, `${prefix}-mcp-confirm`);
    const id = created.identifier;
    const noYes = await lebop(homeA, ["archive", id, "--json"]);
    expect(noYes.code !== 0, "archive without --yes must fail");
    const env = parseJson(noYes.stdout);
    expect(env.ok === false, "error envelope");
    expect(String(env.error?.message ?? "").includes("--yes"), "must mention --yes");

    // MCP confirm: true required for archive_issue — spawn MCP and call without confirm
    const mcp = await callMcpTool(homeA, "archive_issue", { identifiers: [id] });
    expect(
      mcp.isError || /confirm/i.test(mcp.text),
      `MCP archive without confirm must error: ${mcp.text}`,
    );

    const mcpOk = await callMcpTool(homeA, "archive_issue", {
      identifiers: [id],
      confirm: true,
    });
    expect(!mcpOk.isError, `MCP archive with confirm should work: ${mcpOk.text}`);

    record(name, "pass", {
      issue: id,
      note: "CLI --yes gate + MCP archive_issue confirm negative/positive",
    });
  } catch (err) {
    record(name, "fail", { error: err.stack ?? String(err) });
    throw err;
  }
}

/**
 * Minimal MCP stdio call: initialize + tools/call one tool.
 */
async function callMcpTool(home, toolName, args) {
  const invocation = resolveLebopInvocation(["mcp"]);
  const init = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "adversary", version: "1" },
    },
  };
  const initialized = {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  };
  const call = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: toolName, arguments: { ...args, workspace } },
  };
  const stdin = `${JSON.stringify(init)}\n${JSON.stringify(initialized)}\n${JSON.stringify(call)}\n`;
  const result = await runProc(invocation.command, invocation.args, {
    stdin,
    env: { LEBOP_HOME: home },
    timeoutMs: 60_000,
  });
  const lines = result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  let last = null;
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.id === 2) last = msg;
    } catch {
      // ignore non-json
    }
  }
  const text =
    last?.result?.content?.map?.((c) => c.text).join("\n") ??
    JSON.stringify(last?.error ?? last ?? result.stdout.slice(0, 500));
  const isError = Boolean(last?.result?.isError || last?.error);
  return { text, isError, raw: last, code: result.code };
}

async function writeReport() {
  report.finished_at = new Date().toISOString();
  const failed = report.results.some((r) => r.status === "fail");
  report.status = failed ? "failed" : "completed";
  report.summary = {
    total: report.results.length,
    pass: report.results.filter((r) => r.status === "pass").length,
    fail: report.results.filter((r) => r.status === "fail").length,
  };
  const reportDir = path.join(repoRoot, "docs", "local");
  await mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `live-nox-adversary-report-${stamp}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

async function main() {
  console.log(
    `adversary smoke workspace=${workspace} team=${team} stamp=${stamp} mode=${resolveLebopInvocation().mode}`,
  );
  await populateBinaryMeta();

  const token = await readNoxorToken();
  const homeA = await mkdtemp(path.join(tmpdir(), "lebop-adv-a-"));
  const homeB = await mkdtemp(path.join(tmpdir(), "lebop-adv-b-"));
  report.homes = { a: homeA, b: homeB };

  const scenarios = [
    [
      "adv:dual-home-auth",
      async () => {
        await loginHome(homeA, token);
        await loginHome(homeB, token);
        record("adv:dual-home-auth", "pass", { note: "two LEBOP_HOME sessions on noxor" });
      },
    ],
    ["stale-push", () => scenarioStalePush(homeA, homeB)],
    ["stale-publish", () => scenarioStalePublish(homeA, homeB)],
    ["double-apply", () => scenarioDoubleApply(homeA, homeB)],
    ["pull-refresh", () => scenarioPullRefreshGate(homeA)],
    ["label-deltas", () => scenarioLabelDeltas(homeA)],
    ["mcp-confirm", () => scenarioMcpConfirmNegatives(homeA)],
  ];

  try {
    for (const [label, fn] of scenarios) {
      try {
        await fn();
      } catch (err) {
        // scenario* already records FAIL; continue remaining scenarios
        if (!report.results.some((r) => r.status === "fail" && String(r.name).includes(label))) {
          record(`adv:${label}`, "fail", { error: err.stack ?? String(err) });
        }
        console.error(err.stack ?? err);
      }
    }
  } finally {
    for (const id of cleanupIds) {
      await archiveIssue(homeA, id).catch(() => archiveIssue(homeB, id));
    }
    await rm(homeA, { recursive: true, force: true }).catch(() => {});
    await rm(homeB, { recursive: true, force: true }).catch(() => {});
    report.cleanup.push({
      name: "remove temp homes",
      status: "pass",
      at: new Date().toISOString(),
    });
  }

  const reportPath = await writeReport();
  console.log(`REPORT ${reportPath}`);
  console.log(JSON.stringify(report.summary));
  if (report.status !== "completed") {
    process.exitCode = 1;
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((err) => {
    console.error(err.stack ?? err);
    process.exit(1);
  });
}
