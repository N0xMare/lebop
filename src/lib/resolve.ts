import {
  type TeamMetadata,
  isTeamMetadataStale,
  readTeamMetadata,
  writeTeamMetadata,
} from "./cache.ts";
import { LebopError } from "./errors.ts";
import { linear } from "./sdk.ts";

export class ResolveError extends LebopError {
  constructor(message: string, hint?: string) {
    super(message, "resolve_error", hint);
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

export async function getTeamMetadata(
  repoHash: string,
  teamKey: string,
  opts?: { refresh?: boolean },
): Promise<TeamMetadata> {
  const cached = opts?.refresh ? null : await readTeamMetadata(repoHash, teamKey);
  if (cached && !isTeamMetadataStale(cached)) return cached;

  const client = await linear();
  const teams = await client.teams({ filter: { key: { eq: teamKey } } });
  const team = teams.nodes[0];
  if (!team) {
    throw new ResolveError(`team not found: ${teamKey}`);
  }

  const [states, labels, members, projects] = await Promise.all([
    team.states(),
    team.labels(),
    team.members(),
    team.projects(),
  ]);

  const metadata: TeamMetadata = {
    team_id: team.id,
    team_key: team.key,
    fetched_at: new Date().toISOString(),
    states: states.nodes.map((s) => ({ id: s.id, name: s.name, type: s.type })),
    labels: labels.nodes.map((l) => ({ id: l.id, name: l.name })),
    members: members.nodes.map((m) => ({ id: m.id, name: m.name, email: m.email })),
    projects: projects.nodes.map((p) => ({ id: p.id, name: p.name, state: p.state })),
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
    const client = await linear();
    const viewer = await client.viewer;
    return viewer.id;
  }

  const needle = who.toLowerCase();
  const byEmail = metadata.members.find((m) => m.email.toLowerCase() === needle);
  if (byEmail) return byEmail.id;

  const byName = metadata.members.find((m) => m.name.toLowerCase() === needle);
  if (byName) return byName.id;

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
  const asNum = Number.parseInt(value, 10);
  if (!Number.isNaN(asNum) && asNum >= 0 && asNum <= 4) return asNum;
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
