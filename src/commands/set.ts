import chalk from "chalk";
import type { Command } from "commander";
import { parseCliNumber } from "../lib/cliOptions.ts";
import { findGitRoot, hashRepoRoot, resolveConfig } from "../lib/config.ts";
import { envelope } from "../lib/envelope.ts";
import { ConfigError, ValidationError } from "../lib/errors.ts";
import { deriveTeamFromIdentifiers } from "../lib/resolve.ts";
import {
  buildIssueUpdateInputFromCli,
  executeIssueUpdate,
  type IssueUpdateInput as SurfaceIssueUpdateInput,
} from "../surface/issues.ts";
import {
  buildRelationUpdateInputFromCli,
  executeRelationUpdate,
  type RelationMutationDeps,
  relationUpdateCliPayload,
} from "../surface/relations.ts";

const SUPPORTED_FIELDS = [
  "title",
  "description",
  "state",
  "priority",
  "estimate",
  "assignee",
  "labels",
  "parent",
  "project",
  "milestone",
  "cycle",
  "links",
] as const;
type SupportedField = (typeof SUPPORTED_FIELDS)[number];
type UpdateField = Exclude<SupportedField, "links">;
const UNSUPPORTED_FIELDS = new Set(["content"]);

const cliRelationCacheDeps: RelationMutationDeps = {
  resolveCacheContext: () => {
    const repoRoot = findGitRoot(process.cwd());
    return { repoRoot, repoHash: repoRoot ? hashRepoRoot(repoRoot) : "_global" };
  },
};

export function registerSet(program: Command): void {
  program
    .command("set <field> <id> [value...]")
    .description(
      "single-shot point edit (title | description | state | priority | estimate | assignee | labels | parent | project | milestone | cycle | links)",
    )
    .option("--team <key>", "override the resolved team")
    .option("--description <text>", "description body for `set description`")
    .option("--description-file <path>", "read description from a file for `set description`")
    .option("--stdin", "read description from stdin for `set description`")
    .option("--yes", "confirm destructive link removal when using `set links -KIND:ID`")
    .option("--json", "emit structured result")
    .addHelpText(
      "after",
      `
Examples:
  lebop set state TEAM-101 "In Progress"
  lebop set priority TEAM-101 urgent
  lebop set estimate TEAM-101 5             (numeric points; \`null\` clears)
  lebop set assignee TEAM-101 @me
  lebop set assignee TEAM-101 null          (unassign)
  lebop set labels TEAM-101 +urgent -area:backend
  lebop set labels TEAM-101 =area:backend,bug   (exact replacement)
  lebop set title TEAM-101 "new title here"
  lebop set description TEAM-101 --description-file ./body.md
  lebop set parent TEAM-101 TEAM-100        (set parent issue; \`null\` clears)
  lebop set project TEAM-101 "Project Name" (or \`null\` to detach)
  lebop set milestone TEAM-101 "Milestone"  (or \`null\` to clear)
  lebop set cycle TEAM-101 "Cycle 1"        (or \`null\` to clear)
  lebop set links TEAM-101 +blocks:TEAM-102
  lebop set links TEAM-101 -related:TEAM-103 --yes
    supported kinds: blocks | blocked-by | duplicates | duplicated-by | related
    (use \`lebop raw\` for \`similar\`)
`,
    )
    .action(async (field: string, id: string, valueArgs: string[] | undefined, opts: SetOpts) => {
      const values = valueArgs ?? [];
      const tail = parseSharedTailArgs(values);
      const tailOpts: SetOpts = {
        ...opts,
        team: opts.team ?? tail.team,
        json: opts.json === true || tail.json === true,
      };
      // Round-9 / L-9: bad-field invocations are user-input rejections at the
      // CLI boundary — they belong under `code:"validation_error"` in the
      // `--json` envelope, not the unclassified `code:"unknown"` fallback.
      if (UNSUPPORTED_FIELDS.has(field)) {
        throw new ValidationError(
          `\`set ${field}\` is deliberately unsupported (${field} is a large multi-line field)`,
          `use \`lebop pull ${id}\` → edit → \`lebop push\` instead`,
        );
      }
      if (!SUPPORTED_FIELDS.includes(field as SupportedField)) {
        throw new ValidationError(
          `unknown field "${field}"`,
          `supported fields: ${SUPPORTED_FIELDS.join(", ")}`,
        );
      }

      if (field === "links") {
        await handleLinks(id, tail.positionals, tailOpts);
        return;
      }

      await handleUpdateField(id, field as UpdateField, tail, tailOpts);
    });
}

