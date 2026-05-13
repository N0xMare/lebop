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
 *
 * For MCP integration tests, see `startMcpClient` further down — it spawns
 * `bin/lebop mcp`, drives JSON-RPC over stdio, and exposes a tight API
 * (initialize / listTools / callTool / close).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
 *
 * Writes the v2 multi-workspace shape directly so tests don't trigger the
 * v1→v2 migration path (which calls Linear to fetch the org urlKey).
 */
export async function makeAuthFile(
  token: string,
  viewer: { id: string; email: string; name: string } = {
    id: "viewer-id",
    email: "viewer@example.com",
    name: "Test Viewer",
  },
  slug = "test-workspace",
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lebop-test-"));
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify(
      {
        schema_version: 2,
        workspaces: {
          [slug]: {
            slug,
            name: "Test Workspace",
            url_key: slug,
            token,
            viewer,
            created_at: new Date().toISOString(),
          },
        },
        default: slug,
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
 *
 * Round-6 / H1: `cwd` is now configurable. Tests that exercise repo-scoped
 * paths (`diff`, `push`, cache mode) must control the spawn's working
 * directory so `findGitRoot()` resolves predictably — either to the test's
 * tmpdir (no git, `repoHash="_global"`) or to a fixture directory the test
 * has prepared.
 */
export async function runLebop(
  args: string[],
  env: Record<string, string> = {},
  cwd?: string,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("bun", [LEBOP_BIN, ...args], {
      cwd,
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

// ============================================================================
// MCP client — JSON-RPC stdio harness for `bin/lebop mcp`.
// ============================================================================

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpToolContent {
  type: "text";
  text: string;
}

export interface McpToolResult {
  content: McpToolContent[];
  isError?: boolean;
  /** Parsed body of the first text content block as JSON; `null` if unparsable. */
  parsed: unknown;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities?: Record<string, unknown>;
  serverInfo?: Record<string, unknown>;
}

export interface McpClient {
  /** Send JSON-RPC `initialize` and return the server's reply. */
  initialize(): Promise<McpInitializeResult>;
  /** Send the post-initialize notification per spec. No reply expected. */
  notifyInitialized(): Promise<void>;
  /** Send JSON-RPC `tools/list` and return the parsed `tools` array. */
  listTools(): Promise<{ tools: McpToolDescriptor[] }>;
  /** Send JSON-RPC `tools/call` with `{name, arguments}`. */
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  /** Close stdin and wait for the child to exit (or kill on timeout). */
  close(): Promise<void>;
  /** Captured stderr from the child (useful for debugging flakes). */
  readonly stderr: string;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Spawn `bin/lebop mcp` and return a thin JSON-RPC client. Messages are
 * newline-delimited per the MCP stdio transport spec. Responses are routed
 * back to their callers by `id`; the rare unsolicited message (e.g. a server
 * notification) is dropped on the floor (no current tests need it).
 *
 * Timeouts default to 10s per request — well above any in-process mock
 * round-trip and short enough to fail a hung test before vitest's default
 * suite timeout. Override per-call by chaining your own `Promise.race`.
 *
 * The child's stderr is captured into the `stderr` field; failures throw an
 * Error that includes it for fast diagnosis.
 */
export async function startMcpClient(env: Record<string, string> = {}): Promise<McpClient> {
  const child: ChildProcessWithoutNullStreams = spawn("bun", [LEBOP_BIN, "mcp"], {
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  // Line-buffered stdout reader: the MCP SDK writes one JSON-RPC message per
  // line. We buffer partial lines until a `\n` arrives, then route each
  // complete line to the waiter registered for its `id`.
  let buf = "";
  const pending = new Map<
    number,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }
  >();
  let nextId = 1;
  let exited = false;

  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length > 0) {
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (typeof msg.id === "number" && pending.has(msg.id)) {
            const waiter = pending.get(msg.id);
            pending.delete(msg.id);
            waiter?.resolve(msg);
          }
          // Else: server notification or unknown id — ignore silently.
        } catch {
          // Non-JSON line (shouldn't happen, but tolerate stray logging).
        }
      }
      nl = buf.indexOf("\n");
    }
  });

  child.on("exit", () => {
    exited = true;
    // Reject any in-flight waiters so tests fail fast instead of hanging
    // until the vitest suite-level timeout.
    for (const [, waiter] of pending) {
      waiter.reject(
        new Error(`MCP child exited before responding. stderr:\n${stderr || "(empty)"}`),
      );
    }
    pending.clear();
  });

  child.on("error", (err) => {
    for (const [, waiter] of pending) {
      waiter.reject(err);
    }
    pending.clear();
  });

  function send(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    if (exited) {
      return Promise.reject(new Error(`MCP child already exited. stderr:\n${stderr || "(empty)"}`));
    }
    const id = nextId++;
    const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    const promise = new Promise<JsonRpcResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(
            new Error(
              `MCP request "${method}" (id=${id}) timed out after 10s. stderr:\n${stderr || "(empty)"}`,
            ),
          );
        }
      }, 10_000);
      // Best-effort clear-timer on resolve; harmless if already fired.
      const original = pending.get(id);
      if (original) {
        pending.set(id, {
          resolve: (r) => {
            clearTimeout(timer);
            original.resolve(r);
          },
          reject: (e) => {
            clearTimeout(timer);
            original.reject(e);
          },
        });
      }
    });
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return promise;
  }

  function sendNotification(method: string, params?: Record<string, unknown>): void {
    if (exited) return;
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  return {
    get stderr() {
      return stderr;
    },
    async initialize() {
      const res = await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "lebop-integration-test", version: "0.0.1" },
      });
      if (res.error) {
        throw new Error(`MCP initialize failed: ${res.error.message}`);
      }
      return res.result as McpInitializeResult;
    },
    async notifyInitialized() {
      sendNotification("notifications/initialized");
      // The SDK reads it asynchronously; a tiny tick keeps tests deterministic
      // without introducing a real sleep.
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    async listTools() {
      const res = await send("tools/list", {});
      if (res.error) {
        throw new Error(`MCP tools/list failed: ${res.error.message}`);
      }
      return res.result as { tools: McpToolDescriptor[] };
    },
    async callTool(name, args) {
      const res = await send("tools/call", { name, arguments: args });
      if (res.error) {
        // Protocol-level error (e.g. unknown tool). Surface as thrown Error
        // so tests can distinguish from tool-level `isError: true`.
        throw new Error(`MCP tools/call protocol error: ${res.error.message}`);
      }
      const raw = res.result as { content: McpToolContent[]; isError?: boolean };
      let parsed: unknown = null;
      const first = raw.content?.[0];
      if (first?.type === "text") {
        try {
          parsed = JSON.parse(first.text);
        } catch {
          parsed = null;
        }
      }
      return { ...raw, parsed };
    },
    async close() {
      if (exited) return;
      // Closing stdin signals EOF; the server's stdio transport resolves and
      // the process exits cleanly. Fall back to a kill if it doesn't.
      child.stdin.end();
      await new Promise<void>((resolve) => {
        const killer = setTimeout(() => {
          child.kill("SIGTERM");
          resolve();
        }, 2_000);
        child.once("exit", () => {
          clearTimeout(killer);
          resolve();
        });
      });
    },
  };
}
