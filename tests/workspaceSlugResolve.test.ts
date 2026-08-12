import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  peekAuthWorkspacesSync,
  resolveWorkspaceSlugForState,
  UNSET_WORKSPACE_SLUG,
  workspaceCacheRoot,
} from "../src/lib/paths.ts";
import { runWithRequestContext } from "../src/lib/requestContext.ts";

const ORIG_HOME = process.env.LEBOP_HOME;
const ORIG_WS = process.env.LEBOP_WORKSPACE;

function writeAuth(home: string, body: unknown): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), `${JSON.stringify(body)}\n`, { mode: 0o600 });
}

describe("Lane 3 hybrid workspace slug resolve", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(process.cwd(), `.tmp-ws-test-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    process.env.LEBOP_HOME = tmp;
    delete process.env.LEBOP_WORKSPACE;
  });

  afterEach(() => {
    if (ORIG_HOME === undefined) delete process.env.LEBOP_HOME;
    else process.env.LEBOP_HOME = ORIG_HOME;
    if (ORIG_WS === undefined) delete process.env.LEBOP_WORKSPACE;
    else process.env.LEBOP_WORKSPACE = ORIG_WS;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("uses auth.default when no explicit/env/context", () => {
    writeAuth(tmp, {
      schema_version: 2,
      default: "playground",
      workspaces: {
        playground: { slug: "playground", token: "t" },
        other: { slug: "other", token: "t2" },
      },
    });
    expect(resolveWorkspaceSlugForState()).toBe("playground");
    expect(workspaceCacheRoot()).toContain("playground");
  });

  it("uses single workspace when no default", () => {
    writeAuth(tmp, {
      schema_version: 2,
      default: null,
      workspaces: { alone: { slug: "alone", token: "t" } },
    });
    expect(resolveWorkspaceSlugForState()).toBe("alone");
  });

  it("fail-closed multi-ws lists available slugs", () => {
    writeAuth(tmp, {
      schema_version: 2,
      workspaces: {
        a: { slug: "a", token: "t" },
        b: { slug: "b", token: "t2" },
      },
    });
    try {
      resolveWorkspaceSlugForState();
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toMatchObject({
        code: "workspace_required",
        details: { available_workspaces: ["a", "b"] },
      });
      expect(String((err as Error).message)).toContain("a, b");
      expect(String((err as { hint?: string }).hint)).toContain("available:");
    }
  });

  it("explicit and env beat auth.default", () => {
    writeAuth(tmp, {
      schema_version: 2,
      default: "playground",
      workspaces: {
        playground: { slug: "playground", token: "t" },
        other: { slug: "other", token: "t2" },
      },
    });
    expect(resolveWorkspaceSlugForState("other")).toBe("other");
    process.env.LEBOP_WORKSPACE = "other";
    expect(resolveWorkspaceSlugForState()).toBe("other");
  });

  it("request context beats auth.default", () => {
    writeAuth(tmp, {
      schema_version: 2,
      default: "playground",
      workspaces: {
        playground: { slug: "playground", token: "t" },
        other: { slug: "other", token: "t2" },
      },
    });
    runWithRequestContext({ workspace: "other" }, () => {
      expect(resolveWorkspaceSlugForState()).toBe("other");
    });
  });

  it("pre-auth returns _unset", () => {
    expect(peekAuthWorkspacesSync()).toBeNull();
    expect(resolveWorkspaceSlugForState()).toBe(UNSET_WORKSPACE_SLUG);
  });
});
