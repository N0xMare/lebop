import { SCHEMA_VERSION } from "../lib/envelope.ts";
import { InvalidArgumentsError, LebopError } from "../lib/errors.ts";
import type { ToolHandlerResult } from "./types.ts";

export function text(payload: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function envelopeError(code: string, message: string, hint?: string): ToolHandlerResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            schema_version: SCHEMA_VERSION,
            error: { code, message, ...(hint ? { hint } : {}) },
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

export function formatToolError(err: unknown): string {
  if (err instanceof LebopError) {
    const issues =
      err instanceof InvalidArgumentsError && err.issues.length > 0 ? err.issues : undefined;
    return JSON.stringify(
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
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      schema_version: SCHEMA_VERSION,
      error: { code: "unknown", message: (err as Error).message ?? String(err) },
    },
    null,
    2,
  );
}
