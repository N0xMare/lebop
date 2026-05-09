import { mkdir } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { stringify as stringifyYaml } from "yaml";
import { buildComments, buildIssueMetadata, buildProjectMetadata } from "../lib/build.ts";
import {
  type CachedComment,
  type IssueMetadata,
  type ProjectMetadata,
  clearComments,
  issueDir,
  projectDir,
  readIssue,
  readProject,
  writeAtomic,
  writeComment,
  writeIssue,
  writeProject,
} from "../lib/cache.ts";
import { resolveConfig } from "../lib/config.ts";
import { diffIssueMetadata, diffProjectMetadata } from "../lib/diff.ts";
import { rewriteNotFound } from "../lib/errors.ts";
import { expandIds } from "../lib/expand.ts";
import { paginateRaw } from "../lib/paginate.ts";
import {
  type FetchedIssue,
  type FetchedProject,
  MORE_COMMENTS_QUERY,
  PULL_PROJECT_HEADER_QUERY,
  PULL_PROJECT_ISSUES_QUERY,
  buildPullIssuesQuery,
} from "../lib/pullQuery.ts";
import { withRetry } from "../lib/retry.ts";
import { linear, withClient } from "../lib/sdk.ts";

export function registerPull(program: Command): void {
  program
    .command("pull [ids...]")
    .description("fetch Linear entities into ~/.lebop/cache for local editing")
    .option("--team <key>", "override the resolved team")
    .option("--project <name>", "fetch a project and its child issues")
    .option("--project-id <uuid>", "fetch by project UUID")
    .option("--refresh", "overwrite local cache even if it has unpushed edits")
    .option("--no-comments", "skip fetching comments")
    .option(
      "--to <dir>",
      "write files to <dir>/<id>/ instead of the cache. export-only: `status` and `push` operate on the default cache only",
    )
    .option("--json", "emit structured summary")
    .action(async (ids: string[], opts: PullOpts) => {
      const config = await resolveConfig({ teamOverride: opts.team });
      const client = await linear();
      const destinationRoot = opts.to ? resolvePath(opts.to) : null;

      const issueIds = expandIds(ids);
      let projectPulled: { project: FetchedProject; added_issue_ids: string[] } | null = null;

      if (opts.project || opts.projectId) {
        const projectId =
          opts.projectId ?? (await lookupProjectId(client, config.team, opts.project ?? ""));
        const headerResponse = (await withClient((c) =>
          c.client.rawRequest(PULL_PROJECT_HEADER_QUERY, { id: projectId }),
        )) as { data: { project: Omit<FetchedProject, "issues"> | null } };
        const header = headerResponse.data.project;
        if (!header) {
          throw new Error(`project not found: ${opts.project ?? opts.projectId}`);
        }
        type IssuesPage = {
          data: {
            project: {
              issues: {
                nodes: { identifier: string; title?: string }[];
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
              };
            } | null;
          };
        };
        const issueNodes = await paginateRaw<{ identifier: string; title?: string }, IssuesPage>(
          ({ first, after }) =>
            client.client.rawRequest(PULL_PROJECT_ISSUES_QUERY, {
              id: projectId,
              first,
              after,
            }) as Promise<IssuesPage>,
          (response) => response.data.project?.issues ?? null,
          { pageSize: 250 },
        );
        const project: FetchedProject = { ...header, issues: { nodes: issueNodes } };
        projectPulled = {
          project,
          added_issue_ids: issueNodes.map((n) => n.identifier),
        };
        issueIds.push(...projectPulled.added_issue_ids);
      }

      if (issueIds.length === 0 && !projectPulled) {
        throw new Error("nothing to pull — pass issue IDs or --project / --project-id");
      }

      // Refuse to overwrite unpushed edits unless --refresh.
      // Skipped when --to is given (export mode doesn't touch the cache).
      if (!opts.refresh && !destinationRoot) {
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
            `  push them with ${chalk.cyan("lebop push")} or re-run with ${chalk.cyan("--refresh")}\n`,
          );
          process.exitCode = 1;
          return;
        }
      }

      const unique = Array.from(new Set(issueIds));
      const results: { identifier: string; comments: number; path: string }[] = [];
      const errors: { identifier: string; error: string }[] = [];

      if (unique.length > 0) {
        const withComments = opts.comments !== false;
        const { data, errors: aliasErrors } = await rawRequestTolerant<FetchedIssue>(
          client,
          unique,
          (ids) => buildPullIssuesQuery(ids, withComments),
        );
        const fetched: FetchedIssue[] = [];
        for (let i = 0; i < unique.length; i++) {
          const id = unique[i];
          const node = data[`a${i}`];
          if (!node) {
            if (id) {
              const aliasErr = aliasErrors.find((e) => e.path?.[0] === `a${i}`);
              const msg = aliasErr
                ? rewriteNotFound(new Error(aliasErr.message), id).message
                : `not found: ${id}`;
              errors.push({ identifier: id, error: msg });
            }
          } else {
            fetched.push(node);
          }
        }
        if (withComments) {
          // Issues with >250 comments hit the multi-alias fragment cap.
          // Fetch the remaining pages per-issue, picking up from the existing
          // endCursor so we don't re-fetch the first 250.
          const overflow = fetched.filter((i) => i.comments?.pageInfo.hasNextPage);
          for (const issue of overflow) {
            const startCursor = issue.comments?.pageInfo.endCursor;
            if (!startCursor || !issue.comments) continue;
            type CommentsPage = {
              data: {
                issue: {
                  comments: {
                    nodes: NonNullable<FetchedIssue["comments"]>["nodes"];
                    pageInfo: { hasNextPage: boolean; endCursor: string | null };
                  };
                } | null;
              };
            };
            const more = await paginateRaw<
              NonNullable<FetchedIssue["comments"]>["nodes"][number],
              CommentsPage
            >(
              ({ first, after }) =>
                client.client.rawRequest(MORE_COMMENTS_QUERY, {
                  id: issue.identifier,
                  first,
                  after,
                }) as Promise<CommentsPage>,
              (response) => response.data.issue?.comments ?? null,
              { pageSize: 250, initialAfter: startCursor },
            );
            // Defensive: if the follow-up returned nothing despite the first
            // page reporting hasNextPage:true (e.g. issue deleted between
            // calls), surface a warning so the partial set isn't silently
            // taken as canonical.
            if (more.length === 0) {
              process.stderr.write(
                `${chalk.yellow("warning:")} ${issue.identifier} reported additional comments but the follow-up fetch returned 0 nodes — issue may have been deleted; first 250 written\n`,
              );
            }
            issue.comments.nodes.push(...more);
            issue.comments.pageInfo.hasNextPage = false;
            issue.comments.pageInfo.endCursor = null;
          }
        }
        for (const issue of fetched) {
          const { metadata, description } = buildIssueMetadata(issue);
          const commentList = withComments ? buildComments(issue) : [];
          const path = destinationRoot
            ? await writeIssueExport(
                destinationRoot,
                issue.identifier,
                metadata,
                description,
                commentList,
              )
            : await writeIssueToCache(
                config.repoHash,
                issue.identifier,
                metadata,
                description,
                commentList,
                withComments,
              );
          results.push({ identifier: issue.identifier, comments: commentList.length, path });
        }
      }

      let projectResult: { id: string; name: string; issues: number; path: string } | null = null;
      if (projectPulled) {
        const { metadata, content } = buildProjectMetadata(projectPulled.project);
        let path: string;
        if (destinationRoot) {
          path = await writeProjectExport(
            destinationRoot,
            projectPulled.project.id,
            metadata,
            content,
          );
        } else {
          await writeProject(config.repoHash, metadata, content);
          path = projectDir(config.repoHash, projectPulled.project.id);
        }
        projectResult = {
          id: projectPulled.project.id,
          name: projectPulled.project.name,
          issues: projectPulled.added_issue_ids.length,
          path,
        };
      }

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              team: config.team,
              repo_hash: config.repoHash,
              mode: destinationRoot ? "export" : "cache",
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
          `${chalk.green("✓")} pulled project ${chalk.bold(projectResult.name)} (${projectResult.issues} child issues) → ${chalk.cyan(projectResult.path)}\n`,
        );
      }
      for (const r of results) {
        const commentSuffix = r.comments > 0 ? chalk.gray(` (${r.comments} comments)`) : "";
        process.stdout.write(
          `${chalk.green("✓")} ${r.identifier}${commentSuffix} → ${chalk.cyan(r.path)}\n`,
        );
      }
      for (const e of errors) {
        process.stdout.write(`${chalk.red("✗")} ${e.identifier}: ${e.error}\n`);
      }
      if (destinationRoot) {
        process.stdout.write(
          chalk.gray(
            `\nexport mode: \`lebop status\` and \`lebop push\` operate on the default cache only — edits here won't round-trip.\n`,
          ),
        );
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
  to?: string;
  json?: boolean;
}

