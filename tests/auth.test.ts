import { describe, expect, it, vi } from "vitest";
import { AuthError, RateLimitError } from "../src/lib/errors.ts";

// Wave 2 / C — verify probeToken (called via validateToken) routes raw SDK
// failures through `mapSdkError` so structured taxonomy survives login flows.
//
// The auth module imports LinearClient directly from @linear/sdk and constructs
// instances via `linearClientFromToken` — bypassing `linear()` and thus
// `installRawRequestMapping`. The fix in `auth.ts` routes errors thrown by
// `withRetry(() => client.viewer)` through `mapSdkError` (belt-and-suspenders:
// withRetry already does this, but the auth flow strips that structure on the
// way through). These tests cover both the 401-from-status path and the
// structured `extensions.code: UNAUTHENTICATED` path.

// ---------- mock state ----------

// The mocked Linear SDK shape. Each test sets a `viewerImpl` that mimics
// what the SDK would resolve / throw when `.viewer` is awaited.
let viewerImpl: () => Promise<unknown> = async () => ({
  id: "u1",
  email: "a@b",
  name: "Alice",
  organization: Promise.resolve({ urlKey: "acme", name: "Acme" }),
});

vi.mock("@linear/sdk", () => ({
  LinearClient: class FakeLinearClient {
    get viewer(): Promise<unknown> {
      return viewerImpl();
    }
  },
}));

// withRetry: pass through with a single attempt so we don't actually sleep
// or retry — we want the test to deterministically hit the catch arm.
// We use the real retry's behavior of mapping non-retryable errors through
// mapSdkError (mimic by importing and calling directly).
vi.mock("../src/lib/retry.ts", async () => {
  const mod = await import("../src/lib/errors.ts");
  return {
    withRetry: async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        // Mirror the real `withRetry` behavior for non-retryable errors:
        // map through `mapSdkError` and rethrow. We don't bother classifying
        // transient/rate-limit here — auth + 401 are non-retryable.
        throw mod.mapSdkError(err);
      }
    },
  };
});

import { validateToken } from "../src/lib/auth.ts";

describe("validateToken (via probeToken)", () => {
  it("returns the viewer struct on success", async () => {
    viewerImpl = async () => ({
      id: "u1",
      email: "a@b",
      name: "Alice",
      organization: Promise.resolve({ urlKey: "acme", name: "Acme" }),
    });
    const viewer = await validateToken("lin_api_good");
    expect(viewer).toEqual({ id: "u1", email: "a@b", name: "Alice" });
  });

  it("surfaces a 401 status from the SDK as AuthError with code=auth_error", async () => {
    // Simulate Linear rejecting the token with an HTTP 401. `mapSdkError`
    // recognizes `status: 401` and produces an AuthError; probeToken then
    // wraps the message with login-flow-specific affordance.
    viewerImpl = async () => {
      throw Object.assign(new Error("Unauthorized"), { status: 401 });
    };
    const err = await validateToken("lin_api_bad").catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe("auth_error");
    expect((err as AuthError).message).toMatch(/token rejected by Linear/);
    expect((err as AuthError).hint).toMatch(/Settings → API/);
  });

  it("surfaces a structured UNAUTHENTICATED extensions.code as AuthError", async () => {
    // GraphQL-shaped rejection: no HTTP status, but `errors[].extensions.code`
    // = 'UNAUTHENTICATED'. mapSdkError handles this branch separately from
    // the status fallback, so it's worth its own assertion.
    viewerImpl = async () => {
      throw Object.assign(new Error("opaque sdk error"), {
        errors: [{ message: "auth fail", extensions: { code: "UNAUTHENTICATED" } }],
      });
    };
    const err = await validateToken("lin_api_bad").catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe("auth_error");
  });

  it("propagates a 429 as RateLimitError (not AuthError) — regression guard", async () => {
    // The fix in probeToken propagates structured non-Auth LebopError shapes
    // unchanged. A user hitting the login flow during a rate-limit storm
    // should see a RateLimitError, not a misleading "token rejected".
    viewerImpl = async () => {
      throw Object.assign(new Error("Too Many Requests"), { status: 429 });
    };
    const err = await validateToken("lin_api_good").catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).code).toBe("rate_limit_error");
  });

  it("wraps a totally opaque error as AuthError with a 'failed to validate token' message", async () => {
    // Anything mapSdkError can't classify falls through to the legacy
    // `failed to validate token: <msg>` shape so the auth flow always
    // produces a LebopError (never a raw Error).
    viewerImpl = async () => {
      throw new Error("ECONNRESET");
    };
    const err = await validateToken("lin_api_good").catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).message).toMatch(/failed to validate token/);
    expect((err as AuthError).message).toMatch(/ECONNRESET/);
  });
});
