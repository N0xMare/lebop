import {
  isTeamMetadataStale,
  readTeamMetadata,
  type TeamMetadata,
  writeTeamMetadata,
} from "./cache.ts";
import { loadUserConfig } from "./config.ts";
import { LebopError, ValidationError } from "./errors.ts";
import { parseIssueIdentifier } from "./issueIdentifiers.ts";
import { paginateConnection } from "./paginate.ts";
import { withClient } from "./sdk.ts";
import { isUuid } from "./uuid.ts";

/**
 * Thrown by name → UUID resolvers (state, label, assignee, project, etc.)
 * when the input string doesn't match any known entity in the team-metadata
 * cache. Subclass of LebopError purely for ergonomic `instanceof` checks at
 * call sites; the `code` wires through to the documented `validation_error`
 * taxonomy.
 *
 * Round-6 / A6: previously emitted `code: "resolve_error"`, which wasn't in
 * the documented client-facing taxonomy ("auth_error" / "config_error" /
 * "validation_error" / "not_found" / "rate_limit_error" / "network_error" /
 * "cas_error" / "invalid_arguments"). Folded into "validation_error" since
 * every ResolveError IS a validation failure at the name-resolution
 * boundary — same shape, same recoverable, same hint pattern. `instanceof
 * ResolveError` checks in callers are unaffected.
 */
export class ResolveError extends LebopError {
  constructor(message: string, hint?: string) {
    super(message, "validation_error", hint);
  }
}

/**
 * Run `use(metadata)`; if it throws ResolveError (i.e. a name → UUID lookup missed),
 * fetch fresh team metadata once with `refresh: true` and retry. This shields callers
 * from the 1h TTL when lebop itself just created the project/label/state being looked
 * up — without requiring every callsite to know about the staleness possibility.
 */
export async function withFreshMetadataOnMiss<T>(
  fetch: (opts?: { refresh?: boolean }) => Promise<TeamMetadata>,
  use: (metadata: TeamMetadata) => Promise<T>,
): Promise<T> {
  const metadata = await fetch();
  try {
    return await use(metadata);
  } catch (err) {
    if (err instanceof ResolveError) {
      const fresh = await fetch({ refresh: true });
      return use(fresh);
    }
    throw err;
  }
}

/**
 * Resolve the team-metadata-cache TTL in seconds. Order:
 *   1. `team_metadata_ttl_seconds` in `~/.lebop/config.yaml`
 *   2. Default of 3600 (1 hour) — matches the pre-config-key behavior
 *
 * Negative/zero values are accepted and effectively force a refetch on every
 * call. Non-finite or non-numeric values fall back to the default with no
 * thrown error (config-shape errors at the YAML layer are surfaced by
 * `loadUserConfig` itself; this helper only normalizes the value).
 */
async function resolveTeamMetadataTtlSeconds(): Promise<number> {
  try {
    const cfg = await loadUserConfig();
    const v = cfg.team_metadata_ttl_seconds;
    if (typeof v === "number" && Number.isFinite(v)) return v;
  } catch {
    // Failed config reads shouldn't break name resolution. Fall back to
    // the default; surfaceable config errors will reach the user via
    // the normal `resolveConfig()` path on the next command boundary.
  }
  return 3600;
}

export async function getTeamMetadata(
  repoHash: string,
  teamKey: string,
  opts?: { refresh?: boolean },
): Promise<TeamMetadata> {
  const cached = opts?.refresh ? null : await readTeamMetadata(repoHash, teamKey);
  if (cached) {
    const ttlSeconds = await resolveTeamMetadataTtlSeconds();
    if (!isTeamMetadataStale(cached, ttlSeconds)) return cached;
  }

  const teams = await withClient((c) => c.teams({ filter: { key: { eq: teamKey } } }));
  const team = teams.nodes[0];
  if (!team) {
    throw new ResolveError(`team not found: ${teamKey}`);
  }

  // Walk every team subquery via paginateConnection. Linear's SDK defaults
  // to first:50 which silently truncates label/member/project lists on
  // workspaces with >50 of any of those — produces confusing "unknown label X"
  // errors when X is on page 2. paginateConnection walks to completion
  // (subject to the standard LEBOP_MAX_ITEMS safety cap) and uses Linear's
  // 250-per-request maximum.
  const [states, labels, members, projects] = await Promise.all([
    paginateConnection<{ id: string; name: string; type: string }>((args) =>
      withClient(() => team.states(args)),
    ),
    paginateConnection<{ id: string; name: string }>((args) => withClient(() => team.labels(args))),
    paginateConnection<{ id: string; name: string; email: string }>((args) =>
      withClient(() => team.members(args)),
    ),
    paginateConnection<{ id: string; name: string; state: string }>((args) =>
      withClient(() => team.projects(args)),
    ),
  ]);

  const metadata: TeamMetadata = {
    team_id: team.id,
    team_key: team.key,
    fetched_at: new Date().toISOString(),
    states: states.map((s) => ({ id: s.id, name: s.name, type: s.type })),
    labels: labels.map((l) => ({ id: l.id, name: l.name })),
    members: members.map((m) => ({ id: m.id, name: m.name, email: m.email })),
    projects: projects.map((p) => ({ id: p.id, name: p.name, state: p.state })),
  };

  await writeTeamMetadata(repoHash, teamKey, metadata);
  return metadata;
}

