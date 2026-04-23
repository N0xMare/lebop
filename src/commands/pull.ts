import chalk from "chalk";
import type { Command } from "commander";
import { buildComments, buildIssueMetadata, buildProjectMetadata } from "../lib/build.ts";
import {
  type IssueMetadata,
  clearComments,
  readIssue,
  readProject,
  writeComment,
  writeIssue,
  writeProject,
} from "../lib/cache.ts";
import { resolveConfig } from "../lib/config.ts";
import { diffIssueMetadata, diffProjectMetadata } from "../lib/diff.ts";
import { expandIds } from "../lib/expand.ts";
import {
  type FetchedIssue,
  type FetchedProject,
  PULL_PROJECT_QUERY,
  buildPullIssuesQuery,
} from "../lib/pullQuery.ts";
import { linear } from "../lib/sdk.ts";

export function registerPull(program: Command): void {
  program
    .command("pull [ids...]")
    .description("fetch Linear entities into ~/.leebop/cache for local editing")
    .option("--team <key>", "override the resolved team")
    .option("--project <name>", "fetch a project and its child issues")
    .option("--project-id <uuid>", "fetch by project UUID")
    .option("--refresh", "overwrite local cache even if it has unpushed edits")
    .option("--no-comments", "skip fetching comments")
    .option("--json", "emit structured summary")
    .action(async (ids: string[], opts: PullOpts) => {
      const config = await resolveConfig({ teamOverride: opts.team });
      const client = await linear();

      const issueIds = expandIds(ids);
      let projectPulled: { project: FetchedProject; added_issue_ids: string[] } | null = null;

      if (opts.project || opts.projectId) {
        const projectId =
          opts.projectId ?? (await lookupProjectId(client, config.team, opts.project ?? ""));
        const response = (await client.client.rawRequest(PULL_PROJECT_QUERY, {
          id: projectId,
        })) as {
          data: { project: FetchedProject | null };
        };
        const project = response.data.project;
        if (!project) {
          throw new Error(`project not found: ${opts.project ?? opts.projectId}`);
        }
        projectPulled = {
          project,
          added_issue_ids: project.issues.nodes.map((n) => n.identifier),
        };
        issueIds.push(...projectPulled.added_issue_ids);
      }

      if (issueIds.length === 0 && !projectPulled) {
        throw new Error("nothing to pull — pass issue IDs or --project / --project-id");
      }

      // Refuse to overwrite unpushed edits unless --refresh.
      if (!opts.refresh) {
        const conflicts: string[] = [];
        for (const id of issueIds) {
          const existing = await readIssue(config.repoHash, id);
          if (existing && hasLocalChanges(existing.metadata, existing.description)) {
            conflicts.push(id);
          }
        }
        if (projectPulled) {
          const existing = await readProject(config.repoHash, projectPulled.project.id);
          if (existing) {
            const diffs = diffProjectMetadata(existing.metadata, existing.content);
            if (diffs.length > 0) conflicts.push(`project/${projectPulled.project.id}`);
          }
        }
        if (conflicts.length > 0) {
          process.stderr.write(
            `${chalk.yellow("refusing to overwrite local edits on:")} ${conflicts.join(", ")}\n`,
          );
          process.stderr.write(
            `  push them with ${chalk.cyan("leebop push")} or re-run with ${chalk.cyan("--refresh")}\n`,
          );
          process.exit(1);
        }
      }

      const unique = Array.from(new Set(issueIds));
      const results: { identifier: string; comments: number }[] = [];
      const errors: { identifier: string; error: string }[] = [];

      if (unique.length > 0) {
        const withComments = opts.comments !== false;
        const query = buildPullIssuesQuery(unique, withComments);
        const response = (await client.client.rawRequest(query)) as {
          data: Record<string, FetchedIssue | null>;
        };
        const fetched: FetchedIssue[] = [];
        for (let i = 0; i < unique.length; i++) {
          const id = unique[i];
          const node = response.data[`a${i}`];
          if (!node) {
            if (id) errors.push({ identifier: id, error: "not found" });
          } else {
            fetched.push(node);
          }
        }
        for (const issue of fetched) {
          const { metadata, description } = buildIssueMetadata(issue);
          await writeIssue(config.repoHash, metadata, description);
          if (opts.comments !== false) {
            await clearComments(config.repoHash, issue.identifier);
            const comments = buildComments(issue);
            for (const comment of comments) {
              await writeComment(config.repoHash, issue.identifier, comment);
            }
            results.push({ identifier: issue.identifier, comments: comments.length });
          } else {
            results.push({ identifier: issue.identifier, comments: 0 });
          }
        }
      }

      let projectResult: { id: string; name: string; issues: number } | null = null;
      if (projectPulled) {
        const { metadata, content } = buildProjectMetadata(projectPulled.project);
        await writeProject(config.repoHash, metadata, content);
        projectResult = {
          id: projectPulled.project.id,
          name: projectPulled.project.name,
          issues: projectPulled.added_issue_ids.length,
        };
      }

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              team: config.team,
              repo_hash: config.repoHash,
              project: projectResult,
              issues: results,
              errors,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      if (projectResult) {
        process.stdout.write(
          `${chalk.green("✓")} pulled project ${chalk.bold(projectResult.name)} (${projectResult.issues} child issues)\n`,
        );
      }
      for (const r of results) {
        process.stdout.write(
          `${chalk.green("✓")} ${r.identifier}${r.comments > 0 ? chalk.gray(` (${r.comments} comments)`) : ""}\n`,
        );
      }
      for (const e of errors) {
        process.stdout.write(`${chalk.red("✗")} ${e.identifier}: ${e.error}\n`);
      }
      if (errors.length > 0) process.exitCode = 1;
    });
}

interface PullOpts {
  team?: string;
  project?: string;
  projectId?: string;
  refresh?: boolean;
  comments?: boolean; // commander inverts --no-comments into comments=false
  json?: boolean;
}

async function lookupProjectId(
  client: Awaited<ReturnType<typeof linear>>,
  teamKey: string,
  name: string,
): Promise<string> {
  const teams = await client.teams({ filter: { key: { eq: teamKey } } });
  const team = teams.nodes[0];
  if (!team) throw new Error(`team not found: ${teamKey}`);
  const projects = await team.projects({ first: 250 });
  const match = projects.nodes.find((p) => p.name === name);
  if (!match) {
    const candidates = projects.nodes
      .filter((p) => p.name.toLowerCase().includes(name.toLowerCase()))
      .slice(0, 5)
      .map((p) => `"${p.name}"`)
      .join(", ");
    const hint = candidates ? ` candidates: ${candidates}` : "";
    throw new Error(`project not found in ${teamKey}: "${name}".${hint}`);
  }
  return match.id;
}

function hasLocalChanges(metadata: IssueMetadata, description: string): boolean {
  return diffIssueMetadata(metadata, description).length > 0;
}
