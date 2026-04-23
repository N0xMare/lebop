import { homedir } from "node:os";
import { join } from "node:path";

export const LEEBOP_HOME = join(homedir(), ".leebop");
export const AUTH_FILE = join(LEEBOP_HOME, "auth.json");
export const CONFIG_FILE = join(LEEBOP_HOME, "config.yaml");
export const CACHE_ROOT = join(LEEBOP_HOME, "cache");
