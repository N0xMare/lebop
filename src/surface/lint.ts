import { z } from "zod";
import { applyFixesFixpoint, lintContent } from "../lib/lint.ts";
import {
  type LintFileResult,
  type LintFilesInput,
  type LintFilesResult,
  lintFiles,
} from "../lib/lintFiles.ts";
import type { Warning } from "../lib/quirks.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, repoRootArg, teamArg, workspaceArg } from "./schema.ts";

// ---------------------------------------------------------------------------
// Canonical inputs / results
// ---------------------------------------------------------------------------

export type LintFilesCanonicalInput = LintFilesInput;

export interface LintFilesCliInput {
  paths?: string[];
  opts: {
    team?: string;
    fix?: boolean;
    strict?: boolean;
  };
}

export type LintFilesMcpInput = Record<string, unknown> & {
  paths?: string[];
  team?: string;
  fix?: boolean;
  strict?: boolean;
  repo_root?: string;
  workspace?: string;
};

export interface LintTextInput {
  content: string;
  fix?: boolean;
}

export type LintTextMcpInput = Record<string, unknown> & {
  content: string;
  fix?: boolean;
};

export interface LintTextResult {
  warning_count: number;
  warnings: Array<Pick<Warning, "rule" | "severity" | "message" | "line">>;
  fixed?: boolean;
  fixed_content?: string;
  fix_passes?: number;
  remaining_warning_count?: number;
  remaining_warnings?: Array<Pick<Warning, "rule" | "severity" | "message" | "line">>;
}

const lintFilesCanonicalSchema = z
  .object({
    paths: z.array(z.string()).optional(),
    team: z.string().optional(),
    fix: z.boolean().optional(),
    strict: z.boolean().optional(),
    repoRoot: z.string().optional(),
  })
  .strict();