interface SetOpts {
  team?: string;
  description?: string;
  descriptionFile?: string;
  stdin?: boolean;
  yes?: boolean;
  json?: boolean;
}

async function handleUpdateField(
  id: string,
  field: UpdateField,
  tail: SharedTailArgs,
  opts: SetOpts,
): Promise<void> {
  const teamOverride = opts.team ?? tail.team;
  const json = opts.json === true || tail.json === true;
  const input: SurfaceIssueUpdateInput = {
    identifier: id,
  };

  if (field === "description") {
    input.description = await resolveDescriptionValue(tail, opts);
  } else {
    assertNoDescriptionSourceOptions(field, opts, tail);
    if (field === "labels") {
      const labels = parseLabelsFieldInput(id, tail.positionals);
      if (labels.labels !== undefined) input.labels = labels.labels;
      if (labels.labelDeltas !== undefined) input.labelDeltas = labels.labelDeltas;
      if (teamOverride) {
        const config = await resolveSetConfig(id, teamOverride);
        input.team = config.team;
      }
    } else {
      const value = requiredSingleValue(field, id, tail.positionals);
      applyScalarUpdateInput(input, field, value);
    }
  }

  if (field === "project" && input.project !== null && teamOverride) {
    const config = await resolveSetConfig(id, teamOverride);
    input.team = config.team;
  }
  if (field === "cycle" && input.cycle !== null && input.cycle !== undefined) {
    const config = await resolveSetConfig(id, teamOverride);
    input.team = teamForCycleUpdate(id, teamOverride, config.team);
  }
  if (
    teamOverride &&
    (field === "state" ||
      field === "assignee" ||
      field === "milestone" ||
      field === "parent" ||
      field === "priority" ||
      field === "estimate" ||
      field === "title")
  ) {
    const config = await resolveSetConfig(id, teamOverride);
    input.team = config.team;
  }

  const result = await executeIssueUpdate(buildIssueUpdateInputFromCli({ input }), {
    resolveCacheContext: () => {
      const repoRoot = findGitRoot(process.cwd());
      return { repoRoot, repoHash: repoRoot ? hashRepoRoot(repoRoot) : "_global" };
    },
  });
  const cacheWriteback = cacheWritebackFromIssueCache(result.cache);

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        envelope({
          identifier: result.issue.identifier,
          requested_identifier: id,
          field,
          input: sharedInputForOutput(field, input),
          updated_at: result.issue.updatedAt,
          remote: result.remote,
          status: result.status,
          cache_writeback: cacheWriteback,
        }),
        null,
        2,
      )}\n`,
    );
    if (cacheWriteback.status === "failed") process.exitCode = 1;
    return;
  }

  if (cacheWriteback.status === "failed") {
    process.stdout.write(
      `${chalk.red("✗")} ${chalk.bold(result.issue.identifier)} ${field} updated in Linear but local cache writeback failed: ${cacheWriteback.error}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `${chalk.green("✓")} ${chalk.bold(result.issue.identifier)} ${field} updated${cacheWriteback.status === "refreshed" ? chalk.gray(" (cache refreshed)") : ""}\n`,
    );
  }
}

function applyScalarUpdateInput(input: SurfaceIssueUpdateInput, field: UpdateField, value: string) {
  switch (field) {
    case "title":
      input.title = value;
      return;
    case "state":
      input.state = value;
      return;
    case "priority":
      input.priority = value;
      return;
    case "estimate":
      input.estimate = parseEstimate(value);
      return;
    case "assignee":
      input.assignee = parseNullableSelector(value);
      return;
    case "parent":
      input.parent = parseNullableSelector(value);
      return;
    case "project":
      input.project = parseNullableSelector(value);
      return;
    case "milestone":
      input.milestone = parseNullableSelector(value);
      return;
    case "cycle":
      input.cycle = parseNullableSelector(value);
      return;
    case "description":
    case "labels":
      return;
  }
}

