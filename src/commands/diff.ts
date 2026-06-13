import chalk from "chalk";
import type { Command } from "commander";
import { diffIssueCacheVsRemote, diffProjectCacheVsRemote, type FieldDiff } from "../lib/diff.ts";
import { envelope } from "../lib/envelope.ts";
import { ValidationError } from "../lib/errors.ts";

interface DiffOpts {
  team?: string;
  projectId?: string;
  json?: boolean;
}

export function registerDiff(program: Command): void {
  program
    .command("diff [id]")
    .description(
      "show a unified diff of local cache vs live remote for one issue or project. Exits 0 when local matches remote, 1 when drift exists.",
    )
    .option("--team <key>", "override the resolved team")
    .option("--project-id <uuid>", "diff a cached project by UUID")
    .option("--json", "emit structured diff instead of human output")
    .action(async (id: string | undefined, opts: DiffOpts) => {
      if (opts.projectId) {
        if (id) {
          throw new ValidationError(
            "pass either an issue id or --project-id, not both",
            "choose one diff target",
          );
        }
        const result = await diffProjectCacheVsRemote(opts.projectId, { team: opts.team });
        const hasDrift = result.fields.length > 0;
        process.exitCode = hasDrift ? 1 : 0;
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(envelope(result), null, 2)}\n`);
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
      if (!id) {
        throw new ValidationError(
          "missing issue id; pass an issue id or --project-id <uuid>",
          "pass an issue identifier or --project-id <uuid>",
        );
      }
      const result = await diffIssueCacheVsRemote(id, { team: opts.team });

      // Set exit code BEFORE branching on output mode — both --json and
      // human paths must honor `git diff --exit-code` semantics so CI gates
      // piping `lebop diff --json | jq …` still detect drift.
      const hasDrift = result.fields.length > 0 || result.description_changed;
      process.exitCode = hasDrift ? 1 : 0;

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope(result), null, 2)}\n`);
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
