/**
 * Error taxonomy for lebop. All structured errors extend LebopError and carry
 * a stable `code` for programmatic consumers (the MCP server returns
 * `{error: {code, message}}` shapes; CLI scripts can grep on code).
 *
 * Lib functions throw these. The CLI's top-level handler formats them with
 * color + hint and sets the appropriate exit code; the MCP server maps them
 * to MCP error responses. **Lib must not call console.* or process.exit.**
 */

export class LebopError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(message: string, code: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.name = this.constructor.name;
  }
}

export class AuthError extends LebopError {
  constructor(message: string, hint?: string) {
    super(message, "auth_error", hint);
  }
}

export class ConfigError extends LebopError {
  constructor(message: string, hint?: string) {
    super(message, "config_error", hint);
  }
}

export class ValidationError extends LebopError {
  constructor(message: string, hint?: string) {
    super(message, "validation_error", hint);
  }
}

export class CASError extends LebopError {
  constructor(message: string, hint?: string) {
    super(message, "cas_error", hint);
  }
}

export class NetworkError extends LebopError {
  constructor(message: string, hint?: string) {
    super(message, "network_error", hint);
  }
}

export class RateLimitError extends LebopError {
  constructor(message: string, hint?: string) {
    super(message, "rate_limit_error", hint);
  }
}

/**
 * Linear's GraphQL surface returns a generic "Entity not found" error for any unknown
 * issue/project/team UUID or identifier. Surfaced verbatim, that's noisy and lacks the
 * one piece of context the caller needs: which id was missing.
 *
 * Use at catch sites; pass through unrelated errors unchanged.
 */
export function rewriteNotFound(err: unknown, identifier: string): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  if (/Entity not found/i.test(original.message)) {
    return new ValidationError(`not found: ${identifier}`);
  }
  return original;
}
