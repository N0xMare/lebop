import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import packageJson from "../package.json" with { type: "json" };
import { LEBOP_VERSION } from "../src/lib/version.ts";

function readWorkflow(root: string, name: string): Record<string, unknown> {
  return parseYaml(
    readFileSync(join(root, ".github", "workflows", `${name}.yml`), "utf8"),
  ) as Record<string, unknown>;
}

function workflowJobs(workflow: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return workflow.jobs as Record<string, Record<string, unknown>>;
}

function workflowJob(workflow: Record<string, unknown>, name: string): Record<string, unknown> {
  const jobs = workflowJobs(workflow);
  const found = jobs[name];
  expect(found, `missing workflow job ${name}`).toBeDefined();
  return found as Record<string, unknown>;
}

function workflowStep(job: Record<string, unknown>, name: string): Record<string, unknown> {
  const steps = job.steps as Record<string, unknown>[];
  const found = steps.find((step) => step.name === name);
  expect(found, `missing workflow step ${name}`).toBeDefined();
  return found as Record<string, unknown>;
}

function workflowStepIndex(job: Record<string, unknown>, name: string): number {
  const steps = job.steps as Record<string, unknown>[];
  const index = steps.findIndex((step) => step.name === name);
  expect(index, `missing workflow step ${name}`).toBeGreaterThanOrEqual(0);
  return index;
}

function workflowUsesStep(
  job: Record<string, unknown>,
  uses: string,
  withMatcher?: Record<string, unknown>,
): Record<string, unknown> {
  const steps = job.steps as Record<string, unknown>[];
  const action = uses.includes("@") ? uses.slice(0, uses.lastIndexOf("@")) : uses;
  const found = steps.find((step) => {
    if (typeof step.uses !== "string" || !step.uses.startsWith(`${action}@`)) return false;
    if (!withMatcher) return true;
    return Object.entries(withMatcher).every(
      ([key, value]) => (step.with as Record<string, unknown> | undefined)?.[key] === value,
    );
  });
  expect(found, `missing workflow uses step ${uses}`).toBeDefined();
  return found as Record<string, unknown>;
}

