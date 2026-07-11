import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// These shell out to install.sh + fake bins; 5s default is flaky under load.
describe("scripts/install.sh", { timeout: 20_000 }, () => {
  let root: string;
  let home: string;
  let fakeBin: string;
  let logFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lebop-install-script-"));
    home = join(root, "home");
    fakeBin = join(root, "bin");
    logFile = join(root, "install.log");
    mkdirSync(home, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    installFakes(fakeBin);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("uses a creatable writable home bin by default", () => {
    runInstaller();

    expect(readFileSync(logFile, "utf8")).toContain(join(home, ".local", "bin", "lebop"));
  });

  it("falls back to the system dir when an existing home bin is not writable", () => {
    const localBin = join(home, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    chmodSync(localBin, 0o500);

    runInstaller();

    const log = readFileSync(logFile, "utf8");
    expect(log).toContain("/usr/local/bin/lebop");
    expect(log).not.toContain(join(home, ".local", "bin", "lebop"));
  });

  it("sudo-creates the fallback system dir before copying into it", () => {
    writeExecutable(
      fakeBin,
      "mkdir",
      `#!/usr/bin/env bash
target="\${@: -1}"
case "$target" in
  "$HOME/.local/bin") exit 1 ;;
  "/usr/local/bin") printf 'mkdir %s\\n' "$*" >> "$LEBOP_INSTALL_TEST_LOG"; exit 1 ;;
esac
/bin/mkdir "$@"
`,
    );

    runInstaller();

    const log = readFileSync(logFile, "utf8");
    expect(log).toContain("sudo -n mkdir -p /usr/local/bin");
    expect(log).toContain("install -m 0755");
    expect(log.indexOf("sudo -n mkdir -p /usr/local/bin")).toBeLessThan(
      log.indexOf("install -m 0755"),
    );
  });

  it("fails clearly when latest release lookup does not resolve a tag", () => {
    const result = runInstallerFailure(
      { LEBOP_INSTALL_TEST_LATEST_URL: "https://github.com/N0xMare/lebop/releases/latest" },
      { version: null },
    );

    expect(result.stderr).toContain("could not resolve latest release tag");
  });

  it("fails clearly when SHA256SUMS omits the selected asset", () => {
    const result = runInstallerFailure({
      LEBOP_INSTALL_TEST_SHA_ENTRY: "deadbeef  lebop-linux-arm64",
    });

    expect(result.stderr).toContain("no SHA256 entry for lebop-linux-x64 in SHA256SUMS");
  });

  it("fails clearly when SHA256 verification command fails", () => {
    const result = runInstallerFailure({ LEBOP_INSTALL_TEST_SHA256_FAIL: "1" });

    expect(result.stderr).toContain("sha256sum failed while verifying lebop-linux-x64");
  });

  it("refuses to install on SHA256 mismatch", () => {
    const result = runInstallerFailure({ LEBOP_INSTALL_TEST_ACTUAL_SHA: "badc0de" });

    expect(result.stderr).toContain("SHA256 mismatch for lebop-linux-x64");
  });

  function runInstaller(
    envOverrides: Record<string, string> = {},
    opts: { version?: string | null } = {},
  ): void {
    execFileSync("bash", [join(process.cwd(), "scripts", "install.sh")], {
      env: installerEnv(envOverrides, opts),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function runInstallerFailure(
    envOverrides: Record<string, string> = {},
    opts: { version?: string | null } = {},
  ): { stdout: string; stderr: string } {
    try {
      runInstaller(envOverrides, opts);
    } catch (err) {
      const failed = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
      if (typeof failed.status === "number") {
        return {
          stdout: failed.stdout?.toString() ?? "",
          stderr: failed.stderr?.toString() ?? "",
        };
      }
      throw err;
    }
    throw new Error("expected installer to fail");
  }

  function installerEnv(
    envOverrides: Record<string, string>,
    opts: { version?: string | null },
  ): NodeJS.ProcessEnv {
    const next: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      LEBOP_INSTALL_TEST_LOG: logFile,
      ...envOverrides,
    };
    if (opts.version !== null) {
      next.LEBOP_VERSION = opts.version ?? "v0.0.3";
    }
    return next;
  }
});

function installFakes(fakeBin: string): void {
  writeExecutable(
    fakeBin,
    "uname",
    `#!/usr/bin/env bash
case "$1" in
  -s) printf 'Linux\\n' ;;
  -m) printf 'x86_64\\n' ;;
  *) printf 'Linux\\n' ;;
esac
`,
  );
  writeExecutable(
    fakeBin,
    "curl",
    `#!/usr/bin/env bash
out=''
url=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then
    shift
    out="$1"
  elif [[ "$1" == https://* ]]; then
    url="$1"
  fi
  shift || true
done
if [[ "$url" == */releases/latest ]]; then
  if [ "\${LEBOP_INSTALL_TEST_CURL_LATEST_FAIL:-}" = "1" ]; then
    exit 22
  fi
  printf '%s' "\${LEBOP_INSTALL_TEST_LATEST_URL:-https://github.com/N0xMare/lebop/releases/tag/v0.0.3}"
  exit 0
fi
case "$out" in
  *SHA256SUMS) printf '%s\\n' "\${LEBOP_INSTALL_TEST_SHA_ENTRY:-deadbeef  lebop-linux-x64}" > "$out" ;;
  *) printf 'fake binary\\n' > "$out" ;;
esac
`,
  );
  writeExecutable(
    fakeBin,
    "sha256sum",
    `#!/usr/bin/env bash
if [ "\${LEBOP_INSTALL_TEST_SHA256_FAIL:-}" = "1" ]; then
  exit 2
fi
printf '%s  %s\\n' "\${LEBOP_INSTALL_TEST_ACTUAL_SHA:-deadbeef}" "$1"
`,
  );
  writeExecutable(
    fakeBin,
    "install",
    `#!/usr/bin/env bash
printf 'install %s\\n' "$*" >> "$LEBOP_INSTALL_TEST_LOG"
`,
  );
  writeExecutable(
    fakeBin,
    "sudo",
    `#!/usr/bin/env bash
printf 'sudo %s\\n' "$*" >> "$LEBOP_INSTALL_TEST_LOG"
`,
  );
}

function writeExecutable(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content, { mode: 0o755 });
}
