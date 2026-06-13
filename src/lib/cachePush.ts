import { buildIssueMetadata, buildProjectMetadata } from "./build.ts";
import {
  type IssueMetadata,
  inspectCacheIntegrity,
  issueDir,
  listCachedIssues,
  listCachedProjectIds,
  type ProjectMetadata,
  projectDir,
  readIssue,
  readProject,
  sha256,
  writeIssue,
  writeProject,
} from "./cache.ts";
import {
  diffIssueMetadata,
  diffProjectMetadata,
  type IssueChange,
  type ProjectChange,
} from "./diff.ts";
import { ValidationError } from "./errors.ts";
import { expandIds } from "./expand.ts";
import { assertIconNotEmoji } from "./icons.ts";
import { lintContent } from "./lint.ts";
import { requireMutationEntity } from "./mutationResult.ts";
import {
  buildPullIssuesQuery,
  type FetchedIssue,
  type FetchedProject,
  PULL_PROJECT_HEADER_QUERY,
} from "./pullQuery.ts";
import { buildIssueUpdateInput, buildProjectUpdateInput } from "./pushBuild.ts";
import {
  fetchIssueCasStates,
  fetchProjectCasStates,
  ISSUE_UPDATE_MUTATION,
  type IssueUpdateInput,
  PROJECT_UPDATE_MUTATION,
} from "./pushMutations.ts";
import type { LintContext, Warning } from "./quirks.ts";
import { getTeamMetadata, withFreshMetadataOnMiss } from "./resolve.ts";
import { withClient } from "./sdk.ts";

export interface IssueCachePushPlan {
  kind: "issue";
  identifier: string;
  metadata: IssueMetadata;
  description: string;
  changes: IssueChange[];
  cache_path: string;
}

export interface ProjectCachePushPlan {
  kind: "project";
  id: string;
  metadata: ProjectMetadata;
  content: string;
  changes: ProjectChange[];
  cache_path: string;
}

export type CachePushPlan = IssueCachePushPlan | ProjectCachePushPlan;

export interface CachePushVerificationOptions {
  attempts?: number;
  delayMs?: number;
}

export interface CachePushTargetInput {
  identifiers?: string[];
  projectIds?: string[];
  includeUnchanged?: boolean;
}

export interface CachePushResult {
  target: string;
  kind: "issue" | "project";
  status:
    | "pushed"
    | "pushed-writeback-failed"
    | "stale"
    | "remote-missing"
    | "error"
    | "dry-run"
    | "unchanged"
    | "lint-blocked";
  fields?: string[];
  error?: string;
  warnings?: SerializedLintWarning[];
}

export interface CachePushSummary {
  total: number;
  applied: number;
  skipped: number;
  failed: number;
  writeback_failed?: number;
}

export interface SerializedLintWarning {
  rule: string;
  severity: string;
  message: string;
  line: number;
}

export type CachePushLintContext = LintContext;

export async function collectCachePushPlans(
  repoHash: string,
  input: CachePushTargetInput = {},
): Promise<CachePushPlan[]> {
  const explicitIds = normalizeIdentifiers(input.identifiers);
  const explicitProjectIds = normalizeProjectIds(input.projectIds);
  const includeUnchanged = input.includeUnchanged === true;
  const plans: CachePushPlan[] = [];
  if (explicitIds.length === 0 && explicitProjectIds.length === 0) {
    await assertImplicitCacheIntegrityOk(repoHash);
  }

  const targetIssueIds =
    explicitIds.length > 0
      ? explicitIds
      : explicitProjectIds.length > 0
        ? []
        : await listCachedIssues(repoHash);

  for (const id of targetIssueIds) {
    const loaded = await readIssue(repoHash, id);
    if (!loaded) {
      if (explicitIds.length > 0) {
        throw new ValidationError(
          `${id} not in cache`,
          `run \`lebop pull ${id}\` first, or remove it from the reviewed cache source`,
        );
      }
      continue;
    }
    const changes = diffIssueMetadata(loaded.metadata, loaded.description);
    if (changes.length === 0 && !includeUnchanged) continue;
    plans.push({
      kind: "issue",
      identifier: id,
      metadata: loaded.metadata,
      description: loaded.description,
      changes,
      cache_path: issueDir(repoHash, id),
    });
  }

  if (explicitIds.length === 0 || explicitProjectIds.length > 0) {
    const targetProjectIds =
      explicitProjectIds.length > 0 ? explicitProjectIds : await listCachedProjectIds(repoHash);
    for (const projectId of targetProjectIds) {
      const loaded = await readProject(repoHash, projectId);
      if (!loaded) {
        if (explicitProjectIds.length > 0) {
          throw new ValidationError(
            `project/${projectId} not in cache`,
            `run \`lebop pull --project-id ${projectId}\` first, or remove it from the reviewed cache source`,
          );
        }
        continue;
      }
      const changes = diffProjectMetadata(loaded.metadata, loaded.content);
      if (changes.length === 0 && !includeUnchanged) continue;
      plans.push({
        kind: "project",
        id: projectId,
        metadata: loaded.metadata,
        content: loaded.content,
        changes,
        cache_path: projectDir(repoHash, projectId),
      });
    }
  }

  return plans;
}