async function writeIssueToCache(
  repoHash: string,
  identifier: string,
  metadata: IssueMetadata,
  description: string,
  comments: CachedComment[],
  withComments: boolean,
): Promise<string> {
  await writeIssue(repoHash, metadata, description);
  if (withComments) {
    await clearComments(repoHash, identifier);
    for (const comment of comments) {
      await writeComment(repoHash, identifier, comment);
    }
  }
  return issueDir(repoHash, identifier);
}

async function writeIssueExport(
  destinationRoot: string,
  identifier: string,
  metadata: IssueMetadata,
  description: string,
  comments: CachedComment[],
): Promise<string> {
  const dir = join(destinationRoot, identifier);
  await mkdir(dir, { recursive: true });
  await writeAtomic(join(dir, "description.md"), description);
  await writeAtomic(join(dir, "metadata.yaml"), stringifyYaml(metadata, { lineWidth: 0 }));
  if (comments.length > 0) {
    const commentsDir = join(dir, "comments");
    await mkdir(commentsDir, { recursive: true });
    for (const c of comments) {
      const text = `---\n${stringifyYaml(c.frontmatter)}---\n\n${c.body}\n`;
      await writeAtomic(join(commentsDir, `${c.frontmatter.id}.md`), text);
    }
  }
  return dir;
}

