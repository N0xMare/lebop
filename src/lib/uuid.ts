/**
 * Shared UUID-format predicate. Centralizes the previously-duplicated
 * regex across 13 sites in `src/lib/` and `src/commands/`. Use to
 * distinguish UUID inputs from key/name/identifier inputs when a function
 * accepts either, or to gate calls against GraphQL fields typed `ID!`
 * (which reject non-UUID strings at the argument-validation layer).
 *
 * The pattern matches a 36-character hyphenated string of hex digits
 * (case-insensitive). Looser than RFC 4122's strict 8-4-4-4-12 segmented
 * form, but matches the historical codebase convention and accepts every
 * UUID Linear actually returns. If a stricter check is needed (e.g., to
 * reject all-dashes), inline a stricter regex at the call site.
 */
export const UUID_RE = /^[0-9a-f-]{36}$/i;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