async function assertImplicitCacheIntegrityOk(repoHash: string): Promise<void> {
  const problems = await inspectCacheIntegrity(repoHash);
  if (problems.length === 0) return;
  const first = problems[0];
  const summary = problems
    .slice(0, 5)
    .map((problem) => {
      const missing =
        problem.missing_files.length > 0 ? ` missing ${problem.missing_files.join(",")}` : "";
      return `${problem.kind}/${problem.id} ${problem.problem}${missing}`;
    })
    .join("; ");
  throw new ValidationError(
    `cache has ${problems.length} integrity problem${problems.length === 1 ? "" : "s"}: ${summary}`,
    first?.repair_hint ??
      "run `lebop status --json` to inspect cache integrity problems before pushing or publishing",
  );
}

export function hashCachePushPlans(plans: CachePushPlan[]): string {
  const chunks = plans
    .map((plan) => {
      const key = plan.kind === "issue" ? plan.identifier : plan.id;
      const body =
        plan.kind === "issue" ? JSON.stringify(plan.metadata) : JSON.stringify(plan.metadata);
      const content = plan.kind === "issue" ? plan.description : plan.content;
      return `${plan.kind}\0${key}\0${body}\0${content}`;
    })
    .sort();
  return sha256(chunks.join("\0"));
}

export async function collectCacheRemoteSnapshot(plans: CachePushPlan[]): Promise<{
  issues: Array<{ identifier: string; id?: string; updated_at: string }>;
  projects: Array<{ id: string; updated_at: string }>;
  missing: Array<{ kind: "issue" | "project"; target: string }>;
}> {
  const issuePlans = plans.filter((p): p is IssueCachePushPlan => p.kind === "issue");
  const projectPlans = plans.filter((p): p is ProjectCachePushPlan => p.kind === "project");
  const issues: Array<{ identifier: string; id?: string; updated_at: string }> = [];
  const projects: Array<{ id: string; updated_at: string }> = [];
  const missing: Array<{ kind: "issue" | "project"; target: string }> = [];

  if (issuePlans.length > 0) {
    const response = await fetchIssueCasStates(issuePlans.map((p) => p.identifier));
    issuePlans.forEach((plan) => {
      const remote = response[plan.identifier];
      if (remote) {
        issues.push({ identifier: plan.identifier, id: remote.id, updated_at: remote.updatedAt });
      } else {
        missing.push({ kind: "issue", target: plan.identifier });
      }
    });
  }

  if (projectPlans.length > 0) {
    const response = await fetchProjectCasStates(projectPlans.map((p) => p.id));
    projectPlans.forEach((plan) => {
      const remote = response[plan.id];
      if (remote) projects.push({ id: plan.id, updated_at: remote.updatedAt });
      else missing.push({ kind: "project", target: plan.id });
    });
  }

  return { issues, projects, missing };
}

