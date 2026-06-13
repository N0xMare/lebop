import { describe, expect, it } from "vitest";
import {
  collectLinearRateLimitTelemetry,
  linearApiEnvelopeMeta,
  linearRateLimitDetailsFromHeaders,
  observeLinearRateLimitHeaders,
  rateLimitRetryDelayMs,
  recordLinearApiAttempt,
} from "../src/lib/rateLimit.ts";

describe("Linear rate-limit telemetry", () => {
  it("parses request, endpoint, complexity, and retry headers", () => {
    const reset = 1_787_000_000_000;
    const details = linearRateLimitDetailsFromHeaders({
      "x-ratelimit-requests-limit": "2500",
      "x-ratelimit-requests-remaining": "2499",
      "x-ratelimit-requests-reset": String(reset),
      "x-ratelimit-endpoint-requests-limit": "100",
      "x-ratelimit-endpoint-requests-remaining": "99",
      "x-ratelimit-endpoint-requests-reset": String(reset + 1000),
      "x-ratelimit-endpoint-name": "issues",
      "x-complexity": "66",
      "x-ratelimit-complexity-limit": "3000000",
      "x-ratelimit-complexity-remaining": "2999934",
      "x-ratelimit-complexity-reset": String(reset + 2000),
      "retry-after": "2",
    });

    expect(details).toMatchObject({
      observed: true,
      request_budget: {
        limit: 2500,
        remaining: 2499,
        reset_epoch_ms: reset,
        reset_at: new Date(reset).toISOString(),
      },
      endpoint_budget: {
        name: "issues",
        limit: 100,
        remaining: 99,
        reset_epoch_ms: reset + 1000,
      },
      complexity_budget: {
        used: 66,
        limit: 3000000,
        remaining: 2999934,
        reset_epoch_ms: reset + 2000,
      },
      retry_after_seconds: 2,
    });
  });

  it("aggregates request count and last observed budgets per async operation", async () => {
    const reset = 1_787_000_000_000;
    const { telemetry } = await collectLinearRateLimitTelemetry(async () => {
      recordLinearApiAttempt("noxor");
      observeLinearRateLimitHeaders("noxor", {
        "x-ratelimit-requests-limit": "2500",
        "x-ratelimit-requests-remaining": "2400",
        "x-ratelimit-requests-reset": String(reset),
      });
      recordLinearApiAttempt("noxor");
      observeLinearRateLimitHeaders("noxor", {
        "x-ratelimit-requests-limit": "2500",
        "x-ratelimit-requests-remaining": "2399",
        "x-ratelimit-requests-reset": String(reset),
      });
      return "ok";
    });

    expect(telemetry).toMatchObject({
      observed: true,
      requests_made: 2,
      workspaces: ["noxor"],
      request_budget: { limit: 2500, remaining: 2399, reset_epoch_ms: reset },
    });
    expect(linearApiEnvelopeMeta(telemetry)).toMatchObject({
      linear_api: {
        request_count: 2,
        workspaces: ["noxor"],
        rate_limit: {
          requests: { remaining: 2399 },
        },
      },
    });
  });

  it("omits envelope metadata when no Linear rate-limit headers were observed", async () => {
    const { telemetry } = await collectLinearRateLimitTelemetry(async () => {
      recordLinearApiAttempt("noxor");
      return "ok";
    });

    expect(telemetry).toMatchObject({
      observed: false,
      requests_made: 1,
      workspaces: ["noxor"],
    });
    expect(linearApiEnvelopeMeta(telemetry)).toBeUndefined();
  });

  it("uses retry-after before reset-window calculations", () => {
    expect(
      rateLimitRetryDelayMs(
        {
          observed: true,
          retry_after_seconds: 3,
          request_budget: { remaining: 0, reset_epoch_ms: 10_000 },
        },
        1_000,
      ),
    ).toBe(3000);
  });

  it("waits until the longest exhausted rate-limit window resets", () => {
    expect(
      rateLimitRetryDelayMs(
        {
          observed: true,
          request_budget: { remaining: 0, reset_epoch_ms: 10_000 },
          complexity_budget: { remaining: 0, reset_epoch_ms: 12_000 },
        },
        1_000,
      ),
    ).toBe(11_250);
  });
});
