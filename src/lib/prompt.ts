/**
 * Hidden-input TTY prompt for `lebop auth login`. **TTY-only — do not import
 * from the MCP server or any non-CLI code path.** Falls back to reading from
 * stdin (for piped input like `echo $TOKEN | lebop auth login`).
 */
export async function promptHidden(message: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const data = await Bun.stdin.text();
    return data.trim();
  }

  process.stdout.write(message);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    let cleanedUp = false;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.removeListener("SIGINT", onSignal);
    };

    // In raw mode, the kernel does not translate Ctrl+C into SIGINT — the
    // 0x03 byte is delivered to the data stream and handled below. But if
    // a SIGINT comes from elsewhere (another process via `kill -INT`, IDE
    // stop button, etc.), restore cooked mode before the default handler
    // exits the process; otherwise the user's terminal stays in raw mode.
    const onSignal = () => {
      cleanup();
      reject(new Error("aborted by SIGINT"));
    };
    process.once("SIGINT", onSignal);

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(buffer);
          return;
        }
        if (ch === "") {
          cleanup();
          reject(new Error("aborted"));
          return;
        }
        if (ch === "" || ch === "\b") {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += ch;
      }
    };

    process.stdin.on("data", onData);
  });
}