export async function assertCacheRemoteSnapshotCurrent(snapshot: {
  issues?: Array<{ identifier: string; id?: string; updated_at: string }>;
  projects?: Array<{ id: string; updated_at: string }>;
  missing?: Array<{ kind: "issue" | "project"; target: string }>;
}): Promise<void> {
  const changed: string[] = [];
  const issues = snapshot.issues ?? [];
  const projects = snapshot.projects ?? [];
  const missing = snapshot.missing ?? [];

  if (missing.length > 0) {
    throw new ValidationError(
      `Linear remote rows were missing during publish review: ${missing
        .map((row) => `${row.kind}/${row.target}`)
        .join(", ")}`,
      "pull the latest cache or remove the missing row from the publish review target",
    );
  }

  if (issues.length > 0) {
    const response = await fetchIssueCasStates(issues.map((issue) => issue.identifier));
    issues.forEach((expected) => {
      const remote = response[expected.identifier];
      if (!remote || remote.updatedAt !== expected.updated_at) changed.push(expected.identifier);
    });
  }

  if (projects.length > 0) {
    const response = await fetchProjectCasStates(projects.map((project) => project.id));
    projects.forEach((expected) => {
      const remote = response[expected.id];
      if (!remote || remote.updatedAt !== expected.updated_at)
        changed.push(`project/${expected.id}`);
    });
  }

  if (changed.length > 0) {
    throw new ValidationError(
      `Linear changed after publish review: ${changed.join(", ")}`,
      "run review_linear_changes again to inspect the latest remote state before publishing",
    );
  }
}

