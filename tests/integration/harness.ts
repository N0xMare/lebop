/**
 * Integration-test harness. Spins up a local mock for Linear's GraphQL
 * endpoint via `node:http` (works under both `vitest run` and `bun test`),
 * spawns `bin/lebop` as a child process with `LEBOP_HOME` and `LEBOP_API_URL`
 * overrides, captures stdout/stderr/exit, and returns everything for
 * assertion.
 *
 * Usage from a test file:
 *
 *   import { describe, it, beforeAll, afterAll, expect } from "vitest";
 *   import { startMockLinear, runLebop, makeAuthFile } from "./harness.ts";
 *
 *   describe("teams", () => {
 *     let mock: Awaited<ReturnType<typeof startMockLinear>>;
 *     let env: { LEBOP_HOME: string; LEBOP_API_URL: string };
 *
 *     beforeAll(async () => {
 *       mock = await startMockLinear();
 *       env = { LEBOP_HOME: await makeAuthFile("lin_api_test"), LEBOP_API_URL: mock.url };
 *     });
 *     afterAll(async () => { await mock.stop(); });
 *
 *     it("lists teams", async () => {
 *       mock.respond({ teams: { nodes: [{ key: "ENG", name: "Engineering" }] } });
 *       const r = await runLebop(["teams"], env);
 *       expect(r.exitCode).toBe(0);
 *       expect(r.stdout).toContain("ENG");
 *     });
 *   });
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const LEBOP_BIN = join(REPO_ROOT, "bin", "lebop");

export interface MockResponse {
  /** GraphQL `data` payload for the next request. */
  data?: Record<string, unknown>;
  /** GraphQL `errors` payload for the next request. */
  errors?: { message: string; extensions?: Record<string, unknown> }[];
  /** HTTP status to return. Default 200. */
  status?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface MockServer {
  /** Base URL the SDK should hit. */
  url: string;
  /** Queue a response for the next inbound request (FIFO). */
  respond: (response: MockResponse) => void;
  /** Get the body of the request that consumed `index`-th response. */
  requestAt: (index: number) => { query: string; variables: Record<string, unknown> } | undefined;
  /** Reset the FIFO queue + request log. Use in `afterEach` to isolate tests. */
  reset: () => void;
  /** Stop the server. */
  stop: () => Promise<void>;
}

/**
 * Boot a `node:http` server that responds to GraphQL POST requests with
 * queued mock responses (FIFO). Works under both `vitest run` (Node) and
 * `bun test` (Bun). Each call to `respond()` enqueues one response; the
 * next inbound request consumes it. Returns the server URL (for
 * `LEBOP_API_URL`) plus controls.
 */
export async function startMockLinear(): Promise<MockServer> {
  const queue: MockResponse[] = [];
  const log: { query: string; variables: Record<string, unknown> }[] = [];

  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end("method not allowed");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: { query?: string; variables?: Record<string, unknown> };
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "bad request body" }] }));
        return;
      }
      log.push({ query: body.query ?? "", variables: body.variables ?? {} });
      const next = queue.shift();
      if (!next) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ errors: [{ message: "no mock response queued for this request" }] }),
        );
        return;
      }
      const payload: Record<string, unknown> = {};
      if (next.data !== undefined) payload.data = next.data;
      if (next.errors !== undefined) payload.errors = next.errors;
      res.writeHead(next.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/graphql`,
    respond: (response) => {
      queue.push(response);
    },
    requestAt: (index) => log[index],
    reset: () => {
      queue.length = 0;
      log.length = 0;
    },
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Create a fresh temp `LEBOP_HOME` directory containing a valid `auth.json`
 * for the given token. Returns the directory path so the test can pass it
 * via env to `runLebop`.
 */
export async function makeAuthFile(
  token: string,
  viewer: { id: string; email: string; name: string } = {
    id: "viewer-id",
    email: "viewer@example.com",
    name: "Test Viewer",
  },
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lebop-test-"));
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify(
      {
        schema_version: 1,
        token,
        viewer,
        created_at: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return dir;
}

/**
 * Spawn `bin/lebop` as a child process with the supplied args + env, wait
 * for exit, and return captured streams + exit code. Inherits the parent
 * process env minus anything overridden in `env`.
 */
export async function runLebop(
  args: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("bun", [LEBOP_BIN, ...args], {
      env: {
        ...process.env,
        // Force colors off so chalk doesn't pollute stdout assertions.
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}
