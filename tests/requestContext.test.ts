import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let home: string | null = null;
const originalHome = process.env.LEBOP_HOME;
const originalWorkspace = process.env.LEBOP_WORKSPACE;

function workspace(slug: string) {
  return {
    slug,
    name: slug,
    url_key: slug,
    token: `lin_api_${slug}`,
    viewer: { id: `viewer-${slug}`, email: `${slug}@example.com`, name: slug },
    created_at: "2026-06-05T00:00:00.000Z",
  };
}

function stubBun(): void {
  vi.stubGlobal("Bun", {
    file: (path: string) => ({
      exists: async () => existsSync(path),
      json: async () => JSON.parse(await readFile(path, "utf8")),
      text: async () => readFile(path, "utf8"),
    }),
    write: writeFile,
  });
}

async function setupAuth(): Promise<void> {
  home = await mkdtemp(join(tmpdir(), "lebop-request-context-"));
  process.env.LEBOP_HOME = home;
  await writeFile(
    join(home, "auth.json"),
    `${JSON.stringify(
      {
        schema_version: 2,
        default: "default-workspace",
        workspaces: {
          "default-workspace": workspace("default-workspace"),
          "env-workspace": workspace("env-workspace"),
          "request-a": workspace("request-a"),
          "request-b": workspace("request-b"),
        },
      },
      null,
      2,
    )}\n`,
  );
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.resetModules();
  if (home) await rm(home, { recursive: true, force: true });
  home = null;
  if (originalHome === undefined) delete process.env.LEBOP_HOME;
  else process.env.LEBOP_HOME = originalHome;
  if (originalWorkspace === undefined) delete process.env.LEBOP_WORKSPACE;
  else process.env.LEBOP_WORKSPACE = originalWorkspace;
});

describe("request context workspace selection", () => {
  it("keeps concurrent workspace overrides isolated without mutating env", async () => {
    await setupAuth();
    process.env.LEBOP_WORKSPACE = "env-workspace";
    stubBun();
    vi.resetModules();
    const { loadAuthForWorkspace } = await import("../src/lib/auth.ts");
    const { runWithRequestContext } = await import("../src/lib/requestContext.ts");

    const [a, b] = await Promise.all([
      runWithRequestContext({ workspace: "request-a" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return (await loadAuthForWorkspace()).slug;
      }),
      runWithRequestContext({ workspace: "request-b" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return (await loadAuthForWorkspace()).slug;
      }),
    ]);

    expect(a).toBe("request-a");
    expect(b).toBe("request-b");
    expect(process.env.LEBOP_WORKSPACE).toBe("env-workspace");
    expect((await loadAuthForWorkspace()).slug).toBe("env-workspace");
  });
});
