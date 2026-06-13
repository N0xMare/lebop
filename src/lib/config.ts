import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadAuth } from "./auth.ts";
import { ConfigError, ValidationError } from "./errors.ts";
import { CONFIG_FILE } from "./paths.ts";
import { activeTeamOverride, activeWorkspaceOverride } from "./requestContext.ts";
import type { RepoConfig, UserConfig } from "./types.ts";

export interface ResolvedConfig {
  userConfig: UserConfig;
  repoRoot: string | null;
  repoHash: string;
  repoConfig: RepoConfig;
  team: string;
  workspaceUrlPrefix?: string;
}

const GLOBAL_REPO_ROOT = "_global";

export async function loadUserConfig(): Promise<UserConfig> {
  const file = Bun.file(CONFIG_FILE);
  if (!(await file.exists())) return {};
  const text = await file.text();
  const parsed = parseYaml(text) as unknown;
  if (parsed === null || parsed === undefined) return {};
  if (!isPlainRecord(parsed)) {
    throw new ConfigError(
      `${CONFIG_FILE}: expected a YAML object at top level`,
      "the config file must start with `key: value` pairs, not a bare scalar or list",
    );
  }
  validateUserConfig(parsed);
  return parsed as UserConfig;
}

export function findGitRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function validateUserConfig(config: Record<string, unknown>): void {
  expectOptionalString(config, "default_team", "top level");
  expectOptionalNumber(config, "team_metadata_ttl_seconds", "top level");

  if (config.workspace_team_defaults !== undefined) {
    const defaults = expectRecord(config.workspace_team_defaults, "workspace_team_defaults");
    for (const [workspace, team] of Object.entries(defaults)) {
      if (typeof team !== "string") {
        throwConfigShape(
          `workspace_team_defaults.${workspace}`,
          "expected a team key string for each workspace default",
        );
      }
    }
  }

  if (config.workspaces !== undefined) {
    const workspaces = expectRecord(config.workspaces, "workspaces");
    for (const [key, value] of Object.entries(workspaces)) {
      const workspace = expectRecord(value, `workspaces.${key}`);
      expectOptionalString(workspace, "url_prefix", `workspaces.${key}`);
    }
  }

  if (config.repos !== undefined) {
    const repos = expectRecord(config.repos, "repos");
    for (const [repo, value] of Object.entries(repos)) {
      const repoConfig = expectRecord(value, `repos.${repo}`);
      expectOptionalString(repoConfig, "team", `repos.${repo}`);

      if (repoConfig.path_rewrites !== undefined) {
        if (!Array.isArray(repoConfig.path_rewrites)) {
          throwConfigShape(`repos.${repo}.path_rewrites`, "expected a list of rewrite objects");
        }
        for (const [index, rewrite] of repoConfig.path_rewrites.entries()) {
          const record = expectRecord(rewrite, `repos.${repo}.path_rewrites[${index}]`);
          expectRequiredString(record, "from", `repos.${repo}.path_rewrites[${index}]`);
          expectRequiredString(record, "to", `repos.${repo}.path_rewrites[${index}]`);
        }
      }

      if (repoConfig.conventions !== undefined) {
        const conventions = expectRecord(repoConfig.conventions, `repos.${repo}.conventions`);
        if (
          conventions.bracket_issue_refs !== undefined &&
          typeof conventions.bracket_issue_refs !== "boolean"
        ) {
          throwConfigShape(`repos.${repo}.conventions.bracket_issue_refs`, "expected a boolean");
        }
      }

      if (repoConfig.required_formats !== undefined) {
        if (!Array.isArray(repoConfig.required_formats)) {
          throwConfigShape(
            `repos.${repo}.required_formats`,
            "expected a list of required format objects",
          );
        }
        for (const [index, format] of repoConfig.required_formats.entries()) {
          const record = expectRecord(format, `repos.${repo}.required_formats[${index}]`);
          expectRequiredString(record, "pattern", `repos.${repo}.required_formats[${index}]`);
          expectRequiredString(record, "suggest", `repos.${repo}.required_formats[${index}]`);
          expectOptionalString(record, "message", `repos.${repo}.required_formats[${index}]`);
        }
      }
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throwConfigShape(path, "expected an object");
  return value;
}

function expectOptionalString(record: Record<string, unknown>, key: string, parent: string): void {
  if (record[key] !== undefined && typeof record[key] !== "string") {
    throwConfigShape(`${parent}.${key}`, "expected a string");
  }
}

function expectRequiredString(record: Record<string, unknown>, key: string, parent: string): void {
  if (typeof record[key] !== "string") {
    throwConfigShape(`${parent}.${key}`, "expected a string");
  }
}

function expectOptionalNumber(record: Record<string, unknown>, key: string, parent: string): void {
  if (record[key] !== undefined && typeof record[key] !== "number") {
    throwConfigShape(`${parent}.${key}`, "expected a number");
  }
}

function throwConfigShape(path: string, message: string): never {
  throw new ConfigError(
    `${CONFIG_FILE}: invalid ${path}: ${message}`,
    "fix ~/.lebop/config.yaml so known fields use the documented object and scalar types",
  );
}

export function hashRepoRoot(absPath: string): string {
  return createHash("sha256").update(absPath).digest("hex").slice(0, 12);
}

/**
 * Resolve the active Linear workspace slug for team-default lookup. Order:
 * 1. Request-local workspace override set by top-level `--workspace <slug>`
 * 2. `LEBOP_WORKSPACE` env
 * 3. The auth file's `default` workspace
 * Returns `undefined` if neither exists; callers should still resolve auth
 * separately via `loadAuthForWorkspace`.
 */
async function resolveActiveWorkspace(): Promise<string | undefined> {
  const fromContext = activeWorkspaceOverride();
  if (fromContext) return fromContext;
  const fromEnv = process.env.LEBOP_WORKSPACE;
  if (fromEnv) return fromEnv;
  const stored = await loadAuth().catch(() => null);
  return stored?.default;
}

export async function resolveConfig(options?: {
  cwd?: string;
  teamOverride?: string;
  requireGitRoot?: boolean;
}): Promise<ResolvedConfig> {
  const cwd = resolve(options?.cwd ?? process.cwd());
  const userConfig = await loadUserConfig();
  const repoRoot = findGitRoot(cwd);
  if (options?.requireGitRoot && !repoRoot) {
    throw new ValidationError(
      `repo_root is not inside a git repository: ${cwd}`,
      "pass a path inside the intended repo, or omit repo_root to use the MCP server cwd/global cache behavior",
    );
  }

  let repoConfig: RepoConfig = {};
  if (repoRoot && userConfig.repos?.[repoRoot]) {
    repoConfig = userConfig.repos[repoRoot];
  }

  // Per-workspace team default: looked up by active workspace slug. Sits
  // between repo-config and the global default_team in precedence so that
  // (a) explicit --team always wins, (b) repo overrides win over per-
  // workspace, (c) per-workspace wins over the legacy global default.
  const activeWorkspace = await resolveActiveWorkspace();
  const workspaceTeam = activeWorkspace
    ? userConfig.workspace_team_defaults?.[activeWorkspace]
    : undefined;

  const team =
    options?.teamOverride ??
    activeTeamOverride() ??
    process.env.LEBOP_TEAM ??
    repoConfig.team ??
    workspaceTeam ??
    userConfig.default_team;
  if (!team) {
    // Round-6 / A17: error text + hint are surface-neutral. Both the CLI
    // (`--team`) and MCP (`team` arg) call paths funnel into this; using
    // CLI-flavored prose like "pass --team KEY" leaks into MCP responses
    // (where there's no `--team` flag, only a `team` arg).
    throw new ConfigError(
      "no Linear team resolved. Configure one of: " +
        "`default_team` (single-workspace) or `workspace_team_defaults: { <slug>: <KEY> }` " +
        "(multi-workspace) in ~/.lebop/config.yaml, a per-repo `team`, the `LEBOP_TEAM` env, " +
        "or pass the team explicitly.",
      "pass `team` (MCP arg) / `--team KEY` (CLI flag), or configure a default in ~/.lebop/config.yaml",
    );
  }

  const workspaceUrlPrefix =
    (activeWorkspace ? userConfig.workspaces?.[activeWorkspace]?.url_prefix : undefined) ??
    userConfig.workspaces?.[team]?.url_prefix;

  const repoHash = repoRoot ? hashRepoRoot(repoRoot) : GLOBAL_REPO_ROOT;

  return {
    userConfig,
    repoRoot,
    repoHash,
    repoConfig,
    team,
    workspaceUrlPrefix,
  };
}
