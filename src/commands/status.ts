import chalk from "chalk";
import type { Command } from "commander";
import { collectCacheStatus } from "../lib/cacheStatus.ts";
import { resolveConfig } from "../lib/config.ts";
import { envelope } from "../lib/envelope.ts";

/**
 * Inner action handler — exported so `lebop cache status` (in commands/cache.ts)
 * can re-register the exact same behavior as a subcommand alias without
 * duplicating the implementation.
 */
export async function statusAction(opts: {
  team?: string;
  json?: boolean;
  remote?: boolean;
}): Promise<void> {
  const config = await resolveConfig({ teamOverride: opts.team });
  const status = await collectCacheStatus({
    team: config.team,
    repoRoot: config.repoRoot,
    repoHash: config.repoHash,
    checkRemote: opts.remote !== false,
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(envelope({ ...status }), null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `on team: ${chalk.bold(config.team)}${config.repoRoot ? `  (repo: ${config.repoRoot})` : "  (no repo — global cache)"}\n\n`,
  );

  const totalModified = status.modified.issues.length + status.modified.projects.length;
  const totalStale = status.stale.length;
  const totalRemoteConflicts = status.remote_conflicts.length;
  const totalClean = status.clean.issues.length + status.clean.projects.length;
  const totalIntegrityProblems = status.integrity.problems.length;

  if (
    totalModified === 0 &&
    totalStale === 0 &&
    totalRemoteConflicts === 0 &&
    totalClean === 0 &&
    totalIntegrityProblems === 0
  ) {
    process.stdout.write("cache is empty. run `lebop pull` to materialize issues.\n");
    return;
  }

  if (totalModified > 0) {
    process.stdout.write(`${chalk.yellow("modified locally")} (${totalModified}):\n`);
    for (const r of status.modified.issues) {
      process.stdout.write(`  ${chalk.bold(r.identifier)}  ${chalk.gray(r.fields.join(", "))}\n`);
    }
    for (const r of status.modified.projects) {
      process.stdout.write(
        `  ${chalk.bold(`project/${r.name}`)}  ${chalk.gray(r.fields.join(", "))}\n`,
      );
    }
    process.stdout.write("\n");
  }

  if (totalStale > 0) {
    process.stdout.write(`${chalk.cyan("stale (remote newer — needs pull)")} (${totalStale}):\n`);
    const staleKinds = new Set<string>();
    for (const r of status.stale) {
      const label = r.kind === "issue" ? r.identifier : `project/${r.name}`;
      staleKinds.add(r.kind);
      process.stdout.write(`  ${chalk.bold(label)}\n`);
    }
    if (staleKinds.has("issue")) {
      process.stdout.write(
        `  ${chalk.gray("issue rows: run `lebop pull TEAM-123 --refresh --yes` after verifying local cache overwrite is intended")}\n`,
      );
    }
    if (staleKinds.has("project")) {
      process.stdout.write(
        `  ${chalk.gray("project rows: run `lebop pull --project-id <uuid> --refresh --yes` after verifying local cache overwrite is intended")}\n`,
      );
    }
    process.stdout.write("\n");
  }

  if (totalRemoteConflicts > 0) {
    process.stdout.write(
      `${chalk.red("remote conflicts / invalid stale snapshot")} (${totalRemoteConflicts}):\n`,
    );
    for (const r of status.remote_conflicts) {
      const label = r.kind === "issue" ? r.identifier : `project/${r.name}`;
      const fields = r.fields && r.fields.length > 0 ? ` ${chalk.gray(r.fields.join(", "))}` : "";
      process.stdout.write(
        `  ${chalk.bold(label)}  ${chalk.yellow(r.reason)} ${chalk.gray(`(${r.local_status})`)}${fields}\n`,
      );
    }
    process.stdout.write(
      `  ${chalk.gray("resolve remote state before pushing; refresh or remove inaccessible rows")}\n\n`,
    );
  }

  if (totalClean > 0) {
    process.stdout.write(`${chalk.green("clean")} (${totalClean}):\n`);
    if (status.clean.issues.length > 0) {
      process.stdout.write(`  ${status.clean.issues.join(" ")}\n`);
    }
    for (const id of status.clean.projects) {
      process.stdout.write(`  project/${id}\n`);
    }
  }

  if (totalIntegrityProblems > 0) {
    process.stdout.write(
      `\n${chalk.yellow("cache integrity issues")} (${totalIntegrityProblems}):\n`,
    );
    for (const problem of status.integrity.problems) {
      const missing =
        problem.missing_files.length > 0 ? ` missing ${problem.missing_files.join(", ")}` : "";
      process.stdout.write(
        `  ${chalk.bold(`${problem.kind}/${problem.id}`)}  ${chalk.yellow(problem.problem)}${chalk.gray(missing)}\n`,
      );
    }
    process.stdout.write(
      `  ${chalk.gray("repair by refreshing affected rows or removing invalid cache directories")}\n`,
    );
  }

  if (status.stale_check_error) {
    process.stdout.write(
      `\n${chalk.yellow("note:")} remote-staleness check failed (${status.stale_check_error}). ` +
        `run with ${chalk.cyan("--no-remote")} to skip.\n`,
    );
  }
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("git-like status for the current repo's lebop cache")
    .option("--team <key>", "override the resolved team")
    .option("--no-remote", "skip the remote-staleness check (faster, no Linear API calls)")
    .option("--json", "emit structured status")
    .action(statusAction);
}
