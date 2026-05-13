/**
 * Shared issue-list logic. Used by `lebop list`, `lebop mine`, and the MCP
 * `list_issues` tool. Anything that wants a filtered, paginated view of
 * Linear issues goes through here.
 *
 * Filter coverage matches `@schpet/linear-cli`'s `issue query` surface plus
 * lebop's own conventions (`me` assignee shortcut, `Nd|Nh|Nm` relative time).
 */

import type { LinearClient } from "@linear/sdk";
import { ValidationError } from "./errors.ts";
import { paginateConnection } from "./paginate.ts";
import { linear, withClient } from "./sdk.ts";
import { isUuid } from "./uuid.ts";

type IssueFilter = NonNullable<Parameters<LinearClient["issues"]>[0]>["filter"];

export interface ListIssuesOpts {
  /** Team key (e.g. "ENG"). When omitted, falls back to caller's resolved team. */
  team?: string;
  /** Project filter — name or UUID (use `projectId` to disambiguate). */
  project?: string;
  projectId?: string;
  /** State name (exact match, case-insensitive). */
  state?: string;
  /** State type — `triage|backlog|unstarted|started|completed|canceled`. */
  stateType?: string;
  /**
   * Multiple state types. Passed to Linear as `state.type.in` for
   * server-side filtering. Use this for "active states only" (etc.) so
   * the paginator's `max` cap counts post-filter results, not pre-filter.
   * Mutually exclusive with `stateType` — if both set, `stateType` wins
   * (single eq is more specific).
   */
  stateTypeIn?: string[];
  /** `me`/`@me`, email, name, or `*` for "any assignee". */
  assignee?: string;
  /** Toggle: only unassigned issues. Mutually exclusive with `assignee`. */
  unassigned?: boolean;
  /** Repeatable label-name filter (matches issues with ANY of these labels). */
  label?: string[];
  /** Priority 0..4. */
  priority?: number;
  /** Cycle name or UUID. */
  cycle?: string;
  /** Project milestone name or UUID. */
  milestone?: string;
  /** Updated within: `7d`, `24h`, `15m`, or ISO timestamp. */
  updatedSince?: string;
  /** Created after: same shape as `updatedSince`. */
  createdAfter?: string;
  /** Full-text search across title + body (uses `searchableContent`). */
  search?: string;
  /** Toggle: include archived issues in the result. */
  includeArchived?: boolean;
  /** Toggle: drop the team filter (cross-workspace). */
  allTeams?: boolean;
  /** Cap. `Number.POSITIVE_INFINITY` = no user cap (the paginator's safety cap still applies). */
  max?: number;
  /** Items per page request. Default 250. */
  pageSize?: number;
}

export interface ListedIssue {
  identifier: string;
  title: string;
  state: string | null;
  state_type: string | null;
  priority: number;
  assignee: { name: string; email: string } | null;
  labels: string[];
  updated_at: string;
  url: string;
}

/**
 * Build a Linear `IssueFilter` from list opts. Resolves `me` assignee via a
 * viewer lookup; everything else is structural.
 */
export async function buildIssueFilter(
  opts: ListIssuesOpts,
  resolvedTeam: string | undefined,
): Promise<NonNullable<IssueFilter>> {
  const filter: NonNullable<IssueFilter> = {};

  if (!opts.allTeams && resolvedTeam) {
    filter.team = { key: { eq: resolvedTeam } };
  }
  if (opts.project) filter.project = { name: { eq: opts.project } };
  if (opts.projectId) filter.project = { id: { eq: opts.projectId } };
  if (opts.state) filter.state = { name: { eq: opts.state } };
  if (opts.stateType) {
    filter.state = { ...filter.state, type: { eq: opts.stateType } };
  } else if (opts.stateTypeIn && opts.stateTypeIn.length > 0) {
    filter.state = { ...filter.state, type: { in: opts.stateTypeIn } };
  }
  if (opts.priority !== undefined) filter.priority = { eq: opts.priority };
  if (opts.label && opts.label.length > 0) {
    filter.labels = { some: { name: { in: opts.label } } };
  }
  if (opts.cycle) {
    filter.cycle = isUuid(opts.cycle) ? { id: { eq: opts.cycle } } : { name: { eq: opts.cycle } };
  }
  if (opts.milestone) {
    filter.projectMilestone = isUuid(opts.milestone)
      ? { id: { eq: opts.milestone } }
      : { name: { eq: opts.milestone } };
  }

  if (opts.unassigned) {
    if (opts.assignee) {
      throw new ValidationError(
        "`unassigned` and `assignee` are mutually exclusive",
        "drop one of the two filters — use `--unassigned` OR `--assignee <who>`",
      );
    }
    filter.assignee = { null: true };
  } else if (opts.assignee && opts.assignee !== "*") {
    if (opts.assignee === "me" || opts.assignee === "@me") {
      const viewer = await withClient((c) => c.viewer);
      filter.assignee = { id: { eq: viewer.id } };
    } else if (opts.assignee.includes("@")) {
      filter.assignee = { email: { eq: opts.assignee } };
    } else {
      filter.assignee = { name: { eq: opts.assignee } };
    }
  }

  if (opts.updatedSince) {
    filter.updatedAt = { gte: parseRelative(opts.updatedSince) };
  }
  if (opts.createdAfter) {
    filter.createdAt = { gte: parseRelative(opts.createdAfter) };
  }
  if (opts.search) {
    filter.searchableContent = { contains: opts.search };
  }

  return filter;
}

/**
 * Filter, paginate, and shape Linear issues. Returns plain records suitable
 * for both human rendering and JSON / MCP-tool serialization.
 */
export async function listIssues(
  opts: ListIssuesOpts & { resolvedTeam: string | undefined },
): Promise<ListedIssue[]> {
  const filter = await buildIssueFilter(opts, opts.resolvedTeam);
  const max = opts.max ?? 50;
  const pageSize = opts.pageSize ?? 250;

  // Pre-fetch the cached client so paginate can reuse it without
  // double-wrapping retry (paginate retries internally).
  const client = await linear();
  const issues = await paginateConnection(
    ({ first, after }) =>
      client.issues({
        filter,
        first,
        after,
        includeArchived: opts.includeArchived,
      }),
    { max, pageSize },
  );

  return Promise.all(
    issues.map(async (i) => {
      // i.state and i.assignee are lazy SDK getters (Promise<T> | undefined);
      // fine bare since list is read-only and easy to retry.
      const [state, assignee, labels] = await Promise.all([i.state, i.assignee, i.labels()]);
      return {
        identifier: i.identifier,
        title: i.title,
        state: state?.name ?? null,
        state_type: state?.type ?? null,
        priority: i.priority,
        assignee: assignee ? { name: assignee.name, email: assignee.email } : null,
        labels: labels.nodes.map((l) => l.name).sort(),
        updated_at: i.updatedAt.toISOString(),
        url: i.url,
      };
    }),
  );
}

function parseRelative(input: string): Date {
  const m = input.match(/^(\d+)([dhm])$/);
  if (m?.[1] && m[2]) {
    const n = Number.parseInt(m[1], 10);
    const unitMs = m[2] === "d" ? 86400_000 : m[2] === "h" ? 3600_000 : 60_000;
    return new Date(Date.now() - n * unitMs);
  }
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError(
      `unrecognised time format: ${input} (use Nd|Nh|Nm or ISO 8601)`,
      "use a relative form like `7d`, `24h`, `15m`, or an ISO 8601 timestamp",
    );
  }
  return d;
}