function expectPinnedActionUses(value: unknown, action: string): void {
  expect(value).toEqual(
    expect.stringMatching(new RegExp(`^${escapeRegExp(action)}@[a-f0-9]{40}$`)),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("runtime version metadata", () => {
  it("uses package.json as the single runtime source", () => {
    expect(LEBOP_VERSION).toBe(packageJson.version);
    expect(packageJson.version).toBe("0.0.4");
  });

  it("CLI and MCP server do not hardcode independent runtime versions", () => {
    const cli = readFileSync(join(__dirname, "..", "src", "cli.ts"), "utf8");
    const mcp = readFileSync(join(__dirname, "..", "src", "mcp", "server.ts"), "utf8");

    expect(cli).not.toMatch(/\.version\("v?\d+\.\d+\.\d+"/);
    expect(mcp).not.toMatch(/version:\s*"v?\d+\.\d+\.\d+"/);
  });

  it("package description names the current agent-facing product surface", () => {
    const description = packageJson.description.toLowerCase();
    for (const term of ["workspace", "fetch", "publish", "cache", "mcp"]) {
      expect(description).toContain(term);
    }
  });

  it("has release notes and no stale release-candidate docs", () => {
    const root = join(__dirname, "..");
    const releaseNotes = readFileSync(
      join(root, ".github", "release-notes", `v${packageJson.version}.md`),
      "utf8",
    );
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const spec = readFileSync(join(root, "docs", "spec.md"), "utf8");
    const installer = readFileSync(join(root, "scripts", "install.sh"), "utf8");

    expect(releaseNotes).toContain(`lebop v${packageJson.version}`);
    expect(readme).toContain(`LEBOP_VERSION=v${packageJson.version}`);
    expect(installer).toContain(`LEBOP_VERSION=v${packageJson.version}`);
    expect(spec).toContain(`# ${packageJson.version}`);
    expect(`${readme}\n${spec}\n${installer}`).not.toMatch(
      /v0\.0\.2|0\.0\.2|Roadmap to public release|binary distribution lands in v1\.0|post-pre-release/,
    );
  });

  it("release and canary workflows exercise payload contracts and compiled binaries", () => {
    const root = join(__dirname, "..");
    const release = readWorkflow(root, "release");
    const canary = readWorkflow(root, "canary");
    const spec = readFileSync(join(root, "docs", "spec.md"), "utf8");
    const prTemplate = readFileSync(join(root, ".github", "PULL_REQUEST_TEMPLATE.md"), "utf8");

    expect(release.permissions).toEqual({ contents: "read" });

    const releaseGate = workflowJob(release, "gate");
    const gateRuns = ((releaseGate.steps as Record<string, unknown>[]) ?? [])
      .map((step) => step.run)
      .filter((run): run is string => typeof run === "string");
    expect(gateRuns).toContain("node scripts/check-npm-pack.mjs --workflow-action-refs");
    expect(gateRuns).toContain("actionlint .github/workflows/*.yml");
    expect(gateRuns).toContain("bun run typecheck");
    expect(gateRuns).toContain("bun run check");
    expect(gateRuns).toContain("bun run test");
    expect(gateRuns).toContain("bun run check:package");

    const compiledSmoke = workflowJob(release, "compiled-linux-live-smoke");
    expect(compiledSmoke.name).toBe("compiled Linux x64 full live smoke");
    expect(compiledSmoke.needs).toBe("build");
    expect(compiledSmoke.concurrency).toMatchObject({ group: "noxor-live-write" });
    expect(compiledSmoke.env).toMatchObject({
      LEBOP_HOME: "/tmp/lebop-release-compiled-noxor",
    });
    const downloadCompiled = workflowUsesStep(compiledSmoke, "actions/download-artifact", {
      name: "lebop-linux-x64",
    });
    expectPinnedActionUses(downloadCompiled.uses, "actions/download-artifact");
    expect(downloadCompiled.with).toMatchObject({ name: "lebop-linux-x64" });
    const compiledRun = workflowStep(compiledSmoke, "compiled full live harness").run as string;
    expect(compiledRun).toContain('export LEBOP_LIVE_BIN="$PWD/compiled-live/lebop-linux-x64"');
    expect(compiledRun).toContain("bun scripts/live-nox-surface-smoke.mjs");
    expect(workflowStep(compiledSmoke, "validate compiled full live harness report").env).toEqual({
      LEBOP_LIVE_STAMP: `compiled-\${{ github.run_id }}-\${{ github.run_attempt }}`,
      LEBOP_LIVE_EXPECT_WORKSPACE: "noxor",
      LEBOP_LIVE_EXPECT_TEAM: "NOX",
      LEBOP_LIVE_EXPECT_STAMP: `compiled-\${{ github.run_id }}-\${{ github.run_attempt }}`,
      LEBOP_LIVE_EXPECT_BIN_MODE: "compiled-binary",
    });
    expect(workflowStep(compiledSmoke, "validate compiled full live harness report").run).toContain(
      "LEBOP_LIVE_EXPECT_BIN_SHA256",
    );

    const releasePublish = workflowJob(release, "release");
    expect(releasePublish.name).toBe("publish release");
    expect(releasePublish.needs).toEqual(["build", "compiled-linux-live-smoke"]);
    expect(releasePublish.permissions).toEqual({ contents: "write" });
    expect(workflowStep(releasePublish, "download release binary artifacts").with).toMatchObject({
      pattern: "lebop-*",
      path: "dist",
      "merge-multiple": true,
    });
    const allowlistRun = workflowStep(
      releasePublish,
      "verify release asset allowlist and aggregate SHA256SUMS",
    ).run as string;
    expect(allowlistRun).toContain("release_assets=(");
    expect(allowlistRun).toContain(`cat "\${release_assets[@]/%/.sha256}" > SHA256SUMS`);
    expect(allowlistRun).not.toContain("./dist/*");
    const publishRun = workflowStep(
      releasePublish,
      "publish prerelease for installer smoke (idempotent)",
    ).run as string;
    expect(publishRun).toContain('gh release view "$tag" --json isPrerelease,isLatest');
    expect(publishRun).toContain('if [ "$is_prerelease" = "true" ]; then');
    expect(publishRun).toContain("preserving release state during rerun");
    expect(publishRun).toContain(`gh release upload "$tag" --clobber "\${release_assets[@]}"`);
    expect(publishRun).toContain("--prerelease");
    expect(publishRun).toContain("--latest=false");
    expect(publishRun).not.toContain('gh release upload "$tag" --clobber ./dist/*');
    const preserveBranchStart = publishRun.indexOf("preserving release state during rerun");
    const preserveEdit = publishRun.slice(
      publishRun.indexOf('gh release edit "$tag"', preserveBranchStart),
      publishRun.indexOf("fi", preserveBranchStart),
    );
    expect(preserveEdit).not.toContain("--prerelease");
    expect(preserveEdit).not.toContain("--latest=false");
    const installerSmoke = workflowStep(releasePublish, "smoke published installer").run as string;
    expect(installerSmoke).toContain('LEBOP_VERSION="$tag" bash scripts/install.sh');
    expect(installerSmoke).toContain('"$LEBOP_INSTALL_DIR/lebop" --version');
    expect(installerSmoke).toContain('"$LEBOP_INSTALL_DIR/lebop" list --help');
    expect(installerSmoke).toContain('"$LEBOP_INSTALL_DIR/lebop" plan --help');
    expect(installerSmoke).toContain("installed lebop reported");
    expect(installerSmoke).toContain("installed MCP initialize handshake timed out");
    expect(installerSmoke).toContain(
      'BIN="$LEBOP_INSTALL_DIR/lebop" EXPECTED_VERSION="$expected" node',
    );
    expect(installerSmoke).toContain(
      'clientInfo: { name: "release-installed-smoke", version: "1" }',
    );
    const promoteRun = workflowStep(releasePublish, "promote release to latest").run as string;
    expect(promoteRun).toContain('gh release edit "$tag" --prerelease=false --latest');
    expect(
      workflowStepIndex(releasePublish, "publish prerelease for installer smoke (idempotent)"),
    ).toBeLessThan(workflowStepIndex(releasePublish, "smoke published installer"));
    expect(workflowStepIndex(releasePublish, "smoke published installer")).toBeLessThan(
      workflowStepIndex(releasePublish, "promote release to latest"),
    );

    const publicInstallerSmoke = workflowJob(canary, "public-installer-smoke");
    expect(publicInstallerSmoke.name).toBe("public installer smoke");
    const installerRun = workflowStep(publicInstallerSmoke, "install latest public release")
      .run as string;
    expect(
      workflowStep(publicInstallerSmoke, "install latest public release").env,
    ).not.toHaveProperty("LEBOP_VERSION");
    expect(installerRun).toContain("https://api.github.com/repos/N0xMare/lebop/releases/latest");
    expect(installerRun).toContain(
      "raw.githubusercontent.com/N0xMare/lebop/main/scripts/install.sh",
    );
    expect(installerRun).toContain('LEBOP_VERSION="$latest" bash "$installer"');
    expect(installerRun).toContain("installed lebop reported");
    expect(installerRun).toContain('"$LEBOP_INSTALL_DIR/lebop" --version');
    expect(installerRun).toContain('"$LEBOP_INSTALL_DIR/lebop" mcp --help');

    const smoke = workflowJob(canary, "smoke");
    expect(smoke.concurrency).toMatchObject({ group: "noxor-live-write" });
    expect(smoke.env).toMatchObject({
      LEBOP_CANARY_WORKSPACE: "noxor",
      LEBOP_CANARY_TEAM: "NOX",
    });
    const cliReadSmoke = workflowStep(smoke, "read smoke (CLI surface)").run as string;
    expect(cliReadSmoke).toContain("workspace");
    expect(cliReadSmoke).toContain("LEBOP_CANARY_WORKSPACE");
    expect(cliReadSmoke).toContain("LEBOP_CANARY_TEAM");
    expect(cliReadSmoke).toContain("workspace fetch manifest_file missing or not written");
    expect(cliReadSmoke).not.toContain('workspace: "sandbox"');
    expect(cliReadSmoke).not.toContain('team: "sandbox"');
    const mcpReadSmoke = workflowStep(
      smoke,
      "MCP smoke (initialize + tools/list + tools/call read context)",
    ).run as string;
    expect(mcpReadSmoke).toContain("explore payload items missing");
    expect(mcpReadSmoke).toContain("LEBOP_CANARY_WORKSPACE");
    expect(mcpReadSmoke).toContain("LEBOP_CANARY_TEAM");
    expect(mcpReadSmoke).not.toContain('workspace: "sandbox"');
    expect(mcpReadSmoke).not.toContain('team: "sandbox"');
    expect(workflowStep(smoke, "validate full live harness report").run).toContain(
      'bun scripts/live-nox-surface-smoke.mjs --validate-report "$report"',
    );
    expect(workflowStep(smoke, "validate full live harness report").env).toMatchObject({
      LEBOP_LIVE_EXPECT_WORKSPACE: "noxor",
      LEBOP_LIVE_EXPECT_TEAM: "NOX",
    });

    expect(spec).toContain("full-surface harness on Monday schedules and `workflow_dispatch`");
    expect(spec).toContain("compiled Linux x64 full live smoke");
    expect(spec).toContain("LEBOP_LIVE_EXPECT_BIN_MODE");
    expect(spec).toContain("LEBOP_LIVE_EXPECT_BIN_SHA256");
    expect(prTemplate).toContain("Manual NOX/Noxor sandbox run");
    expect(prTemplate).toContain("Compiled-binary NOX/Noxor sandbox run");
    expect(prTemplate).toContain("LEBOP_LIVE_BIN=/path/to/lebop");
  });

  it("pins all third-party workflow actions to full commit SHAs", () => {
    const root = join(__dirname, "..");
    for (const name of ["ci", "release", "canary"]) {
      const source = readFileSync(join(root, ".github", "workflows", `${name}.yml`), "utf8");
      for (const match of source.matchAll(/\buses:\s*['"]?([^'"\s]+)['"]?/g)) {
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
        expect(at, `${name}: ${spec} missing @ref`).toBeGreaterThan(0);
        expect(spec.slice(at + 1), `${name}: ${spec}`).toMatch(/^[a-f0-9]{40}$/);
      }
    }
  });

  it("standalone action-ref checker rejects external uses without @ref", () => {
    const root = join(__dirname, "..");
    const temp = mkdtempSync(join(tmpdir(), "lebop-action-ref-check-"));
    try {
      mkdirSync(join(temp, "agents", "commands"), { recursive: true });
      mkdirSync(join(temp, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(temp, ".github", "workflows", "bad.yml"),
        [
          "name: bad",
          "on: workflow_dispatch",
          "jobs:",
          "  bad:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/checkout",
          "",
        ].join("\n"),
      );

      const result = spawnSync(
        process.execPath,
        [join(root, "scripts", "check-npm-pack.mjs"), "--workflow-action-refs"],
        { cwd: temp, encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("actions/checkout");
      expect(result.stderr).toContain("action ref must be pinned to a full commit SHA");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("package allowlist includes release-facing docs linked by README", () => {
    expect(packageJson.files).toContain("CONTRIBUTING.md");
    expect(packageJson.files).toContain("scripts/install.sh");
    expect(packageJson.files).not.toContain("scripts");
  });

  it("getting-started plan docs copy the template before apply writes linear_id", () => {
    const root = join(__dirname, "..");
    const readme = readFileSync(
      join(root, "docs", "examples", "getting-started", "README.md"),
      "utf8",
    );
    const project = readFileSync(
      join(root, "docs", "examples", "getting-started", "_project.md"),
      "utf8",
    );

    expect(readme).toContain("cp -R docs/examples/getting-started plans/getting-started-demo");
    expect(readme).toContain('lebop plan apply "$plan_dir"');
    expect(readme).toContain("read-only template");
    expect(project).toContain("cp -R docs/examples/getting-started plans/getting-started-demo");
    expect(project).not.toContain("lebop plan apply docs/examples/getting-started");
  });
});
