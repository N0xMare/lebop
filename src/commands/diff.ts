import chalk from "chalk";
import type { Command } from "commander";
import { createTwoFilesPatch } from "diff";
import { buildIssueMetadata } from "../lib/build.ts";
import { readIssue } from "../lib/cache.ts";
import { resolveConfig } from "../lib/config.ts";
import { rewriteNotFound } from "../lib/errors.ts";
import { type FetchedIssue, buildPullIssuesQuery } from "../lib/pullQuery.ts";
import { linear } from "../lib/sdk.ts";

interface DiffOpts {
  team?: string;
  json?: boolean;
}

interface FieldDiff {
  field: string;
  local: unknown;
  remote: unknown;
}

export function registerDiff(program: Command): void {
  program
    .command("diff <id>")
    .description(
      "show a unified diff of local cache vs live remote for one issue (like `git diff`)",
    )
    .option("--team <key>", "override the resolved team")
    .option("--json", "emit structured diff instead of human output")
    .action(async (id: string, opts: DiffOpts) => {
      const config = await resolveConfig({ teamOverride: opts.team });
      const upperId = id.toUpperCase();
      const local = await readIssue(config.repoHash, upperId);
      if (!local) {
        throw new Error(
          `${upperId} is not in the local cache. run \`lebop pull ${upperId}\` first.`,
        );
      }

      // Fetch live remote.
      const client = await linear();
      const query = buildPullIssuesQuery([upperId], false);
      let response: { data: Record<string, FetchedIssue | null> };
      try {
        response = (await client.client.rawRequest(query)) as {
          data: Record<string, FetchedIssue | null>;
        };
      } catch (err) {
        throw rewriteNotFound(err, upperId);
      }
      const remoteNode = response.data.a0;
      if (!remoteNode) throw new Error(`not found: ${upperId}`);

      const { metadata: remoteMeta } = buildIssueMetadata(remoteNode);
      const remoteBody = remoteNode.description ?? "";

      const fields = computeFieldDiff(local.metadata, remoteMeta);
      const patch = createTwoFilesPatch(
        `a/${upperId}/description.md`,
        `b/${upperId}/description.md`,
        remoteBody,
        local.description,
        "remote (live)",
        "local (cache)",
        { context: 3 },
      );
      // Headers (+++ / ---) always appear in a unified patch; ignore them.
      const descChanged = patch
        .split("\n")
        .some(
          (l) =>
            (l.startsWith("+") && !l.startsWith("+++")) ||
            (l.startsWith("-") && !l.startsWith("---")),
        );

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              identifier: upperId,
              fields,
              description_changed: descChanged,
              description_patch: descChanged ? patch : null,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      printHuman(upperId, fields, descChanged, patch);
      if (fields.length === 0 && !descChanged) process.exitCode = 0;
      else process.exitCode = 1;
    });
}

function computeFieldDiff(
  local: import("../lib/cache.ts").IssueMetadata,
  remote: import("../lib/cache.ts").IssueMetadata,
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  if (local.title !== remote.title) {
    diffs.push({ field: "title", local: local.title, remote: remote.title });
  }
  if (local.state !== remote.state) {
    diffs.push({ field: "state", local: local.state, remote: remote.state });
  }
  if (local.priority !== remote.priority) {
    diffs.push({ field: "priority", local: local.priority, remote: remote.priority });
  }
  const localLabels = [...local.labels].sort();
  const remoteLabels = [...remote.labels].sort();
  if (JSON.stringify(localLabels) !== JSON.stringify(remoteLabels)) {
    diffs.push({ field: "labels", local: localLabels, remote: remoteLabels });
  }
  if ((local.assignee ?? null) !== (remote.assignee ?? null)) {
    diffs.push({ field: "assignee", local: local.assignee, remote: remote.assignee });
  }
  return diffs;
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
