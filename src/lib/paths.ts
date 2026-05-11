import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Root for lebop's runtime state. Default is `~/.lebop/`. Override with the
 * `LEBOP_HOME` environment variable — useful for integration tests, sandbox
 * runs, and per-context credential isolation.
 */
export const LEBOP_HOME = process.env.LEBOP_HOME ?? join(homedir(), ".lebop");
export const AUTH_FILE = join(LEBOP_HOME, "auth.json");
export const CONFIG_FILE = join(LEBOP_HOME, "config.yaml");
export const CACHE_ROOT = join(LEBOP_HOME, "cache");
