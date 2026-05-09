import type { LinearClient } from "@linear/sdk";
import chalk from "chalk";
import { linearClientFromToken, loadAuth } from "./auth.ts";

let _client: LinearClient | undefined;

export async function linear(): Promise<LinearClient> {
  if (_client) return _client;
  const auth = await loadAuth();
  if (!auth) {
    process.stderr.write(
      `${chalk.red("no Linear credentials found.")} run ${chalk.cyan("lebop auth login")} first.\n`,
    );
    process.exit(1);
  }
  _client = linearClientFromToken(auth.token);
  return _client;
}
