import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadAuth } from "./auth.ts";
import { ConfigError } from "./errors.ts";
import { CONFIG_FILE } from "./paths.ts";
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
  if (typeof parsed !== "object") {
    throw new ConfigError(
      `${CONFIG_FILE}: expected a YAML object at top level`,
      "the config file must start with `key: value` pairs, not a bare scalar or list",
    );
  }
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

export function hashRepoRoot(absPath: string): string {
  return createHash("sha256").update(absPath).digest("hex").slice(0, 12);
}

/**
 * Resolve the active Linear workspace slug for team-default lookup. Order:
 * 1. `LEBOP_WORKSPACE` env (set by the top-level `--workspace <slug>` hook)
 * 2. The auth file's `default` workspace
 * Returns `undefined` if neither exists; callers should still resolve auth
 * separately via `loadAuthForWorkspace`.
 */
async function resolveActiveWorkspace(): Promise<string | undefined> {
  const fromEnv = process.env.LEBOP_WORKSPACE;
  if (fromEnv) return fromEnv;
  const stored = await loadAuth().catch(() => null);
  return stored?.default;
}

export async function resolveConfig(options?: {
  cwd?: string;
  teamOverride?: string;
}): Promise<ResolvedConfig> {
  const cwd = resolve(options?.cwd ?? process.cwd());
  const userConfig = await loadUserConfig();
  const repoRoot = findGitRoot(cwd);

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

  const workspaceUrlPrefix = userConfig.workspaces?.[team]?.url_prefix;

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