async function writeProjectExport(
  destinationRoot: string,
  projectId: string,
  metadata: ProjectMetadata,
  content: string,
): Promise<string> {
  const dir = join(destinationRoot, `project-${projectId}`);
  await mkdir(dir, { recursive: true });
  await writeAtomic(join(dir, "content.md"), content);
  await writeAtomic(join(dir, "metadata.yaml"), stringifyYaml(metadata));
  return dir;
}

async function lookupProjectId(
  _client: Awaited<ReturnType<typeof linear>>,
  teamKey: string,
  name: string,
): Promise<string> {
  const teams = await withClient((c) => c.teams({ filter: { key: { eq: teamKey } } }));
  const team = teams.nodes[0];
  if (!team) throw new Error(`team not found: ${teamKey}`);
  const projects = await withRetry(() => team.projects({ first: 250 }));
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

interface AliasError {
  message: string;
  path?: string[];
}

/**
 * Linear's SDK throws and discards `data` whenever ANY alias in a multi-alias query
 * errors — successful aliases are lost. To honour spec §8.1 ("on per-entity error,
 * report and continue"), try the multi-alias query first (one round-trip happy path);
 * on error, fall back to per-id parallel single-alias queries so successes survive.
 *
 * Returns `data` keyed by `a0..aN-1` matching `identifiers` order, plus a per-alias
 * `errors` list (with `path: [alias]`) for any failed lookups.
 */
async function rawRequestTolerant<T>(
  client: Awaited<ReturnType<typeof linear>>,
  identifiers: string[],
  build: (ids: string[]) => string,
): Promise<{ data: Record<string, T | null>; errors: AliasError[] }> {
  try {
    // Reads are idempotent — wrap the multi-alias attempt with retry so a
    // transient 5xx doesn't immediately fall through to the N-round-trip
    // per-id fallback path.
    const r = (await withRetry(() => client.client.rawRequest(build(identifiers)))) as {
      data: Record<string, T | null>;
    };
    return { data: r.data ?? {}, errors: [] };
  } catch (err) {
    // Per-id fallback: each request gets its own success/failure. Each
    // single-alias request is also retry-wrapped so a transient blip on one
    // id doesn't kill the rest.
    const settled = await Promise.allSettled(
      identifiers.map(
        (id) =>
          withRetry(() => client.client.rawRequest(build([id]))) as Promise<{
            data: { a0: T | null };
          }>,
      ),
    );
    const data: Record<string, T | null> = {};
    const errors: AliasError[] = [];
    settled.forEach((s, i) => {
      const alias = `a${i}`;
      if (s.status === "fulfilled") {
        data[alias] = s.value.data?.a0 ?? null;
      } else {
        data[alias] = null;
        errors.push({ path: [alias], message: (s.reason as Error).message });
      }
    });
    return { data, errors };
  }
}
