#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";

const slashCommandEntries = readdirSync("agents/commands")
  .filter((name) => /^lebop-.*\.md$/.test(name))
  .sort()
  .map((name) => `agents/commands/${name}`);

const requiredEntries = [
  "bin/lebop",
  "bin/lebop.ts",
  "bin/install-claude",
  "src/cli.ts",
  "agents/skills/lebop/SKILL.md",
  ...slashCommandEntries,
  "scripts/check-npm-pack.mjs",
  "scripts/install.sh",
  "docs/spec.md",
  "docs/examples/getting-started/README.md",
  "README.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "package.json",
];

const forbiddenPrefixes = ["docs/local/", "tests/", ".github/", "dist/", "node_modules/"];

const forbiddenEntries = ["scripts/live-nox-surface-smoke.mjs", "tests/liveNoxHarness.test.mjs"];

const executableEntries = new Map([
  ["bin/lebop", 0o755],
  ["bin/install-claude", 0o755],
  ["scripts/install.sh", 0o755],
]);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE ?? "/tmp/lebop-npm-cache",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

if (process.argv.includes("--workflow-action-refs")) {
  await checkWorkflowActionRefs();
  process.exit(0);
}

const result = await run("npm", ["pack", "--dry-run", "--json"]);
if (result.code !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.code ?? 1);
}

let pack;
try {
  pack = JSON.parse(result.stdout);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`failed to parse npm pack JSON: ${message}\n`);
  process.stderr.write(result.stdout);
  process.exit(1);
}

const packedFiles = pack?.[0]?.files ?? [];
const files = new Set(packedFiles.map((file) => file.path));
const filesByPath = new Map(packedFiles.map((file) => [file.path, file]));
const missing = requiredEntries.filter((entry) => !files.has(entry));
const forbidden = [...files].filter(
  (entry) =>
    forbiddenEntries.includes(entry) ||
    forbiddenPrefixes.some((prefix) => entry.startsWith(prefix)),
);
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const forbiddenScriptRefs = Object.entries(packageJson.scripts ?? {}).filter(
  ([, command]) =>
    typeof command === "string" && forbiddenEntries.some((entry) => command.includes(entry)),
);
const nonExecutable = [...executableEntries.entries()].filter(([entry]) => {
  const mode = filesByPath.get(entry)?.mode;
  return typeof mode !== "number" || (mode & 0o111) === 0;
});

if (
  missing.length > 0 ||
  forbidden.length > 0 ||
  forbiddenScriptRefs.length > 0 ||
  nonExecutable.length > 0
) {
  if (missing.length > 0) {
    process.stderr.write(`npm package missing required entries:\n${missing.join("\n")}\n`);
  }
  if (forbidden.length > 0) {
    process.stderr.write(
      `npm package includes forbidden live/test/local entries:\n${forbidden.join("\n")}\n`,
    );
  }
  if (forbiddenScriptRefs.length > 0) {
    process.stderr.write(
      `package.json scripts reference files intentionally excluded from npm package:\n${forbiddenScriptRefs
        .map(([name, command]) => `${name}: ${command}`)
        .join("\n")}\n`,
    );
  }
  if (nonExecutable.length > 0) {
    process.stderr.write(
      `npm package entries are not executable:\n${nonExecutable
        .map(([entry, expected]) => {
          const actual = filesByPath.get(entry)?.mode;
          return `${entry} expected executable mode like ${expected.toString(8)}, got ${
            typeof actual === "number" ? actual.toString(8) : "missing"
          }`;
        })
        .join("\n")}\n`,
    );
  }
  process.exit(1);
}

process.stdout.write(
  `npm pack dry-run ok: ${pack[0].name}@${pack[0].version}, ${files.size} files\n`,
);