export async function applyCachePushPlans(input: {
  repoHash: string;
  team: string;
  plans: CachePushPlan[];
  lintCtx: CachePushLintContext;
  dryRun?: boolean;
  force?: boolean;
  strict?: boolean;
}): Promise<{ results: CachePushResult[]; summary: CachePushSummary }> {
  const dryRun = input.dryRun === true;
  const force = input.force === true;
  const strict = input.strict === true;
  const issuePlans = input.plans.filter((p): p is IssueCachePushPlan => p.kind === "issue");
  const projectPlans = input.plans.filter((p): p is ProjectCachePushPlan => p.kind === "project");
  const issueRemoteState = force
    ? { stale: new Set<string>(), missing: new Set<string>(), invalid: new Map<string, string>() }
    : await detectIssueRemoteState(issuePlans);
  const projectRemoteState = force
    ? { stale: new Set<string>(), missing: new Set<string>(), invalid: new Map<string, string>() }
    : await detectProjectRemoteState(projectPlans);
  const results: CachePushResult[] = [];
  let teamMetadata: Awaited<ReturnType<typeof getTeamMetadata>> | null = null;

  for (const [index, plan] of issuePlans.entries()) {
    const fields = plan.changes.map((c) => c.field);
    if (fields.length === 0) {
      results.push({ target: plan.identifier, kind: "issue", status: "unchanged" });
      continue;
    }
    if (issueRemoteState.missing.has(plan.identifier)) {
      results.push({
        target: plan.identifier,
        kind: "issue",
        status: "remote-missing",
        fields,
        error: "remote issue is missing or inaccessible — pull latest cache or remove this row",
      });
      continue;
    }
    const invalidState = issueRemoteState.invalid.get(plan.identifier);
    if (invalidState) {
      results.push({
        target: plan.identifier,
        kind: "issue",
        status: "error",
        fields,
        error: invalidState,
      });
      continue;
    }
    if (issueRemoteState.stale.has(plan.identifier)) {
      results.push({
        target: plan.identifier,
        kind: "issue",
        status: "stale",
        fields,
        error: `remote updated since pull — run \`lebop pull ${plan.identifier} --refresh --yes\` after verifying local cache overwrite is intended`,
      });
      continue;
    }

    const lintWarnings = plan.changes.some((c) => c.field === "description")
      ? lintContent(plan.description, input.lintCtx).warnings
      : [];
    if (strict && lintWarnings.length > 0) {
      results.push({
        target: plan.identifier,
        kind: "issue",
        status: "lint-blocked",
        fields,
        warnings: serializeLintWarnings(lintWarnings),
        error: `${lintWarnings.length} lint warning(s) — fix or retry without strict=true`,
      });
      continue;
    }

    let linearInput: IssueUpdateInput;
    try {
      linearInput = await withFreshMetadataOnMiss(
        async (opts) => {
          if (!opts?.refresh && teamMetadata) return teamMetadata;
          teamMetadata = await getTeamMetadata(input.repoHash, input.team, opts);
          return teamMetadata;
        },
        async (metadata) => buildIssueUpdateInput(plan, metadata),
      );
    } catch (err) {
      results.push({
        target: plan.identifier,
        kind: "issue",
        status: "error",
        fields,
        warnings: serializeLintWarnings(lintWarnings),
        error: (err as Error).message,
      });
      continue;
    }
    if (Object.keys(linearInput).length === 0) {
      results.push({ target: plan.identifier, kind: "issue", status: "unchanged" });
      continue;
    }
    if (dryRun) {
      results.push({
        target: plan.identifier,
        kind: "issue",
        status: "dry-run",
        fields,
        warnings: serializeLintWarnings(lintWarnings),
      });
      continue;
    }
    if (!force) {
      const freshnessBlocker = await issuePreMutationRemoteBlocker(plan, fields);
      if (freshnessBlocker) {
        results.push(freshnessBlocker);
        continue;
      }
    }
    let updated: FetchedIssue;
    try {
      const response = (await withClient((c) =>
        c.client.rawRequest(ISSUE_UPDATE_MUTATION, {
          id: plan.metadata._server.id,
          input: linearInput,
        }),
      )) as { data: { issueUpdate: { success: boolean; issue: FetchedIssue } } };
      updated = requireMutationEntity<FetchedIssue>(
        "issueUpdate",
        response.data.issueUpdate as unknown as { success?: boolean } & Record<string, unknown>,
        "issue",
      );
    } catch (err) {
      results.push({
        target: plan.identifier,
        kind: "issue",
        status: "error",
        fields,
        warnings: serializeLintWarnings(lintWarnings),
        error: (err as Error).message,
      });
      continue;
    }
    const rebuilt = buildIssueMetadata(updated);
    try {
      await writeIssue(input.repoHash, rebuilt.metadata, updated.description ?? "");
      results.push({
        target: plan.identifier,
        kind: "issue",
        status: "pushed",
        fields,
        warnings: serializeLintWarnings(lintWarnings),
      });
    } catch (err) {
      const error = `pushed to Linear but local cache writeback failed: ${(err as Error).message}`;
      results.push({
        target: plan.identifier,
        kind: "issue",
        status: "pushed-writeback-failed",
        fields,
        warnings: serializeLintWarnings(lintWarnings),
        error,
      });
      pushSkippedAfterWritebackFailure(
        results,
        [...issuePlans.slice(index + 1), ...projectPlans],
        error,
      );
      return { results, summary: summarizeResults(results) };
    }
  }

  for (const [index, plan] of projectPlans.entries()) {
    const fields = plan.changes.map((c) => c.field);
    if (fields.length === 0) {
      results.push({ target: plan.metadata.name, kind: "project", status: "unchanged" });
      continue;
    }
    if (projectRemoteState.missing.has(plan.id)) {
      results.push({
        target: plan.metadata.name,
        kind: "project",
        status: "remote-missing",
        fields,
        error: `remote project/${plan.id} is missing or inaccessible — pull latest cache or remove this row`,
      });
      continue;
    }
    const invalidState = projectRemoteState.invalid.get(plan.id);
    if (invalidState) {
      results.push({
        target: plan.metadata.name,
        kind: "project",
        status: "error",
        fields,
        error: invalidState,
      });
      continue;
    }
    if (projectRemoteState.stale.has(plan.id)) {
      results.push({
        target: plan.metadata.name,
        kind: "project",
        status: "stale",
        fields,
        error: `remote updated since pull — run \`lebop pull --project-id ${plan.id} --refresh --yes\` after verifying local cache overwrite is intended`,
      });
      continue;
    }

    const lintWarnings = plan.changes.some((c) => c.field === "content")
      ? lintContent(plan.content, input.lintCtx).warnings
      : [];
    if (plan.changes.some((c) => c.field === "icon")) {
      try {
        assertIconNotEmoji(plan.metadata.icon ?? undefined);
      } catch (err) {
        results.push({
          target: plan.metadata.name,
          kind: "project",
          status: "error",
          fields,
          error: (err as Error).message,
        });
        continue;
      }
    }
    if (strict && lintWarnings.length > 0) {
      results.push({
        target: plan.metadata.name,
        kind: "project",
        status: "lint-blocked",
        fields,
        warnings: serializeLintWarnings(lintWarnings),
        error: `${lintWarnings.length} lint warning(s) — fix or retry without strict=true`,
      });
      continue;
    }
    if (dryRun) {
      results.push({
        target: plan.metadata.name,
        kind: "project",
        status: "dry-run",
        fields,
        warnings: serializeLintWarnings(lintWarnings),
      });
      continue;
    }

    if (!force) {
      const freshnessBlocker = await projectPreMutationRemoteBlocker(plan, fields);
      if (freshnessBlocker) {
        results.push(freshnessBlocker);
        continue;
      }
    }
    let updated: FetchedProject;
    try {
      const response = (await withClient((c) =>
        c.client.rawRequest(PROJECT_UPDATE_MUTATION, {
          id: plan.metadata._server.id,
          input: buildProjectUpdateInput(plan),
        }),
      )) as { data: { projectUpdate: { success: boolean; project: FetchedProject } } };
      updated = requireMutationEntity<FetchedProject>(
        "projectUpdate",
        response.data.projectUpdate as unknown as { success?: boolean } & Record<string, unknown>,
        "project",
      );
    } catch (err) {
      results.push({
        target: plan.metadata.name,
        kind: "project",
        status: "error",
        fields,
        warnings: serializeLintWarnings(lintWarnings),
        error: (err as Error).message,
      });
      continue;
    }
    const rebuilt = buildProjectMetadata(updated);
    try {
      await writeProject(input.repoHash, rebuilt.metadata, updated.content ?? "");
      results.push({
        target: plan.metadata.name,
        kind: "project",
        status: "pushed",
        fields,
        warnings: serializeLintWarnings(lintWarnings),
      });
    } catch (err) {
      const error = `pushed to Linear but local cache writeback failed: ${(err as Error).message}`;
      results.push({
        target: plan.metadata.name,
        kind: "project",
        status: "pushed-writeback-failed",
        fields,
        warnings: serializeLintWarnings(lintWarnings),
        error,
      });
      pushSkippedAfterWritebackFailure(results, projectPlans.slice(index + 1), error);
      return { results, summary: summarizeResults(results) };
    }
  }

  return { results, summary: summarizeResults(results) };
}

