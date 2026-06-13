import { loadAuthForWorkspace } from "./auth.ts";
import {
  applyCachePushPlans,
  assertCacheRemoteSnapshotCurrent,
  type CachePushResult,
  type CachePushSummary,
  collectCachePushPlans,
  collectCacheRemoteSnapshot,
  hashCachePushPlans,
  verifyCachePushPlansClean,
} from "./cachePush.ts";
import { resolveConfig } from "./config.ts";
import { ValidationError } from "./errors.ts";
import { expandIds } from "./expand.ts";
import { type ApplyResult, applyPlan, preflightPlanApply } from "./planApply.ts";
import { diffPlan, type PlanDiffResult } from "./planDiff.ts";
import {
  countRemainingPlanLintWarnings,
  lintPlanFiles,
  type PlanLintFileResult,
} from "./planLint.ts";
import { parsePlan } from "./planParse.ts";
import { LINK_KEYS, type ParsedPlan, type ValidationResult } from "./planTypes.ts";
import { validatePlanWithFreshTeamMetadata } from "./planValidate.ts";
import {
  createCachePublishReviewRecord,
  createPublishReviewRecord,
  hashPlanDir,
  markPublishReviewApplying,
  markPublishReviewBlocked,
  markPublishReviewCompleted,
  readPublishReviewRecord,
} from "./publishStore.ts";
import {
  buildPullIssuesQuery,
  type FetchedIssue,
  type FetchedProject,
  PULL_PROJECT_HEADER_QUERY,
} from "./pullQuery.ts";
import { withClient } from "./sdk.ts";

export interface PublishSummary {
  ready: boolean;
  blockers: string[];
  warnings: number;
  validation_errors: number;
  validation_warnings: number;
  lint_warnings: number;
  drift: boolean;
  planned_entities: {
    project: number;
    projects: number;
    issues: number;
  };
}

export interface ReviewLinearChangesInput {
  source:
    | { kind: "plan"; dir: string }
    | {
        kind: "cache";
        repo_root?: string;
        identifiers?: string[];
        project_ids?: string[];
        all_modified?: boolean;
      };
  team?: string;
  strict?: boolean;
}

export interface ReviewLinearChangesResult {
  review_id: string;
  source:
    | { kind: "plan"; dir: string }
    | {
        kind: "cache";
        repo_hash: string;
        repo_root?: string;
        identifiers: string[];
        project_ids: string[];
      };
  requested_source?:
    | {
        kind: "cache";
        repo_hash: string;
        repo_root?: string;
        identifiers: string[];
        project_ids: string[];
        all_modified: boolean;
      }
    | undefined;
  team: string;
  ready: boolean;
  summary: PublishSummary;
  validation: ValidationResult | null;
  lint: PlanLintFileResult[] | null;
  diff: PlanDiffResult | null;
  preview: ApplyResult | { results: CachePushResult[]; summary: CachePushSummary } | null;
  next?: {
    tool: "publish_linear_changes";
    arguments: { review_id: string; verify: true; workspace: string };
  };
}

export interface PublishLinearChangesInput {
  reviewId: string;
  verify?: boolean;
}

export interface PublishLinearChangesResult {
  review_id: string;
  source: ReviewLinearChangesResult["source"];
  requested_source?: ReviewLinearChangesResult["requested_source"];
  team: string;
  status: "verified" | "blocked" | "published_with_drift" | "published_unverified";
  summary: PublishSummary;
  validation: ValidationResult | null;
  lint: PlanLintFileResult[] | null;
  result: ApplyResult | { results: CachePushResult[]; summary: CachePushSummary } | null;
  verification: PlanDiffResult | { clean: boolean; dirty: string[] } | null;
}

type PublishRemoteSnapshot = {
  project?: { id: string; updated_at: string };
  issues?: Array<{ identifier: string; id?: string; updated_at: string }>;
  projects?: Array<{ id: string; updated_at: string }>;
  missing?: Array<{ kind: "issue" | "project"; target: string }>;
};

