#!/usr/bin/env bun
/**
 * Mode A multi-workspace isolation smoke.
 *
 *   bun scripts/live-dual-workspace-smoke.mjs
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const bin = path.join(repoRoot, "bin", "lebop");
const a = process.env.LEBOP_LIVE_WORKSPACE_A ?? "lebop-playground";
const b = process.env.LEBOP_LIVE_WORKSPACE_B ?? "2nd-lebop-playground";
const results = [];

function run(args, envExtra = {}) {
  return new Promise((resolve) => {
    const child = spawn("bun", [bin, ...args], {
      cwd: repoRoot,
      env: { ...process.env, LEBOP_MACHINE_FORMAT: "json", NO_COLOR: "1", ...envExtra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseJson(stdout) {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error(`not JSON: ${text.slice(0, 200)}`);
  }
}

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: String(e?.message ?? e) });
    console.error(`FAIL  ${name}: ${e?.message ?? e}`);
  }
}

function assert(c, m) {
  if (!c) throw new Error(m);
}

await step("auth list has both workspaces", async () => {
  const r = await run(["auth", "list", "--json"]);
  assert(r.code === 0, r.stderr || r.stdout);
  const body = parseJson(r.stdout);
  const slugs = (body.workspaces ?? []).map((w) => w.slug);
  assert(slugs.includes(a), `missing ${a}`);
  assert(slugs.includes(b), `missing ${b}`);
  return { slugs };
});

let viewerA;
let viewerB;
await step(`whoami ${a}`, async () => {
  const r = await run(["--workspace", a, "auth", "whoami", "--refresh", "--json"]);
  assert(r.code === 0, r.stderr || r.stdout);
  const body = parseJson(r.stdout);
  assert(body.workspace === a || body.workspace_name, "workspace a");
  viewerA = body.viewer?.id ?? body.id;
  return body;
});

await step(`whoami ${b}`, async () => {
  const r = await run(["--workspace", b, "auth", "whoami", "--refresh", "--json"]);
  assert(r.code === 0, r.stderr || r.stdout);
  const body = parseJson(r.stdout);
  assert(body.workspace === b || body.workspace_name, "workspace b");
  viewerB = body.viewer?.id ?? body.id;
  assert(viewerA && viewerB && viewerA !== viewerB, "viewers must differ across workspaces");
  return body;
});

await step("cache path isolation", async () => {
  const { repoCacheDir } = await import("../src/lib/cache.ts");
  const pa = repoCacheDir("_global", a);
  const pb = repoCacheDir("_global", b);
  assert(pa !== pb, "cache paths must differ");
  assert(pa.includes(a) && pb.includes(b), "slug in path");
  return { pa, pb };
});

await step(`teams on ${a}`, async () => {
  const r = await run(["--workspace", a, "teams", "--json"]);
  assert(r.code === 0, r.stderr || r.stdout);
  const body = parseJson(r.stdout);
  assert(Array.isArray(body.teams), "teams");
  return { count: body.teams.length };
});

await step(`teams on ${b}`, async () => {
  const r = await run(["--workspace", b, "teams", "--json"]);
  assert(r.code === 0, r.stderr || r.stdout);
  const body = parseJson(r.stdout);
  assert(Array.isArray(body.teams), "teams");
  return { count: body.teams.length };
});

const failed = results.filter((r) => !r.ok);
const summary = {
  a,
  b,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  failures: failed,
  steps: results,
};
const outDir = path.join(repoRoot, "docs", "local");
await mkdir(outDir, { recursive: true });
const reportPath = path.join(outDir, "live-dual-workspace-report.json");
await writeFile(reportPath, JSON.stringify(summary, null, 2));
console.log(`\nreport: ${reportPath}`);
console.log(`passed ${summary.passed}/${summary.total}`);
if (failed.length) process.exitCode = 1;
