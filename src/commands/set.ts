import chalk from "chalk";
import type { Command } from "commander";
import { buildIssueMetadata } from "../lib/build.ts";
import type { TeamMetadata } from "../lib/cache.ts";
import { readIssue, writeIssue } from "../lib/cache.ts";
import { resolveConfig } from "../lib/config.ts";
import { envelope } from "../lib/envelope.ts";
import { ConfigError, NotFoundError, ValidationError } from "../lib/errors.ts";
import { buildPullIssuesQuery, type FetchedIssue } from "../lib/pullQuery.ts";
import { ISSUE_UPDATE_MUTATION, type IssueUpdateInput } from "../lib/pushMutations.ts";
import {
  createLink,
  deleteLink,
  findLink,
  type LinkDelta,
  parseLinkToken,
} from "../lib/relations.ts";
import {
  deriveTeamFromIdentifiers,
  getTeamMetadata,
  resolveAssigneeId,
  resolveLabelId,
  resolveLabelIds,
  resolvePriority,
  resolveStateId,
  withFreshMetadataOnMiss,
} from "../lib/resolve.ts";
import { type linear, withClient } from "../lib/sdk.ts";

const SUPPORTED_FIELDS = [
  "title",
  "state",
  "priority",
  "estimate",
  "assignee",
  "labels",
  "parent",
  "links",
] as const;
type SupportedField = (typeof SUPPORTED_FIELDS)[number];
const UNSUPPORTED_FIELDS = new Set(["description", "content"]);

export function registerSet(program: Command): void {
  program
    .command("set <field> <id> <value...>")
    .description(
      "single-shot point edit (title | state | priority | estimate | assignee | labels | parent | links)",
    )
    .option("--team <key>", "override the resolved team")
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
  lebop set parent TEAM-101 TEAM-100        (set parent issue; \`null\` clears)
  lebop set links TEAM-101 +blocks:TEAM-102 -related:TEAM-103
    supported kinds: blocks | blocked-by | duplicates | duplicated-by | related
    (use \`lebop raw\` for \`similar\`)
`,
    )
    .action(async (field: string, id: string, valueArgs: string[], opts: SetOpts) => {
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
        await handleLinks(id, valueArgs, opts);
        return;
      }

      const value = valueArgs.join(" ");
      // Round-10 / L5 deferred: same class as the M8 site in initiative.ts —
      // surfaces as `code: "unknown"` in `--json` envelopes. Broader CLI
      // ValidationError sweep is a v1.0 polish item.
      if (!value) throw new Error(`missing value for \`set ${field} ${id}\``);

      // Round-6 / H6: if no `--team` override and config has no default,
      // derive team from the issue identifier (e.g. "NOX-101" → "NOX"). The
      // MCP `update_issue` tool already does this (round-6 / C3); CLI parity
      // is the UX win — pre-fix, every `lebop set` call required explicit
      // `--team`, even though every other CLI verb (`show`, `comment`,
      // `relation`) auto-resolves from the identifier prefix.
      let config: Awaited<ReturnType<typeof resolveConfig>>;
      try {
        config = await resolveConfig({ teamOverride: opts.team });
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        let derived: string | null = null;
        try {
          derived = deriveTeamFromIdentifiers([id]);
        } catch {
          // identifier wasn't TEAM-NN shape — re-throw the original
          // ConfigError so the user sees the canonical "no team resolved"
          // message instead of a confusing identifier-format error.
        }
        if (!derived) throw err;
        config = await resolveConfig({ teamOverride: derived });
      }

      // Fetch full issue first so we have current state (needed for labels delta).
      const issueSummary = await withClient((c) => c.issue(id));
      if (!issueSummary) throw new NotFoundError(`issue not found: ${id}`);

      const input = await withFreshMetadataOnMiss(
        (o) => getTeamMetadata(config.repoHash, config.team, o),
        (md) =>
          buildInput(field as Exclude<SupportedField, "links">, value, valueArgs, issueSummary, md),
      );

      const response = (await withClient((c) =>
        c.client.rawRequest(ISSUE_UPDATE_MUTATION, {
          id: issueSummary.id,
          input,
        }),
      )) as { data: { issueUpdate: { success: boolean; issue: FetchedIssue } } };

      const updated = response.data.issueUpdate.issue;

      // Refresh cache if this issue was cached.
      const cached = await readIssue(config.repoHash, id);
      if (cached) {
        const rebuilt = buildIssueMetadata(updated);
        await writeIssue(config.repoHash, rebuilt.metadata, updated.description ?? "");
      }

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            envelope({
              identifier: id,
              field,
              input,
              updated_at: updated.updatedAt,
            }),
            null,
            2,
          )}\n`,
        );
        return;
      }

      process.stdout.write(
        `${chalk.green("✓")} ${chalk.bold(id)} ${field} updated${cached ? chalk.gray(" (cache refreshed)") : ""}\n`,
      );
    });
}

interface SetOpts {
  team?: string;
  json?: boolean;
}

async function buildInput(
  field: Exclude<SupportedField, "links">,
  value: string,
  valueArgs: string[],
  issue: Awaited<ReturnType<Awaited<ReturnType<typeof linear>>["issue"]>>,
  teamMetadata: TeamMetadata,
): Promise<IssueUpdateInput> {
  switch (field) {
    case "title":
      return { title: value };
    case "state":
      return { stateId: resolveStateId(teamMetadata, value) };
    case "priority":
      return { priority: resolvePriority(value) };
    case "estimate":
      return { estimate: parseEstimate(value) };
    case "assignee":
      return { assigneeId: await resolveAssigneeId(teamMetadata, value) };
    case "labels":
      return { labelIds: await resolveLabelsInput(valueArgs, issue, teamMetadata) };
    case "parent":
      return { parentId: await resolveParentId(value) };
  }
}

function parseEstimate(value: string): number | null {
  if (value === "null" || value === "none" || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `invalid estimate "${value}" — pass a non-negative number or \`null\` to clear`,
    );
  }
  return n;
}

