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

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    };

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