export async function reviewLinearChanges(
  input: ReviewLinearChangesInput,
): Promise<ReviewLinearChangesResult> {
  if (input.source.kind === "cache") {
    return reviewCacheLinearChanges({
      source: input.source,
      team: input.team,
      strict: input.strict,
    });
  }
  const ctx = await loadPlanPublishContext({
    dir: input.source.dir,
    team: input.team,
    strict: input.strict,
  });
  let remoteSnapshot: PublishRemoteSnapshot | undefined;
  let remoteSnapshotError: string | undefined;
  try {
    remoteSnapshot = await collectRemoteSnapshot(ctx.plan);
  } catch (err) {
    remoteSnapshotError = (err as Error).message;
  }
  const diff = await diffPlan(ctx.plan, ctx.teamMetadata);
  const summary = summarize(ctx.plan, ctx.validation, ctx.lint, diff, input.strict);
  if (remoteSnapshotError) {
    addBlockers(summary, [
      `plan publish review preflight: failed to capture review baseline: ${remoteSnapshotError}`,
    ]);
  }
  let preview: ApplyResult | null = null;
  await addPlanPreflightBlockers(summary, ctx.plan);
  if (summary.ready) {
    preview = await applyPlan(ctx.plan, ctx.teamMetadata, {
      dryRun: true,
      force: true,
      strict: input.strict,
      lintCtx: ctx.lintCtx,
    });
    addApplyResultBlockers(summary, preview, "dry-run preview");
  }
  if (summary.ready) {
    try {
      await assertRemoteSnapshotCurrent(remoteSnapshot);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      addBlockers(summary, [`plan publish review preflight: ${err.message}`]);
    }
  }
  const workspace = await currentWorkspaceSnapshot();
  const record = await createPublishReviewRecord({
    dir: ctx.plan.dir,
    team: ctx.config.team,
    strict: input.strict,
    workspace,
    remoteSnapshot,
    review: reviewState(summary),
  });

  return {
    review_id: record.review_id,
    source: record.source,
    team: ctx.config.team,
    ready: summary.ready,
    summary,
    validation: ctx.validation,
    lint: ctx.lint,
    diff,
    preview,
    ...(summary.ready ? { next: publishNext(record.review_id, workspace.url_key) } : {}),
  };
}

