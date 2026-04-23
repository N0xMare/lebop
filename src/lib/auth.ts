import { execSync } from "node:child_process";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { LinearClient } from "@linear/sdk";
import { AUTH_FILE, LEEBOP_HOME } from "./paths.ts";
import type { AuthFile, Viewer } from "./types.ts";

const AUTH_SCHEMA_VERSION = 1 as const;

export async function loadAuth(): Promise<AuthFile | null> {
  const file = Bun.file(AUTH_FILE);
  if (!(await file.exists())) return null;
  try {
    const data = (await file.json()) as unknown;
    if (!isAuthFile(data)) {
      throw new Error(
        `auth file at ${AUTH_FILE} has unexpected shape — run \`leebop auth login\` to recreate`,
      );
    }
    return data;
  } catch (err) {
    if (err instanceof Error && err.message.includes("leebop auth login")) throw err;
    throw new Error(`failed to read ${AUTH_FILE}: ${(err as Error).message}`);
  }
}

export async function saveAuth(token: string, viewer: Viewer): Promise<AuthFile> {
  await mkdir(dirname(AUTH_FILE), { recursive: true, mode: 0o700 });
  const auth: AuthFile = {
    schema_version: AUTH_SCHEMA_VERSION,
    token,
    viewer,
    created_at: new Date().toISOString(),
  };
  await Bun.write(AUTH_FILE, `${JSON.stringify(auth, null, 2)}\n`);
  chmodSync(AUTH_FILE, 0o600);
  chmodSync(LEEBOP_HOME, 0o700);
  return auth;
}

export function deleteAuth(): boolean {
  if (!existsSync(AUTH_FILE)) return false;
  unlinkSync(AUTH_FILE);
  return true;
}

export function linearClientFromToken(token: string): LinearClient {
  // PAKs start with `lin_api_` and go in Authorization header as-is.
  // OAuth bearer tokens need the `Bearer ` prefix, which @linear/sdk adds for `accessToken`.
  return token.startsWith("lin_api_")
    ? new LinearClient({ apiKey: token })
    : new LinearClient({ accessToken: token });
}

export async function validateToken(token: string): Promise<Viewer> {
  const client = linearClientFromToken(token);
  try {
    const viewer = await client.viewer;
    return {
      id: viewer.id,
      email: viewer.email,
      name: viewer.name,
    };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (
      msg.toLowerCase().includes("authentication") ||
      msg.toLowerCase().includes("unauthorized")
    ) {
      throw new Error(
        "token rejected by Linear — paste the full `lin_api_...` value from Settings → API",
      );
    }
    throw new Error(`failed to validate token: ${msg}`);
  }
}

export function importFromSchpet(): string {
  try {
    const token = execSync("linear auth token", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!token) {
      throw new Error("`linear auth token` returned empty — run `linear auth login` first");
    }
    return token;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    throw new Error(
      `could not import from @schpet/linear-cli: ${msg}. Install it (https://github.com/schpet/linear-cli) and run \`linear auth login\`, or use \`leebop auth login\` with a Linear personal API key.`,
    );
  }
}

function isAuthFile(value: unknown): value is AuthFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.schema_version !== AUTH_SCHEMA_VERSION) return false;
  if (typeof v.token !== "string" || v.token.length === 0) return false;
  if (typeof v.created_at !== "string") return false;
  const viewer = v.viewer as Record<string, unknown> | undefined;
  if (!viewer) return false;
  if (typeof viewer.id !== "string") return false;
  if (typeof viewer.email !== "string") return false;
  if (typeof viewer.name !== "string") return false;
  return true;
}
