import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

type AuthModule = typeof import("../src/lib/auth.ts");
type ErrorsModule = typeof import("../src/lib/errors.ts");

let AuthError: ErrorsModule["AuthError"];
let RateLimitError: ErrorsModule["RateLimitError"];
let loadAuth: AuthModule["loadAuth"];
let validateToken: AuthModule["validateToken"];
let resolveLinearApiUrlOverride: AuthModule["resolveLinearApiUrlOverride"];
let authHome: string;
let authFile: string;
let prevHome: string | undefined;
let prevWorkspace: string | undefined;
let prevApiUrl: string | undefined;
let prevAllowCustomApiUrl: string | undefined;
let prevBun: unknown;

interface CapturedErrorShape {
  code?: string;
  hint?: string;
  message: string;
}

beforeAll(async () => {
  prevHome = process.env.LEBOP_HOME;
  prevWorkspace = process.env.LEBOP_WORKSPACE;
  prevApiUrl = process.env.LEBOP_API_URL;
  prevAllowCustomApiUrl = process.env.LEBOP_ALLOW_CUSTOM_API_URL;
  prevBun = (globalThis as { Bun?: unknown }).Bun;
  authHome = mkdtempSync(join(tmpdir(), "lebop-auth-test-"));
  authFile = join(authHome, "auth.json");
  process.env.LEBOP_HOME = authHome;
  delete process.env.LEBOP_WORKSPACE;
  (globalThis as { Bun?: unknown }).Bun = {
    file: (path: string) => ({
      exists: async () => existsSync(path),
      json: async () => JSON.parse(readFileSync(path, "utf8")),
    }),
  };
  vi.resetModules();
  ({ AuthError, RateLimitError } = await import("../src/lib/errors.ts"));
  ({ loadAuth, resolveLinearApiUrlOverride, validateToken } = await import("../src/lib/auth.ts"));
});

beforeEach(() => {
  rmSync(authFile, { force: true });
  viewerImpl = async () => ({
    id: "u1",
    email: "a@b",
    name: "Alice",
    organization: Promise.resolve({ urlKey: "acme", name: "Acme" }),
  });
  delete process.env.LEBOP_API_URL;
  delete process.env.LEBOP_ALLOW_CUSTOM_API_URL;
});

afterAll(() => {
  if (prevHome === undefined) {
    delete process.env.LEBOP_HOME;
  } else {
    process.env.LEBOP_HOME = prevHome;
  }
  if (prevWorkspace === undefined) {
    delete process.env.LEBOP_WORKSPACE;
  } else {
    process.env.LEBOP_WORKSPACE = prevWorkspace;
  }
  if (prevApiUrl === undefined) {
    delete process.env.LEBOP_API_URL;
  } else {
    process.env.LEBOP_API_URL = prevApiUrl;
  }
  if (prevAllowCustomApiUrl === undefined) {
    delete process.env.LEBOP_ALLOW_CUSTOM_API_URL;
  } else {
    process.env.LEBOP_ALLOW_CUSTOM_API_URL = prevAllowCustomApiUrl;
  }
  (globalThis as { Bun?: unknown }).Bun = prevBun;
  rmSync(authHome, { recursive: true, force: true });
  vi.resetModules();
});

describe("LEBOP_API_URL safety", () => {
  it("allows local test-server API URL overrides", () => {
    process.env.LEBOP_API_URL = "http://127.0.0.1:4567/graphql";

    expect(resolveLinearApiUrlOverride()).toBe("http://127.0.0.1:4567/graphql");
  });

  it("rejects non-local API URL overrides unless explicitly allowed", () => {
    process.env.LEBOP_API_URL = "https://example.invalid/graphql";

    expect(() => resolveLinearApiUrlOverride()).toThrow(/LEBOP_ALLOW_CUSTOM_API_URL/);
  });

  it("rejects malformed and non-HTTP API URL overrides", () => {
    process.env.LEBOP_API_URL = "not a url";
    expect(() => resolveLinearApiUrlOverride()).toThrow(/valid URL/);

    process.env.LEBOP_API_URL = "file:///tmp/linear.sock";
    expect(() => resolveLinearApiUrlOverride()).toThrow(/http or https/);
  });

  it("allows intentional non-local API URL overrides with the escape hatch", () => {
    process.env.LEBOP_API_URL = "https://example.invalid/graphql";
    process.env.LEBOP_ALLOW_CUSTOM_API_URL = "1";

    expect(resolveLinearApiUrlOverride()).toBe("https://example.invalid/graphql");
  });

  it("allows localhost and IPv6 loopback test-server overrides", () => {
    for (const url of [
      "http://localhost:4567/graphql",
      "http://[::1]:4567/graphql",
      "http://127.0.0.1:4567/graphql",
    ]) {
      process.env.LEBOP_API_URL = url;
      expect(resolveLinearApiUrlOverride()).toBe(url);
    }
  });
});

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
    expect((err as CapturedErrorShape).code).toBe("auth_error");
    expect((err as CapturedErrorShape).message).toMatch(/token rejected by Linear/);
    expect((err as CapturedErrorShape).hint).toMatch(/Settings → API/);
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
    expect((err as CapturedErrorShape).code).toBe("auth_error");
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
    expect((err as CapturedErrorShape).code).toBe("rate_limit_error");
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
    expect((err as CapturedErrorShape).message).toMatch(/failed to validate token/);
    expect((err as CapturedErrorShape).message).toMatch(/ECONNRESET/);
  });
});

describe("loadAuth v2 validation", () => {
  function writeAuthJson(value: unknown): void {
    writeFileSync(authFile, `${JSON.stringify(value)}\n`);
  }

  it("rejects malformed workspace records", async () => {
    writeAuthJson({
      schema_version: 2,
      default: "noxor",
      workspaces: {
        noxor: {
          slug: "noxor",
          name: "Noxor",
          url_key: "noxor",
          token: "lin_api_test",
          viewer: { id: "u1", email: "viewer@example.com" },
          created_at: "2026-06-05T00:00:00.000Z",
        },
      },
    });
    const err = await loadAuth().catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toContain("unexpected shape");
  });

  it("rejects a default workspace that does not exist", async () => {
    writeAuthJson({
      schema_version: 2,
      default: "missing",
      workspaces: {
        noxor: {
          slug: "noxor",
          name: "Noxor",
          url_key: "noxor",
          token: "lin_api_test",
          viewer: { id: "u1", email: "viewer@example.com", name: "Viewer" },
          created_at: "2026-06-05T00:00:00.000Z",
        },
      },
    });
    const err = await loadAuth().catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.message).toContain("unexpected shape");
  });
});