export async function publishLinearChanges(
  input: PublishLinearChangesInput,
): Promise<PublishLinearChangesResult> {
  const record = await readPublishReviewRecord(input.reviewId);
  await assertWorkspaceMatches(record.workspace);
  if (record.review?.ready === false) {
    await markPublishReviewBlocked(
      record.review_id,
      `publish review ${record.review_id} was created while blocked`,
      record.review.blockers,
      { allowAlreadyBlocked: true },
    ).catch(() => {});
    return blockedByOriginalReview(record);
  }
  if (record.source.kind === "cache") {
    return publishCacheLinearChanges(input, {
      ...record,
      source: record.source,
    });
  }
  const currentHash = await hashPlanDir(record.source.dir);
  if (currentHash !== record.content_hash) {
    await markPublishReviewBlocked(
      record.review_id,
      `publish review ${record.review_id} is stale`,
      ["the plan changed after review; run review_linear_changes again"],
    ).catch(() => {});
    throw new ValidationError(
      `publish review ${record.review_id} is stale`,
      "the plan changed after review; run review_linear_changes again and publish the new review_id",
    );
  }

  const ctx = await loadPlanPublishContext({
    dir: record.source.dir,
    team: record.team,
    strict: record.strict,
  });
  const initialDiff = await diffPlan(ctx.plan, ctx.teamMetadata);
  const summary = summarize(ctx.plan, ctx.validation, ctx.lint, initialDiff, record.strict);
  await addPlanPreflightBlockers(summary, ctx.plan);
  let preview: ApplyResult | null = null;
  if (summary.ready) {
    preview = await applyPlan(ctx.plan, ctx.teamMetadata, {
      dryRun: true,
      force: true,
      strict: record.strict,
      lintCtx: ctx.lintCtx,
    });
    addApplyResultBlockers(summary, preview, "dry-run preview");
  }
  if (!summary.ready) {
    await markPublishReviewBlocked(
      record.review_id,
      "plan publish blocked by review preflight",
      summary.blockers,
    ).catch(() => {});
    return {
      review_id: record.review_id,
      source: record.source,
      requested_source: record.requested_source,
      team: ctx.config.team,
      status: "blocked",
      summary,
      validation: ctx.validation,
      lint: ctx.lint,
      result: preview,
      verification: null,
    };
  }
  try {
    await assertRemoteSnapshotCurrent(record.remote_snapshot);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    addBlockers(summary, [`plan publish preflight: ${err.message}`]);
    await markPublishReviewBlocked(
      record.review_id,
      `plan publish preflight: ${err.message}`,
      summary.blockers,
    ).catch(() => {});
    return {
      review_id: record.review_id,
      source: record.source,
      requested_source: record.requested_source,
      team: ctx.config.team,
      status: "blocked",
      summary,
      validation: ctx.validation,
      lint: ctx.lint,
      result: preview,
      verification: null,
    };
  }

  await markPublishReviewApplying(record.review_id);
  let result: ApplyResult;
  try {
    result = await applyPlan(ctx.plan, ctx.teamMetadata, {
      force: true,
      strict: record.strict,
      lintCtx: ctx.lintCtx,
    });
  } catch (err) {
    await markPublishReviewCompleted(record.review_id, "failed", (err as Error).message).catch(
      () => {},
    );
    throw err;
  }
  addApplyResultBlockers(summary, result, "plan apply");
  const hasApplyErrors =
    result.project.status === "error" ||
    result.project.status === "created-writeback-failed" ||
    result.project.status === "updated-writeback-failed" ||
    result.issues.some(
      (issue) =>
        issue.status === "error" ||
        issue.status === "lint-blocked" ||
        issue.status === "created-writeback-failed" ||
        issue.status === "updated-writeback-failed",
    ) ||
    result.relations.some((relation) => relation.status === "error");

  let verification: PlanDiffResult | null = null;
  let status: PublishLinearChangesResult["status"] = hasApplyErrors
    ? "published_with_drift"
    : input.verify === false
      ? "published_unverified"
      : "verified";
  if (input.verify !== false) {
    const reparsed = await parsePlan(record.source.dir);
    verification = await diffPlan(reparsed, ctx.teamMetadata);
    if (
      verification.has_drift ||
      verification.has_blockers ||
      verification.has_incomplete_scan ||
      hasApplyErrors
    )
      status = "published_with_drift";
  }
  await markPublishReviewCompleted(
    record.review_id,
    status === "verified" || status === "published_unverified" ? "applied" : "failed",
    status === "published_with_drift" ? "published with drift" : undefined,
  ).catch(() => {});

  return {
    review_id: record.review_id,
    source: record.source,
    requested_source: record.requested_source,
    team: ctx.config.team,
    status,
    summary,
    validation: ctx.validation,
    lint: ctx.lint,
    result,
    verification,
  };
}

async function currentWorkspaceSnapshot(): Promise<{ url_key: string; name: string }> {
  const auth = await loadAuthForWorkspace();
  return { url_key: auth.url_key, name: auth.name };
}

