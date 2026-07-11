import { z } from "zod";
import { resolveConfig } from "../lib/config.ts";
import { ValidationError } from "../lib/errors.ts";
import {
  type ApplyResult,
  applyPlan,
  type PlanApplyPreflightResult,
  preflightPlanApply,
} from "../lib/planApply.ts";
import { diffPlan, type PlanDiffResult } from "../lib/planDiff.ts";
import {
  countRemainingPlanLintWarnings,
  lintPlanFiles,
  type PlanLintFileResult,
} from "../lib/planLint.ts";
import { parsePlan } from "../lib/planParse.ts";
import { type PullResult, pullPlan } from "../lib/planPull.ts";
import type { ParsedPlan, ValidationResult } from "../lib/planTypes.ts";
import { validatePlanWithFreshTeamMetadata } from "../lib/planValidate.ts";
import { getTeamMetadata } from "../lib/resolve.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, teamArg, workspaceArg } from "./schema.ts";

// ---------------------------------------------------------------------------
// Canonical inputs
// ---------------------------------------------------------------------------

export interface PlanDirInput {
  dir: string;
  team?: string;
}

export interface PlanLintInput extends PlanDirInput {
  fix?: boolean;
  strict?: boolean;
}

export interface PlanApplyInput extends PlanDirInput {
  dryRun?: boolean;
  force?: boolean;
  strict?: boolean;
}

export interface PlanPullInput extends PlanDirInput {
  force?: boolean;
  includeNew?: boolean;
}

export interface PlanValidateCliInput {
  dir: string;
  opts: { team?: string };
}

export type PlanValidateMcpInput = Record<string, unknown> & {
  dir: string;
  team?: string;
  workspace?: string;
};

export interface PlanLintCliInput {
  dir: string;
  opts: { team?: string; fix?: boolean; strict?: boolean };
}

export type PlanLintMcpInput = Record<string, unknown> & {
  dir: string;
  fix?: boolean;
  strict?: boolean;
  team?: string;
  workspace?: string;
};

export interface PlanApplyCliInput {
  dir: string;
  opts: {
    team?: string;
    dryRun?: boolean;
    force?: boolean;
    yes?: boolean;
    confirm?: boolean;
    strict?: boolean;
  };
}

export type PlanApplyMcpInput = Record<string, unknown> & {
  dir: string;
  dry_run?: boolean;
  force?: boolean;
  confirm?: boolean;
  strict?: boolean;
  team?: string;
  workspace?: string;
};

export interface PlanDiffCliInput {
  dir: string;
  opts: { team?: string };
}

export type PlanDiffMcpInput = Record<string, unknown> & {
  dir: string;
  team?: string;
  workspace?: string;
};

export interface PlanPullCliInput {
  dir: string;
  opts: {
    team?: string;
    force?: boolean;
    yes?: boolean;
    confirm?: boolean;
    includeNew?: boolean;
  };
}

