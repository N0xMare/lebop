import chalk from "chalk";
import type { Command } from "commander";
import { wantsMachineOutput } from "../lib/encode.ts";
import { NetworkError, ValidationError } from "../lib/errors.ts";
import { writeMachineEnvelope } from "../lib/output.ts";
import {
  checkForUpdate,
  performUpdate,
  type UpdateCheckResult,
  type UpdatePerformResult,
} from "../lib/selfUpdate.ts";
/**
 * `lebop update` — self-update from GitHub Releases (same assets as install.sh).
 *
 * Updates the installed release binary (default ~/.local/bin/lebop or the
 * running compiled binary). Source checkouts keep their wrapper; the release
 * install path is updated so PATH picks up the new binary.
 */
export function registerUpdate(program: Command): void {
  program
    .command("update")
    .description("update the lebop binary from GitHub Releases (SHA256 verified)")
    .option("--check", "only report whether an update is available (no download)")
    .option(
      "--version <tag>",
      "install a specific release tag (e.g. v0.0.6 or 0.0.6); default: latest",
    )
    .option("--force", "reinstall even when already on the target version")
    .option(
      "--install-dir <dir>",
      "install directory (default: LEBOP_INSTALL_DIR or ~/.local/bin or running binary dir)",
    )
    .option("--yes", "skip confirmation when replacing an existing binary (non-interactive OK)")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(async (opts: UpdateOpts) => {
      try {
        if (opts.check) {
          const result = await checkForUpdate({
            version: opts.version,
            installDir: opts.installDir,
          });
          emitCheck(result, opts);
          if (result.update_available) process.exitCode = 0;
          return;
        }

        // Non-TTY install without --yes still proceeds (agent-friendly); --yes is
        // documented for scripts that want an explicit affirm.
        void opts.yes;

        const result = await performUpdate({
          version: opts.version,
          installDir: opts.installDir,
          force: opts.force,
        });
        emitPerform(result, opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/download|HTTP|network|fetch|resolve latest|ECONN|ENOTFOUND/i.test(message)) {
          throw new NetworkError(message, "check network access to github.com and try again");
        }
        throw new ValidationError(message, "see `lebop update --help`");
      }
    });
}

interface UpdateOpts {
  check?: boolean;
  version?: string;
  force?: boolean;
  installDir?: string;
  yes?: boolean;
  json?: boolean;
  format?: string;
  pretty?: boolean;
}

function emitCheck(result: UpdateCheckResult, opts: UpdateOpts): void {
  if (wantsMachineOutput(opts)) {
    writeMachineEnvelope(
      {
        ...result,
        next: result.update_available
          ? [`update → ${result.latest_tag}`]
          : ["up to date"],
      } as Record<string, unknown>,
      { json: true, format: opts.format, pretty: opts.pretty },
    );
    return;
  }

  process.stdout.write(`installed: ${chalk.bold(result.current_version)}\n`);
  if (result.running_version !== result.current_version) {
    process.stdout.write(`running:   ${result.running_version}\n`);
  }
  process.stdout.write(`latest:    ${chalk.bold(result.latest_tag)} (${result.latest_version})\n`);
  process.stdout.write(`target:    ${result.install_target}\n`);
  process.stdout.write(`platform:  ${result.platform.asset}\n`);
  if (result.update_available) {
    process.stdout.write(
      `${chalk.yellow("update available")} — run ${chalk.bold("lebop update")} to install ${result.latest_tag}\n`,
    );
  } else {
    process.stdout.write(`${chalk.green("up to date")}\n`);
  }
  for (const n of result.notes) {
    process.stdout.write(`${chalk.gray("note:")} ${n}\n`);
  }
}

function emitPerform(result: UpdatePerformResult, opts: UpdateOpts): void {
  if (wantsMachineOutput(opts)) {
    writeMachineEnvelope(
      {
        ...result,
        next:
          result.action === "already_latest"
            ? ["up to date"]
            : [`installed ${result.latest_tag}`, "rehash PATH / new shell"],
      } as Record<string, unknown>,
      { json: true, format: opts.format, pretty: opts.pretty },
    );
    return;
  }

  if (result.action === "already_latest") {
    process.stdout.write(
      `${chalk.green("✓")} already on ${chalk.bold(result.latest_tag)} (${result.installed_path})\n`,
    );
    return;
  }

  process.stdout.write(
    `${chalk.green("✓")} ${result.action === "forced" ? "reinstalled" : "updated"} ${chalk.gray(result.previous_version)} → ${chalk.bold(result.latest_tag)}\n`,
  );
  process.stdout.write(`  installed: ${result.installed_path}\n`);
  for (const n of result.notes) {
    process.stdout.write(`${chalk.gray("note:")} ${n}\n`);
  }
  if (result.previous_version !== result.latest_version) {
    process.stdout.write(
      `${chalk.gray("tip:")} run ${chalk.bold("lebop --version")} to confirm PATH resolves the new binary\n`,
    );
  }
}
