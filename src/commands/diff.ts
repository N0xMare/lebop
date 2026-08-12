import chalk from "chalk";
import type { Command } from "commander";
import { wantsMachineOutput } from "../lib/encode.ts";
import { diffNext } from "../lib/nextStubs.ts";
import { writeMachineEnvelope } from "../lib/output.ts";
import {
  buildCacheDiffIssueInputFromCli,
  buildCacheDiffProjectInputFromCli,
  executeCacheDiffIssue,
  executeCacheDiffProject,
  type FieldDiff,
} from "../surface/cache.ts";

interface DiffOpts {
  team?: string;
  projectId?: string;
  json?: boolean;
  format?: string;
  pretty?: boolean;
}

export function registerDiff(program: Command): void {
  program
    .command("diff [id]")
    .description(
      "show a unified diff of local cache vs live remote for one issue or project. Exits 0 when local matches remote, 1 when drift exists.",
    )
    .option("--team <key>", "override the resolved team")
    .option("--project-id <uuid>", "diff a cached project by UUID")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(async (id: string | undefined, opts: DiffOpts) => {
      if (opts.projectId) {
        const result = await executeCacheDiffProject(
          buildCacheDiffProjectInputFromCli({ id, opts }),
        );
        const hasDrift = result.fields.length > 0;
        process.exitCode = hasDrift ? 1 : 0;
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope(
            { ...result, next: diffNext() } as Record<string, unknown>,
            {
              json: true,
              format: opts.format,
              pretty: opts.pretty,
            },
          );
          return;
        }
        printHumanProject(
          result.project_id,
          result.name,
          result.fields,
          result.content_changed,
          result.content_patch ?? "",
        );
        return;
      }
      const result = await executeCacheDiffIssue(buildCacheDiffIssueInputFromCli({ id, opts }));

      // Set exit code BEFORE branching on output mode — both --json and
      // human paths must honor `git diff --exit-code` semantics so CI gates
      // piping `lebop diff --json | jq …` still detect drift.
      const hasDrift = result.fields.length > 0 || result.description_changed;
      process.exitCode = hasDrift ? 1 : 0;

      if (wantsMachineOutput(opts)) {
        writeMachineEnvelope({ ...result, next: diffNext() } as Record<string, unknown>, {
          json: true,
          format: opts.format,
          pretty: opts.pretty,
        });
        return;
      }

      printHuman(
        result.identifier,
        result.fields,
        result.description_changed,
        result.description_patch ?? "",
      );
    });
}

function printHumanProject(
  projectId: string,
  name: string,
  fields: FieldDiff[],
  contentChanged: boolean,
  patch: string,
): void {
  const label = `project/${name}`;
  if (fields.length === 0) {
    process.stdout.write(`${chalk.green("✓")} ${chalk.bold(label)} local matches remote\n`);
    return;
  }

  process.stdout.write(
    `${chalk.bold(label)}  ${chalk.gray(`(${projectId}; local → remote drift)`)}\n`,
  );
  for (const d of fields.filter((f) => f.field !== "content")) {
    process.stdout.write(
      `  ${chalk.cyan(d.field)}: ${chalk.red(JSON.stringify(d.remote))} ${chalk.gray("(remote)")} → ${chalk.green(JSON.stringify(d.local))} ${chalk.gray("(local)")}\n`,
    );
  }
  if (contentChanged) {
    process.stdout.write(`\n${chalk.gray("── project content patch (remote → local) ──")}\n`);
    const colored = patch
      .split("\n")
      .map((l) => {
        if (l.startsWith("+++") || l.startsWith("---")) return chalk.bold(l);
        if (l.startsWith("@@")) return chalk.cyan(l);
        if (l.startsWith("+")) return chalk.green(l);
        if (l.startsWith("-")) return chalk.red(l);
        return l;
      })
      .join("\n");
    process.stdout.write(`${colored}\n`);
  }
}

function printHuman(
  identifier: string,
  fields: FieldDiff[],
  descChanged: boolean,
  patch: string,
): void {
  if (fields.length === 0 && !descChanged) {
    process.stdout.write(`${chalk.green("✓")} ${chalk.bold(identifier)} local matches remote\n`);
    return;
  }

  process.stdout.write(`${chalk.bold(identifier)}  ${chalk.gray("(local → remote drift)")}\n`);
  for (const d of fields) {
    process.stdout.write(
      `  ${chalk.cyan(d.field)}: ${chalk.red(JSON.stringify(d.remote))} ${chalk.gray("(remote)")} → ${chalk.green(JSON.stringify(d.local))} ${chalk.gray("(local)")}\n`,
    );
  }
  if (descChanged) {
    process.stdout.write(`\n${chalk.gray("── description patch (remote → local) ──")}\n`);
    const colored = patch
      .split("\n")
      .map((l) => {
        if (l.startsWith("+++") || l.startsWith("---")) return chalk.bold(l);
        if (l.startsWith("@@")) return chalk.cyan(l);
        if (l.startsWith("+")) return chalk.green(l);
        if (l.startsWith("-")) return chalk.red(l);
        return l;
      })
      .join("\n");
    process.stdout.write(`${colored}\n`);
  }
}
