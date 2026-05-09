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
import { buildCasQuery } from "../lib/pushMutations.ts";
import { withRetry } from "../lib/retry.ts";
import { linear } from "../lib/sdk.ts";

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("git-like status for the current repo's lebop cache")
    .option("--team <key>", "override the resolved team")
    .option("--no-remote", "skip the remote-staleness check (faster, no Linear API calls)")
    .option("--json", "emit structured status")
    .action(async (opts: { team?: string; json?: boolean; remote?: boolean }) => {
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

      // Detect stale entries: remote `updatedAt` newer than local `_server.updated_at`.
      // Only check clean entries — modified ones already need attention regardless.
      // Skipped with `--no-remote` (faster; offline-friendly).
      interface StaleEntry {
        id: string;
        metadata: IssueMetadata;
        changes: IssueChange[];
        server_updated_at: string;
        remote_updated_at: string;
      }
      const staleEntries: StaleEntry[] = [];
      const staleErrors: { id: string; error: string }[] = [];
      const checkRemote = opts.remote !== false && cleanIssues.length > 0;
      if (checkRemote) {
        try {
          const client = await linear();
          const ids = cleanIssues.map((r) => r.id);
          const query = buildCasQuery(ids);
          const response = (await withRetry(() => client.client.rawRequest(query))) as {
            data: Record<string, { id: string; identifier: string; updatedAt: string } | null>;
          };
          ids.forEach((id, i) => {
            const entry = cleanIssues[i];
            if (!entry) return;
            const remote = response.data[`a${i}`];
            if (!remote) return; // missing-remote — surface elsewhere
            const localT = Date.parse(entry.metadata._server.updated_at);
            const remoteT = Date.parse(remote.updatedAt);
            if (remoteT > localT) {
              staleEntries.push({
                ...entry,
                server_updated_at: entry.metadata._server.updated_at,
                remote_updated_at: remote.updatedAt,
              });
            }
          });
        } catch (err) {
          // Best-effort: if the remote check fails, fall through to local-only status.
          staleErrors.push({ id: "*", error: (err as Error).message });
        }
      }
      const staleIdSet = new Set(staleEntries.map((r) => r.id));
      const trulyCleanIssues = cleanIssues.filter((r) => !staleIdSet.has(r.id));

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
              stale: staleEntries.map((r) => ({
                identifier: r.id,
                kind: "issue",
                server_updated_at: r.server_updated_at,
                remote_updated_at: r.remote_updated_at,
              })),
              stale_check: checkRemote ? (staleErrors.length > 0 ? "errored" : "ok") : "skipped",
              clean: {
                issues: trulyCleanIssues.map((r) => r.id),
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
      const totalStale = staleEntries.length;
      const totalClean = trulyCleanIssues.length + cleanProjects.length;

      if (totalModified === 0 && totalStale === 0 && totalClean === 0) {
        process.stdout.write("cache is empty. run `lebop pull` to materialize issues.\n");
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

      if (totalStale > 0) {
        process.stdout.write(
          `${chalk.cyan("stale (remote newer — needs pull)")} (${totalStale}):\n`,
        );
        for (const r of staleEntries) {
          process.stdout.write(`  ${chalk.bold(r.id)}\n`);
        }
        process.stdout.write(`  ${chalk.gray("run `lebop pull <id> --refresh` to update")}\n\n`);
      }

      if (totalClean > 0) {
        process.stdout.write(`${chalk.green("clean")} (${totalClean}):\n`);
        const ids = trulyCleanIssues.map((r) => r.id);
        process.stdout.write(`  ${ids.join(" ")}\n`);
        for (const r of cleanProjects) {
          process.stdout.write(`  project/${r.metadata.name}\n`);
        }
      }

      if (staleErrors.length > 0) {
        process.stdout.write(
          `\n${chalk.yellow("note:")} remote-staleness check failed (${staleErrors[0]?.error ?? "unknown"}). ` +
            `run with ${chalk.cyan("--no-remote")} to skip.\n`,
        );
      }
    });
}