async function resolveParentId(value: string): Promise<string | null> {
  if (value === "null" || value === "none" || value === "") return null;
  if (!/^[A-Z]+-\d+$/.test(value)) {
    throw new Error(`invalid parent "${value}" — pass a TEAM-NN identifier or \`null\` to clear`);
  }
  // Linear's parentId wants a UUID, not the identifier.
  const parent = await withClient((c) => c.issue(value));
  if (!parent) {
    throw new NotFoundError(`parent issue not found: ${value}`);
  }
  return parent.id;
}

async function resolveLabelsInput(
  tokens: string[],
  issue: Awaited<ReturnType<Awaited<ReturnType<typeof linear>>["issue"]>>,
  teamMetadata: TeamMetadata,
): Promise<string[]> {
  if (tokens.length === 1 && tokens[0]?.startsWith("=")) {
    const names = tokens[0]
      .slice(1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return resolveLabelIds(teamMetadata, names);
  }

  const current = await issue.labels();
  const currentIds = new Set(current.nodes.map((l) => l.id));

  for (const token of tokens) {
    // Round-8 / M2: detect commander flag-shaped tokens (`--team`, `--json`)
    // that leaked into the positional list due to commander's
    // positional-vs-option parsing. Parity with `parseLinkToken`'s round-6
    // / H7 + round-7 / HIGH-4 flag-shape hint. Without this, the bare `-`
    // branch below treated `--json` as the label name `-json` (after the
    // single-char slice) and threw a confusing "unknown label -json".
    if (token.startsWith("--")) {
      throw new ValidationError(
        `label token "${token}" looks like a CLI flag, not a label delta`,
        "place flags (--team, --json, ...) BEFORE positional label tokens, or use `--` to split: `lebop set labels --json ID +urgent` or `lebop set labels ID -- -urgent`",
      );
    }
    if (token.startsWith("+")) {
      currentIds.add(resolveLabelId(teamMetadata, token.slice(1)));
    } else if (token.startsWith("-")) {
      const id = resolveLabelId(teamMetadata, token.slice(1));
      currentIds.delete(id);
    } else {
      throw new Error(
        `label token "${token}" must start with + or - (delta) or use =a,b,c (exact replacement)`,
      );
    }
  }

  return Array.from(currentIds);
}

interface LinkResult {
  op: "+" | "-";
  kind: string;
  target: string;
  status: "created" | "deleted" | "already-absent" | "error";
  relationId?: string;
  error?: string;
}

async function handleLinks(id: string, valueArgs: string[], opts: SetOpts): Promise<void> {
  if (valueArgs.length === 0) {
    throw new Error("`set links` requires at least one +KIND:ID or -KIND:ID token");
  }

  const deltas: LinkDelta[] = valueArgs.map(parseLinkToken);
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
  await Promise.all(
    uniqueTargets.map(async (ident) => {
      const issue = await withClient((c) => c.issue(ident));
      if (!issue) throw new NotFoundError(`link target not found: ${ident}`);
      targetMap.set(ident, issue.id);
    }),
  );

  const results: LinkResult[] = [];
  for (const d of deltas) {
    const targetUuid = targetMap.get(d.target);
    if (!targetUuid) {
      results.push({ ...d, status: "error", error: "target UUID missing" });
      continue;
    }
    try {
      if (d.op === "+") {
        const { id: relId } = await createLink(selfUuid, targetUuid, d.kind);
        results.push({ ...d, status: "created", relationId: relId });
      } else {
        const relId = await findLink(selfIdentifier, d.target, d.kind);
        if (!relId) {
          results.push({ ...d, status: "already-absent" });
        } else {
          await deleteLink(relId);
          results.push({ ...d, status: "deleted", relationId: relId });
        }
      }
    } catch (err) {
      results.push({ ...d, status: "error", error: (err as Error).message });
    }
  }

  // Refresh cache snapshot if this issue was cached — relation mutations bump updatedAt.
  const cached = await readIssue(config.repoHash, id);
  if (cached) {
    const refreshQuery = buildPullIssuesQuery([selfIdentifier], false);
    const refresh = (await withClient((c) => c.client.rawRequest(refreshQuery))) as {
      data: Record<string, FetchedIssue | null>;
    };
    const fresh = refresh.data.a0;
    if (fresh) {
      const rebuilt = buildIssueMetadata(fresh);
      await writeIssue(config.repoHash, rebuilt.metadata, fresh.description ?? "");
    }
  }

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(envelope({ identifier: selfIdentifier, results }), null, 2)}\n`,
    );
  } else {
    for (const r of results) {
      const icon =
        r.status === "error"
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

  if (results.some((r) => r.status === "error")) {
    process.exitCode = 1;
  }
}