// ---------- name → id resolvers ----------

export function resolveStateId(metadata: TeamMetadata, name: string): string {
  const match = metadata.states.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (!match) {
    const names = metadata.states.map((s) => `"${s.name}"`).join(", ");
    throw new ResolveError(`unknown state "${name}". available: ${names}`);
  }
  return match.id;
}

export function resolveLabelId(metadata: TeamMetadata, name: string): string {
  const match = metadata.labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (!match) {
    const suggestions = metadata.labels
      .filter((l) => l.name.toLowerCase().includes(name.toLowerCase()))
      .map((l) => `"${l.name}"`)
      .join(", ");
    const hint = suggestions ? ` did you mean: ${suggestions}?` : "";
    throw new ResolveError(`unknown label "${name}".${hint}`);
  }
  return match.id;
}

export function resolveLabelIds(metadata: TeamMetadata, names: string[]): string[] {
  return names.map((n) => resolveLabelId(metadata, n));
}

export async function resolveAssigneeId(
  metadata: TeamMetadata,
  who: string,
): Promise<string | null> {
  if (who === "null" || who === "none" || who === "") return null;
  if (who === "@me" || who === "me") {
    const viewer = await withClient((c) => c.viewer);
    return viewer.id;
  }

  const needle = who.toLowerCase();
  const byEmail = metadata.members.find((m) => m.email.toLowerCase() === needle);
  if (byEmail) return byEmail.id;

  const byName = metadata.members.filter((m) => m.name.toLowerCase() === needle);
  if (byName.length === 1 && byName[0]) return byName[0].id;
  if (byName.length > 1) {
    const candidates = byName.map((m) => `${m.name} <${m.email}>`).join(", ");
    throw new ResolveError(
      `ambiguous assignee "${who}" matches multiple members with exact name: ${candidates}`,
      "pass the assignee email address instead of the display name",
    );
  }

  const byPrefix = metadata.members.filter(
    (m) => m.email.toLowerCase().startsWith(needle) || m.name.toLowerCase().startsWith(needle),
  );
  if (byPrefix.length === 1 && byPrefix[0]) return byPrefix[0].id;
  if (byPrefix.length > 1) {
    const candidates = byPrefix.map((m) => `${m.name} <${m.email}>`).join(", ");
    throw new ResolveError(`ambiguous assignee "${who}" matches: ${candidates}`);
  }

  throw new ResolveError(`unknown assignee "${who}" — no member match by email or name`);
}

// ---------- id → name reverse ----------

export function stateNameById(metadata: TeamMetadata, id: string): string | null {
  return metadata.states.find((s) => s.id === id)?.name ?? null;
}

export function labelNameById(metadata: TeamMetadata, id: string): string | null {
  return metadata.labels.find((l) => l.id === id)?.name ?? null;
}

export function memberById(
  metadata: TeamMetadata,
  id: string,
): { name: string; email: string } | null {
  const m = metadata.members.find((x) => x.id === id);
  if (!m) return null;
  return { name: m.name, email: m.email };
}

// ---------- priority ----------

const PRIORITY_NAMES = ["none", "urgent", "high", "normal", "low"] as const;