async function checkWorkflowActionRefs() {
  const refs = workflowActionRefs();
  const missing = [];
  for (const ref of refs) {
    if (!/^[a-f0-9]{40}$/i.test(ref.ref)) {
      missing.push(`${ref.spec} (${ref.source}: action ref must be pinned to a full commit SHA)`);
      continue;
    }
    const refResult = await validateWorkflowActionRef(ref);
    if (!refResult.ok) {
      missing.push(`${ref.spec} (${ref.source}: ${refResult.reason})`);
      continue;
    }
    const pathResult = await validateWorkflowActionPath(ref);
    if (!pathResult.ok) {
      missing.push(`${ref.spec} (${ref.source}: ${pathResult.reason})`);
    }
  }
  if (missing.length > 0) {
    process.stderr.write(`workflow action refs do not exist:\n${missing.join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`workflow action refs ok: ${refs.length} refs\n`);
}

function workflowActionRefs() {
  const refs = new Map();
  for (const file of readdirSync(".github/workflows").filter((name) => /\.ya?ml$/.test(name))) {
    const source = `.github/workflows/${file}`;
    const text = readFileSync(source, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = /\buses:\s*['"]?([^'"\s]+)['"]?/.exec(line);
      if (!match) continue;
      const spec = match[1];
      if (
        !spec ||
        spec.startsWith("./") ||
        spec.startsWith("../") ||
        spec.startsWith("docker://")
      ) {
        continue;
      }
      const at = spec.lastIndexOf("@");
      if (at === -1) {
        refs.set(`missing-ref:${source}:${spec}`, {
          repo: "",
          ref: "",
          actionSubpath: "",
          spec,
          source,
          missingRef: true,
        });
        continue;
      }
      const actionPath = spec.slice(0, at);
      const ref = spec.slice(at + 1);
      const parts = actionPath.split("/");
      if (parts.length < 2) continue;
      const repo = `${parts[0]}/${parts[1]}`;
      const actionSubpath = parts.slice(2).join("/");
      refs.set(`${repo}/${actionSubpath}@${ref}`, { repo, ref, actionSubpath, spec, source });
    }
  }
  return [...refs.values()].sort((a, b) => a.spec.localeCompare(b.spec));
}

async function validateWorkflowActionRef(ref) {
  const repoUrl = `https://github.com/${ref.repo}.git`;
  if (/^[a-f0-9]{40}$/i.test(ref.ref)) {
    const tempRepo = mkdtempSync(path.join(tmpdir(), "lebop-action-ref-"));
    try {
      const init = await run("git", ["-C", tempRepo, "init", "-q"]);
      if (init.code !== 0) return { ok: false, reason: "could not initialize temp git repo" };
      const fetch = await run("git", ["-C", tempRepo, "fetch", "--depth=1", repoUrl, ref.ref]);
      return fetch.code === 0
        ? { ok: true }
        : { ok: false, reason: "SHA pin could not be fetched from remote" };
    } finally {
      rmSync(tempRepo, { recursive: true, force: true });
    }
  }

  const result = await run("git", [
    "ls-remote",
    "--exit-code",
    repoUrl,
    `refs/heads/${ref.ref}`,
    `refs/tags/${ref.ref}`,
    `refs/tags/${ref.ref}^{}`,
  ]);
  return result.code === 0 ? { ok: true } : { ok: false, reason: "ref does not exist" };
}

async function validateWorkflowActionPath(ref) {
  const base = ref.actionSubpath ? `${trimSlashes(ref.actionSubpath)}/` : "";
  const candidates = [`${base}action.yml`, `${base}action.yaml`, `${base}Dockerfile`];
  for (const candidate of candidates) {
    if (await rawGithubPathExists(ref.repo, ref.ref, candidate)) return { ok: true };
  }
  return { ok: false, reason: `action metadata not found under ${base || "repo root"}` };
}

function trimSlashes(value) {
  return value.replace(/^\/+|\/+$/g, "");
}

function rawGithubPathExists(repo, ref, filePath) {
  const encodedPath = filePath
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${encodedPath}`;
  return new Promise((resolve) => {
    const request = https.request(
      url,
      {
        method: "HEAD",
        headers: { "User-Agent": "lebop-package-check" },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.on("error", () => resolve(false));
    request.setTimeout(10_000, () => {
      request.destroy();
      resolve(false);
    });
    request.end();
  });
}
