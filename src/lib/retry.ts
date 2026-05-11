import { NetworkError, RateLimitError } from "./errors.ts";

/**
 * Retry-with-backoff for Linear API calls. Wraps any async operation that
 * might hit a transient failure or rate limit. Non-retryable errors (auth,
 * validation, not-found) propagate immediately on the first attempt.
 *
 * Important: only safe for **idempotent operations** — reads, paginated
 * fetches, `issueUpdate` / `projectUpdate` (Linear's update mutations are
 * idempotent at the value level: same input → same outcome). Do **not**
 * wrap `issueCreate` with this — duplicate creation could result if the
 * first attempt succeeded but the response was lost.
 */

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_INITIAL_DELAY_MS = 200;
const DEFAULT_MAX_DELAY_MS = 5_000;

export interface RetryOpts {
  /** How many attempts total (including the first try). Default 5. */
  maxAttempts?: number;
  /** Delay before first retry, in ms. Doubles per retry. Default 200. */
  initialDelayMs?: number;
  /** Cap on delay between retries, in ms. Default 5000. */
  maxDelayMs?: number;
}

export type ErrorClass = "rate-limit" | "transient" | "non-retryable";

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const max = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialDelay = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelay = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  let lastError: unknown;
  for (let attempt = 0; attempt < max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const klass = classifyError(err);
      if (klass === "non-retryable") throw err;

      if (attempt === max - 1) {
        // Final attempt failed; surface as a structured error.
        const msg = (err as Error).message ?? String(err);
        if (klass === "rate-limit") {
          throw new RateLimitError(
            `rate limited by Linear after ${max} attempts: ${msg}`,
            "wait a few seconds and retry, or reduce concurrency",
          );
        }
        throw new NetworkError(
          `transient network error after ${max} attempts: ${msg}`,
          "check your connection and retry",
        );
      }

      // Exponential backoff with ±20% jitter.
      const base = Math.min(initialDelay * 2 ** attempt, maxDelay);
      const jitter = base * (0.8 + Math.random() * 0.4);
      await new Promise((r) => setTimeout(r, jitter));
    }
  }

  throw lastError as Error;
}

/**
 * Classify an error from `@linear/sdk` or fetch into one of three buckets.
 * `rate-limit` and `transient` are retryable; `non-retryable` propagates
 * immediately.
 *
 * Lookup order:
 *   1. `errors[].extensions.code` on the thrown error object — the structured
 *      signal Linear's GraphQL surface returns (per spec §12.1, the SDK's
 *      thrown error has a top-level `errors` array with `{message, extensions}`
 *      entries). Most reliable across SDK versions.
 *   2. HTTP status code on the error (`status` property).
 *   3. Message string regex — fragile but catches errors that omit structured
 *      metadata.
 *
 * Exported for testing. Don't call from production code — use `withRetry`.
 */
export function classifyError(err: unknown): ErrorClass {
  // Check structured GraphQL extension codes first (most reliable signal).
  // `@linear/sdk`'s thrown error has `data`, `errors`, `query`, `status`, `raw`
  // top-level fields per spec §12.1. The `errors` array carries
  // `{message, extensions: {code, ...}}` per GraphQL convention.
  if (typeof err === "object" && err !== null) {
    const errors = (err as { errors?: { extensions?: { code?: unknown } }[] }).errors;
    if (Array.isArray(errors)) {
      for (const e of errors) {
        const code = e?.extensions?.code;
        if (typeof code === "string") {
          const upper = code.toUpperCase();
          if (
            upper === "RATELIMITED" ||
            upper === "RATE_LIMITED" ||
            upper === "TOO_MANY_REQUESTS"
          ) {
            return "rate-limit";
          }
          if (
            upper === "INTERNAL_SERVER_ERROR" ||
            upper === "SERVICE_UNAVAILABLE" ||
            upper === "BAD_GATEWAY" ||
            upper === "GATEWAY_TIMEOUT"
          ) {
            return "transient";
          }
        }
      }
    }
  }

  if (!(err instanceof Error)) return "non-retryable";

  const msg = err.message.toLowerCase();
  const status = (err as Error & { status?: number }).status;

  // Rate limiting (HTTP 429 or message indicators).
  if (status === 429) return "rate-limit";
  if (msg.includes("429") || msg.includes("too many requests")) return "rate-limit";
  if (msg.includes("rate limit") || msg.includes("rate_limit") || msg.includes("ratelimit")) {
    return "rate-limit";
  }

  // Transient server errors (5xx) and network glitches.
  if (status === 502 || status === 503 || status === 504) return "transient";
  if (msg.includes("502") || msg.includes("503") || msg.includes("504")) return "transient";
  if (
    msg.includes("internal server error") ||
    msg.includes("bad gateway") ||
    msg.includes("service unavailable") ||
    msg.includes("gateway timeout")
  ) {
    return "transient";
  }
  if (
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("eaddrnotavail") ||
    msg.includes("epipe") ||
    msg.includes("network error") ||
    msg.includes("fetch failed") ||
    msg.includes("socket hang up") ||
    msg.includes("connect timeout")
  ) {
    return "transient";
  }

  // Everything else (auth, validation, not-found, GraphQL field errors, etc.)
  // propagates immediately.
  return "non-retryable";
}
