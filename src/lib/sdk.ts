import type { LinearClient } from "@linear/sdk";
import chalk from "chalk";
import { linearClientFromToken, loadAuth } from "./auth.ts";

let _client: LinearClient | undefined;

export async function linear(): Promise<LinearClient> {
  if (_client) return _client;
  const auth = await loadAuth();
  if (!auth) {
    process.stderr.write(
      `${chalk.red("no Linear credentials found.")} run ${chalk.cyan("leebop auth login")} first.\n`,
    );
    process.exit(1);
  }
  _client = linearClientFromToken(auth.token);
  return _client;
}

export function isAuthError(err: unknown): boolean {
  const msg = (err as Error | undefined)?.message?.toLowerCase() ?? "";
  return (
    msg.includes("authentication") || msg.includes("unauthorized") || msg.includes("invalid bearer")
  );
}

export function handleAuthError(): never {
  process.stderr.write(
    `${chalk.red("Linear rejected the stored token.")} it may have been revoked. run ${chalk.cyan("leebop auth login")} again.\n`,
  );
  process.exit(1);
}
