/**
 * Shared result envelope helper for both CLI (`process.stdout.write`) and MCP
 * (`text(...)`) emission sites.
 *
 * Wave 2's CLI/MCP parity audit found 9 hard breakages and 11 minor drifts
 * across 50 paired ops. The root cause was always the same: each surface
 * hand-built `{ schema_version: 1, ...payload }` at the call site, so any
 * field rename / reorder leaked between the two on its own pace. Funnel
 * envelope construction through one helper and the drift can't compound.
 *
 * Usage:
 *   CLI:  process.stdout.write(`${JSON.stringify(envelope({ issues, count }))}\n`);
 *   MCP:  return text(envelope({ issue }));
 *
 * The single source of truth for `schema_version` lives here — if/when we
 * bump to `schema_version: 2`, this is the only line that changes.
 */

/** Stable schema version for every CLI/MCP JSON result envelope. */
export const SCHEMA_VERSION = 1 as const;

export type ResultEnvelope<T extends Record<string, unknown>> = T & {
  schema_version: typeof SCHEMA_VERSION;
};

/**
 * Wrap a payload object as a versioned result envelope.
 *
 * Field-ordering note: the spread comes AFTER `schema_version`, so the
 * version always serializes first in the JSON output. Callers occasionally
 * eyeball `head -1` of a CLI invocation to spot-check the version — keeping
 * the field in front preserves that affordance.
 *
 * The return type is the input `T` intersected with the envelope tag so
 * callers retain full payload typing.
 */
export function envelope<T extends Record<string, unknown>>(payload: T): ResultEnvelope<T> {
  return { schema_version: SCHEMA_VERSION, ...payload };
}