const lintTextCanonicalSchema = z
  .object({
    content: z.string(),
    fix: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function buildLintFilesInputFromCli(input: LintFilesCliInput): LintFilesCanonicalInput {
  return parseSurfaceInput("lint.files", lintFilesCanonicalSchema, {
    paths: input.paths,
    team: input.opts.team,
    fix: input.opts.fix,
    strict: input.opts.strict,
  });
}

export function buildLintFilesInputFromMcp(input: LintFilesMcpInput): LintFilesCanonicalInput {
  return parseSurfaceInput("lint.files", lintFilesCanonicalSchema, {
    paths: input.paths,
    team: input.team,
    fix: input.fix,
    strict: input.strict,
    repoRoot: input.repo_root,
  });
}

export function buildLintTextInputFromMcp(input: LintTextMcpInput): LintTextInput {
  return parseSurfaceInput("lint.text", lintTextCanonicalSchema, {
    content: input.content,
    fix: input.fix,
  });
}

// ---------------------------------------------------------------------------
// Execute + payloads
// ---------------------------------------------------------------------------

export async function executeLintFiles(input: LintFilesCanonicalInput): Promise<LintFilesResult> {
  return lintFiles(input);
}

/** CLI JSON omits missing_paths / cache_mode and maps files to a slim shape. */
export function lintFilesCliPayload(result: LintFilesResult) {
  return {
    files: result.files.map((f) => ({
      path: f.path,
      warnings: f.warnings,
      fixed: f.fixed,
    })),
    warning_count: result.warning_count,
    fixed_count: result.fixed_count,
    missing_count: result.missing_count,
    strict_failed: result.strict_failed,
  };
}

/** MCP JSON includes full LintFileResult rows + missing_paths + cache_mode. */
export function lintFilesMcpPayload(result: LintFilesResult) {
  return {
    files: result.files,
    warning_count: result.warning_count,
    fixed_count: result.fixed_count,
    missing_count: result.missing_count,
    missing_paths: result.missing_paths,
    strict_failed: result.strict_failed,
    cache_mode: result.cache_mode,
  };
}

export function executeLintText(input: LintTextInput): LintTextResult {
  const { warnings } = lintContent(input.content, {});
  const base: LintTextResult = {
    warning_count: warnings.length,
    warnings: warnings.map((w) => ({
      rule: w.rule,
      severity: w.severity,
      message: w.message,
      line: w.line,
    })),
  };
  if (input.fix !== true) return base;

  const fixed = applyFixesFixpoint(input.content, {});
  return {
    ...base,
    fixed: fixed.content !== input.content,
    fixed_content: fixed.content,
    fix_passes: fixed.passes,
    remaining_warning_count: fixed.warnings.length,
    remaining_warnings: fixed.warnings.map((w) => ({
      rule: w.rule,
      severity: w.severity,
      message: w.message,
      line: w.line,
    })),
  };
}

export function lintTextPayload(result: LintTextResult): Record<string, unknown> {
  return { ...result };
}

export type { LintFileResult, LintFilesResult };

// ---------------------------------------------------------------------------
// MCP schemas + operations
// ---------------------------------------------------------------------------

const lintFilesDescription =
  "MCP parity with `lebop lint`: lint explicit local markdown paths, or omit paths to lint cached issue/project markdown for the resolved repo/team. Supports fix and strict like the CLI.";

const lintTextDescription =
  "Run lebop's in-memory Linear renderer lint rules (L001, L002, L003, L005, L006) against text content. Catches table-cell ordered-list markers, setext H2 from `text\\n---`, etc. Pass fix=true to also return fixed_content and remaining warnings after in-memory autofixes. NOTE: this tool takes a content string, NOT a file path. Repo-scoped rules such as L004/R001/R002 require config/path context and run through the CLI/file lint surfaces instead.";

export function buildLintFilesMcpInputSchema(workspaceDescription: string) {
  return {
    paths: z
      .array(z.string())
      .optional()
      .describe("Local markdown file paths. Omit to lint cached issue/project markdown."),
    team: teamArg.describe("Override the resolved team for cache-mode config."),
    fix: z.boolean().optional().describe("Apply safe autofixes to files before returning results."),
    strict: z
      .boolean()
      .optional()
      .describe("Set strict_failed=true when remaining warnings exist."),
    repo_root: repoRootArg.describe(
      "Repo root for config/cache resolution and relative path handling.",
    ),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildLintTextMcpInputSchema() {
  return {
    content: z.string().describe("Markdown content to lint."),
    fix: z.boolean().optional().describe("Return fixed_content after applying safe autofixes."),
  };
}

export const lintFilesOperation = {
  id: "lint.files",
  domain: "lint",
  resource: "markdown",
  action: "review",
  title: "Lint local markdown files for Linear renderer quirks",
  description: lintFilesDescription,
  cli: {
    command: "lint",
    liveSteps: ["cli:lint --json"],
  },
  mcp: {
    tool: "lint_files",
    title: "Lint local markdown files for Linear renderer quirks",
    description: lintFilesDescription,
    annotations: {
      title: "Lint local markdown files for Linear renderer quirks",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchemaKeys: ["paths", "team", "fix", "strict", "repo_root", "workspace"],
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: false },
  notes:
    "CLI JSON omits missing_paths/cache_mode and slims file rows; MCP returns full LintFilesResult fields (behavior freeze).",
  fromCli: buildLintFilesInputFromCli,
  fromMcp: buildLintFilesInputFromMcp,
  execute: executeLintFiles,
} satisfies SurfaceOperationContract<
  LintFilesCanonicalInput,
  LintFilesResult,
  LintFilesCliInput,
  LintFilesMcpInput
>;

export const lintTextOperation = {
  id: "lint.text",
  domain: "lint",
  resource: "markdown",
  action: "review",
  title: "Lint markdown for Linear renderer quirks",
  description: lintTextDescription,
  mcp: {
    tool: "lint_text",
    title: "Lint markdown for Linear renderer quirks",
    description: lintTextDescription,
    annotations: {
      title: "Lint markdown for Linear renderer quirks",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchemaKeys: ["content", "fix"],
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
  exception: {
    kind: "mcp_only",
    reason: "MCP-only content-string linter; use lint_files for CLI lint parity.",
  },
  fromMcp: buildLintTextInputFromMcp,
  execute: async (input: LintTextInput) => executeLintText(input),
} satisfies SurfaceOperationContract<LintTextInput, LintTextResult, never, LintTextMcpInput>;

export const LINT_SURFACE_OPERATIONS = [lintFilesOperation, lintTextOperation] as const;
