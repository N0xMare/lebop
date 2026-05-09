import { describe, expect, it } from "vitest";
import { NetworkError, RateLimitError } from "../src/lib/errors.ts";
import { classifyError, withRetry } from "../src/lib/retry.ts";

describe("classifyError", () => {
  describe("rate limits", () => {
    it("classifies HTTP 429 status", () => {
      const err = Object.assign(new Error("Too many requests"), { status: 429 });
      expect(classifyError(err)).toBe("rate-limit");
    });

    it("classifies error message containing '429'", () => {
      expect(classifyError(new Error("got 429 from upstream"))).toBe("rate-limit");
    });

    it("classifies 'rate limit' in message", () => {
      expect(classifyError(new Error("rate limit exceeded"))).toBe("rate-limit");
      expect(classifyError(new Error("Rate Limit Exceeded"))).toBe("rate-limit");
      expect(classifyError(new Error("RATE_LIMITED"))).toBe("rate-limit");
      expect(classifyError(new Error("rateLimit window"))).toBe("rate-limit");
    });

    it("classifies 'too many requests' as rate limit", () => {
      expect(classifyError(new Error("Too many requests"))).toBe("rate-limit");
    });
  });

  describe("transient errors", () => {
    it("classifies HTTP 5xx via status", () => {
      expect(classifyError(Object.assign(new Error(), { status: 502 }))).toBe("transient");
      expect(classifyError(Object.assign(new Error(), { status: 503 }))).toBe("transient");
      expect(classifyError(Object.assign(new Error(), { status: 504 }))).toBe("transient");
    });

    it("classifies 5xx via message", () => {
      expect(classifyError(new Error("502 bad gateway"))).toBe("transient");
      expect(classifyError(new Error("503 Service Unavailable"))).toBe("transient");
      expect(classifyError(new Error("504 gateway timeout"))).toBe("transient");
      expect(classifyError(new Error("internal server error"))).toBe("transient");
    });

    it("classifies network glitches", () => {
      expect(classifyError(new Error("ECONNRESET"))).toBe("transient");
      expect(classifyError(new Error("ETIMEDOUT"))).toBe("transient");
      expect(classifyError(new Error("ENOTFOUND linear.app"))).toBe("transient");
      expect(classifyError(new Error("fetch failed"))).toBe("transient");
      expect(classifyError(new Error("socket hang up"))).toBe("transient");
      expect(classifyError(new Error("Connect Timeout"))).toBe("transient");
    });
  });

  describe("non-retryable errors", () => {
    it("classifies auth errors", () => {
      expect(classifyError(new Error("authentication failed"))).toBe("non-retryable");
      expect(classifyError(new Error("Unauthorized"))).toBe("non-retryable");
    });

    it("classifies validation errors", () => {
      expect(classifyError(new Error("Entity not found: TEAM-999"))).toBe("non-retryable");
      expect(classifyError(new Error("Field 'foo' is not defined"))).toBe("non-retryable");
    });

    it("classifies non-Error inputs as non-retryable", () => {
      expect(classifyError(null)).toBe("non-retryable");
      expect(classifyError(undefined)).toBe("non-retryable");
      expect(classifyError("string error")).toBe("non-retryable");
      expect(classifyError({ message: "no Error wrapper" })).toBe("non-retryable");
    });

    it("classifies HTTP 400/404 (no retry on client errors)", () => {
      // No status match for 400 in the classifier — falls through to non-retryable.
      expect(classifyError(Object.assign(new Error("Bad Request"), { status: 400 }))).toBe(
        "non-retryable",
      );
    });
  });
});

describe("withRetry", () => {
  it("returns the value on first success without delay", async () => {
    const start = Date.now();
    const result = await withRetry(async () => 42);
    expect(result).toBe(42);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("propagates non-retryable errors immediately on first attempt", async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        throw new Error("authentication failed");
      }),
    ).rejects.toThrow("authentication failed");
    expect(attempts).toBe(1);
  });

  it("retries transient errors and eventually succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("ECONNRESET");
        return "ok";
      },
      { initialDelayMs: 1, maxDelayMs: 5 },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("throws RateLimitError on exhausted rate-limit retries", async () => {
    await expect(
      withRetry(
        async () => {
          throw new Error("Too many requests");
        },
        { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 5 },
      ),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("throws NetworkError on exhausted transient retries", async () => {
    await expect(
      withRetry(
        async () => {
          throw new Error("ECONNRESET");
        },
        { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 5 },
      ),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});
