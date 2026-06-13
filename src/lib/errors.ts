/**
 * Error taxonomy for lebop. All structured errors extend LebopError and carry
 * a stable `code` for programmatic consumers (the MCP server returns
 * `{error: {code, message}}` shapes; CLI scripts can grep on code).
 *
 * Lib functions throw these. The CLI's top-level handler formats them with
 * color + hint and sets the appropriate exit code; the MCP server maps them
 * to MCP error responses. **Lib must not call `console.*` or `process.exit`.**
 *
 * One documented exception: `paginate.ts:maybeWarnApproachingCap` writes
 * to `process.stderr` to surface a soft "approaching the safety cap"
 * warning that doesn't fit the error-throwing path (the walk is still
 * succeeding; we just want the operator to notice before they hit the
 * hard cap). Don't add more.
 */

import {
  type LinearRateLimitDetails,
  linearRateLimitDetailsFromError,
  rateLimitHint,
} from "./rateLimit.ts";

export class LebopError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code: string, hint?: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.details = details;
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

/**
 * MCP JSON-RPC layer rejected the tool call because the provided arguments
 * failed the tool's input schema (zod). Distinct from `validation_error`
 * (which is reserved for lib-level / business-rule rejections after
 * arguments have already been accepted at the wire layer).
 *
 * Constructed at the MCP envelope-validator (`src/mcp/server.ts`) — clients
 * can branch on `code === "invalid_arguments"` to know the failure was
 * structural (wrong type, missing required field, out-of-range value) and
 * inspect the `issues[]` field on the error object for per-field detail.
 * Never thrown by lib functions.
 *
 * Round-6 / H11: prior to this round, MCP zod-rejection bypassed the
 * envelope contract entirely (raw `"MCP error -32602: ..."` prose).
 */
export class InvalidArgumentsError extends LebopError {
  readonly issues: readonly unknown[];
  constructor(message: string, issues: readonly unknown[] = [], hint?: string) {
    super(message, "invalid_arguments", hint);
    this.issues = issues;
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
  constructor(message: string, hint?: string, details?: LinearRateLimitDetails) {
    super(message, "rate_limit_error", hint, details as Record<string, unknown> | undefined);
  }
}

export class PermissionError extends LebopError {
  constructor(message: string, hint?: string) {
    super(message, "permission_error", hint);
  }
}

/**
 * Linear's GraphQL surface returns "Entity not found" for any unknown
 * UUID/identifier. Map that to a structured NotFoundError at the SDK boundary
 * so callers (and the MCP server) can distinguish missing entities from other
 * failures without grepping message strings.
 *
 * Round-22 update: lib-level `get_*` helpers still use `tryMapToNull` so raw
 * SDK not-found noise is normalized at the boundary, but mapped CLI/MCP
 * command surfaces convert that `null` into structured `not_found` errors.
 * Lookup-style tools can still expose nullable payloads where that is the
 * explicit operation contract.
 *
 * `rewriteNotFound` is still used by:
 *   - `updateIssue` catch block (mutation; throwing is correct)
 *   - `lifecycleOne` (archive/unarchive lifecycle results)
 *   - `resolveIssueIdByIdentifier` catch block (issue identifier → UUID)
 *   - `show.ts` and `pull.ts` CLI command shells (preserve human-mode error text)
 *   - `diff.ts` (catches Linear "not found" on the live-remote fetch)
 *   - `link.ts` (catches Linear "not found" on the listAttachments fallback)
 *
 * Round-9 / RH2: returns `NotFoundError` (was `ValidationError` pre-fix).
 */
export class NotFoundError extends LebopError {
  constructor(message: string, hint?: string) {
    super(message, "not_found", hint);
  }
}

/**
 * Run an SDK-touching function, returning `null` if the underlying call
 * surfaces a `NotFoundError` after `mapSdkError` mapping. All other errors
 * (including all other `LebopError` subtypes — AuthError, RateLimitError,
 * NetworkError, ValidationError, ConfigError, CASError) propagate.
 *
 * Deduplicates the repeated try/catch + `mapSdkError` + `instanceof
 * NotFoundError` pattern across every `get_*` lib function (projects,
 * initiatives, documents, milestones, cycles, agentSessions, teams,
 * workflowStates). Single source of truth for the "missing → null"
 * contract that those tools advertise.
 */
export async function tryMapToNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    const mapped = err instanceof LebopError ? err : mapSdkError(err);
    if (mapped instanceof NotFoundError) return null;
    // Round-9 / M-7: Linear types some `get_*` ID variables as `ID!` (vs the
    // more lenient `String!`). The `ID!` scalar rejects malformed UUIDs at
    // the argument-validation layer instead of returning Entity-not-found,
    // so `get_milestone {id: "<malformed-uuid>"}` returns
    // `validation_error` while `get_document {id: "<malformed-uuid>"}`
    // returns `null`. From the user's perspective both are "the entity
    // isn't there" — collapse the inconsistency by also mapping
    // ID-targeted Argument-Validation-Error to null. Only the
    // `argument validation` shape + `id`-token in the message qualifies;
    // every other ValidationError still propagates.
    if (
      mapped instanceof ValidationError &&
      /argument validation/i.test(mapped.message) &&
      /\bid\b/i.test(mapped.message)
    ) {
      return null;
    }
    throw mapped;
  }
}

