/**
 * Self-update helpers for GitHub Releases binaries.
 *
 * Mirrors scripts/install.sh: resolve tag → download asset + SHA256SUMS →
 * verify → atomic install to the install target.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { LEBOP_VERSION } from "./version.ts";

export const DEFAULT_LEBOP_REPO = "N0xMare/lebop";

export type UpdatePlatform = {
  os: "darwin" | "linux";
  arch: "x64" | "arm64";
  asset: string;
};

export type UpdateCheckResult = {
  /** Version at the install target (preferred) or running package. */
  current_version: string;
  /** Version of the currently executing lebop process (package.json / compiled). */
  running_version: string;
  latest_version: string;
  latest_tag: string;
  update_available: boolean;
  repo: string;
  platform: UpdatePlatform;
  install_target: string;
  current_binary: string | null;
  notes: string[];
};

export type UpdatePerformResult = UpdateCheckResult & {
  action: "updated" | "already_latest" | "forced";
  previous_version: string;
  installed_path: string;
};

function normalizeTag(tag: string): string {
  const t = tag.trim();
  if (!t) throw new Error("empty version tag");
  return t.startsWith("v") ? t : `v${t}`;
}

/** Strip leading v for semver-ish compare of x.y.z tags. */
export function versionFromTag(tag: string): string {
  const t = normalizeTag(tag);
  return t.startsWith("v") ? t.slice(1) : t;
}

/**
 * Compare dotted numeric versions (e.g. 0.0.3 vs 0.0.5).
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a
    .replace(/^v/, "")
    .split(".")
    .map((p) => Number.parseInt(p, 10) || 0);
  const pb = b
    .replace(/^v/, "")
    .split(".")
    .map((p) => Number.parseInt(p, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

export function detectPlatform(
  unameS: string = process.platform,
  unameM: string = process.arch,
): UpdatePlatform {
  let os: UpdatePlatform["os"];
  if (unameS === "darwin") os = "darwin";
  else if (unameS === "linux") os = "linux";
  else throw new Error(`unsupported OS for binary update: ${unameS} (need darwin or linux)`);

  let arch: UpdatePlatform["arch"];
  if (unameM === "x64" || unameM === "x86_64" || unameM === "amd64") arch = "x64";
  else if (unameM === "arm64" || unameM === "aarch64") arch = "arm64";
  else throw new Error(`unsupported architecture for binary update: ${unameM} (need x64 or arm64)`);

  return { os, arch, asset: `lebop-${os}-${arch}` };
}

/** True when path looks like a self-contained release binary (not a #! script). */
export function isReleaseBinary(path: string): boolean {
  try {
    const head = readFileSync(path).subarray(0, 2);
    // Scripts start with #!; Mach-O / ELF binaries do not.
    if (head[0] === 0x23 && head[1] === 0x21) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve where `lebop update` should install the binary.
 * Prefer replacing the running release binary; otherwise install-dir defaults.
 */
export function resolveInstallTarget(opts?: {
  installDir?: string;
  /** Override for tests. Defaults to process.execPath. */
  execPath?: string;
  /** Override for tests. Defaults to process.argv[1]. */
  argv1?: string;
  home?: string;
}): { install_target: string; current_binary: string | null; notes: string[] } {
  const notes: string[] = [];
  const home = opts?.home ?? homedir();
  const execPath = opts?.execPath ?? process.execPath;
  const argv1 = opts?.argv1 ?? process.argv[1];

  // Compiled release: process.execPath is the lebop binary.
  if (basename(execPath).startsWith("lebop") && existsSync(execPath) && isReleaseBinary(execPath)) {
    return { install_target: execPath, current_binary: execPath, notes };
  }

  // Source / bun link: argv1 may be a #! wrapper — update the install-dir binary instead.
  if (argv1 && existsSync(argv1) && !isReleaseBinary(argv1)) {
    notes.push(
      `running from source wrapper (${argv1}); will update the release install target, not this wrapper`,
    );
  }

  if (opts?.installDir || process.env.LEBOP_INSTALL_DIR) {
    const dir = opts?.installDir ?? process.env.LEBOP_INSTALL_DIR!;
    return {
      install_target: join(dir, "lebop"),
      current_binary: existsSync(join(dir, "lebop")) ? join(dir, "lebop") : null,
      notes,
    };
  }

  const localBin = join(home, ".local", "bin", "lebop");
  if (existsSync(localBin)) {
    return { install_target: localBin, current_binary: localBin, notes };
  }

  // Default writable user path (same as install.sh preference).
  notes.push("no existing install found at ~/.local/bin/lebop; will install there");
  return {
    install_target: localBin,
    current_binary: null,
    notes,
  };
}

async function githubRedirectLatestTag(repo: string): Promise<string> {
  const res = await fetch(`https://github.com/${repo}/releases/latest`, {
    method: "HEAD",
    redirect: "manual",
  });
  const loc = res.headers.get("location") ?? res.headers.get("Location") ?? "";
  // Follow one hop if needed (some environments return 302).
  if (res.status >= 300 && res.status < 400 && loc) {
    const tag = loc.replace(/\/$/, "").split("/").pop() ?? "";
    if (/^v\d/.test(tag)) return tag;
  }
  // Fallback: GET releases/latest JSON via API (no auth for public repos).
  const api = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `lebop/${LEBOP_VERSION}`,
    },
  });
  if (!api.ok) {
    throw new Error(
      `could not resolve latest release for ${repo} (HTTP ${api.status}). Is the repo public and tagged?`,
    );
  }
  const body = (await api.json()) as { tag_name?: string };
  if (!body.tag_name || !/^v\d/.test(body.tag_name)) {
    throw new Error(`could not parse latest release tag from GitHub API for ${repo}`);
  }
  return body.tag_name;
}

