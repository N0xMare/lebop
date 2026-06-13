/**
 * Config-file mutations. `loadUserConfig` is read-only by design; this file
 * owns the narrow write paths we want to expose (currently only setting
 * `workspace_team_defaults[slug] = teamKey`).
 *
 * Writes go through `writeAtomic` to avoid corrupting the YAML file under
 * concurrent edits. Mode is preserved (0o600 on first create) so the file
 * never leaks readable to the world even if it picked up stray bits during
 * a shell redirect.
 *
 * **Comment preservation**: reads pass through `yaml`'s `parseDocument` (not
 * the plain `parse`), mutate the resulting Document via `setIn`, and write
 * back with `doc.toString()` — preserving user-authored comments and key
 * order. The lebop docs and spec §15.2 advertise this property; spec
 * compliance + ergonomics for users who hand-edit configs.
 */

import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Document, parseDocument } from "yaml";
import { writeAtomic } from "./cache.ts";
import { ValidationError } from "./errors.ts";
import { CONFIG_FILE, LEBOP_HOME } from "./paths.ts";
import { ensureLebopHomeForWrite } from "./stateSafety.ts";

const CONFIG_WRITE_LOCK_TIMEOUT_MS = 30_000;
const CONFIG_WRITE_LOCK_POLL_MS = 25;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withConfigWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockDir = join(LEBOP_HOME, ".config.yaml.lebop-write.lock");
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST") throw err;
      if (Date.now() - started > CONFIG_WRITE_LOCK_TIMEOUT_MS) {
        throw new ValidationError(
          "~/.lebop/config.yaml is locked by another writer",
          "wait for the other lebop process to finish, or remove the stale config lock after verifying no process is writing the config",
        );
      }
      await sleep(CONFIG_WRITE_LOCK_POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/**
 * Set `workspace_team_defaults[workspaceSlug] = teamKey` in
 * `~/.lebop/config.yaml`, creating the file (and parent dir) if absent.
 * Preserves every other key in the config AND user-authored comments.
 *
 * Idempotent at the value level — re-applying the same (slug, key) is a
 * no-op write. We still rewrite the file so the timestamp moves; agents
 * watching for config changes pick up the touch.
 */
export async function setWorkspaceDefaultTeam(
  workspaceSlug: string,
  teamKey: string,
): Promise<void> {
  // Ensure ~/.lebop/ exists with mode 0700 (matches auth.ts).
  ensureLebopHomeForWrite();
  if (!existsSync(LEBOP_HOME)) {
    mkdirSync(LEBOP_HOME, { recursive: true, mode: 0o700 });
  }
  chmodSync(LEBOP_HOME, 0o700);
  const dir = dirname(CONFIG_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  await withConfigWriteLock(async () => {
    // Read the existing file as a Document so comments + key order survive
    // the round-trip. If the file is absent we synthesize an empty Document;
    // `setIn` auto-builds the missing map structure.
    let doc: Document;
    if (existsSync(CONFIG_FILE)) {
      const raw = await Bun.file(CONFIG_FILE).text();
      doc = parseDocument(raw);
      // parseDocument doesn't throw on malformed YAML — it collects parse errors
      // on `doc.errors`. doc.toString() WOULD throw `Document with errors cannot
      // be stringified` later, with no actionable context. Surface it now as a
      // structured ValidationError with a hint pointing at the file.
      if (doc.errors.length > 0) {
        const firstErr = doc.errors[0];
        throw new ValidationError(
          `~/.lebop/config.yaml has invalid YAML: ${firstErr?.message ?? "parse failed"}`,
          "fix the YAML by hand (the file is human-readable) or rm ~/.lebop/config.yaml to start fresh",
        );
      }
    } else {
      doc = new Document({});
    }
    doc.setIn(["workspace_team_defaults", workspaceSlug], teamKey);

    await writeAtomic(CONFIG_FILE, doc.toString());
    // 0600 — config carries no secrets today but might in future (e.g.
    // additional per-workspace tokens). Defense in depth.
    try {
      chmodSync(CONFIG_FILE, 0o600);
    } catch {
      // chmod can fail on exotic filesystems (e.g. Windows mounts under WSL).
      // The atomic write already landed; just skip the perms tighten.
    }
  });
}
