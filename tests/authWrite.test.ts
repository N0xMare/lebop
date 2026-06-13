import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let viewerImpl: () => Promise<unknown> = async () => ({
  id: "u1",
  email: "viewer@example.com",
  name: "Viewer",
  organization: Promise.resolve({ urlKey: "noxor", name: "Noxor" }),
});

vi.mock("@linear/sdk", () => ({
  LinearClient: class FakeLinearClient {
    get viewer(): Promise<unknown> {
      return viewerImpl();
    }
  },
}));

vi.mock("../src/lib/retry.ts", () => ({
  withRetry: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("auth secure writes", () => {
  let home: string;
  let previousHome: string | undefined;
  let previousWorkspace: string | undefined;
  let previousBun: unknown;

  beforeEach(() => {
    previousHome = process.env.LEBOP_HOME;
    previousWorkspace = process.env.LEBOP_WORKSPACE;
    previousBun = (globalThis as { Bun?: unknown }).Bun;
    home = mkdtempSync(join(tmpdir(), "lebop-auth-write-"));
    chmodSync(home, 0o755);
    process.env.LEBOP_HOME = home;
    delete process.env.LEBOP_WORKSPACE;
    (globalThis as { Bun?: unknown }).Bun = {
      file: (path: string) => ({
        exists: async () => existsSync(path),
        json: async () => JSON.parse(readFileSync(path, "utf8")),
      }),
    };
    viewerImpl = async () => ({
      id: "u1",
      email: "viewer@example.com",
      name: "Viewer",
      organization: Promise.resolve({ urlKey: "noxor", name: "Noxor" }),
    });
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.LEBOP_HOME;
    } else {
      process.env.LEBOP_HOME = previousHome;
    }
    if (previousWorkspace === undefined) {
      delete process.env.LEBOP_WORKSPACE;
    } else {
      process.env.LEBOP_WORKSPACE = previousWorkspace;
    }
    (globalThis as { Bun?: unknown }).Bun = previousBun;
    rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  it("secures an existing permissive LEBOP_HOME before writing auth.json", async () => {
    vi.resetModules();
    const { addWorkspace } = await import("../src/lib/auth.ts");

    await addWorkspace("lin_api_secure");

    expect(mode(home)).toBe(0o700);
    expect(mode(join(home, "auth.json"))).toBe(0o600);
    expect(readdirSync(home).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("refuses a symlinked LEBOP_HOME before writing auth.json", async () => {
    const realHome = mkdtempSync(join(tmpdir(), "lebop-auth-write-real-"));
    const linkHome = join(tmpdir(), `lebop-auth-write-link-${Date.now()}`);
    rmSync(home, { recursive: true, force: true });
    symlinkSync(realHome, linkHome, "dir");
    home = linkHome;
    process.env.LEBOP_HOME = linkHome;
    vi.resetModules();
    const { addWorkspace } = await import("../src/lib/auth.ts");

    await expect(addWorkspace("lin_api_secure")).rejects.toMatchObject({
      code: "auth_error",
      message: expect.stringContaining("unsafe state directory"),
    });
    expect(existsSync(join(realHome, "auth.json"))).toBe(false);
    rmSync(realHome, { recursive: true, force: true });
  });

  it("repairs permissive existing auth permissions before reading auth.json", async () => {
    const authPath = join(home, "auth.json");
    writeFileSync(
      authPath,
      JSON.stringify({
        schema_version: 2,
        workspaces: {
          noxor: {
            slug: "noxor",
            token: "lin_api_existing",
            url_key: "noxor",
            name: "Noxor",
            viewer: { id: "u1", email: "viewer@example.com", name: "Viewer" },
            created_at: "2026-06-01T00:00:00.000Z",
          },
        },
        default: "noxor",
      }),
    );
    chmodSync(home, 0o755);
    chmodSync(authPath, 0o644);
    vi.resetModules();
    const { loadAuth } = await import("../src/lib/auth.ts");

    await expect(loadAuth()).resolves.toMatchObject({ default: "noxor" });
    expect(mode(home)).toBe(0o700);
    expect(mode(authPath)).toBe(0o600);
  });
});