async function reviewCacheLinearChanges(
  input: ReviewLinearChangesInput & {
    source: Extract<ReviewLinearChangesInput["source"], { kind: "cache" }>;
  },
): Promise<ReviewLinearChangesResult> {
  const requestedIdentifiers = normalizeCacheIssueIdentifiers(input.source.identifiers);
  const hasIssueTargets = requestedIdentifiers.length > 0;
  const hasProjectTargets = (input.source.project_ids ?? []).some((id) => id.trim() !== "");
  if (!hasIssueTargets && !hasProjectTargets && input.source.all_modified !== true) {
    throw new ValidationError(
      "cache publish review requires explicit target intent",
      "pass identifiers, project_ids, or all_modified: true / --all-modified to review every modified cache row",
    );
  }
  if (input.source.all_modified === true && (hasIssueTargets || hasProjectTargets)) {
    throw new ValidationError(
      "cache publish review cannot mix all_modified with explicit targets",
      "either pass all_modified: true / --all-modified to review every modified cache row, or pass identifiers/project_ids to review a bounded explicit set",
    );
  }
  const config = await resolveConfig({
    cwd: input.source.repo_root,
    teamOverride: input.team,
    requireGitRoot: Boolean(input.source.repo_root),
  });
  const plans = await collectCachePushPlans(config.repoHash, {
    identifiers: requestedIdentifiers,
    projectIds: input.source.project_ids,
    includeUnchanged: hasIssueTargets || hasProjectTargets,
  });
  const lintCtx = {
    repoConfig: config.repoConfig,
    workspaceUrlPrefix: config.workspaceUrlPrefix,
  };
  const preview = await applyCachePushPlans({
    repoHash: config.repoHash,
    team: config.team,
    plans,
    lintCtx,
    dryRun: true,
    strict: input.strict,
  });
  const summary = summarizeCachePreview(preview, plans);
  const workspace = await currentWorkspaceSnapshot();
  const remoteSnapshot = await collectCacheRemoteSnapshot(plans);
  const source = {
    kind: "cache" as const,
    repo_hash: config.repoHash,
    ...(config.repoRoot ? { repo_root: config.repoRoot } : {}),
    identifiers: plans
      .filter((p) => p.kind === "issue")
      .map((p) => ("identifier" in p ? p.identifier : ""))
      .filter(Boolean),
    project_ids: plans.filter((p) => p.kind === "project").map((p) => ("id" in p ? p.id : "")),
  };
  const requestedSource = {
    kind: "cache" as const,
    repo_hash: config.repoHash,
    ...(config.repoRoot ? { repo_root: config.repoRoot } : {}),
    identifiers: requestedIdentifiers,
    project_ids: normalizeCacheProjectIds(input.source.project_ids),
    all_modified: input.source.all_modified === true,
  };
  const record = await createCachePublishReviewRecord({
    source,
    requestedSource,
    team: config.team,
    strict: input.strict,
    contentHash: hashCachePushPlans(plans),
    workspace,
    remoteSnapshot,
    review: reviewState(summary),
  });

  return {
    review_id: record.review_id,
    source: record.source,
    requested_source: record.requested_source,
    team: config.team,
    ready: summary.ready,
    summary,
    validation: null,
    lint: null,
    diff: null,
    preview,
    ...(summary.ready ? { next: publishNext(record.review_id, workspace.url_key) } : {}),
  };
}

