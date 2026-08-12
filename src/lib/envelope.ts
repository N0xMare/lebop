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
 *   CLI:  writeMachineEnvelope(payload, { json: true, format })  // TOON/JSON encode
 *   MCP:  return text(envelope({ issue }));  // compact JSON for hosts
 *
 * The single source of truth for `schema_version` lives here (currently 2).
 */

/**
 * Stable schema version for every CLI/MCP result envelope.
 * Bumped to 2 for the 0.0.6 AXI dense-defaults train (encoding + slim schemas).
 */
export const SCHEMA_VERSION = 2 as const;

export type ResultEnvelope<T extends Record<string, unknown>> = T & {
  schema_version: typeof SCHEMA_VERSION;
  _meta?: ResultEnvelopeMeta;
};

export interface ResultEnvelopeMeta {
  linear_api?: unknown;
}

/**
 * Wrap a payload object as a versioned result envelope.
 *
 * Field-ordering note: `schema_version` is inserted first so it serializes
 * first in JSON output. Callers occasionally eyeball `head -1` of a CLI
 * invocation to spot-check the version — keeping the field in front preserves
 * that affordance.
 *
 * Payload-owned `schema_version` is ignored. The envelope version is helper
 * owned, not caller controlled.
 *
 * The return type is the input `T` intersected with the envelope tag so
 * callers retain full payload typing.
 */
export function envelope<T extends Record<string, unknown>>(
  payload: T,
  meta?: ResultEnvelopeMeta,
): ResultEnvelope<T> {
  const rest = { ...payload };
  delete (rest as Record<string, unknown>).schema_version;
  delete (rest as Record<string, unknown>)._meta;
  return {
    schema_version: SCHEMA_VERSION,
    ...rest,
    ...(hasMeta(meta) ? { _meta: meta } : {}),
  } as ResultEnvelope<T>;
}

function hasMeta(meta: ResultEnvelopeMeta | undefined): meta is ResultEnvelopeMeta {
  if (!meta) return false;
  return Object.values(meta).some((value) => value !== undefined);
}
