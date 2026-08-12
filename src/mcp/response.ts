import { encodeErrorEnvelope, encodeForAgent } from "../lib/encode.ts";
import { SCHEMA_VERSION } from "../lib/envelope.ts";
import { InvalidArgumentsError, LebopError } from "../lib/errors.ts";
import { encodeMcpPayload } from "../lib/output.ts";
import type { ToolHandlerResult } from "./types.ts";

/** MCP text content: dense TOON/compact JSON (no pretty by default). */
export function text(payload: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text", text: encodeMcpPayload(payload) }],
  };
}

export function envelopeError(code: string, message: string, hint?: string): ToolHandlerResult {
  return {
    content: [
      {
        type: "text",
        text: encodeErrorEnvelope({ code, message, ...(hint ? { hint } : {}) }, { format: "json" }),
      },
    ],
    isError: true,
  };
}

export function formatToolError(err: unknown): string {
  if (err instanceof LebopError) {
    const issues =
      err instanceof InvalidArgumentsError && err.issues.length > 0 ? err.issues : undefined;
    return encodeForAgent(
      {
        schema_version: SCHEMA_VERSION,
        error: {
          code: err.code,
          message: err.message,
          hint: err.hint,
          ...(err.details ? { details: err.details } : {}),
          ...(issues ? { issues } : {}),
        },
      },
      { format: "json", shape: "nested" },
    );
  }
  return encodeErrorEnvelope(
    {
      code: "unknown",
      message: (err as Error).message ?? String(err),
    },
    { format: "json" },
  );
}