async function publishCacheLinearChanges(
  input: PublishLinearChangesInput,
  record: Awaited<ReturnType<typeof readPublishReviewRecord>> & {
    source: Extract<ReviewLinearChangesResult["source"], { kind: "cache" }>;
  },
): Promise<PublishLinearChangesResult> {
  const config = await resolveConfig({
    cwd: record.source.repo_root,
    teamOverride: record.team,
    requireGitRoot: Boolean(record.source.repo_root),
  });
  if (config.repoHash !== record.source.repo_hash) {
    throw new ValidationError(
      `publish review ${record.review_id} was created for repo cache ${record.source.repo_hash}, but current repo cache is ${config.repoHash}`,
      "run publish apply from the same repo root used during review, or run review_linear_changes again",
    );
  }
  const plans = await collectCachePushPlans(config.repoHash, {
    identifiers: record.source.identifiers,
    projectIds: record.source.project_ids,
    includeUnchanged: record.source.identifiers.length > 0 || record.source.project_ids.length > 0,
  });
  const currentHash = hashCachePushPlans(plans);
  if (currentHash !== record.content_hash) {
    await markPublishReviewBlocked(
      record.review_id,
      `publish review ${record.review_id} is stale`,
      ["the cache changed after review; run review_linear_changes again"],
    ).catch(() => {});
    throw new ValidationError(
      `publish review ${record.review_id} is stale`,
      "the cache changed after review; run review_linear_changes again and publish the new review_id",
    );
  }
  const lintCtx = {
    repoConfig: config.repoConfig,
    workspaceUrlPrefix: config.workspaceUrlPrefix,
  };
  if (record.remote_snapshot) {
    try {
      await assertCacheRemoteSnapshotCurrent(record.remote_snapshot);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      const preview = await applyCachePushPlans({
        repoHash: config.repoHash,
        team: config.team,
        plans,
        lintCtx,
        dryRun: true,
        strict: record.strict,
      });
      const summary = summarizeCachePreview(preview, plans);
      const blocker = `cache publish preflight: ${err.message}`;
      if (!summary.blockers.includes(blocker)) summary.blockers.push(blocker);
      summary.ready = false;
      summary.drift = true;
      await markPublishReviewBlocked(record.review_id, blocker, summary.blockers).catch(() => {});
      return {
        review_id: record.review_id,
        source: record.source,
        requested_source: record.requested_source,
        team: config.team,
        status: "blocked",
        summary,
        validation: null,
        lint: null,
        result: preview,
        verification: null,
      };
    }
  }
  await markPublishReviewApplying(record.review_id);
  let result: Awaited<ReturnType<typeof applyCachePushPlans>>;
  try {
    result = await applyCachePushPlans({
      repoHash: config.repoHash,
      team: config.team,
      plans,
      lintCtx,
      strict: record.strict,
    });
  } catch (err) {
    await markPublishReviewCompleted(record.review_id, "failed", (err as Error).message).catch(
      () => {},
    );
    throw err;
  }
  const summary = summarizeCachePreview(result, plans);
  const writebackFailures = result.results.filter(
    (row) => row.status === "pushed-writeback-failed",
  );
  const hasFailures = result.summary.failed > 0;
  if (!summary.ready) {
    if (result.summary.applied > 0) {
      summary.drift = true;
      await markPublishReviewCompleted(
        record.review_id,
        "failed",
        "cache publish applied some rows but finished with blockers",
      ).catch(() => {});
      return {
        review_id: record.review_id,
        source: record.source,
        requested_source: record.requested_source,
        team: config.team,
        status: "published_with_drift",
        summary,
        validation: null,
        lint: null,
        result,
        verification: null,
      };
    }
    await markPublishReviewCompleted(record.review_id, "failed", "cache publish blocked").catch(
      () => {},
    );
    return {
      review_id: record.review_id,
      source: record.source,
      requested_source: record.requested_source,
      team: config.team,
      status: "blocked",
      summary,
      validation: null,
      lint: null,
      result,
      verification: null,
    };
  }
  let verification: { clean: boolean; dirty: string[] } | null = null;
  let status: PublishLinearChangesResult["status"] =
    writebackFailures.length > 0
      ? "published_with_drift"
      : hasFailures && result.summary.applied > 0
        ? "published_with_drift"
        : hasFailures
          ? "blocked"
          : input.verify === false
            ? "published_unverified"
            : "verified";
  if (input.verify !== false && !hasFailures && writebackFailures.length === 0) {
    verification = await verifyCachePushPlansClean(config.repoHash, plans, {
      attempts: 4,
      delayMs: 1000,
    });
    if (!verification.clean) status = "published_with_drift";
  }
  await markPublishReviewCompleted(
    record.review_id,
    status === "verified" || status === "published_unverified" ? "applied" : "failed",
    status === "published_with_drift" || status === "blocked"
      ? `cache publish finished with status ${status}`
      : undefined,
  ).catch(() => {});
  return {
    review_id: record.review_id,
    source: record.source,
    requested_source: record.requested_source,
    team: config.team,
    status,
    summary,
    validation: null,
    lint: null,
    result,
    verification,
  };
}

async function assertWorkspaceMatches(recorded: { url_key?: string; name?: string } | undefined) {
  if (!recorded?.url_key) return;
  const current = await loadAuthForWorkspace();
  if (current.url_key !== recorded.url_key) {
    throw new ValidationError(
      `publish review was created for workspace ${recorded.url_key}, but current workspace is ${current.url_key}`,
      "publish with the same workspace used for review, or run review_linear_changes again in the target workspace",
    );
  }
}

function publishNext(
  reviewId: string,
  workspace: string,
): NonNullable<ReviewLinearChangesResult["next"]> {
  return {
    tool: "publish_linear_changes",
    arguments: { review_id: reviewId, verify: true, workspace },
  };
}

function reviewState(summary: PublishSummary): {
  ready: boolean;
  blockers: string[];
  status: "ready" | "blocked";
} {
  return {
    ready: summary.ready,
    blockers: [...summary.blockers],
    status: summary.ready ? "ready" : "blocked",
  };
}

function blockedByOriginalReview(
  record: Awaited<ReturnType<typeof readPublishReviewRecord>>,
): PublishLinearChangesResult {
  const storedBlockers = record.review?.blockers ?? [];
  const blockers = [
    `publish review ${record.review_id} was created while blocked`,
    ...storedBlockers,
  ];
  return {
    review_id: record.review_id,
    source: record.source,
    requested_source: record.requested_source,
    team: record.team,
    status: "blocked",
    summary: {
      ready: false,
      blockers,
      warnings: 0,
      validation_errors: 0,
      validation_warnings: 0,
      lint_warnings: 0,
      drift: true,
      planned_entities: {
        project: 0,
        projects: 0,
        issues: 0,
      },
    },
    validation: null,
    lint: null,
    result: null,
    verification: null,
  };
}

