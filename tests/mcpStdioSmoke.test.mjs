import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMcpSmoke } from "../scripts/mcp-stdio-smoke.mjs";

const runner = fileURLToPath(new URL("../scripts/mcp-stdio-smoke.mjs", import.meta.url));
const requests = [
  { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
  { method: "notifications/initialized" },
  { id: 2, method: "tools/list" },
  ...[3, 4, 5].map((id) => ({ id, method: "tools/call", params: { name: `tool-${id}` } })),
].map((request) => ({ jsonrpc: "2.0", ...request }));
const input = `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`;

// Like the MCP server, this fake exits on EOF, abandoning any asynchronous tool work.
// Timers simulate delayed replies, never synchronization in the client under test.
const fakeServer = `
import { createInterface } from "node:readline";
const mode = process.argv[1];
const send = (id, result) => process.stdout.write(JSON.stringify({
  jsonrpc: "2.0", id,
  ...(mode === "rpc-" + id ? { error: { code: -32603, message: "fake RPC error" } } : { result }),
}) + "\\n");
process.stdout.write(JSON.stringify({
  jsonrpc: "2.0", method: "test/pid", params: { pid: process.pid },
}) + "\\n");
if (mode === "missing" || mode === "stubborn") process.on("SIGTERM", () => {});
process.stdin.on("end", () => {
  if (mode === "stubborn") { setInterval(() => {}, 1000); return; }
  process.exit(mode === "nonzero" ? 7 : 0);
});
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === 1) send(1, { protocolVersion: "2024-11-05" });
  if (request.id === 2) send(2, { tools: [] });
  if (request.id !== 5) return;
  if (mode === "early-exit") { process.exit(0); return; }
  if (mode === "missing") return;
  if (mode === "malformed") { process.stdout.write("debug log\\n"); return; }
  if (mode === "non-rpc") { process.stdout.write('{"log":true}\\n'); return; }
  if (mode === "partial") { process.stdout.end('{"jsonrpc":'); process.exit(0); return; }
  setTimeout(() => {
    send(5, { isError: mode === "tool-error", content: [{ type: "text", text: "{}" }] });
    send(4, { content: [{ type: "text", text: "{}" }] });
    // Exercise out-of-order IDs, fragmented lines, and a split UTF-8 character.
    const final = Buffer.from(JSON.stringify({
      jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "café" }] },
    }) + "\\n");
    const split = final.indexOf(Buffer.from("é")) + 1;
    process.stdout.write(final.subarray(0, split));
    setImmediate(() => process.stdout.write(final.subarray(split)));
  }, 60);
});
`;

function fakeArgs(mode) {
  return ["--input-type=module", "-e", fakeServer, "--", mode];
}

function messages(stdout) {
  return stdout
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function responseIds(stdout) {
  return messages(stdout)
    .filter((message) => message.id !== undefined)
    .map(({ id }) => id);
}

function runFake(mode, overrides = {}) {
  let stdout = "";
  const done = runMcpSmoke({
    command: process.execPath,
    args: fakeArgs(mode),
    requests,
    timeoutMs: 1_500,
    shutdownGraceMs: 100,
    onStdout: (chunk) => {
      stdout += chunk;
    },
    ...overrides,
  });
  return { done, stdout: () => stdout };
}

describe("canary MCP stdio lifecycle", () => {
  it("reproduces the finite-pipe failure: clean exit loses all delayed tool replies", () => {
    const result = spawnSync(process.execPath, fakeArgs("delayed"), {
      input,
      encoding: "utf8",
      timeout: 4_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(responseIds(result.stdout)).toEqual([1, 2]);
  });

  it("keeps stdin open for delayed, out-of-order replies and drains split UTF-8 stdout", async () => {
    const result = runFake("delayed");
    await result.done;
    expect(responseIds(result.stdout())).toEqual([1, 2, 5, 4, 3]);
    expect(messages(result.stdout()).at(-1).result.content[0].text).toBe("café");
  });

  it.each([
    ["rpc-1", /id=1 returned a JSON-RPC error/],
    ["rpc-2", /id=2 returned a JSON-RPC error/],
    ["rpc-5", /id=5 returned a JSON-RPC error/],
    ["tool-error", /id=5 returned tool isError=true/],
    ["early-exit", /exited before replying; missing IDs: 3,4,5/],
    ["malformed", /non-JSON stdout/],
    ["non-rpc", /non-JSON-RPC stdout/],
    ["partial", /unterminated stdout/],
    ["nonzero", /exited with status 7/],
  ])("rejects %s rather than mistaking process exit for success", async (mode, expected) => {
    await expect(runFake(mode).done).rejects.toThrow(expected);
  });

  it.each([
    ["missing", /replies timed out.*missing IDs: 3,4,5/],
    ["stubborn", /did not exit after all replies/],
  ])("bounds cleanup and kills a SIGTERM-resistant %s server", async (mode, expected) => {
    const result = runFake(mode);
    await expect(result.done).rejects.toThrow(expected);
    const pid = messages(result.stdout()).find((message) => message.method === "test/pid").params
      .pid;
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  it("rejects spawn failures", async () => {
    await expect(
      runFake("delayed", { command: "/nonexistent-lebop-mcp-smoke" }).done,
    ).rejects.toThrow(/MCP (process|stdin) error/);
  });

  it.each([
    ["delayed", 0],
    ["tool-error", 1],
    ["rpc-5", 1],
    ["early-exit", 1],
  ])("the workflow's CLI interface reports %s with exit status %i", (mode, status) => {
    const result = spawnSync(process.execPath, [runner, process.execPath, ...fakeArgs(mode)], {
      input,
      encoding: "utf8",
      timeout: 4_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
    if (status === 0) expect(responseIds(result.stdout)).toEqual([1, 2, 5, 4, 3]);
    else expect(result.stderr).toMatch(/MCP (response|process)/);
  });
});