export async function verifyCachePushPlansClean(
  _repoHash: string,
  plans: CachePushPlan[],
  options: CachePushVerificationOptions = {},
): Promise<{ clean: boolean; dirty: string[] }> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 1));
  const delayMs = Math.max(0, Math.floor(options.delayMs ?? 0));
  let last: { clean: boolean; dirty: string[] } | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await verifyCachePushPlansCleanOnce(plans);
    if (last.clean || attempt === attempts - 1) return last;
    if (delayMs > 0) await sleep(delayMs);
  }

  return last ?? { clean: true, dirty: [] };
}

async function verifyCachePushPlansCleanOnce(
  plans: CachePushPlan[],
): Promise<{ clean: boolean; dirty: string[] }> {
  const dirty: string[] = [];

  const issuePlans = plans.filter((plan): plan is IssueCachePushPlan => plan.kind === "issue");
  if (issuePlans.length > 0) {
    const response = (await withClient((c) =>
      c.client.rawRequest(
        buildPullIssuesQuery(
          issuePlans.map((plan) => plan.identifier),
          false,
        ),
      ),
    )) as { data: Record<string, FetchedIssue | null> };
    for (let i = 0; i < issuePlans.length; i++) {
      const plan = issuePlans[i];
      if (!plan) continue;
      const remote = response.data[`a${i}`];
      if (!remote) {
        dirty.push(plan.identifier);
        continue;
      }
      const rebuilt = buildIssueMetadata(remote);
      const metadata = {
        ...plan.metadata,
        _server: rebuilt.metadata._server,
      };
      if (!issuePlanMatchesRemote(metadata, plan.description)) {
        dirty.push(plan.identifier);
      }
    }
  }

  const projectPlans = plans.filter(
    (plan): plan is ProjectCachePushPlan => plan.kind === "project",
  );
  for (const plan of projectPlans) {
    const response = (await withClient((c) =>
      c.client.rawRequest(PULL_PROJECT_HEADER_QUERY, { id: plan.id }),
    )) as { data: { project: FetchedProject | null } };
    const remote = response.data.project;
    if (!remote) {
      dirty.push(`project/${plan.id}`);
      continue;
    }
    const rebuilt = buildProjectMetadata(remote);
    const metadata = {
      ...plan.metadata,
      _server: rebuilt.metadata._server,
    };
    if (!projectPlanMatchesRemote(metadata, plan.content)) {
      dirty.push(`project/${plan.id}`);
    }
  }

  return { clean: dirty.length === 0, dirty };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function issuePlanMatchesRemote(metadata: IssueMetadata, description: string): boolean {
  return linearTextCandidates(description).some(
    (candidate) => diffIssueMetadata(metadata, candidate).length === 0,
  );
}

function projectPlanMatchesRemote(metadata: ProjectMetadata, content: string): boolean {
  return linearTextCandidates(content).some(
    (candidate) => diffProjectMetadata(metadata, candidate).length === 0,
  );
}

function linearTextCandidates(value: string): string[] {
  const normalized = value.replace(/\r\n/g, "\n");
  const candidates = [normalized];
  if (normalized.endsWith("\n")) {
    candidates.push(normalized.replace(/\n+$/u, ""));
  }
  return [...new Set(candidates)];
}

function normalizeIdentifiers(value: string[] | undefined): string[] {
  return expandIds((value ?? []).map((id) => id.trim()).filter(Boolean));
}

function normalizeProjectIds(value: string[] | undefined): string[] {
  return [...new Set((value ?? []).map((id) => id.trim()).filter(Boolean))];
}

async function detectIssueRemoteState(
  plans: IssueCachePushPlan[],
): Promise<{ stale: Set<string>; missing: Set<string>; invalid: Map<string, string> }> {
  const stale = new Set<string>();
  const missing = new Set<string>();
  const invalid = new Map<string, string>();
  if (plans.length === 0) return { stale, missing, invalid };
  const response = await fetchIssueCasStates(plans.map((p) => p.identifier));
  plans.forEach((plan) => {
    const remote = response[plan.identifier];
    if (!remote) {
      missing.add(plan.identifier);
      return;
    }
    const remoteTime = parseTimestamp(remote.updatedAt);
    const localTime = parseTimestamp(plan.metadata._server.updated_at);
    if (remoteTime === null || localTime === null) {
      invalid.set(
        plan.identifier,
        `invalid updatedAt stale-guard timestamp for ${plan.identifier}: local=${JSON.stringify(
          plan.metadata._server.updated_at,
        )}, remote=${JSON.stringify(remote.updatedAt)}`,
      );
      return;
    }
    if (remote.updatedAt !== plan.metadata._server.updated_at) {
      stale.add(plan.identifier);
    }
  });
  return { stale, missing, invalid };
}

async function detectProjectRemoteState(
  plans: ProjectCachePushPlan[],
): Promise<{ stale: Set<string>; missing: Set<string>; invalid: Map<string, string> }> {
  const stale = new Set<string>();
  const missing = new Set<string>();
  const invalid = new Map<string, string>();
  if (plans.length === 0) return { stale, missing, invalid };
  const response = await fetchProjectCasStates(plans.map((p) => p.id));
  plans.forEach((plan) => {
    const remote = response[plan.id];
    if (!remote) {
      missing.add(plan.id);
      return;
    }
    const remoteTime = parseTimestamp(remote.updatedAt);
    const localTime = parseTimestamp(plan.metadata._server.updated_at);
    if (remoteTime === null || localTime === null) {
      invalid.set(
        plan.id,
        `invalid updatedAt stale-guard timestamp for project/${plan.id}: local=${JSON.stringify(
          plan.metadata._server.updated_at,
        )}, remote=${JSON.stringify(remote.updatedAt)}`,
      );
      return;
    }
    if (remote.updatedAt !== plan.metadata._server.updated_at) {
      stale.add(plan.id);
    }
  });
  return { stale, missing, invalid };
}

async function issuePreMutationRemoteBlocker(
  plan: IssueCachePushPlan,
  fields: string[],
): Promise<CachePushResult | null> {
  const state = await detectIssueRemoteState([plan]);
  if (state.missing.has(plan.identifier)) {
    return {
      target: plan.identifier,
      kind: "issue",
      status: "remote-missing",
      fields,
      error: "remote issue is missing or inaccessible — pull latest cache or remove this row",
    };
  }
  const invalidState = state.invalid.get(plan.identifier);
  if (invalidState) {
    return {
      target: plan.identifier,
      kind: "issue",
      status: "error",
      fields,
      error: invalidState,
    };
  }
  if (state.stale.has(plan.identifier)) {
    return {
      target: plan.identifier,
      kind: "issue",
      status: "stale",
      fields,
      error: `remote updated since pull — run \`lebop pull ${plan.identifier} --refresh --yes\` after verifying local cache overwrite is intended`,
    };
  }
  return null;
}

async function projectPreMutationRemoteBlocker(
  plan: ProjectCachePushPlan,
  fields: string[],
): Promise<CachePushResult | null> {
  const state = await detectProjectRemoteState([plan]);
  if (state.missing.has(plan.id)) {
    return {
      target: plan.metadata.name,
      kind: "project",
      status: "remote-missing",
      fields,
      error: `remote project/${plan.id} is missing or inaccessible — pull latest cache or remove this row`,
    };
  }
  const invalidState = state.invalid.get(plan.id);
  if (invalidState) {
    return {
      target: plan.metadata.name,
      kind: "project",
      status: "error",
      fields,
      error: invalidState,
    };
  }
  if (state.stale.has(plan.id)) {
    return {
      target: plan.metadata.name,
      kind: "project",
      status: "stale",
      fields,
      error: `remote updated since pull — run \`lebop pull --project-id ${plan.id} --refresh --yes\` after verifying local cache overwrite is intended`,
    };
  }
  return null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function serializeLintWarnings(warnings: Warning[]): SerializedLintWarning[] | undefined {
  if (warnings.length === 0) return undefined;
  return warnings.map((w) => ({
    rule: w.rule,
    severity: w.severity,
    message: w.message,
    line: w.line,
  }));
}

function pushSkippedAfterWritebackFailure(
  results: CachePushResult[],
  plans: CachePushPlan[],
  reason: string,
): void {
  for (const plan of plans) {
    results.push(skippedAfterWritebackFailure(plan, reason));
  }
}

function skippedAfterWritebackFailure(plan: CachePushPlan, reason: string): CachePushResult {
  const fields = plan.changes.map((change) => change.field);
  return {
    target: plan.kind === "issue" ? plan.identifier : plan.metadata.name,
    kind: plan.kind,
    status: "error",
    fields: fields.length > 0 ? fields : undefined,
    error: `skipped because cache writeback failed: ${reason}`,
  };
}

function summarizeResults(results: CachePushResult[]): CachePushSummary {
  const failed = results.filter((r) =>
    ["error", "stale", "remote-missing", "lint-blocked"].includes(r.status),
  ).length;
  const writebackFailed = results.filter((r) => r.status === "pushed-writeback-failed").length;
  const applied = results.filter((r) => r.status === "pushed").length + writebackFailed;
  const skipped = results.length - applied - failed;
  return { total: results.length, applied, skipped, failed, writeback_failed: writebackFailed };
}
