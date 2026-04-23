export type SchemaVersion = 1;

export interface AuthFile {
  schema_version: SchemaVersion;
  token: string;
  viewer: Viewer;
  created_at: string;
}

export interface Viewer {
  id: string;
  email: string;
  name: string;
}

export interface RepoConfig {
  team?: string;
  path_rewrites?: { from: string; to: string }[];
  conventions?: { bracket_issue_refs?: boolean };
}

export interface WorkspaceConfig {
  url_prefix: string;
}

export interface UserConfig {
  default_team?: string;
  workspaces?: Record<string, WorkspaceConfig>;
  repos?: Record<string, RepoConfig>;
}