async function collectRemoteSnapshot(
  plan: ParsedPlan,
  diff?: PlanDiffResult,
): Promise<PublishRemoteSnapshot> {
  const snapshot: PublishRemoteSnapshot = {};
  const projectId = plan.project.frontmatter.linear_id;
  if (projectId && diff?.project.status === "missing-remote") {
    snapshot.missing ??= [];
    snapshot.missing.push({ kind: "project", target: projectId });
  } else if (projectId && diff?.project.status !== "error") {
    const response = (await withClient((c) =>
      c.client.rawRequest(PULL_PROJECT_HEADER_QUERY, { id: projectId }),
    )) as { data: { project: Omit<FetchedProject, "issues"> | null } };
    const project = response.data.project;
    if (project) {
      snapshot.project = { id: project.id, updated_at: project.updatedAt };
    } else {
      snapshot.missing ??= [];
      snapshot.missing.push({ kind: "project", target: projectId });
    }
  }
  const issueDiffsBySlug = new Map((diff?.issues ?? []).map((issue) => [issue.slug, issue]));
  const issuesToSnapshot = plan.issues.flatMap((issue) => {
    const id = issue.frontmatter.linear_id;
    if (typeof id !== "string" || id.trim() === "") return [];
    const issueDiff = issueDiffsBySlug.get(issue.slug);
    if (diff !== undefined && issueDiff === undefined) return [];
    return [{ id, diff: issueDiff }];
  });
  for (const entry of issuesToSnapshot) {
    if (entry.diff?.status === "missing-remote") {
      snapshot.missing ??= [];
      snapshot.missing.push({ kind: "issue", target: entry.id });
    }
  }
  const issueIds = issuesToSnapshot
    .filter((entry) => entry.diff?.status !== "missing-remote" && entry.diff?.status !== "error")
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === "string" && id.trim() !== "");
  const relationTargets = collectExternalRelationTargets(plan);
  const issueTargets = Array.from(new Set([...issueIds, ...relationTargets]));
  if (issueTargets.length > 0) {
    const response = (await withClient((c) =>
      c.client.rawRequest(buildPullIssuesQuery(issueTargets, false)),
    )) as { data: Record<string, FetchedIssue | null> };
    snapshot.issues = issueTargets.flatMap((identifier, i) => {
      const issue = response.data[`a${i}`];
      if (issue)
        return [{ identifier: issue.identifier, id: issue.id, updated_at: issue.updatedAt }];
      snapshot.missing ??= [];
      snapshot.missing.push({ kind: "issue", target: identifier });
      return [];
    });
  }
  return snapshot;
}

function collectExternalRelationTargets(plan: ParsedPlan): string[] {
  const slugToId = new Map<string, string>();
  const localIssueIds = new Set<string>();
  const localSlugs = new Set<string>();
  for (const issue of plan.issues) {
    localSlugs.add(issue.slug);
    if (issue.frontmatter.linear_id) {
      slugToId.set(issue.slug, issue.frontmatter.linear_id);
      localIssueIds.add(issue.frontmatter.linear_id);
    }
  }
  const targets = new Set<string>();
  for (const issue of plan.issues) {
    for (const key of LINK_KEYS) {
      const links = issue.frontmatter[key];
      if (!Array.isArray(links)) continue;
      for (const raw of links) {
        if (typeof raw !== "string" || raw.trim() === "") continue;
        if (localSlugs.has(raw) && !slugToId.has(raw)) continue;
        const resolved = slugToId.get(raw) ?? raw;
        if (!localIssueIds.has(resolved)) targets.add(resolved);
      }
    }
  }
  return Array.from(targets);
}

