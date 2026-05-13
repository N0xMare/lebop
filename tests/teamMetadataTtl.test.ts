/**
 * Tests for the `team_metadata_ttl_seconds` config plumbing introduced in
 * wave-3 round-3 polish. Covers:
 *
 *   1. `isTeamMetadataStale` standalone — default 3600s + explicit override.
 *   2. End-to-end via `getTeamMetadata` — with `loadUserConfig` mocked,
 *      assert that the resolved TTL controls whether the cache short-circuits
 *      or a refetch is attempted. We mock `readTeamMetadata` (cache reader)
 *      and `withClient` (sdk entry) directly to keep the test hermetic.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isTeamMetadataStale, type TeamMetadata } from "../src/lib/cache.ts";

function buildMetadata(fetchedAt: Date): TeamMetadata {
  return {
    team_id: "t-1",
    team_key: "UE",
    fetched_at: fetchedAt.toISOString(),
    states: [{ id: "s-1", name: "Backlog", type: "backlog" }],
    labels: [],
    members: [],
    projects: [],
  };
}

// Mocks live above the import sites that consume them. The cache module
// supplies both `readTeamMetadata` and the `writeTeamMetadata` writer; we
// stub them out plus `withClient` so no real network or disk is touched.
//
// `loadUserConfig` is mocked per-test via `vi.mocked(...).mockResolvedValue`
// so each test can pick its own TTL.
vi.mock("../src/lib/config.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/config.ts")>("../src/lib/config.ts");
  return {
    ...actual,
    loadUserConfig: vi.fn(async () => ({})),
  };
});

vi.mock("../src/lib/cache.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/cache.ts")>("../src/lib/cache.ts");
  return {
    ...actual,
    readTeamMetadata: vi.fn(),
    writeTeamMetadata: vi.fn(async () => {}),
  };
});

vi.mock("../src/lib/sdk.ts", () => ({
  withClient: vi.fn(),
  linear: vi.fn(),
}));

describe("isTeamMetadataStale (default TTL)", () => {
  it("treats a freshly-fetched entry as not stale under the 3600s default", () => {
    const m = buildMetadata(new Date());
    expect(isTeamMetadataStale(m)).toBe(false);
  });

  it("treats an entry older than the 3600s default as stale", () => {
    // 2 hours ago — past the default 1h TTL.
    const m = buildMetadata(new Date(Date.now() - 7200 * 1000));
    expect(isTeamMetadataStale(m)).toBe(true);
  });

  it("treats unparseable fetched_at as stale (forces refetch)", () => {
    const m = buildMetadata(new Date());
    m.fetched_at = "not a real date";
    expect(isTeamMetadataStale(m)).toBe(true);
  });
});

describe("isTeamMetadataStale (explicit TTL override)", () => {
  it("respects a short TTL — 10s, entry 30s old is stale", () => {
    const m = buildMetadata(new Date(Date.now() - 30 * 1000));
    expect(isTeamMetadataStale(m, 10)).toBe(true);
  });

  it("respects a long TTL — 86_400s, entry 2h old is not stale", () => {
    const m = buildMetadata(new Date(Date.now() - 7200 * 1000));
    expect(isTeamMetadataStale(m, 86_400)).toBe(false);
  });
});

describe("getTeamMetadata wires team_metadata_ttl_seconds from user config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("default path: with no config key set, a 60s-old entry is treated as fresh (TTL=3600s)", async () => {
    const { loadUserConfig } = await import("../src/lib/config.ts");
    const { readTeamMetadata } = await import("../src/lib/cache.ts");
    const { withClient } = await import("../src/lib/sdk.ts");
    const { getTeamMetadata } = await import("../src/lib/resolve.ts");

    vi.mocked(loadUserConfig).mockResolvedValue({});
    const fresh = buildMetadata(new Date(Date.now() - 60 * 1000));
    vi.mocked(readTeamMetadata).mockResolvedValue(fresh);

    const got = await getTeamMetadata("repo-hash", "UE");
    expect(got.fetched_at).toBe(fresh.fetched_at);
    // No network call: `withClient` would only be invoked on a cache miss
    // OR stale entry. A fresh entry under the default TTL means short-circuit.
    expect(vi.mocked(withClient)).not.toHaveBeenCalled();
  });

  it("override path: ttl=60 in config + 2h-old entry → cache treated as stale → refetch attempted", async () => {
    const { loadUserConfig } = await import("../src/lib/config.ts");
    const { readTeamMetadata } = await import("../src/lib/cache.ts");
    const { withClient } = await import("../src/lib/sdk.ts");
    const { getTeamMetadata } = await import("../src/lib/resolve.ts");

    vi.mocked(loadUserConfig).mockResolvedValue({ team_metadata_ttl_seconds: 60 });
    const stale = buildMetadata(new Date(Date.now() - 7200 * 1000));
    vi.mocked(readTeamMetadata).mockResolvedValue(stale);

    // First `withClient` call returns a teams page with no nodes → resolve.ts
    // throws ResolveError("team not found"). That's enough to assert "refetch
    // was attempted" without standing up a full LinearClient.
    vi.mocked(withClient).mockResolvedValueOnce({ nodes: [] } as unknown as never);

    await expect(getTeamMetadata("repo-hash", "UE")).rejects.toThrow(/team not found/);
    expect(vi.mocked(withClient)).toHaveBeenCalled();
  });

  it("override path: long TTL (86_400s) + 2h-old entry → still fresh, no refetch", async () => {
    const { loadUserConfig } = await import("../src/lib/config.ts");
    const { readTeamMetadata } = await import("../src/lib/cache.ts");
    const { withClient } = await import("../src/lib/sdk.ts");
    const { getTeamMetadata } = await import("../src/lib/resolve.ts");

    vi.mocked(loadUserConfig).mockResolvedValue({ team_metadata_ttl_seconds: 86_400 });
    const olderButWithinTtl = buildMetadata(new Date(Date.now() - 7200 * 1000));
    vi.mocked(readTeamMetadata).mockResolvedValue(olderButWithinTtl);

    const got = await getTeamMetadata("repo-hash", "UE");
    expect(got.fetched_at).toBe(olderButWithinTtl.fetched_at);
    expect(vi.mocked(withClient)).not.toHaveBeenCalled();
  });
});
