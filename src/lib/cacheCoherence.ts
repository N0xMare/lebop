import type { IssueCacheRefreshResult } from "./cacheRefresh.ts";

export interface IssueCacheRefreshSummary {
  checked: true;
  policy: "refresh-updated-rows-if-cached";
  refreshed: number;
  failed: number;
  not_cached: number;
  rows: IssueCacheRefreshResult[];
}

export interface IssueCacheNotRefreshedSummary {
  checked: false;
  policy: "not-refreshed";
  reason: string;
  repair_hint: string;
  affected: ({ kind: "issue"; identifier: string } | { kind: "comment"; id: string })[];
  repo_hash?: string;
  repo_root?: string | null;
}

export type IssueCacheCoherenceSummary = IssueCacheRefreshSummary | IssueCacheNotRefreshedSummary;

export function summarizeIssueCacheRefresh(
  rows: IssueCacheRefreshResult[],
): IssueCacheRefreshSummary {
  return {
    checked: true,
    policy: "refresh-updated-rows-if-cached",
    refreshed: rows.filter((row) => row.refreshed).length,
    failed: rows.filter((row) => row.present && row.error).length,
    not_cached: rows.filter((row) => !row.present).length,
    rows,
  };
}

export function issueCacheNotRefreshed(input: {
  identifiers: string[];
  reason: string;
  repairHint: string;
  repoHash?: string;
  repoRoot?: string | null;
}): IssueCacheNotRefreshedSummary {
  return {
    checked: false,
    policy: "not-refreshed",
    reason: input.reason,
    repair_hint: input.repairHint,
    affected: input.identifiers.map((identifier) => ({
      kind: "issue",
      identifier,
    })),
    ...(input.repoHash ? { repo_hash: input.repoHash } : {}),
    ...(input.repoRoot !== undefined ? { repo_root: input.repoRoot } : {}),
  };
}

export function commentCacheNotRefreshed(input: {
  commentIds: string[];
  reason: string;
  repairHint: string;
  repoHash?: string;
  repoRoot?: string | null;
}): IssueCacheNotRefreshedSummary {
  return {
    checked: false,
    policy: "not-refreshed",
    reason: input.reason,
    repair_hint: input.repairHint,
    affected: input.commentIds.map((id) => ({ kind: "comment", id })),
    ...(input.repoHash ? { repo_hash: input.repoHash } : {}),
    ...(input.repoRoot !== undefined ? { repo_root: input.repoRoot } : {}),
  };
}
