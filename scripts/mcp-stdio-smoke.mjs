#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Replay a finite JSON-RPC batch, but keep the server's stdin open until every reply arrives. */
export async function runMcpSmoke({
  command,
  args = [],
  requests,
  timeoutMs = 12_000,
  shutdownGraceMs = 1_000,
  onStdout = (chunk) => process.stdout.write(chunk),
}) {
  const pending = new Set(
    requests.filter((request) => request.id !== undefined).map(({ id }) => id),
  );
  if (pending.size === 0) throw new Error("MCP smoke batch has no request IDs");

  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
    let buffer = "";
    let failure;
    let shutdownTimer;
    let killTimer;
    const responseTimer = setTimeout(() => {
      fail(`MCP replies timed out after ${timeoutMs}ms; missing IDs: ${[...pending].join(",")}`);
    }, timeoutMs);

    function fail(message) {
      if (failure) return;
      failure = new Error(message);
      clearTimeout(responseTimer);
      clearTimeout(shutdownTimer);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), shutdownGraceMs);
    }

    child.stdin.on("error", (error) => fail(`MCP stdin error: ${error.message}`));
    child.on("error", (error) => fail(`MCP process error: ${error.message}`));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      onStdout(chunk);
      buffer += chunk;
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line || failure) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          fail("MCP server wrote non-JSON stdout");
          continue;
        }
        if (message?.jsonrpc !== "2.0") {
          fail("MCP server wrote non-JSON-RPC stdout");
        } else if (Object.hasOwn(message, "error")) {
          fail(`MCP response id=${message.id ?? "?"} returned a JSON-RPC error`);
        } else if (message.result?.isError) {
          fail(`MCP response id=${message.id ?? "?"} returned tool isError=true`);
        } else if (pending.has(message.id)) {
          if (!Object.hasOwn(message, "result")) {
            fail(`MCP response id=${message.id} missing result`);
            continue;
          }
          pending.delete(message.id);
          if (pending.size === 0) {
            clearTimeout(responseTimer);
            // EOF is safe only now: the server may abandon asynchronous tools on stdin close.
            child.stdin.end();
            shutdownTimer = setTimeout(
              () => fail("MCP process did not exit after all replies"),
              shutdownGraceMs,
            );
          }
        }
      }
    });

    // 'close', unlike 'exit', fires after stdout is drained, including the final reply.
    child.on("close", (code, signal) => {
      clearTimeout(responseTimer);
      clearTimeout(shutdownTimer);
      clearTimeout(killTimer);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(new Error(`MCP process exited with ${signal ?? `status ${code}`}`));
      else if (buffer.trim()) reject(new Error("MCP server left unterminated stdout"));
      else if (pending.size) {
        reject(
          new Error(`MCP process exited before replying; missing IDs: ${[...pending].join(",")}`),
        );
      } else resolve();
    });

    child.stdin.write(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const requests = input
      .trim()
      .split(/\n+/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const [command, ...args] = process.argv.slice(2);
    if (!command) throw new Error("usage: mcp-stdio-smoke.mjs <command> [args...]");
    await runMcpSmoke({ command, args, requests });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
