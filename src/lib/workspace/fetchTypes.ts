/**
 * Shared types for workspace fetch (mechanical extract).
 */
import type { ContextFile } from "../workspaceContextWriter.ts";

export type FetchDepth = "shallow" | "full";

export interface FetchLinearWorkspaceInput {
  target: string;
  include?: string[];
  depth?: FetchDepth;
  limit?: number;
  to?: string;
  repoRoot?: string;
  workspace?: string;
  cursor?: string;
}

export interface FetchLinearWorkspaceResult {
  target: string;
  kind: string;
  requested_path_kind: string;
  focused_collection: string | null;
  selected_includes: string[];
  root: string;
  manifest_file: string;
  index_file: string;
  summary_file: string;
  counts: Record<string, number>;
  completeness: Record<string, FetchCompletenessEntry>;
  omitted: string[];
  truncated: boolean;
  recommended_reads: string[];
  continuations: FetchContinuation[];
}

export interface FetchContinuation {
  tool: "fetch_linear_workspace" | "explore_linear_workspace";
  reason: string;
  args: Record<string, unknown>;
}

export interface FetchCompletenessEntry {
  returned: number;
  limit: number | null;
  complete: boolean;
  truncated: boolean;
  total_available?: number;
  limit_semantics?: "per_collection" | "per_parent" | "per_direction" | "per_parent_direction";
  reason?: string;
}

export interface FetchSelection {
  requested_path_kind: string;
  focused_collection: string | null;
  selected_includes: string[];
}

export interface FetchCollectionFragment {
  files: ContextFile[];
  counts: Record<string, number>;
  completeness: Record<string, FetchCompletenessEntry>;
  omitted: string[];
  continuations: FetchContinuation[];
}