/** CLI label token UX → surface labels (exact) or labelDeltas (+/-). */
function parseLabelsFieldInput(
  id: string,
  tokens: string[],
): Pick<SurfaceIssueUpdateInput, "labels" | "labelDeltas"> {
  if (tokens.length === 0) {
    throw new ValidationError(
      `missing value for \`set labels ${id}\``,
      "pass label deltas like +urgent / -bug, or use =a,b,c for exact replacement",
    );
  }

  if (tokens.length === 1 && tokens[0]?.startsWith("=")) {
    return {
      labels: tokens[0]
        .slice(1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }

  const add: string[] = [];
  const remove: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("--")) {
      throw new ValidationError(
        `label token "${token}" looks like a CLI flag, not a label delta`,
        "place flags (--team, --json, ...) BEFORE positional label tokens, or use `--` to split: `lebop set labels --json ID +urgent` or `lebop set labels ID -- -urgent`",
      );
    }
    if (token.startsWith("+")) {
      add.push(token.slice(1));
    } else if (token.startsWith("-")) {
      remove.push(token.slice(1));
    } else {
      throw new ValidationError(
        `label token "${token}" must start with + or - (delta) or use =a,b,c (exact replacement)`,
        "prefix labels with + or -, or use =a,b,c for exact replacement",
      );
    }
  }

  return { labelDeltas: { add, remove } };
}

function cacheWritebackFromIssueCache(cache: {
  present: boolean;
  refreshed: boolean;
  dirty?: { fields: string[] };
  error?: { code: string; message: string; hint?: string };
}): CacheWritebackResult {
  if (cache.refreshed) return { status: "refreshed" };
  if (!cache.present && cache.error === undefined) return { status: "not-cached" };
  if (cache.error) {
    return {
      status: "failed",
      error: cache.error.message,
      code: cache.error.code,
      ...(cache.dirty ? { dirty: cache.dirty } : {}),
    };
  }
  return { status: "failed", error: "cache refresh did not complete" };
}

async function resolveSetConfig(
  id: string,
  teamOverride: string | undefined,
): Promise<Awaited<ReturnType<typeof resolveConfig>>> {
  try {
    return await resolveConfig({ teamOverride });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    let derived: string | null = null;
    try {
      derived = deriveTeamFromIdentifiers([id]);
    } catch {
      // Leave the original config error intact for non TEAM-NN identifiers.
    }
    if (!derived) throw err;
    return resolveConfig({ teamOverride: derived });
  }
}

function teamForCycleUpdate(
  id: string,
  explicitTeam: string | undefined,
  configTeam: string,
): string | undefined {
  if (explicitTeam) return explicitTeam;
  try {
    deriveTeamFromIdentifiers([id]);
    return undefined;
  } catch {
    return configTeam;
  }
}

async function resolveDescriptionValue(tail: SharedTailArgs, opts: SetOpts): Promise<string> {
  const provided = [
    tail.positionals.length > 0,
    opts.description !== undefined || tail.description !== undefined,
    opts.descriptionFile !== undefined || tail.descriptionFile !== undefined,
    opts.stdin === true || tail.stdin === true,
  ].filter(Boolean).length;
  if (provided === 0) {
    throw new ValidationError(
      "missing description for `set description`",
      "pass a positional value, --description, --description-file, or --stdin",
    );
  }
  if (provided > 1) {
    throw new ValidationError(
      "choose at most one description source",
      "pass only one of positional value, --description, --description-file, or --stdin",
    );
  }
  if (tail.positionals.length > 0) return tail.positionals.join(" ");
  if (opts.description !== undefined) return opts.description;
  if (tail.description !== undefined) return tail.description;
  const descriptionFile = opts.descriptionFile ?? tail.descriptionFile;
  if (descriptionFile) return (await Bun.file(descriptionFile).text()).trimEnd();
  return (await Bun.stdin.text()).trimEnd();
}

interface SharedTailArgs {
  positionals: string[];
  description?: string;
  descriptionFile?: string;
  stdin?: boolean;
  json?: boolean;
  team?: string;
}

