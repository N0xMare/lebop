import { describe, expect, it, vi } from "vitest";
import {
  AuthError,
  LebopError,
  mapSdkError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "../src/lib/errors.ts";

// ---------- Fix #2: mapSdkError taxonomy ----------
//
// Direct unit tests for the SDK-boundary error mapper. These cover the four
// shapes the brief calls out (NotFound, Validation, Auth, RateLimit) plus a
// regression guard that non-mapped errors pass through unchanged.

describe("mapSdkError", () => {
  describe("Entity not found", () => {
    it("maps Linear's 'Entity not found: X - Could not find referenced X.' message", () => {
      const err = new Error("Entity not found: Project - Could not find referenced Project.");
      const mapped = mapSdkError(err);
      expect(mapped).toBeInstanceOf(NotFoundError);
      const lerr = mapped as LebopError;
      expect(lerr.code).toBe("not_found");
      // The hint should mention the entity type so callers can surface it.
      expect(lerr.hint).toMatch(/Project/);
    });

    it("maps structured extensions.code = NOT_FOUND", () => {
      const err = Object.assign(new Error("some message"), {
        errors: [{ message: "missing X", extensions: { code: "NOT_FOUND" } }],
      });
      const mapped = mapSdkError(err);
      expect(mapped).toBeInstanceOf(NotFoundError);
      expect((mapped as LebopError).hint).toBeTruthy();
    });
  });

  describe("Validation", () => {
    it("maps 'Argument Validation Error - ...' message", () => {
      const err = new Error("Argument Validation Error - field 'priority' must be 0..4");
      const mapped = mapSdkError(err);
      expect(mapped).toBeInstanceOf(ValidationError);
      const lerr = mapped as LebopError;
      expect(lerr.code).toBe("validation_error");
      expect(lerr.hint).toMatch(/priority/);
    });

    it("maps structured extensions.code = INVALID_INPUT", () => {
      const err = Object.assign(new Error("opaque"), {
        errors: [{ message: "bad input", extensions: { code: "INVALID_INPUT" } }],
      });
      const mapped = mapSdkError(err);
      expect(mapped).toBeInstanceOf(ValidationError);
    });
  });

  describe("Auth", () => {
    it("maps 401 status to AuthError", () => {
      const err = Object.assign(new Error("Unauthorized"), { status: 401 });
      const mapped = mapSdkError(err);
      expect(mapped).toBeInstanceOf(AuthError);
      const lerr = mapped as LebopError;
      expect(lerr.code).toBe("auth_error");
      expect(lerr.hint).toMatch(/lebop auth login/);
    });

    it("maps AuthenticationError-style message", () => {
      const err = new Error("authentication failed for token lin_api_***");
      const mapped = mapSdkError(err);
      expect(mapped).toBeInstanceOf(AuthError);
    });

    it("maps structured extensions.code = UNAUTHENTICATED", () => {
      const err = Object.assign(new Error("opaque"), {
        errors: [{ message: "nope", extensions: { code: "UNAUTHENTICATED" } }],
      });
      expect(mapSdkError(err)).toBeInstanceOf(AuthError);
    });
  });

  describe("Rate limit", () => {
    it("maps 429 status to RateLimitError", () => {
      const err = Object.assign(new Error("Too Many Requests"), { status: 429 });
      const mapped = mapSdkError(err);
      expect(mapped).toBeInstanceOf(RateLimitError);
      expect((mapped as LebopError).code).toBe("rate_limit_error");
    });

    it("maps structured extensions.code = RATELIMITED", () => {
      const err = Object.assign(new Error("opaque"), {
        errors: [{ message: "x", extensions: { code: "RATELIMITED" } }],
      });
      expect(mapSdkError(err)).toBeInstanceOf(RateLimitError);
    });
  });

  describe("pass-through", () => {
    it("returns LebopError instances unchanged (idempotent)", () => {
      const original = new ValidationError("already structured");
      expect(mapSdkError(original)).toBe(original);
    });

    it("returns unrelated errors unchanged so callers still throw them", () => {
      // Regression guard for the brief's 'NON-not-found still throws' case:
      // an arbitrary network error must not be silently swallowed.
      const err = new Error("ECONNRESET something");
      // mapSdkError is permissive — it leaves this alone (retry.ts handles
      // transient classification separately).
      const mapped = mapSdkError(err);
      expect(mapped).toBe(err);
      expect(mapped).not.toBeInstanceOf(LebopError);
    });
  });
});

// ---------- Fix #1: get_* return null on not-found ----------
//
// Mock the SDK boundary to throw the raw Linear "Entity not found" wording for
// each of the 6 get_* functions; assert they return null. Includes a regression
// case (one fn) that confirms a non-not-found error still propagates.

const notFoundError = () =>
  new Error("Entity not found: Project - Could not find referenced Project.");

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: async <T>(fn: (c: unknown) => Promise<T>): Promise<T> =>
    fn({
      client: {
        rawRequest: async (_query: string, _variables: unknown) => {
          const next = nextMockResponse();
          if (next instanceof Error) throw next;
          return next;
        },
      },
    }),
  linear: async () => ({
    client: {
      rawRequest: async (_query: string, _variables: unknown) => {
        const next = nextMockResponse();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  }),
}));

let mockQueue: Array<{ data: unknown } | Error> = [];
function nextMockResponse(): { data: unknown } | Error {
  const next = mockQueue.shift();
  if (!next) throw new Error("mock exhausted");
  return next;
}
function queue(...items: Array<{ data: unknown } | Error>) {
  mockQueue = items;
}

import { getAgentSession } from "../src/lib/agentSessions.ts";
import { getCycle } from "../src/lib/cycles.ts";
import { getDocument } from "../src/lib/documents.ts";
import { getInitiative } from "../src/lib/initiatives.ts";
import { getMilestone } from "../src/lib/milestones.ts";
import { getProject } from "../src/lib/projects.ts";

describe("get_* returns null on Entity not found", () => {
  it("getProject: returns null", async () => {
    queue(notFoundError());
    expect(await getProject("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("getInitiative: returns null", async () => {
    queue(notFoundError());
    expect(await getInitiative("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("getMilestone: returns null", async () => {
    queue(notFoundError());
    expect(await getMilestone("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("getDocument: returns null", async () => {
    queue(notFoundError());
    expect(await getDocument("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("getCycle: returns null", async () => {
    queue(notFoundError());
    expect(await getCycle("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("getAgentSession: returns null", async () => {
    queue(notFoundError());
    expect(await getAgentSession("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("getProject: still throws on non-not-found errors (regression guard)", async () => {
    // An auth error must NOT be silently turned into null. The function should
    // map it to AuthError (via mapSdkError) and rethrow.
    queue(Object.assign(new Error("Unauthorized"), { status: 401 }));
    await expect(getProject("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
      AuthError,
    );
  });
});
