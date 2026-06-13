import chalk from "chalk";
import type { Command } from "commander";
import type { TeamMetadata } from "../lib/cache.ts";
import { refreshCachedIssueByIdentifier } from "../lib/cacheRefresh.ts";
import { parseCliNumber } from "../lib/cliOptions.ts";
import { mapLimit } from "../lib/concurrency.ts";
import { findGitRoot, hashRepoRoot, resolveConfig } from "../lib/config.ts";
import { envelope } from "../lib/envelope.ts";
import { ConfigError, NotFoundError, ValidationError } from "../lib/errors.ts";
import {
  assertRelationCreateConfirmed,
  createLink,
  deleteLink,
  findLink,
  type LinkDelta,
  parseLinkToken,
  preflightCreateLink,
  type RelationCreatePreflight,
  relationBatchAddsRequireConfirmation,
  relationDeltaKey,
  relationPairKey,
} from "../lib/relations.ts";
import {
  deriveTeamFromIdentifiers,
  getTeamMetadata,
  resolveLabelId,
  withFreshMetadataOnMiss,
} from "../lib/resolve.ts";
import { withClient } from "../lib/sdk.ts";
import {
  buildIssueUpdateInputFromCli,
  executeIssueUpdate,
  type IssueUpdateInput as SurfaceIssueUpdateInput,
} from "../surface/issues.ts";

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
      input.labels = await resolveLabelsInputNames(id, tail.positionals, opts, tail);
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

async function resolveLabelsInputNames(
  id: string,
  tokens: string[],
  opts: SetOpts,
  tail: SharedTailArgs,
): Promise<string[]> {
  if (tokens.length === 0) {
    throw new ValidationError(
      `missing value for \`set labels ${id}\``,
      "pass label deltas like +urgent / -bug, or use =a,b,c for exact replacement",
    );
  }

  const teamOverride = opts.team ?? tail.team;
  const config = await resolveSetConfig(id, teamOverride);
  const issue = await withClient((c) => c.issue(id));
  if (!issue) throw new NotFoundError(`issue not found: ${id}`);
  const issueIdentifier = typeof issue.identifier === "string" ? issue.identifier : id;
  const teamKey = teamOverride ?? deriveTeamForMetadata(issueIdentifier, config.team);
  const metadata = await withFreshMetadataOnMiss(
    (o) => getTeamMetadata(config.repoHash, teamKey, o),
    async (md) => md,
  );

  if (tokens.length === 1 && tokens[0]?.startsWith("=")) {
    return tokens[0]
      .slice(1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name) => canonicalLabelName(metadata, name));
  }

  const current = await issue.labels();
  const currentNames = new Map<string, string>();
  for (const label of current.nodes) {
    currentNames.set(label.name.toLowerCase(), label.name);
  }

  for (const token of tokens) {
    if (token.startsWith("--")) {
      throw new ValidationError(
        `label token "${token}" looks like a CLI flag, not a label delta`,
        "place flags (--team, --json, ...) BEFORE positional label tokens, or use `--` to split: `lebop set labels --json ID +urgent` or `lebop set labels ID -- -urgent`",
      );
    }
    if (token.startsWith("+")) {
      const name = canonicalLabelName(metadata, token.slice(1));
      currentNames.set(name.toLowerCase(), name);
    } else if (token.startsWith("-")) {
      const name = canonicalLabelName(metadata, token.slice(1));
      currentNames.delete(name.toLowerCase());
    } else {
      throw new ValidationError(
        `label token "${token}" must start with + or - (delta) or use =a,b,c (exact replacement)`,
        "prefix labels with + or -, or use =a,b,c for exact replacement",
      );
    }
  }

  return Array.from(currentNames.values());
}

function deriveTeamForMetadata(identifier: string, fallbackTeam: string): string {
  try {
    return deriveTeamFromIdentifiers([identifier]) ?? fallbackTeam;
  } catch {
    return fallbackTeam;
  }
}

function canonicalLabelName(metadata: TeamMetadata, name: string): string {
  const id = resolveLabelId(metadata, name);
  return metadata.labels.find((label) => label.id === id)?.name ?? name;
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
  return { [field]: input[field] };
}

function parseEstimate(value: string): number | null {
  if (value === "null" || value === "none" || value === "") return null;
  return parseCliNumber(value, { optionName: "estimate", allowNullHint: true });
}

interface LinkResult {
  op: "+" | "-";
  kind: string;
  target: string;
  status:
    | "created"
    | "deleted"
    | "unchanged"
    | "created-writeback-failed"
    | "deleted-writeback-failed"
    | "already-absent"
    | "error";
  relationId?: string;
  error?: string;
}

type CacheWritebackResult =
  | { status: "not-cached" }
  | { status: "refreshed" }
  | { status: "skipped-no-remote-row" }
  | { status: "failed"; error: string; code?: string; dirty?: { fields: string[] } };