function parseSharedTailArgs(valueArgs: string[]): SharedTailArgs {
  const parsed: SharedTailArgs = { positionals: [] };
  for (let index = 0; index < valueArgs.length; index += 1) {
    const token = valueArgs[index];
    if (token === undefined) continue;
    const inlineTeam = inlineFlagValue(token, "--team");
    if (inlineTeam !== null) {
      parsed.team = inlineTeam;
      continue;
    }
    const inlineDescription = inlineFlagValue(token, "--description");
    if (inlineDescription !== null) {
      parsed.description = inlineDescription;
      continue;
    }
    const inlineDescriptionFile = inlineFlagValue(token, "--description-file");
    if (inlineDescriptionFile !== null) {
      parsed.descriptionFile = inlineDescriptionFile;
      continue;
    }
    if (token === "--json") {
      parsed.json = true;
      continue;
    }
    if (token === "--stdin") {
      parsed.stdin = true;
      continue;
    }
    if (token === "--team" || token === "--description" || token === "--description-file") {
      const value = valueArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throw new ValidationError(
          `${token} requires a value`,
          "pass the flag value immediately after the flag",
        );
      }
      if (token === "--team") parsed.team = value;
      else if (token === "--description") parsed.description = value;
      else parsed.descriptionFile = value;
      index += 1;
      continue;
    }
    parsed.positionals.push(token);
  }
  return parsed;
}

function inlineFlagValue(token: string, flag: string): string | null {
  if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  if (token.startsWith(`${flag} `)) return token.slice(flag.length + 1).trimStart();
  return null;
}

function assertNoDescriptionSourceOptions(
  field: string,
  opts: SetOpts,
  tail?: SharedTailArgs,
): void {
  if (
    opts.description === undefined &&
    opts.descriptionFile === undefined &&
    opts.stdin !== true &&
    tail?.description === undefined &&
    tail?.descriptionFile === undefined &&
    tail?.stdin !== true
  ) {
    return;
  }
  throw new ValidationError(
    `description input flags cannot be used with \`set ${field}\``,
    "use --description, --description-file, or --stdin only with `set description`",
  );
}

function requiredSingleValue(field: string, id: string, valueArgs: string[]): string {
  const value = valueArgs.join(" ");
  if (!value) {
    throw new ValidationError(
      `missing value for \`set ${field} ${id}\``,
      "pass the new field value as a positional argument",
    );
  }
  return value;
}

function parseNullableSelector(value: string): string | null {
  const normalized = value.trim();
  if (normalized === "" || normalized === "null" || normalized === "none") return null;
  return value;
}

function sharedInputForOutput(
  field: UpdateField,
  input: SurfaceIssueUpdateInput,
): Record<string, unknown> {
  if (field === "labels") {
    if (input.labels !== undefined) return { labels: input.labels };
    return { labels: input.labelDeltas };
  }
  return { [field]: input[field] };
}

function parseEstimate(value: string): number | null {
  if (value === "null" || value === "none" || value === "") return null;
  return parseCliNumber(value, { optionName: "estimate", allowNullHint: true });
}

type CacheWritebackResult =
  | { status: "not-cached" }
  | { status: "refreshed" }
  | { status: "skipped-no-remote-row" }
  | { status: "failed"; error: string; code?: string; dirty?: { fields: string[] } };

async function handleLinks(id: string, valueArgs: string[], opts: SetOpts): Promise<void> {
  const yesFromVariadic = valueArgs.includes("--yes");
  const linkArgs = valueArgs.filter((arg) => arg !== "--yes");
  const confirmed = opts.yes === true || yesFromVariadic;

  const result = await executeRelationUpdate(
    buildRelationUpdateInputFromCli({
      id,
      tokens: linkArgs,
      opts: { yes: confirmed },
    }),
    cliRelationCacheDeps,
  );
  const payload = relationUpdateCliPayload(result);
  const cacheWriteback = payload.cache_writeback;

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(envelope(payload), null, 2)}\n`);
  } else {
    for (const r of payload.results) {
      const icon =
        r.status === "error" || r.status.endsWith("-writeback-failed")
          ? chalk.red("✗")
          : r.status === "already-absent"
            ? chalk.gray("·")
            : chalk.green("✓");
      const label = `${r.op}${r.kind}:${r.target}`;
      const note =
        r.status === "error" ? ` ${chalk.red(r.error ?? "")}` : ` ${chalk.gray(r.status)}`;
      process.stdout.write(`${icon} ${chalk.bold(payload.identifier)} ${label}${note}\n`);
    }
  }

  if (payload.results.some((r) => r.status === "error") || cacheWriteback.status === "failed") {
    process.exitCode = 1;
  }
}
