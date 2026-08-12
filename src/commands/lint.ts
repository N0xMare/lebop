import chalk from "chalk";
import type { Command } from "commander";
import { wantsMachineOutput } from "../lib/encode.ts";
import type { LintFileResult } from "../lib/lintFiles.ts";
import { writeMachineEnvelope } from "../lib/output.ts";
import {
  buildLintFilesInputFromCli,
  executeLintFiles,
  lintFilesCliPayload,
} from "../surface/lint.ts";

interface LintOpts {
  team?: string;
  fix?: boolean;
  strict?: boolean;
  json?: boolean;
  format?: string;
  pretty?: boolean;
}

export function registerLint(program: Command): void {
  program
    .command("lint [paths...]")
    .description("lint local markdown files for Linear renderer quirks")
    .option("--team <key>", "override the resolved team")
    .option("--fix", "auto-apply safe rewrites")
    .option("--strict", "exit non-zero on any warning")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(async (paths: string[], opts: LintOpts) => {
      const result = await executeLintFiles(
        buildLintFilesInputFromCli({
          paths,
          opts: {
            team: opts.team,
            fix: opts.fix,
            strict: opts.strict,
          },
        }),
      );
      if (result.files.length === 0 && result.missing_count === 0) {
        process.stderr.write(`${chalk.yellow("no markdown files found to lint.")}\n`);
        return;
      }
      for (const file of result.missing_paths)
        process.stderr.write(`${chalk.red("missing:")} ${file}\n`);

      if (wantsMachineOutput(opts)) {
        writeMachineEnvelope(lintFilesCliPayload(result) as Record<string, unknown>, {
          json: true,
          format: opts.format,
          pretty: opts.pretty,
        });
      } else {
        printHuman(result.files, Boolean(opts.fix));
      }

      if (result.strict_failed) process.exitCode = 1;
    });
}

function printHuman(results: LintFileResult[], didFix: boolean): void {
  let totalWarnings = 0;
  let totalFixed = 0;
  for (const r of results) {
    if (r.warnings.length === 0) continue;
    process.stdout.write(`\n${chalk.bold(r.path)}\n`);
    for (const w of r.warnings) {
      const sev =
        w.severity === "warn"
          ? chalk.yellow("warn")
          : w.severity === "error"
            ? chalk.red("error")
            : chalk.gray("info");
      const fixHint = w.fix
        ? didFix
          ? chalk.green(" [fixed]")
          : chalk.gray(" [--fix available]")
        : "";
      process.stdout.write(
        `  ${chalk.dim(`L${w.line}:`)} ${sev} ${chalk.cyan(w.rule)} ${w.message}${fixHint}\n`,
      );
    }
    totalWarnings += r.warnings.length;
    totalFixed += r.fixed;
  }

  process.stdout.write(
    `\n${chalk.gray(
      `${results.length} file(s) checked · ${totalWarnings} warning(s)${didFix ? ` · ${totalFixed} fixed` : ""}\n`,
    )}`,
  );
}