async function assertRemoteSnapshotCurrent(
  snapshot: PublishRemoteSnapshot | undefined,
): Promise<void> {
  if (!snapshot) return;
  const changed: string[] = [];
  if (snapshot.project) {
    const expectedProject = snapshot.project;
    const response = (await withClient((c) =>
      c.client.rawRequest(PULL_PROJECT_HEADER_QUERY, { id: expectedProject.id }),
    )) as { data: { project: Omit<FetchedProject, "issues"> | null } };
    const project = response.data.project;
    if (!project || project.updatedAt !== expectedProject.updated_at) {
      changed.push(`project/${expectedProject.id}`);
    }
  }
  const issues = snapshot.issues ?? [];
  if (issues.length > 0) {
    const response = (await withClient((c) =>
      c.client.rawRequest(
        buildPullIssuesQuery(
          issues.map((issue) => issue.identifier),
          false,
        ),
      ),
    )) as { data: Record<string, FetchedIssue | null> };
    for (let i = 0; i < issues.length; i++) {
      const expected = issues[i];
      if (!expected) continue;
      const issue = response.data[`a${i}`];
      if (!issue || issue.updatedAt !== expected.updated_at) {
        changed.push(expected.identifier);
      }
    }
  }
  const missing = snapshot.missing ?? [];
  if (missing.length > 0) {
    const stillMissing: string[] = [];
    const reappeared: string[] = [];
    for (const entry of missing) {
      if (entry.kind === "project") {
        const response = (await withClient((c) =>
          c.client.rawRequest(PULL_PROJECT_HEADER_QUERY, { id: entry.target }),
        )) as { data: { project: Omit<FetchedProject, "issues"> | null } };
        if (response.data.project) reappeared.push(`project/${entry.target}`);
        else stillMissing.push(`project/${entry.target}`);
      } else {
        const response = (await withClient((c) =>
          c.client.rawRequest(buildPullIssuesQuery([entry.target], false)),
        )) as { data: Record<string, FetchedIssue | null> };
        if (response.data.a0) reappeared.push(entry.target);
        else stillMissing.push(entry.target);
      }
    }
    if (reappeared.length > 0) changed.push(...reappeared);
    if (stillMissing.length > 0) {
      throw new ValidationError(
        `publish review contains missing Linear remotes: ${stillMissing.join(", ")}`,
        "run review_linear_changes again after restoring the remotes, or remove their linear_id values before reviewing a create",
      );
    }
  }
  if (changed.length > 0) {
    throw new ValidationError(
      `Linear changed after publish review: ${changed.join(", ")}`,
      "run review_linear_changes again to inspect the latest remote state before publishing",
    );
  }
}

async function loadPlanPublishContext(input: { dir: string; team?: string; strict?: boolean }) {
  const plan = await parsePlan(input.dir);
  const teamKey = input.team ?? plan.project.frontmatter.team;
  const config = await resolveConfig({ teamOverride: teamKey });
  const lintCtx = {
    repoConfig: config.repoConfig,
    workspaceUrlPrefix: config.workspaceUrlPrefix,
  };
  const { teamMetadata, validation } = await validatePlanWithFreshTeamMetadata(plan, {
    repoHash: config.repoHash,
    team: config.team,
    lintCtx,
  });
  const lint = await lintPlanFiles(plan, { fix: false, lintCtx });
  return { plan, config, teamMetadata, lintCtx, validation, lint };
}

function summarize(
  plan: ParsedPlan,
  validation: ValidationResult,
  lint: PlanLintFileResult[],
  diff: PlanDiffResult,
  strict: boolean | undefined,
): PublishSummary {
  const lintWarnings = countRemainingPlanLintWarnings(lint, false);
  const blockers = validation.errors.map((error) =>
    error.path ? `${error.path}: ${error.message}` : error.message,
  );
  blockers.push(...planDiffBlockers(diff));
  if (strict && lintWarnings > 0) {
    blockers.push(`${lintWarnings} lint warning(s) remain and strict mode is enabled`);
  }
  return {
    ready: blockers.length === 0,
    blockers,
    warnings: validation.warnings.length + lintWarnings,
    validation_errors: validation.errors.length,
    validation_warnings: validation.warnings.length,
    lint_warnings: lintWarnings,
    drift: diff.has_drift || diff.has_blockers || diff.has_incomplete_scan,
    planned_entities: {
      project: 1,
      projects: 1,
      issues: plan.issues.length,
    },
  };
}