/**
 * Result of {@link tryIdempotentDelete}. A discriminated union on `status`:
 *   - `"deleted"` — the underlying mutation ran; `result` is the lib's
 *     return value (typically `boolean` for Linear success flags).
 *   - `"already-absent"` — the underlying mutation surfaced a `NotFoundError`;
 *     no result is carried (only `status` exists on this branch).
 *
 * Round-8 backlog / N2: the prior shape was `{status, result: T | null}` —
 * `null` only occurred on already-absent, so the union was imprecise. The
 * discriminated form lets TypeScript narrow `result` based on `status`.
 */
export type IdempotentDeleteResult<T> =
  | { status: "deleted"; result: T }
  | { status: "already-absent" };

/**
 * Wraps a delete-style mutation so re-running on an already-deleted entity
 * surfaces as an idempotent `{status: "already-absent"}` instead of an
 * "Entity not found" error.
 *
 * Round-6 / H10: unifies the delete-idempotency convention across `lebop
 * comment delete`, `document delete`, `label delete`, `initiative delete`,
 * `milestone delete`, and `project delete`. Pre-fix the behavior was
 * inconsistent — `document`/`project` silently re-printed `✓ deleted`
 * (exit 0); `comment`/`milestone`/`label` errored "Entity not found"
 * (exit 1); `relation delete` was already idempotent. This helper pins
 * everything to the `relation` pattern (re-run safe; explicit status).
 */
export async function tryIdempotentDelete<T>(
  fn: () => Promise<T>,
): Promise<IdempotentDeleteResult<T>> {
  try {
    const result = await fn();
    return { status: "deleted", result };
  } catch (err) {
    const mapped = err instanceof LebopError ? err : mapSdkError(err);
    if (mapped instanceof NotFoundError) {
      return { status: "already-absent" };
    }
    throw mapped;
  }
}

/**
 * Linear's GraphQL surface signals "not found" for any unknown
 * issue/project/team UUID or identifier. Surfaced verbatim, that's noisy
 * and lacks the one piece of context the caller needs: which id was missing.
 *
 * Lookup order, mirroring `classifyError`:
 *   1. Structured: `errors[].extensions.code` of `NOT_FOUND` (or variants)
 *   2. Message-string regex on `Entity not found` (current Linear wording)
 *
 * Use at catch sites; pass through unrelated errors unchanged.
 */
export function rewriteNotFound(err: unknown, identifier: string): Error {
  // Check structured GraphQL extension codes first (resilient across SDK
  // versions and future Linear wording changes). Preserve the `hint` from
  // `mapSdkError`'s `hintForNotFound` rather than dropping it on reconstruction
  // — the hint gives callers actionable context ("no Issue with the given id").
  if (typeof err === "object" && err !== null) {
    const errors = (err as { errors?: { extensions?: { code?: unknown }; message?: unknown }[] })
      .errors;
    if (Array.isArray(errors)) {
      for (const e of errors) {
        const code = e?.extensions?.code;
        if (typeof code === "string") {
          const upper = code.toUpperCase();
          if (upper === "NOT_FOUND" || upper === "ENTITY_NOT_FOUND" || upper === "NOTFOUND") {
            const msg = typeof e.message === "string" ? e.message : "";
            return new NotFoundError(`not found: ${identifier}`, hintForNotFound(msg));
          }
        }
      }
    }
  }

  const original = err instanceof Error ? err : new Error(String(err));
  if (/Entity not found/i.test(original.message)) {
    return new NotFoundError(`not found: ${identifier}`, hintForNotFound(original.message));
  }
  return original;
}

/**
 * Map a raw `@linear/sdk` (or fetch) error into a structured LebopError. Used
 * at the SDK boundary so every call site surfaces the same error taxonomy.
 *
 * Lookup order mirrors `classifyError` (see `retry.ts`):
 *   1. Already a LebopError? pass through unchanged.
 *   2. Structured GraphQL `errors[].extensions.code` — most reliable.
 *   3. `status` numeric (401, 403, 429) — covers fetch-level failures.
 *   4. Message regex on Linear's current wording — fragile fallback.
 *
 * If nothing matches, returns the original error unchanged. Callers should
 * still rethrow the result; `mapSdkError` does not throw on its own.
 */
