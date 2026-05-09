/**
 * Auth file schema version. Bumped when the on-disk shape changes
 * incompatibly. Version 1 stored a single workspace's credentials; version 2
 * stores N workspaces keyed by slug with an optional `default`. lebop
 * auto-migrates v1 → v2 transparently on first read.
 */
export type SchemaVersion = 1 | 2;

export interface Viewer {
  id: string;
  email: string;
  name: string;
}

/**
 * One workspace's stored credentials. The slug is the Linear organization
 * `urlKey` (the part after `linear.app/` in the URL). Used as the key in
 * `AuthFile.workspaces` and as the value of `--workspace <slug>`.
 */
export interface WorkspaceAuth {
  slug: string;
  name: string;
  url_key: string;
  token: string;
  viewer: Viewer;
  created_at: string;
}

/**
 * On-disk auth file. Version 2 supports multiple workspaces. Always written
 * at version 2; reads accept either version and migrate transparently.
 */
export interface AuthFile {
  schema_version: SchemaVersion;
  workspaces: Record<string, WorkspaceAuth>;
  default?: string;
}

/**
 * Legacy v1 shape — single workspace, no slug. Kept for migration only.
 * New code should use `AuthFile`.
 */
export interface AuthFileV1 {
  schema_version: 1;
  token: string;
  viewer: Viewer;
  created_at: string;
}

export interface RepoConfig {
  team?: string;
  path_rewrites?: { from: string; to: string }[];
  conventions?: { bracket_issue_refs?: boolean };
  required_formats?: { pattern: string; suggest: string; message?: string }[];
}

export interface WorkspaceConfig {
  url_prefix: string;
}

export interface UserConfig {
  default_team?: string;
  /**
   * Per-workspace team defaults keyed by Linear workspace slug (the
   * `urlKey` — what appears after `linear.app/` in URLs and in
   * `lebop auth list`). Lets a single config sensibly drive multiple
   * workspaces without `default_team` leaking across boundaries.
   *
   * Example:
   *   workspace_team_defaults:
   *     unlink-xyz: UE
   *     noxor: NOX
   */
  workspace_team_defaults?: Record<string, string>;
  workspaces?: Record<string, WorkspaceConfig>;
  repos?: Record<string, RepoConfig>;
}