export type PlanPullMcpInput = Record<string, unknown> & {
  dir: string;
  force?: boolean;
  confirm?: boolean;
  include_new?: boolean;
  team?: string;
  workspace?: string;
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface PlanIssueSummary {
  slug: string;
  title: string;
  linear_id: string | null;
}

export interface PlanValidateExecutionResult {
  /** Parsed plan absolute dir (CLI json `dir`). */
  parsedDir: string;
  /** Caller-supplied dir string (MCP envelope `dir`). */
  requestDir: string;
  project: { name: string; linear_id: string | null };
  issues: PlanIssueSummary[];
  errors: ValidationResult["errors"];
  warnings: ValidationResult["warnings"];
  parsed: ParsedPlan;
  validation: ValidationResult;
}

export interface PlanLintExecutionResult {
  requestDir: string;
  files: PlanLintFileResult[];
  remaining_warnings: number;
  strict_failed: boolean;
  fix: boolean;
  strict: boolean;
}

export type PlanApplyExecutionResult =
  | {
      kind: "validation_failed";
      requestDir: string;
      parsed: ParsedPlan;
      validation: ValidationResult;
    }
  | {
      kind: "preflight_failed";
      requestDir: string;
      dryRun: boolean;
      preflight: PlanApplyPreflightResult;
      /** Non-fatal validation warnings (CLI human mode may print these). */
      warnings: ValidationResult["warnings"];
    }
  | {
      kind: "applied";
      requestDir: string;
      dryRun: boolean;
      result: ApplyResult;
      warnings: ValidationResult["warnings"];
    };

export interface PlanDiffExecutionResult {
  requestDir: string;
  result: PlanDiffResult;
}

export type PlanPullRefusalCode =
  | "diff-scan-incomplete"
  | "diff-blocker-detected"
  | "drift-detected";

export type PlanPullExecutionResult =
  | {
      kind: "refused";
      requestDir: string;
      refused: PlanPullRefusalCode;
      /** CLI json `hint` text. */
      cliHint: string;
      /** MCP ValidationError message. */
      mcpMessage: string;
      /** MCP ValidationError hint. */
      mcpHint: string;
      diff: PlanDiffResult;
    }
  | {
      kind: "pulled";
      requestDir: string;
      result: PullResult;
    };

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const planDirCanonicalSchema = z
  .object({
    dir: z.string().min(1),
    team: teamArg,
  })
  .strict();

const planLintCanonicalSchema = z
  .object({
    dir: z.string().min(1),
    team: teamArg,
    fix: z.boolean().optional(),
    strict: z.boolean().optional(),
  })
  .strict();

const planApplyCanonicalSchema = z
  .object({
    dir: z.string().min(1),
    team: teamArg,
    dryRun: z.boolean().optional(),
    force: z.boolean().optional(),
    strict: z.boolean().optional(),
  })
  .strict();

const planPullCanonicalSchema = z
  .object({
    dir: z.string().min(1),
    team: teamArg,
    force: z.boolean().optional(),
    includeNew: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function isConfirmed(opts: { yes?: boolean; confirm?: boolean }): boolean {
  return opts.yes === true || opts.confirm === true;
}

export function buildPlanValidateInputFromCli(input: PlanValidateCliInput): PlanDirInput {
  return parseSurfaceInput("plan.validate", planDirCanonicalSchema, {
    dir: input.dir,
    team: input.opts.team,
  });
}

export function buildPlanValidateInputFromMcp(input: PlanValidateMcpInput): PlanDirInput {
  return parseSurfaceInput("plan.validate", planDirCanonicalSchema, {
    dir: input.dir,
    team: input.team,
  });
}

export function buildPlanLintInputFromCli(input: PlanLintCliInput): PlanLintInput {
  return parseSurfaceInput("plan.lint", planLintCanonicalSchema, {
    dir: input.dir,
    team: input.opts.team,
    fix: input.opts.fix,
    strict: input.opts.strict,
  });
}

export function buildPlanLintInputFromMcp(input: PlanLintMcpInput): PlanLintInput {
  return parseSurfaceInput("plan.lint", planLintCanonicalSchema, {
    dir: input.dir,
    team: input.team,
    fix: input.fix,
    strict: input.strict,
  });
}

export function buildPlanApplyInputFromCli(input: PlanApplyCliInput): PlanApplyInput {
  const dryRun = input.opts.dryRun === true;
  if (input.opts.force === true && !dryRun && !isConfirmed(input.opts)) {
    throw new ValidationError(
      "refusing to apply plan with --force without --yes/--confirm",
      "run with --dry-run to preview, or pass --yes/--confirm after verifying plan stale-guard bypass is intended",
    );
  }
  return parseSurfaceInput("plan.apply", planApplyCanonicalSchema, {
    dir: input.dir,
    team: input.opts.team,
    dryRun,
    force: input.opts.force,
    strict: input.opts.strict,
  });
}

export function buildPlanApplyInputFromMcp(input: PlanApplyMcpInput): PlanApplyInput {
  return parseSurfaceInput("plan.apply", planApplyCanonicalSchema, {
    dir: input.dir,
    team: input.team,
    dryRun: input.dry_run,
    force: input.force,
    strict: input.strict,
  });
}

export function buildPlanDiffInputFromCli(input: PlanDiffCliInput): PlanDirInput {
  return parseSurfaceInput("plan.diff", planDirCanonicalSchema, {
    dir: input.dir,
    team: input.opts.team,
  });
}

export function buildPlanDiffInputFromMcp(input: PlanDiffMcpInput): PlanDirInput {
  return parseSurfaceInput("plan.diff", planDirCanonicalSchema, {
    dir: input.dir,
    team: input.team,
  });
}

export function buildPlanPullInputFromCli(input: PlanPullCliInput): PlanPullInput {
  if (input.opts.force === true && !isConfirmed(input.opts)) {
    throw new ValidationError(
      "refusing to pull plan with --force without --yes/--confirm",
      "run `lebop plan diff` to inspect first, or pass --yes/--confirm after verifying local file overwrite is intended",
    );
  }
  return parseSurfaceInput("plan.pull", planPullCanonicalSchema, {
    dir: input.dir,
    team: input.opts.team,
    force: input.opts.force,
    includeNew: input.opts.includeNew,
  });
}

export function buildPlanPullInputFromMcp(input: PlanPullMcpInput): PlanPullInput {
  return parseSurfaceInput("plan.pull", planPullCanonicalSchema, {
    dir: input.dir,
    team: input.team,
    force: input.force,
    includeNew: input.include_new,
  });
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

async function resolvePlanTeamContext(plan: ParsedPlan, teamOverride?: string) {
  const team = teamOverride ?? plan.project.frontmatter.team;
  const config = await resolveConfig({ teamOverride: team });
  const lintCtx = {
    repoConfig: config.repoConfig,
    workspaceUrlPrefix: config.workspaceUrlPrefix,
  };
  return { config, lintCtx };
}

export async function executePlanValidate(
  input: PlanDirInput,
): Promise<PlanValidateExecutionResult> {
  const parsed = await parsePlan(input.dir);
  const { config, lintCtx } = await resolvePlanTeamContext(parsed, input.team);
  const { validation } = await validatePlanWithFreshTeamMetadata(parsed, {
    repoHash: config.repoHash,
    team: config.team,
    lintCtx,
  });
  return {
    parsedDir: parsed.dir,
    requestDir: input.dir,
    project: {
      name: parsed.project.frontmatter.name,
      linear_id: parsed.project.frontmatter.linear_id ?? null,
    },
    issues: parsed.issues.map((i) => ({
      slug: i.slug,
      title: i.frontmatter.title,
      linear_id: i.frontmatter.linear_id ?? null,
    })),
    errors: validation.errors,
    warnings: validation.warnings,
    parsed,
    validation,
  };
}

/** CLI json uses absolute parsed dir; MCP uses request dir (behavior freeze). */
export function planValidateCliPayload(result: PlanValidateExecutionResult) {
  return {
    dir: result.parsedDir,
    project: result.project,
    issues: result.issues,
    errors: result.errors,
    warnings: result.warnings,
  };
}

export function planValidateMcpPayload(result: PlanValidateExecutionResult) {
  return {
    dir: result.requestDir,
    project: result.project,
    issues: result.issues,
    errors: result.errors,
    warnings: result.warnings,
  };
}

export async function executePlanLint(input: PlanLintInput): Promise<PlanLintExecutionResult> {
  const parsed = await parsePlan(input.dir);
  const { lintCtx } = await resolvePlanTeamContext(parsed, input.team);
  const fix = input.fix === true;
  const files = await lintPlanFiles(parsed, { fix, lintCtx });
  const remaining = countRemainingPlanLintWarnings(files, fix);
  const strict = input.strict === true;
  return {
    requestDir: input.dir,
    files,
    remaining_warnings: remaining,
    strict_failed: strict && remaining > 0,
    fix,
    strict,
  };
}

/** CLI json remaps files to path/warnings/fixed only (behavior freeze). */
export function planLintCliPayload(result: PlanLintExecutionResult) {
  return {
    dir: result.requestDir,
    files: result.files.map((f) => ({
      path: f.path,
      warnings: f.warnings,
      fixed: f.fixed,
    })),
    remaining_warnings: result.remaining_warnings,
    strict_failed: result.strict_failed,
  };
}

/** MCP json keeps full PlanLintFileResult objects (behavior freeze). */
export function planLintMcpPayload(result: PlanLintExecutionResult) {
  return {
    dir: result.requestDir,
    files: result.files,
    remaining_warnings: result.remaining_warnings,
    strict_failed: result.strict_failed,
  };
}

export async function executePlanApply(input: PlanApplyInput): Promise<PlanApplyExecutionResult> {
  const dryRun = input.dryRun === true;
  const parsed = await parsePlan(input.dir);
  const { config, lintCtx } = await resolvePlanTeamContext(parsed, input.team);
  const { teamMetadata, validation } = await validatePlanWithFreshTeamMetadata(parsed, {
    repoHash: config.repoHash,
    team: config.team,
    lintCtx,
  });

  if (validation.errors.length > 0) {
    return {
      kind: "validation_failed",
      requestDir: input.dir,
      parsed,
      validation,
    };
  }

  const preflight = await preflightPlanApply(parsed);
  if (!preflight.ready) {
    return {
      kind: "preflight_failed",
      requestDir: input.dir,
      dryRun,
      preflight,
      warnings: validation.warnings,
    };
  }

  const result = await applyPlan(parsed, teamMetadata, {
    dryRun,
    force: input.force,
    strict: input.strict,
    lintCtx,
  });

  return {
    kind: "applied",
    requestDir: input.dir,
    dryRun,
    result,
    warnings: validation.warnings,
  };
}

/** CLI validation-fail json omits `dir` (behavior freeze). */
export function planApplyCliPayload(result: PlanApplyExecutionResult): Record<string, unknown> {
  if (result.kind === "validation_failed") {
    return { validation: result.validation };
  }
  if (result.kind === "preflight_failed") {
    return { dry_run: result.dryRun, preflight: result.preflight };
  }
  return { dry_run: result.dryRun, ...result.result };
}

/** MCP always includes request `dir` (behavior freeze). */
export function planApplyMcpPayload(result: PlanApplyExecutionResult): Record<string, unknown> {
  if (result.kind === "validation_failed") {
    return { dir: result.requestDir, validation: result.validation };
  }
  if (result.kind === "preflight_failed") {
    return { dir: result.requestDir, dry_run: result.dryRun, preflight: result.preflight };
  }
  return { dir: result.requestDir, dry_run: result.dryRun, ...result.result };
}

export function planApplyHasErrors(
  result: Extract<PlanApplyExecutionResult, { kind: "applied" }>,
): boolean {
  const r = result.result;
  return (
    r.project.status === "error" ||
    r.project.status === "created-writeback-failed" ||
    r.project.status === "updated-writeback-failed" ||
    r.issues.some(
      (i) =>
        i.status === "error" ||
        i.status === "lint-blocked" ||
        i.status === "created-writeback-failed" ||
        i.status === "updated-writeback-failed",
    ) ||
    r.relations.some((rel) => rel.status === "error")
  );
}

export async function executePlanDiff(input: PlanDirInput): Promise<PlanDiffExecutionResult> {
  const parsed = await parsePlan(input.dir);
  const { config } = await resolvePlanTeamContext(parsed, input.team);
  const teamMetadata = await getTeamMetadata(config.repoHash, config.team);
  const result = await diffPlan(parsed, teamMetadata);
  return { requestDir: input.dir, result };
}

/** CLI json spreads diff only; MCP prefixes request `dir` (behavior freeze). */
export function planDiffCliPayload(result: PlanDiffExecutionResult) {
  return { ...result.result };
}

export function planDiffMcpPayload(result: PlanDiffExecutionResult) {
  return { dir: result.requestDir, ...result.result };
}

export function hasPlanDiffFailure(result: PlanDiffResult): boolean {
  return result.has_drift || result.has_blockers || result.has_incomplete_scan;
}

export async function executePlanPull(input: PlanPullInput): Promise<PlanPullExecutionResult> {
  const parsed = await parsePlan(input.dir);
  const { config } = await resolvePlanTeamContext(parsed, input.team);
  const teamMetadata = await getTeamMetadata(config.repoHash, config.team);
  const force = input.force === true;

  if (!force) {
    const preDiff = await diffPlan(parsed, teamMetadata);
    if (hasPlanDiffFailure(preDiff)) {
      const refused: PlanPullRefusalCode = preDiff.has_incomplete_scan
        ? "diff-scan-incomplete"
        : preDiff.has_blockers
          ? "diff-blocker-detected"
          : "drift-detected";
      const cliHint = preDiff.has_incomplete_scan
        ? "run `lebop plan diff` to inspect the scan failure, then retry once Linear is reachable or re-run with --force --yes after verifying local file overwrite is intended"
        : "run `lebop plan diff` to inspect, then re-run with --force --yes after verifying local file overwrite is intended";
      const mcpMessage = preDiff.has_incomplete_scan
        ? "refusing to pull: plan diff scan incomplete"
        : preDiff.has_blockers
          ? "refusing to pull: plan diff has blockers"
          : "refusing to pull: local plan has drift";
      return {
        kind: "refused",
        requestDir: input.dir,
        refused,
        cliHint,
        mcpMessage,
        mcpHint:
          "call plan_diff to inspect, then retry with force=true and confirm=true after verifying local file overwrite is intended",
        diff: preDiff,
      };
    }
  }

  const result = await pullPlan(parsed, teamMetadata, { includeNew: input.includeNew });
  return { kind: "pulled", requestDir: input.dir, result };
}

export function planPullCliPayload(result: Extract<PlanPullExecutionResult, { kind: "pulled" }>) {
  return { ...result.result };
}

export function planPullMcpPayload(result: Extract<PlanPullExecutionResult, { kind: "pulled" }>) {
  return { dir: result.requestDir, ...result.result };
}

export function planPullHasErrors(result: PullResult): boolean {
  return (
    result.project.status === "error" ||
    result.issues.some((i) => i.status === "error" || i.status === "missing-remote") ||
    result.new_import_errors.length > 0 ||
    result.remote_scan_error !== undefined
  );
}

// ---------------------------------------------------------------------------
// MCP input schemas
// ---------------------------------------------------------------------------

export function buildPlanValidateMcpInputSchema(workspaceParamDescription: string) {
  return {
    dir: z.string().describe("Plan directory path (absolute or relative to MCP server cwd)."),
    team: z
      .string()
      .optional()
      .describe("Team key — if provided, runs full semantic checks against team metadata."),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

export function buildPlanLintMcpInputSchema(workspaceParamDescription: string) {
  return {
    dir: z.string(),
    fix: z.boolean().optional(),
    strict: z.boolean().optional(),
    team: z.string().optional(),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

export function buildPlanApplyMcpInputSchema(workspaceParamDescription: string) {
  return {
    dir: z.string(),
    dry_run: z.boolean().optional(),
    force: z
      .boolean()
      .optional()
      .describe(
        "Apply existing Linear updates even when plan updatedAt snapshots are missing/stale.",
      ),
    confirm: z
      .boolean()
      .optional()
      .describe("Required true when force=true because plan stale protection is bypassed."),
    strict: z.boolean().optional(),
    team: z
      .string()
      .optional()
      .describe("Override the resolved team (defaults to project frontmatter team)."),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

export function buildPlanDiffMcpInputSchema(workspaceParamDescription: string) {
  return {
    dir: z.string(),
    team: z.string().optional(),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

export function buildPlanPullMcpInputSchema(workspaceParamDescription: string) {
  return {
    dir: z.string(),
    force: z.boolean().optional(),
    confirm: z
      .boolean()
      .optional()
      .describe("Required true when force=true because local plan files may be overwritten."),
    include_new: z
      .boolean()
      .optional()
      .describe("Also import remote issues that don't have a corresponding plan file."),
    team: z.string().optional(),
    workspace: workspaceArg.describe(workspaceParamDescription),
  };
}

// ---------------------------------------------------------------------------
// Operation contracts
// ---------------------------------------------------------------------------

export const planValidateOperation = {
  id: "plan.validate",
  domain: "plan",
  resource: "plan",
  action: "review",
  title: "Validate a plan directory (no Linear writes)",
  description:
    "Parse and validate a directory of plan markdown files (frontmatter + body) without writing to Linear.",
  cli: {
    command: "plan validate",
    liveSteps: ["cli:plan validate --json"],
  },
  mcp: {
    tool: "plan_validate",
    title: "Validate a plan directory (no Linear writes)",
    description:
      "Parses + validates a directory of plan markdown files (frontmatter + body). Reports errors (must-fix) and warnings (renderer quirks, relation-pair conflicts, slug shadows, etc.). Pass team to enable network-dependent semantic checks (state/label/assignee resolution).",
    annotations: {
      title: "Validate a plan directory (no Linear writes)",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["dir", "team", "workspace"],
  },
  safety: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
    confirm: "not_required",
  },
  notes:
    "CLI json `dir` is the absolute parsed path; MCP json `dir` is the request path (behavior freeze).",
  fromCli: buildPlanValidateInputFromCli,
  fromMcp: buildPlanValidateInputFromMcp,
  execute: executePlanValidate,
} satisfies SurfaceOperationContract<
  PlanDirInput,
  PlanValidateExecutionResult,
  PlanValidateCliInput,
  PlanValidateMcpInput
>;

export const planLintOperation = {
  id: "plan.lint",
  domain: "plan",
  resource: "plan",
  action: "other",
  title: "Lint every markdown body in a plan directory",
  description:
    "Lint every issue body in a plan directory against repo-scoped rules; optional in-place fix.",
  cli: {
    command: "plan lint",
    liveSteps: ["cli:plan lint --json"],
  },
  mcp: {
    tool: "plan_lint",
    title: "Lint every markdown body in a plan directory",
    description:
      "MCP parity with `lebop plan lint`: lints _project.md plus issue files, optionally applying safe fixes in-place. strict=true reports strict_failed when warnings remain.",
    annotations: {
      title: "Lint every markdown body in a plan directory",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["dir", "fix", "strict", "team", "workspace"],
  },
  safety: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: true,
    confirm: "not_required",
  },
  notes:
    "fix=true writes plan .md files. CLI json remaps files to {path,warnings,fixed}; MCP returns full PlanLintFileResult objects.",
  fromCli: buildPlanLintInputFromCli,
  fromMcp: buildPlanLintInputFromMcp,
  execute: executePlanLint,
} satisfies SurfaceOperationContract<
  PlanLintInput,
  PlanLintExecutionResult,
  PlanLintCliInput,
  PlanLintMcpInput
>;

export const planApplyOperation = {
  id: "plan.apply",
  domain: "plan",
  resource: "plan",
  action: "publish",
  title: "Realize a plan as a Linear project + issues + relations",
  description:
    "Create/update the project + issues + links described by the plan. Writes linear_id on first apply.",
  cli: {
    command: "plan apply",
    liveSteps: ["cli:plan apply dry-run --json", "cli:plan apply --json"],
  },
  mcp: {
    tool: "plan_apply",
    title: "Realize a plan as a Linear project + issues + relations",
    description:
      "Writes back `linear_id:` to each file on first apply; re-running after successful writeback is a no-op. Do not auto-retry failed creates before writeback. Set dry_run=true to preview. strict=true blocks on lint warnings.",
    annotations: {
      title: "Realize a plan as a Linear project + issues + relations",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchemaKeys: ["dir", "dry_run", "force", "confirm", "strict", "team", "workspace"],
  },
  safety: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
    confirm: "required_when_mutating",
  },
  notes:
    "Confirm for force is adapter-owned: CLI --yes/--confirm in fromCli; MCP requireConfirm when force=true && !dry_run. CLI validation-fail envelope omits dir; MCP includes request dir.",
  fromCli: buildPlanApplyInputFromCli,
  fromMcp: buildPlanApplyInputFromMcp,
  execute: executePlanApply,
} satisfies SurfaceOperationContract<
  PlanApplyInput,
  PlanApplyExecutionResult,
  PlanApplyCliInput,
  PlanApplyMcpInput
>;

export const planDiffOperation = {
  id: "plan.diff",
  domain: "plan",
  resource: "plan",
  action: "fetch",
  title: "Local-vs-remote drift for a plan directory",
  description: "Show drift between plan files and live Linear state.",
  cli: {
    command: "plan diff",
    liveSteps: ["cli:plan diff --json"],
  },
  mcp: {
    tool: "plan_diff",
    title: "Local-vs-remote drift for a plan directory",
    description:
      "Computes per-entity drift between the plan files and Linear's current state. Output mirrors `lebop plan diff`.",
    annotations: {
      title: "Local-vs-remote drift for a plan directory",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["dir", "team", "workspace"],
  },
  safety: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
    confirm: "not_required",
  },
  notes: "CLI json spreads diff fields only; MCP prefixes request `dir`.",
  fromCli: buildPlanDiffInputFromCli,
  fromMcp: buildPlanDiffInputFromMcp,
  execute: executePlanDiff,
} satisfies SurfaceOperationContract<
  PlanDirInput,
  PlanDiffExecutionResult,
  PlanDiffCliInput,
  PlanDiffMcpInput
>;

export const planPullOperation = {
  id: "plan.pull",
  domain: "plan",
  resource: "plan",
  action: "fetch",
  title: "Overwrite plan files with current remote state",
  description:
    "Bring remote Linear state back into plan files (overwrites local). Refuses when local drift exists unless force.",
  cli: {
    command: "plan pull",
    liveSteps: ["cli:plan pull --json"],
  },
  mcp: {
    tool: "plan_pull",
    title: "Overwrite plan files with current remote state",
    description:
      "Reverse of plan_apply for the local files: rewrites each plan file's frontmatter + body to match Linear. Refuses to overwrite locally-modified files unless force=true.",
    annotations: {
      title: "Overwrite plan files with current remote state",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchemaKeys: ["dir", "force", "confirm", "include_new", "team", "workspace"],
  },
  safety: {
    readOnly: false,
    destructive: true,
    idempotent: true,
    openWorld: true,
    confirm: "required_when_mutating",
  },
  notes:
    "Confirm for force is adapter-owned (CLI fromCli --yes/--confirm; MCP requireConfirm). Drift refusal without force: CLI returns refused envelope/stderr; MCP throws ValidationError (behavior freeze).",
  fromCli: buildPlanPullInputFromCli,
  fromMcp: buildPlanPullInputFromMcp,
  execute: executePlanPull,
} satisfies SurfaceOperationContract<
  PlanPullInput,
  PlanPullExecutionResult,
  PlanPullCliInput,
  PlanPullMcpInput
>;

export const PLAN_SURFACE_OPERATIONS = [
  planValidateOperation,
  planLintOperation,
  planApplyOperation,
  planDiffOperation,
  planPullOperation,
] as const;