export function mapSdkError(err: unknown): unknown {
  if (err instanceof LebopError) return err;

  // Structured GraphQL extension codes (most reliable signal across SDK
  // versions and Linear wording changes).
  if (typeof err === "object" && err !== null) {
    const errObj = err as {
      errors?: { message?: unknown; extensions?: { code?: unknown } }[];
      status?: number;
      message?: unknown;
    };
    const errors = errObj.errors;
    if (Array.isArray(errors)) {
      for (const e of errors) {
        const code = e?.extensions?.code;
        if (typeof code === "string") {
          const upper = code.toUpperCase();
          if (upper === "NOT_FOUND" || upper === "ENTITY_NOT_FOUND" || upper === "NOTFOUND") {
            const msg = typeof e.message === "string" ? e.message : "entity not found";
            return new NotFoundError(msg, hintForNotFound(msg));
          }
          if (
            upper === "RATELIMITED" ||
            upper === "RATE_LIMITED" ||
            upper === "TOO_MANY_REQUESTS" ||
            upper === "RATELIMITEDLINEARERROR"
          ) {
            const msg = typeof e.message === "string" ? e.message : "rate limited by Linear";
            const details = linearRateLimitDetailsFromError(err) ?? undefined;
            return new RateLimitError(msg, rateLimitHint(details), details);
          }
          if (
            upper === "UNAUTHENTICATED" ||
            upper === "AUTHENTICATION_ERROR" ||
            upper === "UNAUTHORIZED"
          ) {
            const msg = typeof e.message === "string" ? e.message : "authentication failed";
            return new AuthError(
              msg,
              "check your Linear token — run `lebop auth login` to re-authenticate",
            );
          }
          if (
            upper === "FORBIDDEN" ||
            upper === "PERMISSION_DENIED" ||
            upper === "INSUFFICIENT_PERMISSIONS" ||
            upper === "ACCESS_DENIED"
          ) {
            const msg = typeof e.message === "string" ? e.message : "permission denied by Linear";
            return new PermissionError(msg, hintForPermission());
          }
          if (upper === "INVALID_INPUT" || upper === "ARGUMENT_VALIDATION_ERROR") {
            const msg = typeof e.message === "string" ? e.message : "validation error";
            return new ValidationError(msg, hintForValidation(msg));
          }
        }
      }
    }

    // HTTP status fallbacks (fetch-level failures before GraphQL even runs).
    if (errObj.status === 401) {
      return new AuthError(
        toMessage(err) || "401 Unauthorized",
        "check your Linear token — run `lebop auth login` to re-authenticate",
      );
    }
    if (errObj.status === 403) {
      return new PermissionError(toMessage(err) || "403 Forbidden", hintForPermission());
    }
    if (errObj.status === 429) {
      const details = linearRateLimitDetailsFromError(err) ?? undefined;
      return new RateLimitError(
        toMessage(err) || "429 Too Many Requests",
        rateLimitHint(details),
        details,
      );
    }
  }

  // Message-string fallbacks for SDK error shapes that don't expose extensions.
  if (!(err instanceof Error)) return err;
  const msg = err.message;
  const lower = msg.toLowerCase();

  if (/entity not found/i.test(msg)) {
    return new NotFoundError(msg, hintForNotFound(msg));
  }
  if (/argument validation error/i.test(msg)) {
    return new ValidationError(msg, hintForValidation(msg));
  }
  if (
    lower.includes("permission denied") ||
    lower.includes("insufficient permission") ||
    lower.includes("insufficient_permissions") ||
    lower.includes("access denied") ||
    lower.includes("forbidden") ||
    /\b403\b/.test(lower)
  ) {
    return new PermissionError(msg, hintForPermission());
  }
  if (
    lower.includes("authentication") ||
    lower.includes("unauthorized") ||
    lower.includes("unauthenticated") ||
    /\b401\b/.test(lower)
  ) {
    return new AuthError(
      msg,
      "check your Linear token — run `lebop auth login` to re-authenticate",
    );
  }
  if (
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("ratelimit") ||
    lower.includes("too many requests") ||
    /\b429\b/.test(lower)
  ) {
    const details = linearRateLimitDetailsFromError(err) ?? undefined;
    return new RateLimitError(msg, rateLimitHint(details), details);
  }

  return err;
}

function hintForNotFound(msg: string): string {
  // Try to pull "X" out of "Entity not found: X - Could not find referenced X."
  const m = /Entity not found:\s*([A-Za-z0-9_]+)/i.exec(msg);
  if (m) return `no ${m[1]} with the given id`;
  return "verify the id exists and your token has access to it";
}

function hintForValidation(msg: string): string {
  // "Argument Validation Error - field foo is required" → extract the tail.
  const m = /Argument Validation Error\s*[-:]?\s*(.+)/i.exec(msg);
  if (m?.[1]) return `Linear reported: ${m[1].trim()}`;
  return "double-check the input shape against Linear's schema";
}

function hintForPermission(): string {
  return "verify the Linear token has access to this workspace and resource";
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}