export async function resolveReleaseTag(
  version: string | undefined,
  repo = DEFAULT_LEBOP_REPO,
): Promise<string> {
  if (!version || version === "latest") {
    return githubRedirectLatestTag(repo);
  }
  return normalizeTag(version);
}

/** Probe `path --version` for a semver string (release binary or wrapper). */
export function readBinaryVersion(path: string | null | undefined): string | null {
  if (!path || !existsSync(path)) return null;
  try {
    const r = spawnSync(path, ["--version"], {
      encoding: "utf8",
      timeout: 8_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const m = text.match(/(\d+\.\d+\.\d+)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function checkForUpdate(opts?: {
  version?: string;
  repo?: string;
  installDir?: string;
  /** Override installed version (tests). */
  currentVersion?: string;
  runningVersion?: string;
}): Promise<UpdateCheckResult> {
  const repo = opts?.repo ?? process.env.LEBOP_REPO ?? DEFAULT_LEBOP_REPO;
  const platform = detectPlatform();
  const target = resolveInstallTarget({ installDir: opts?.installDir });
  const latestTag = await resolveReleaseTag(opts?.version, repo);
  const latestVersion = versionFromTag(latestTag);
  const runningVersion = opts?.runningVersion ?? LEBOP_VERSION;
  const installedVersion =
    opts?.currentVersion ??
    readBinaryVersion(target.current_binary) ??
    readBinaryVersion(target.install_target) ??
    runningVersion;
  const notes = [...target.notes];
  if (installedVersion !== runningVersion && target.current_binary && !opts?.currentVersion) {
    notes.push(
      `install target reports ${installedVersion}; this process is ${runningVersion} (source/wrapper may differ)`,
    );
  }
  const updateAvailable = compareVersions(installedVersion, latestVersion) < 0;

  return {
    current_version: installedVersion,
    running_version: runningVersion,
    latest_version: latestVersion,
    latest_tag: latestTag,
    update_available: updateAvailable,
    repo,
    platform,
    install_target: target.install_target,
    current_binary: target.current_binary,
    notes,
  };
}

async function downloadBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { "User-Agent": `lebop/${LEBOP_VERSION}` },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`download failed (${res.status}): ${url}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseSha256Sums(text: string, asset: string): string {
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([a-fA-F0-9]{64})\s+(\S+)$/);
    if (m?.[1] && m[2] === asset) return m[1].toLowerCase();
  }
  throw new Error(`no SHA256 entry for ${asset} in SHA256SUMS`);
}

/**
 * Download, verify, and install a release binary to install_target.
 */
export async function performUpdate(opts?: {
  version?: string;
  repo?: string;
  installDir?: string;
  force?: boolean;
  currentVersion?: string;
  /** Inject for tests. */
  download?: (url: string) => Promise<Uint8Array>;
  writeBinary?: (target: string, bytes: Uint8Array) => void;
}): Promise<UpdatePerformResult> {
  const check = await checkForUpdate({
    version: opts?.version,
    repo: opts?.repo,
    installDir: opts?.installDir,
    currentVersion: opts?.currentVersion,
  });

  if (!check.update_available && !opts?.force) {
    return {
      ...check,
      action: "already_latest",
      previous_version: check.current_version,
      installed_path: check.install_target,
    };
  }

  const base = `https://github.com/${check.repo}/releases/download/${check.latest_tag}`;
  const binaryUrl = `${base}/${check.platform.asset}`;
  const sumsUrl = `${base}/SHA256SUMS`;
  const download = opts?.download ?? downloadBytes;

  const [binary, sumsText] = await Promise.all([
    download(binaryUrl),
    download(sumsUrl).then((b) => new TextDecoder().decode(b)),
  ]);

  const expected = parseSha256Sums(sumsText, check.platform.asset);
  const actual = sha256Hex(binary);
  if (expected !== actual) {
    throw new Error(
      `SHA256 mismatch for ${check.platform.asset} (expected ${expected}, got ${actual}) — refusing to install`,
    );
  }

  const write =
    opts?.writeBinary ??
    ((target: string, bytes: Uint8Array) => {
      const dir = dirname(target);
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.lebop-update-${process.pid}-${Date.now()}.tmp`);
      // Write temp in same directory for atomic rename.
      writeFileSync(tmp, bytes);
      chmodSync(tmp, 0o755);
      try {
        renameSync(tmp, target);
      } catch {
        // Cross-device fallback: copy + unlink.
        copyFileSync(tmp, target);
        chmodSync(target, 0o755);
        try {
          unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
    });

  write(check.install_target, binary);

  return {
    ...check,
    action: opts?.force && !check.update_available ? "forced" : "updated",
    previous_version: check.current_version,
    installed_path: check.install_target,
    update_available: false,
  };
}
