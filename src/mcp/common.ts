import { resolve as resolvePath } from "node:path";
import { findGitRoot, hashRepoRoot } from "../lib/config.ts";
import { NotFoundError, ValidationError } from "../lib/errors.ts";
import { getTeam } from "../lib/teams.ts";
import { isUuid } from "../lib/uuid.ts";

export const WORKSPACE_PARAM_DESCRIPTION =
  "Target Linear workspace slug. Precedence: this param > LEBOP_WORKSPACE env > auth file default. Omit to use the default.";

export function requireMcpEntity<T>(
  value: T | null | undefined,
  label: string,
  id: string,
  hint?: string,
): T {
  if (value === null || value === undefined) {
    throw new NotFoundError(`${label} not found: ${id}`, hint);
  }
  return value;
}

export function resolveMcpRepoCacheContext(repoRootArg: string | undefined): {
  repoRoot: string | null;
  repoHash: string;
} {
  const cwd = resolvePath(repoRootArg ?? process.cwd());
  const repoRoot = findGitRoot(cwd);
  if (repoRootArg && !repoRoot) {
    throw new ValidationError(
      `repo_root is not inside a git repository: ${cwd}`,
      "pass a path inside the intended repo, or omit repo_root to use the MCP server cwd/global cache behavior",
    );
  }
  return { repoRoot, repoHash: repoRoot ? hashRepoRoot(repoRoot) : "_global" };
}

export async function resolveTeamSelectorToId(team: string): Promise<string> {
  if (isUuid(team)) return team;
  const resolved = await getTeam(team);
  if (!resolved) {
    throw new NotFoundError(
      `team not found: ${team}`,
      "pass a valid team key, or pass a team UUID via team_id/team_ids",
    );
  }
  return resolved.id;
}

export function requireConfirm(args: { confirm?: boolean }, toolName: string): void {
  if (args.confirm === true) return;
  throw new ValidationError(
    `${toolName} requires confirm: true`,
    "pass confirm: true after verifying the target and state-changing behavior are exactly what you intend",
  );
}

export function requireNonEmpty(values: string[], field: string, toolName: string): void {
  if (values.length > 0) return;
  throw new ValidationError(
    `${toolName} requires at least one ${field} entry`,
    `pass at least one ${field} value`,
  );
}