export function resolvePriority(value: string | number): number {
  if (typeof value === "number") {
    if (value < 0 || value > 4 || !Number.isInteger(value)) {
      throw new ResolveError(`priority must be 0..4 (got ${value})`);
    }
    return value;
  }
  if (/^[0-4]$/.test(value)) return Number(value);
  const idx = PRIORITY_NAMES.indexOf(value.toLowerCase() as (typeof PRIORITY_NAMES)[number]);
  if (idx === -1) {
    throw new ResolveError(
      `priority must be one of ${PRIORITY_NAMES.join("|")} or 0..4 (got "${value}")`,
    );
  }
  return idx;
}

export function priorityName(value: number): string {
  return PRIORITY_NAMES[value] ?? `unknown(${value})`;
}

// ---------- identifier helpers ----------

/**
 * Derive a single team key from a list of issue identifiers (e.g. ["NOX-34",
 * "NOX-35"] → "NOX"). Used by MCP tools that take an `identifiers` arg but
 * not a `team` arg — if every identifier shares a prefix we can short-circuit
 * the team-resolution step that would otherwise fail when no `team` is in
 * the resolved config.
 *
 * Returns null if `identifiers` is empty. Throws `ValidationError` if the
 * identifiers span multiple distinct prefixes (the caller must disambiguate).
 *
 * Identifiers are expected to be in `TEAM-NN` form; anything else is rejected
 * with `ValidationError` so callers don't accidentally swallow malformed input.
 */
export function deriveTeamFromIdentifiers(identifiers: string[]): string | null {
  if (identifiers.length === 0) return null;
  const prefixes = new Set<string>();
  for (const id of identifiers) {
    prefixes.add(parseIssueIdentifier(id).teamKey);
  }
  if (prefixes.size > 1) {
    throw new ValidationError(
      `identifiers span multiple teams: ${[...prefixes].join(", ")}`,
      "pass --team explicitly or split the call by team",
    );
  }
  return [...prefixes][0] ?? null;
}

// ---------- milestone / cycle name → UUID resolvers ----------

interface ResolvedProjectNode {
  id: string;
  name: string;
  teams?: { nodes: { key: string }[] };
}

const RESOLVE_PROJECT_BY_NAME_QUERY = /* GraphQL */ `
  query ResolveProjectByName($name: String!) {
    projects(filter: { name: { eq: $name } }, first: 2) {
      nodes {
        id
        name
        teams { nodes { key } }
      }
    }
  }
`;

const RESOLVE_PROJECT_BY_NAME_AND_TEAM_QUERY = /* GraphQL */ `
  query ResolveProjectByNameAndTeam($name: String!, $teamKey: String!) {
    projects(
      filter: {
        name: { eq: $name }
        accessibleTeams: { some: { key: { eq: $teamKey } } }
      }
      first: 2
    ) {
      nodes {
        id
        name
        teams { nodes { key } }
      }
    }
  }
`;

function describeProjectMatches(nodes: ResolvedProjectNode[]): string {
  return nodes
    .map((node) => {
      const teams = node.teams?.nodes.map((team) => team.key).filter(Boolean) ?? [];
      return teams.length > 0 ? `${node.name} (${teams.join(", ")})` : node.name;
    })
    .join(", ");
}

/**
 * Resolve a project name OR UUID to a UUID. UUIDs pass through unchanged.
 *
 * Name lookup is strict:
 *   - With an explicit team key, only projects accessible to that team match.
 *   - Without a team key, workspace-wide duplicate names are rejected instead
 *     of silently taking the first GraphQL row.
 */
export async function resolveProjectIdByName(
  nameOrId: string,
  opts: { teamKey?: string } = {},
): Promise<string> {
  if (isUuid(nameOrId)) return nameOrId;
  const teamKey = opts.teamKey?.toUpperCase();
  const query = teamKey ? RESOLVE_PROJECT_BY_NAME_AND_TEAM_QUERY : RESOLVE_PROJECT_BY_NAME_QUERY;
  const variables = teamKey ? { name: nameOrId, teamKey } : { name: nameOrId };
  const response = (await withClient((c) => c.client.rawRequest(query, variables))) as {
    data: { projects: { nodes: ResolvedProjectNode[] } };
  };
  const nodes = response.data.projects.nodes;
  if (nodes.length === 0) {
    const scope = teamKey ? ` (team ${teamKey})` : "";
    throw new ResolveError(
      `project not found: ${nameOrId}${scope}`,
      teamKey
        ? "verify the project name belongs to that team, or use the project UUID"
        : "pass the project UUID, or pass team to scope a non-unique project name",
    );
  }
  if (nodes.length > 1) {
    throw new ResolveError(
      `ambiguous project name "${nameOrId}" matches: ${describeProjectMatches(nodes)}`,
      "pass an explicit team scope or the project UUID",
    );
  }
  const node = nodes[0];
  if (!node) {
    throw new ResolveError(`project not found: ${nameOrId}`);
  }
  return node.id;
}

