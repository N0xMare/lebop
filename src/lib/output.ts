/**
 * Shared CLI/MCP emit helpers for dense agent output (0.0.6 AXI control plane).
 */

import {
  type EncodeOptions,
  encodeEnvelope,
  encodeErrorEnvelope,
  encodeForAgent,
  type OutputFormat,
  parseFormatFlag,
} from "./encode.ts";
import type { ResultEnvelopeMeta } from "./envelope.ts";

export interface MachineEmitOptions extends EncodeOptions {
  /** When true, write to stdout with trailing newline (CLI). */
  stdout?: boolean;
}

/** Emit a versioned success envelope for CLI machine mode. */
export function writeMachineEnvelope(
  payload: Record<string, unknown>,
  opts: { json?: boolean; pretty?: boolean; format?: string; shape?: EncodeOptions["shape"] } = {},
  meta?: ResultEnvelopeMeta,
): void {
  const format = parseFormatFlag(opts);
  process.stdout.write(`${encodeEnvelope(payload, { format, shape: opts.shape }, meta)}\n`);
}

export function writeMachineError(
  error: { code: string; message: string; hint?: string; details?: unknown },
  opts: { pretty?: boolean; format?: string } = {},
): void {
  const format = parseFormatFlag({ ...opts, json: true });
  process.stdout.write(`${encodeErrorEnvelope(error, { format })}\n`);
}

/**
 * MCP: dense compact JSON by default (no pretty indent).
 * MCP hosts and contract tests commonly JSON.parse tool text; TOON stays the
 * CLI agent-optimal format. Compact JSON still cuts pretty-print token waste.
 */
export function encodeMcpPayload(payload: unknown, options: EncodeOptions = {}): string {
  const format = options.format ?? "json";
  if (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    "schema_version" in (payload as object)
  ) {
    return encodeForAgent(payload, { format, shape: options.shape ?? "nested" });
  }
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return encodeEnvelope(payload as Record<string, unknown>, {
      format,
      shape: options.shape ?? "nested",
    });
  }
  return encodeForAgent(payload, { ...options, format });
}

/** Shared CLI flags for agent-default machine output. */
export function addMachineOutputOptions(cmd: {
  option: (flags: string, description?: string) => unknown;
}): void {
  cmd.option("--json", "machine output (default; TOON)");
  cmd.option("--format <fmt>", "toon | json | pretty");
  cmd.option("--pretty", "pretty-printed JSON");
  cmd.option(
    "--human",
    "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped for readability)",
  );
}

export type MachineCliOpts = {
  json?: boolean;
  format?: string;
  pretty?: boolean;
  human?: boolean;
};

export type { OutputFormat };
