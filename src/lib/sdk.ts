import type { LinearClient } from "@linear/sdk";
import { linearClientFromToken, loadAuth } from "./auth.ts";
import { AuthError } from "./errors.ts";

let _client: LinearClient | undefined;

export async function linear(): Promise<LinearClient> {
  if (_client) return _client;
  const auth = await loadAuth();
  if (!auth) {
    throw new AuthError("no Linear credentials found", "run `lebop auth login` first");
  }
  _client = linearClientFromToken(auth.token);
  return _client;
}
