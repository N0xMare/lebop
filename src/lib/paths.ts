import { homedir } from "node:os";
import { join } from "node:path";

export const LEBOP_HOME = join(homedir(), ".lebop");
export const AUTH_FILE = join(LEBOP_HOME, "auth.json");
export const CONFIG_FILE = join(LEBOP_HOME, "config.yaml");
export const CACHE_ROOT = join(LEBOP_HOME, "cache");
