/**
 * AXI output-boundary encoding for agent-facing machine output.
 *
 * Internal logic stays as structured objects. At the wire boundary:
 * - TOON for uniform lists / flat tabular / simple objects
 * - compact JSON for deeply nested or non-uniform shapes
 * - pretty JSON only when explicitly requested (--pretty / format=pretty)
 */

import { encode as encodeToon } from "@toon-format/toon";
import {
  envelope,
  type ResultEnvelope,
  type ResultEnvelopeMeta,
  SCHEMA_VERSION,
} from "./envelope.ts";

export type OutputFormat = "toon" | "json" | "pretty";

export type EncodeShape = "auto" | "tabular" | "nested" | "simple";

export interface EncodeOptions {
  format?: OutputFormat;
  /** Hint when format is auto (default). */
  shape?: EncodeShape;
  /** Max nesting depth before auto prefers compact JSON (default 3). */
  nestedDepthThreshold?: number;
}

const DEFAULT_NESTED_DEPTH = 3;

/**
 * Decide wire format for a payload.
 * Explicit format wins. Auto: nested/deep → compact JSON; else TOON.
 */
export function resolveOutputFormat(
  value: unknown,
  options: EncodeOptions = {},
): "toon" | "json" | "pretty" {
  if (options.format === "pretty") return "pretty";
  if (options.format === "json") return "json";
  if (options.format === "toon") return "toon";

  if (options.shape === "nested") return "json";
  if (options.shape === "tabular" || options.shape === "simple") return "toon";

  const threshold = options.nestedDepthThreshold ?? DEFAULT_NESTED_DEPTH;
  if (maxDepth(value) > threshold) return "json";
  if (isUniformObjectArray(value) || isFlatRecord(value)) return "toon";
  if (isUniformListEnvelope(value)) return "toon";
  return "json";
}

/**
 * Encode a value for agent consumption (no trailing policy beyond one newline
 * at emit sites). Does not add schema_version — pass through envelope() first
 * for versioned payloads.
 */
export function encodeForAgent(value: unknown, options: EncodeOptions = {}): string {
  const format = resolveOutputFormat(value, options);
  if (format === "pretty") return JSON.stringify(value, null, 2);
  if (format === "json") return JSON.stringify(value);
  try {
    return encodeToon(value as Parameters<typeof encodeToon>[0]);
  } catch {
    // TOON rejects some exotic shapes; fall back to compact JSON.
    return JSON.stringify(value);
  }
}

/**
 * Build a versioned envelope then encode for the agent.
 */
export function encodeEnvelope<T extends Record<string, unknown>>(
  payload: T,
  options: EncodeOptions = {},
  meta?: ResultEnvelopeMeta,
): string {
  const env = envelope(payload, meta);
  // Envelopes with large nested maps (fetch manifests) prefer compact JSON
  // unless caller forces TOON or the shape is clearly tabular.
  const shape = options.shape ?? (looksTabularEnvelope(env) ? "tabular" : "auto");
  return encodeForAgent(env, { ...options, shape });
}

export function encodeErrorEnvelope(
  error: { code: string; message: string; hint?: string; details?: unknown },
  options: EncodeOptions = {},
): string {
  return encodeEnvelope(
    {
      ok: false,
      error,
    },
    { format: options.format ?? "toon", shape: "simple" },
  );
}

/** CLI/MCP shared parse of format flags. */
export function parseFormatFlag(
  opts: { json?: boolean; pretty?: boolean; format?: string } | undefined,
): OutputFormat {
  if (!opts) return "toon";
  if (opts.pretty || opts.format === "pretty") return "pretty";
  if (opts.format === "json") return "json";
  if (opts.format === "toon") return "toon";
  // Integration / jq-compat harnesses can force compact JSON for --json.
  if (process.env.LEBOP_MACHINE_FORMAT === "json") return "json";
  // Machine mode (--json without --format) → TOON by default (0.0.6 agent path)
  if (opts.json) return "toon";
  return "toon";
}

/**
 * Agent-only product: machine output is the default.
 * Opt into chalk/TTY tables with `--human` or LEBOP_HUMAN=1.
 * `--json` / `--format` / `--pretty` are still accepted (machine path).
 */
export function wantsMachineOutput(
  opts: { json?: boolean; format?: string; pretty?: boolean; human?: boolean } | undefined,
): boolean {
  if (opts?.human === true) return false;
  if (process.env.LEBOP_HUMAN === "1" || process.env.LEBOP_HUMAN === "true") return false;
  return true;
}

/** Inverse of wantsMachineOutput — chalk / human tables only. */
export function wantsHumanOutput(
  opts: { json?: boolean; format?: string; pretty?: boolean; human?: boolean } | undefined,
): boolean {
  return !wantsMachineOutput(opts);
}

export function maxDepth(value: unknown, depth = 0): number {
  if (value === null || value === undefined) return depth;
  if (typeof value !== "object") return depth;
  if (Array.isArray(value)) {
    if (value.length === 0) return depth + 1;
    return Math.max(...value.map((item) => maxDepth(item, depth + 1)));
  }
  const vals = Object.values(value as Record<string, unknown>);
  if (vals.length === 0) return depth + 1;
  return Math.max(...vals.map((item) => maxDepth(item, depth + 1)));
}

function isFlatRecord(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(
    (v) =>
      v === null ||
      v === undefined ||
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean" ||
      (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")),
  );
}

function isUniformObjectArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (!value.every(isPlainObject)) return false;
  const keys = Object.keys(value[0] as object)
    .sort()
    .join("\0");
  return value.every(
    (row) =>
      Object.keys(row as object)
        .sort()
        .join("\0") === keys,
  );
}

/** Scalar / control keys that are not row collections (never drive tabular TOON). */
const LIST_ENVELOPE_NON_ROW_KEYS = new Set([
  "schema_version",
  "ok",
  "count",
  "limit",
  "has_more",
  "next_cursor",
  "truncated",
  "next",
  // Note: do not denylist "fields" — custom-field list uses `fields: object[]`
  // for tabular TOON. Issue-list projection `fields: string[]` is not a uniform
  // object array so it never drives tabular detection on its own.
  "team",
  "all_teams",
  "query",
  "scope",
  "identifier",
  "status",
  "cmd",
  "usage",
  "s",
  "error",
  "hint",
]);

/**
 * True when the payload has at least one uniform object-array property
 * (list/table of rows). Structural — not a hard-coded domain key allowlist.
 */
function isUniformListEnvelope(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const rec = value as Record<string, unknown>;
  for (const [key, v] of Object.entries(rec)) {
    if (LIST_ENVELOPE_NON_ROW_KEYS.has(key)) continue;
    if (Array.isArray(v) && isUniformObjectArray(v)) return true;
  }
  return false;
}

function looksTabularEnvelope(env: ResultEnvelope<Record<string, unknown>>): boolean {
  return isUniformListEnvelope(env);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { SCHEMA_VERSION };
