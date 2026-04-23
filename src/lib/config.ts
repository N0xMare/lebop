import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
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
    throw new Error(`${CONFIG_FILE}: expected a YAML object at top level`);
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

  const team = options?.teamOverride ?? repoConfig.team ?? userConfig.default_team;
  if (!team) {
    throw new Error(
      "no Linear team resolved. pass --team KEY, or set `default_team` / a per-repo `team` in ~/.leebop/config.yaml",
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