function planDiffBlockers(diff: PlanDiffResult): string[] {
  const blockers: string[] = [];
  if (diff.project.status === "missing-remote") {
    blockers.push(`project/${diff.project.linear_id}: remote project is missing`);
  } else if (diff.project.status === "error") {
    blockers.push(
      `project/${diff.project.linear_id ?? diff.project.name}: ${diff.project.error ?? "diff failed"}`,
    );
  }
  for (const issue of diff.issues) {
    if (issue.status === "missing-remote") {
      blockers.push(`issue/${issue.linear_id}: remote issue is missing`);
    } else if (issue.status === "error") {
      blockers.push(`issue/${issue.linear_id ?? issue.slug}: ${issue.error ?? "diff failed"}`);
    }
  }
  if (diff.extra_remote_issues_error) {
    blockers.push(`remote-only issue scan failed: ${diff.extra_remote_issues_error}`);
  }
  return blockers;
}

async function addPlanPreflightBlockers(summary: PublishSummary, plan: ParsedPlan): Promise<void> {
  if (!summary.ready) return;
  const preflight = await preflightPlanApply(plan);
  if (preflight.ready) return;
  addBlockers(
    summary,
    preflight.blockers.map((blocker) => `plan apply preflight: ${blocker}`),
  );
}

function addApplyResultBlockers(
  summary: PublishSummary,
  result: ApplyResult,
  prefix: string,
): void {
  const blockers: string[] = [];
  if (
    result.project.status === "error" ||
    result.project.status === "created-writeback-failed" ||
    result.project.status === "updated-writeback-failed"
  ) {
    blockers.push(
      `${prefix}: project/${result.project.name}: ${result.project.error ?? result.project.status}`,
    );
  }
  for (const issue of result.issues) {
    if (
      issue.status === "error" ||
      issue.status === "lint-blocked" ||
      issue.status === "created-writeback-failed" ||
      issue.status === "updated-writeback-failed"
    ) {
      blockers.push(
        `${prefix}: issue/${issue.linearId ?? issue.slug}: ${issue.error ?? issue.status}`,
      );
    }
  }
  for (const relation of result.relations) {
    if (relation.status === "error") {
      blockers.push(
        `${prefix}: relation/${relation.fromIdentifier}/${relation.kind}/${relation.toIdentifier}: ${relation.error ?? relation.status}`,
      );
    }
  }
  addBlockers(summary, blockers);
}

function addBlockers(summary: PublishSummary, blockers: string[]): void {
  for (const blocker of blockers) {
    if (!summary.blockers.includes(blocker)) summary.blockers.push(blocker);
  }
  summary.ready = summary.blockers.length === 0;
  summary.drift = summary.drift || blockers.length > 0;
}

function summarizeCachePreview(
  preview: { results: CachePushResult[]; summary: CachePushSummary },
  plans: Awaited<ReturnType<typeof collectCachePushPlans>>,
): PublishSummary {
  const blockers = preview.results
    .filter((result) =>
      ["error", "stale", "remote-missing", "lint-blocked", "pushed-writeback-failed"].includes(
        result.status,
      ),
    )
    .map((result) =>
      result.error
        ? `${result.kind}/${result.target}: ${result.error}`
        : `${result.kind}/${result.target}: ${result.status}`,
    );
  if (plans.length === 0) {
    blockers.push("no modified cache rows selected");
  }
  const lintWarnings = preview.results.reduce((n, result) => n + (result.warnings?.length ?? 0), 0);
  const writebackFailures = preview.results.filter(
    (result) => result.status === "pushed-writeback-failed",
  ).length;
  const issueCount = plans.filter((p) => p.kind === "issue").length;
  const projectCount = plans.filter((p) => p.kind === "project").length;
  return {
    ready: blockers.length === 0,
    blockers,
    warnings: lintWarnings + writebackFailures,
    validation_errors: 0,
    validation_warnings: 0,
    lint_warnings: lintWarnings,
    drift:
      writebackFailures > 0 ||
      blockers.some((blocker) => blocker.includes("stale") || blocker.includes("remote-missing")),
    planned_entities: {
      project: projectCount,
      projects: projectCount,
      issues: issueCount,
    },
  };
}

function normalizeCacheIssueIdentifiers(value: string[] | undefined): string[] {
  return expandIds((value ?? []).map((id) => id.trim()).filter(Boolean));
}

function normalizeCacheProjectIds(value: string[] | undefined): string[] {
  return [...new Set((value ?? []).map((id) => id.trim()).filter(Boolean))];
}