async function handleLinks(id: string, valueArgs: string[], opts: SetOpts): Promise<void> {
  const yesFromVariadic = valueArgs.includes("--yes");
  const linkArgs = valueArgs.filter((arg) => arg !== "--yes");
  if (linkArgs.length === 0) {
    throw new ValidationError(
      "`set links` requires at least one +KIND:ID or -KIND:ID token",
      "pass one or more link delta tokens",
    );
  }

  const deltas: LinkDelta[] = linkArgs.map(parseLinkToken);
  const confirmed = opts.yes === true || yesFromVariadic;
  if (deltas.some((d) => d.op === "-") && !confirmed) {
    throw new ValidationError(
      "refusing to remove links without --yes",
      "re-run with --yes to confirm this destructive state change",
    );
  }
  if (relationBatchAddsRequireConfirmation(deltas) && !confirmed) {
    throw new ValidationError(
      "refusing to add multiple relation kinds for the same issue pair without --yes",
      "Linear stores one relation per issue pair; re-run with --yes after verifying the batch replacement order is intended",
    );
  }
  // Round-6 / H6: same auto-derive fallback as the main set path — link
  // mutations are workspace-scoped (no team metadata needed); we only
  // touch config for repoHash on the cache-refresh side. Derive team from
  // the source identifier to avoid the `--team` requirement.
  let config: Awaited<ReturnType<typeof resolveConfig>>;
  try {
    config = await resolveConfig({ teamOverride: opts.team });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    let derived: string | null = null;
    try {
      derived = deriveTeamFromIdentifiers([id]);
    } catch {
      // identifier wasn't TEAM-NN shape — fall through.
    }
    if (!derived) throw err;
    config = await resolveConfig({ teamOverride: derived });
  }

  const selfIssue = await withClient((c) => c.issue(id));
  if (!selfIssue) throw new NotFoundError(`issue not found: ${id}`);
  const selfUuid = selfIssue.id;
  const selfIdentifier = selfIssue.identifier;

  // Resolve each target identifier → UUID in parallel.
  const uniqueTargets = Array.from(new Set(deltas.map((d) => d.target)));
  const targetMap = new Map<string, string>();
  await mapLimit(uniqueTargets, 8, async (ident) => {
    const issue = await withClient((c) => c.issue(ident));
    if (!issue) throw new NotFoundError(`link target not found: ${ident}`);
    targetMap.set(ident, issue.id);
  });

  const createPreflights = new Map<string, RelationCreatePreflight>();
  for (const d of deltas.filter((delta) => delta.op === "+")) {
    const key = relationDeltaKey(d);
    if (createPreflights.has(key)) continue;
    const preflight = await preflightCreateLink(selfIdentifier, d.target, d.kind);
    assertRelationCreateConfirmed(preflight, confirmed);
    createPreflights.set(key, preflight);
  }

  const results: LinkResult[] = [];
  const dirtyPairs = new Set<string>();
  for (const d of deltas) {
    const targetUuid = targetMap.get(d.target);
    if (!targetUuid) {
      results.push({ ...d, status: "error", error: "target UUID missing" });
      continue;
    }
    try {
      if (d.op === "+") {
        const pairKey = relationPairKey(d.target);
        const preflight = dirtyPairs.has(pairKey)
          ? await preflightCreateLink(selfIdentifier, d.target, d.kind)
          : createPreflights.get(relationDeltaKey(d));
        if (preflight) assertRelationCreateConfirmed(preflight, confirmed);
        if (preflight?.exact) {
          results.push({ ...d, status: "unchanged", relationId: preflight.exact.id });
          continue;
        }
        const { id: relId } = await createLink(selfUuid, targetUuid, d.kind);
        dirtyPairs.add(pairKey);
        results.push({ ...d, status: "created", relationId: relId });
      } else {
        const relId = await findLink(selfIdentifier, d.target, d.kind);
        if (!relId) {
          results.push({ ...d, status: "already-absent" });
        } else {
          await deleteLink(relId);
          dirtyPairs.add(relationPairKey(d.target));
          results.push({ ...d, status: "deleted", relationId: relId });
        }
      }
    } catch (err) {
      results.push({ ...d, status: "error", error: (err as Error).message });
    }
  }

  // Refresh cache snapshot if this issue was cached — relation mutations bump updatedAt.
  let cacheWriteback: CacheWritebackResult = { status: "not-cached" };
  try {
    cacheWriteback = cacheWritebackFromLinkRefresh(
      await refreshCachedIssueByIdentifier(selfIdentifier, {
        repoHash: config.repoHash,
        repoRoot: config.repoRoot,
      }),
    );
    if (cacheWriteback.status === "failed") {
      for (const result of results) {
        if (result.status === "created") result.status = "created-writeback-failed";
        if (result.status === "deleted") result.status = "deleted-writeback-failed";
      }
    }
  } catch (err) {
    cacheWriteback = { status: "failed", error: (err as Error).message };
    for (const result of results) {
      if (result.status === "created") result.status = "created-writeback-failed";
      if (result.status === "deleted") result.status = "deleted-writeback-failed";
    }
  }

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        envelope({ identifier: selfIdentifier, results, cache_writeback: cacheWriteback }),
        null,
        2,
      )}\n`,
    );
  } else {
    for (const r of results) {
      const icon =
        r.status === "error" || r.status.endsWith("-writeback-failed")
          ? chalk.red("✗")
          : r.status === "already-absent"
            ? chalk.gray("·")
            : chalk.green("✓");
      const label = `${r.op}${r.kind}:${r.target}`;
      const note =
        r.status === "error" ? ` ${chalk.red(r.error ?? "")}` : ` ${chalk.gray(r.status)}`;
      process.stdout.write(`${icon} ${chalk.bold(selfIdentifier)} ${label}${note}\n`);
    }
  }

  if (results.some((r) => r.status === "error") || cacheWriteback.status === "failed") {
    process.exitCode = 1;
  }
}

function cacheWritebackFromLinkRefresh(result: {
  present: boolean;
  refreshed: boolean;
  dirty?: { fields: string[] };
  error?: { code: string; message: string; hint?: string };
}): CacheWritebackResult {
  if (result.refreshed) return { status: "refreshed" };
  if (!result.present && result.error === undefined) return { status: "not-cached" };
  if (result.error?.code === "not_found") return { status: "skipped-no-remote-row" };
  if (result.error) {
    return {
      status: "failed",
      error: result.error.message,
      code: result.error.code,
      ...(result.dirty ? { dirty: result.dirty } : {}),
    };
  }
  return { status: "failed", error: "cache refresh did not complete" };
}