/**
 * Resolve a milestone name OR UUID to a UUID. UUIDs pass through unchanged;
 * names hit Linear's `projectMilestones` connection with `name eq`.
 *
 * Milestones are project-scoped in Linear, so callers should pass the target
 * or current project id whenever they have it. Unscoped name lookup is allowed
 * only when the name is unique workspace-wide; duplicate names are rejected
 * instead of silently taking the first row.
 *
 * Moved to lib/resolve.ts in wave 3 (was MCP-server-local) so both the
 * CLI's `updateIssue` lib call and the MCP `update_issue` tool can share
 * the resolver.
 */
export async function resolveMilestoneIdByName(
  nameOrId: string,
  opts: { projectId?: string | null } = {},
): Promise<string> {
  if (isUuid(nameOrId)) return nameOrId;
  const QUERY = opts.projectId
    ? /* GraphQL */ `
      query ResolveMilestone($name: String!, $projectId: ID!) {
        projectMilestones(
          filter: { name: { eq: $name }, project: { id: { eq: $projectId } } }
          first: 2
        ) {
          nodes { id name project { id name } }
        }
      }
    `
    : /* GraphQL */ `
      query ResolveMilestone($name: String!) {
        projectMilestones(filter: { name: { eq: $name } }, first: 2) {
          nodes { id name project { id name } }
        }
      }
    `;
  const variables = opts.projectId
    ? { name: nameOrId, projectId: opts.projectId }
    : { name: nameOrId };
  const response = (await withClient((c) => c.client.rawRequest(QUERY, variables))) as {
    data: {
      projectMilestones: {
        nodes: { id: string; name: string; project?: { id: string; name: string } }[];
      };
    };
  };
  const nodes = response.data.projectMilestones.nodes;
  const node = nodes[0];
  if (!node) {
    const scope = opts.projectId ? ` (project ${opts.projectId})` : "";
    throw new ResolveError(`milestone not found: ${nameOrId}${scope}`);
  }
  if (nodes.length > 1) {
    const matches = nodes
      .map((m) => (m.project ? `${m.name} (${m.project.name})` : m.name))
      .join(", ");
    throw new ResolveError(
      `ambiguous milestone name "${nameOrId}" matches: ${matches}`,
      "pass the milestone UUID, or scope the write by project",
    );
  }
  return node.id;
}

/**
 * Resolve a cycle name OR UUID to a UUID. UUIDs pass through unchanged.
 *
 * Wave 3 fix: cycle names are NOT uniquely identifying across teams (every
 * team has its own "Cycle 12", etc.). The previous helper picked the first
 * cross-workspace match, which silently returned the wrong UUID when
 * multiple teams shared a cycle name. We now require a `teamKey` for name
 * lookups and filter the GraphQL query by team. UUID inputs skip the
 * team-scope requirement entirely (caller already disambiguated).
 *
 * Throws `ResolveError` if `teamKey` is missing for a name input, or if
 * no cycle matches the (teamKey, name) tuple.
 */
export async function resolveCycleIdByName(nameOrId: string, teamKey?: string): Promise<string> {
  if (isUuid(nameOrId)) return nameOrId;
  if (!teamKey) {
    throw new ResolveError(
      `cycle name "${nameOrId}" requires a team scope`,
      "pass the team key, or use the cycle UUID instead (cycle names aren't globally unique)",
    );
  }
  // Team-scoped query: filter by team.key + cycle name. cycles connection
  // accepts a `team` filter at the top level.
  const QUERY = /* GraphQL */ `
    query ResolveCycle($name: String!, $team: String!) {
      cycles(filter: { name: { eq: $name }, team: { key: { eq: $team } } }, first: 1) {
        nodes { id name }
      }
    }
  `;
  const response = (await withClient((c) =>
    c.client.rawRequest(QUERY, { name: nameOrId, team: teamKey }),
  )) as {
    data: { cycles: { nodes: { id: string; name: string }[] } };
  };
  const node = response.data.cycles.nodes[0];
  if (!node) {
    throw new ResolveError(`cycle not found: ${nameOrId} (team ${teamKey})`);
  }
  return node.id;
}
