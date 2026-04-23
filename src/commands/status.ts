import chalk from "chalk";
import type { Command } from "commander";
import {
  type IssueMetadata,
  type ProjectMetadata,
  listCachedIssues,
  listCachedProjectIds,
  readIssue,
  readProject,
} from "../lib/cache.ts";
import { resolveConfig } from "../lib/config.ts";
import {
  type IssueChange,
  type ProjectChange,
  diffIssueMetadata,
  diffProjectMetadata,
} from "../lib/diff.ts";

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("git-like status for the current repo's leebop cache")
    .option("--team <key>", "override the resolved team")
    .option("--json", "emit structured status")
    .action(async (opts: { team?: string; json?: boolean }) => {
      const config = await resolveConfig({ teamOverride: opts.team });

      const issueIds = await listCachedIssues(config.repoHash);
      const issueResults = await Promise.all(
        issueIds.map(async (id) => {
          const loaded = await readIssue(config.repoHash, id);
          if (!loaded) return null;
          const changes = diffIssueMetadata(loaded.metadata, loaded.description);
          return { id, metadata: loaded.metadata, changes };
        }),
      );

      const projectIds = await listCachedProjectIds(config.repoHash);
      const projectResults = await Promise.all(
        projectIds.map(async (pid) => {
          const loaded = await readProject(config.repoHash, pid);
          if (!loaded) return null;
          const changes = diffProjectMetadata(loaded.metadata, loaded.content);
          return { id: pid, metadata: loaded.metadata, changes };
        }),
      );

      const modifiedIssues = issueResults.filter(
        (r): r is { id: string; metadata: IssueMetadata; changes: IssueChange[] } =>
          r !== null && r.changes.length > 0,
      );
      const cleanIssues = issueResults.filter(
        (r): r is { id: string; metadata: IssueMetadata; changes: IssueChange[] } =>
          r !== null && r.changes.length === 0,
      );
      const modifiedProjects = projectResults.filter(
        (r): r is { id: string; metadata: ProjectMetadata; changes: ProjectChange[] } =>
          r !== null && r.changes.length > 0,
      );
      const cleanProjects = projectResults.filter(
        (r): r is { id: string; metadata: ProjectMetadata; changes: ProjectChange[] } =>
          r !== null && r.changes.length === 0,
      );

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              team: config.team,
              repo_root: config.repoRoot,
              repo_hash: config.repoHash,
              modified: {
                issues: modifiedIssues.map((r) => ({
                  identifier: r.id,
                  fields: r.changes.map((c) => c.field),
                })),
                projects: modifiedProjects.map((r) => ({
                  id: r.id,
                  name: r.metadata.name,
                  fields: r.changes.map((c) => c.field),
                })),
              },
              clean: {
                issues: cleanIssues.map((r) => r.id),
                projects: cleanProjects.map((r) => r.id),
              },
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      process.stdout.write(
        `on team: ${chalk.bold(config.team)}${config.repoRoot ? `  (repo: ${config.repoRoot})` : "  (no repo — global cache)"}\n\n`,
      );

      const totalModified = modifiedIssues.length + modifiedProjects.length;
      const totalClean = cleanIssues.length + cleanProjects.length;

      if (totalModified === 0 && totalClean === 0) {
        process.stdout.write("cache is empty. run `leebop pull` to materialize issues.\n");
        return;
      }

      if (totalModified > 0) {
        process.stdout.write(`${chalk.yellow("modified locally")} (${totalModified}):\n`);
        for (const r of modifiedIssues) {
          const fields = r.changes.map((c) => c.field).join(", ");
          process.stdout.write(`  ${chalk.bold(r.id)}  ${chalk.gray(fields)}\n`);
        }
        for (const r of modifiedProjects) {
          const fields = r.changes.map((c) => c.field).join(", ");
          process.stdout.write(
            `  ${chalk.bold(`project/${r.metadata.name}`)}  ${chalk.gray(fields)}\n`,
          );
        }
        process.stdout.write("\n");
      }

      if (totalClean > 0) {
        process.stdout.write(`${chalk.green("clean")} (${totalClean}):\n`);
        const ids = cleanIssues.map((r) => r.id);
        process.stdout.write(`  ${ids.join(" ")}\n`);
        for (const r of cleanProjects) {
          process.stdout.write(`  project/${r.metadata.name}\n`);
        }
      }
    });
}
