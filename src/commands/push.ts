import chalk from "chalk";
import type { Command } from "commander";
import { buildIssueMetadata, buildProjectMetadata } from "../lib/build.ts";
import {
  type IssueMetadata,
  type ProjectMetadata,
  listCachedIssues,
  listCachedProjectIds,
  readIssue,
  readProject,
  writeIssue,
  writeProject,
} from "../lib/cache.ts";
import { resolveConfig } from "../lib/config.ts";
import {
  type IssueChange,
  type ProjectChange,
  diffIssueMetadata,
  diffProjectMetadata,
} from "../lib/diff.ts";
import { expandIds } from "../lib/expand.ts";
import { lintContent } from "../lib/lint.ts";
import type { FetchedIssue, FetchedProject } from "../lib/pullQuery.ts";
import {
  ISSUE_UPDATE_MUTATION,
  type IssueUpdateInput,
  PROJECT_UPDATE_MUTATION,
  type ProjectUpdateInput,
  buildCasQuery,
} from "../lib/pushMutations.ts";
import {
  getTeamMetadata,
  resolveAssigneeId,
  resolveLabelIds,
  resolveStateId,
} from "../lib/resolve.ts";
import { linear } from "../lib/sdk.ts";

interface PushOpts {
  team?: string;
  dryRun?: boolean;
  force?: boolean;
  strict?: boolean;
  json?: boolean;
}

interface IssuePlan {
  kind: "issue";
  identifier: string;
  metadata: IssueMetadata;
  description: string;
  changes: IssueChange[];
}

interface ProjectPlan {
  kind: "project";
  id: string;
  metadata: ProjectMetadata;
  content: string;
  changes: ProjectChange[];
}

type Plan = IssuePlan | ProjectPlan;

interface PushResult {
  target: string;
  kind: "issue" | "project";
  status: "pushed" | "stale" | "error" | "dry-run" | "no-changes" | "lint-blocked";
  fields?: string[];
  error?: string;
  warnings?: { rule: string; severity: string; message: string; line: number }[];
}

export function registerPush(program: Command): void {
  program
    .command("push [ids...]")
    .description("push locally-modified cache entries back to Linear")
    .option("--team <key>", "override the resolved team")
    .option("--dry-run", "print diff and mutations; no API calls")
    .option("--force", "skip CAS staleness check (dangerous)")
    .option("--strict", "block push on any lint warning")
    .option("--json", "emit structured per-entity result records")
    .action(async (ids: string[], opts: PushOpts) => {
      const config = await resolveConfig({ teamOverride: opts.team });

      const plans = await collectPlans(config.repoHash, expandIds(ids));

      if (plans.length === 0) {
        process.stdout.write("nothing to push — cache is clean\n");
        return;
      }

      const issuePlans = plans.filter((p): p is IssuePlan => p.kind === "issue");
      const projectPlans = plans.filter((p): p is ProjectPlan => p.kind === "project");

      // CAS staleness check — one batched query for all issues.
      const staleIssues = opts.force ? new Set<string>() : await detectStaleIssues(issuePlans);

      const results: PushResult[] = [];

      if (issuePlans.length > 0) {
        const metadata = await getTeamMetadata(config.repoHash, config.team);
        const client = await linear();
        for (const plan of issuePlans) {
          if (staleIssues.has(plan.identifier)) {
            results.push({
              target: plan.identifier,
              kind: "issue",
              status: "stale",
              fields: plan.changes.map((c) => c.field),
              error: `remote updated since pull — run \`leebop pull ${plan.identifier} --refresh\``,
            });
            continue;
          }

          let input: IssueUpdateInput;
          try {
            input = await buildIssueUpdateInput(plan, metadata);
          } catch (err) {
            results.push({
              target: plan.identifier,
              kind: "issue",
              status: "error",
              fields: plan.changes.map((c) => c.field),
              error: (err as Error).message,
            });
            continue;
          }

          // Lint the description if it's part of the change set; warn always, block on --strict.
          const descChanged = plan.changes.some((c) => c.field === "description");
          const lintWarnings = descChanged ? lintContent(plan.description).warnings : [];
          if (lintWarnings.length > 0 && !opts.json) {
            printLintWarnings(plan.identifier, lintWarnings, Boolean(opts.strict));
          }
          if (opts.strict && lintWarnings.length > 0) {
            results.push({
              target: plan.identifier,
              kind: "issue",
              status: "lint-blocked",
              fields: plan.changes.map((c) => c.field),
              warnings: lintWarnings.map((w) => ({
                rule: w.rule,
                severity: w.severity,
                message: w.message,
                line: w.line,
              })),
              error: `${lintWarnings.length} lint warning(s) — fix or run without --strict`,
            });
            continue;
          }

          if (opts.dryRun) {
            results.push({
              target: plan.identifier,
              kind: "issue",
              status: "dry-run",
              fields: plan.changes.map((c) => c.field),
            });
            if (!opts.json) {
              printDryRunIssue(plan.identifier, plan.changes, input);
            }
            continue;
          }

          try {
            const response = (await client.client.rawRequest(ISSUE_UPDATE_MUTATION, {
              id: plan.metadata._server.id,
              input,
            })) as { data: { issueUpdate: { success: boolean; issue: FetchedIssue } } };
            const updated = response.data.issueUpdate.issue;
            // Linear re-renders markdown (blank lines around ---, etc.), so store the
            // server's normalized description — otherwise `description_hash` diverges
            // from the on-disk file and status stays "modified" forever.
            const rebuilt = buildIssueMetadata(updated);
            await writeIssue(config.repoHash, rebuilt.metadata, updated.description ?? "");
            results.push({
              target: plan.identifier,
              kind: "issue",
              status: "pushed",
              fields: plan.changes.map((c) => c.field),
            });
          } catch (err) {
            results.push({
              target: plan.identifier,
              kind: "issue",
              status: "error",
              fields: plan.changes.map((c) => c.field),
              error: (err as Error).message,
            });
          }
        }
      }

      if (projectPlans.length > 0) {
        const client = await linear();
        for (const plan of projectPlans) {
          const input = buildProjectUpdateInput(plan);

          // Lint project content if it changed; warn always, block on --strict.
          const contentChanged = plan.changes.some((c) => c.field === "content");
          const lintWarnings = contentChanged ? lintContent(plan.content).warnings : [];
          if (lintWarnings.length > 0 && !opts.json) {
            printLintWarnings(`project/${plan.metadata.name}`, lintWarnings, Boolean(opts.strict));
          }
          if (opts.strict && lintWarnings.length > 0) {
            results.push({
              target: plan.metadata.name,
              kind: "project",
              status: "lint-blocked",
              fields: plan.changes.map((c) => c.field),
              warnings: lintWarnings.map((w) => ({
                rule: w.rule,
                severity: w.severity,
                message: w.message,
                line: w.line,
              })),
              error: `${lintWarnings.length} lint warning(s) — fix or run without --strict`,
            });
            continue;
          }

          if (opts.dryRun) {
            results.push({
              target: plan.metadata.name,
              kind: "project",
              status: "dry-run",
              fields: plan.changes.map((c) => c.field),
            });
            if (!opts.json) printDryRunProject(plan.metadata.name, plan.changes, input);
            continue;
          }
          try {
            const response = (await client.client.rawRequest(PROJECT_UPDATE_MUTATION, {
              id: plan.metadata._server.id,
              input,
            })) as {
              data: { projectUpdate: { success: boolean; project: FetchedProject } };
            };
            const updated = response.data.projectUpdate.project;
            // same re-render normalization applies to project content — write the server's
            // version, not the local pre-push version, so content_hash matches on disk.
            const rebuilt = buildProjectMetadata(updated);
            await writeProject(config.repoHash, rebuilt.metadata, updated.content ?? "");
            results.push({
              target: plan.metadata.name,
              kind: "project",
              status: "pushed",
              fields: plan.changes.map((c) => c.field),
            });
          } catch (err) {
            results.push({
              target: plan.metadata.name,
              kind: "project",
              status: "error",
              fields: plan.changes.map((c) => c.field),
              error: (err as Error).message,
            });
          }
        }
      }

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify({ schema_version: 1, team: config.team, results }, null, 2)}\n`,
        );
      } else {
        printSummary(results, opts.dryRun === true);
      }

      if (
        results.some(
          (r) => r.status === "error" || r.status === "stale" || r.status === "lint-blocked",
        )
      ) {
        process.exitCode = 1;
      }
    });
}

async function collectPlans(repoHash: string, explicitIds: string[]): Promise<Plan[]> {
  const plans: Plan[] = [];

  const targetIssueIds = explicitIds.length > 0 ? explicitIds : await listCachedIssues(repoHash);

  for (const id of targetIssueIds) {
    const loaded = await readIssue(repoHash, id);
    if (!loaded) {
      // explicit ids that don't exist should error, but for "push everything modified"
      // we silently skip non-existent cached entries.
      if (explicitIds.length > 0) {
        throw new Error(`${id} not in cache — run \`leebop pull ${id}\` first`);
      }
      continue;
    }
    const changes = diffIssueMetadata(loaded.metadata, loaded.description);
    if (changes.length === 0) continue;
    plans.push({
      kind: "issue",
      identifier: id,
      metadata: loaded.metadata,
      description: loaded.description,
      changes,
    });
  }

  if (explicitIds.length === 0) {
    const projectIds = await listCachedProjectIds(repoHash);
    for (const pid of projectIds) {
      const loaded = await readProject(repoHash, pid);
      if (!loaded) continue;
      const changes = diffProjectMetadata(loaded.metadata, loaded.content);
      if (changes.length === 0) continue;
      plans.push({
        kind: "project",
        id: pid,
        metadata: loaded.metadata,
        content: loaded.content,
        changes,
      });
    }
  }

  return plans;
}

async function detectStaleIssues(plans: IssuePlan[]): Promise<Set<string>> {
  if (plans.length === 0) return new Set();
  const client = await linear();
  const query = buildCasQuery(plans.map((p) => p.identifier));
  const response = (await client.client.rawRequest(query)) as {
    data: Record<string, { id: string; identifier: string; updatedAt: string } | null>;
  };
  const stale = new Set<string>();
  plans.forEach((plan, i) => {
    const remote = response.data[`a${i}`];
    if (!remote) return;
    if (Date.parse(remote.updatedAt) > Date.parse(plan.metadata._server.updated_at)) {
      stale.add(plan.identifier);
    }
  });
  return stale;
}

async function buildIssueUpdateInput(
  plan: IssuePlan,
  teamMetadata: Awaited<ReturnType<typeof getTeamMetadata>>,
): Promise<IssueUpdateInput> {
  const input: IssueUpdateInput = {};
  for (const change of plan.changes) {
    switch (change.field) {
      case "title":
        input.title = plan.metadata.title;
        break;
      case "description":
        input.description = plan.description;
        break;
      case "state":
        input.stateId = resolveStateId(teamMetadata, plan.metadata.state);
        break;
      case "priority":
        input.priority = plan.metadata.priority;
        break;
      case "labels":
        input.labelIds = resolveLabelIds(teamMetadata, plan.metadata.labels);
        break;
      case "assignee":
        input.assigneeId = plan.metadata.assignee
          ? await resolveAssigneeId(teamMetadata, plan.metadata.assignee)
          : null;
        break;
    }
  }
  return input;
}

function buildProjectUpdateInput(plan: ProjectPlan): ProjectUpdateInput {
  const input: ProjectUpdateInput = {};
  for (const change of plan.changes) {
    switch (change.field) {
      case "name":
        input.name = plan.metadata.name;
        break;
      case "description":
        input.description = plan.metadata.description;
        break;
      case "state":
        input.state = plan.metadata.state;
        break;
      case "content":
        input.content = plan.content;
        break;
    }
  }
  return input;
}

function printDryRunIssue(
  identifier: string,
  changes: IssueChange[],
  input: IssueUpdateInput,
): void {
  process.stdout.write(`${chalk.cyan("dry-run")} ${identifier}\n`);
  for (const change of changes) {
    process.stdout.write(
      `  ${chalk.bold(change.field)}: ${formatValue(change.from)} → ${formatValue(change.to)}\n`,
    );
  }
  process.stdout.write(`  ${chalk.gray("mutation input:")} ${JSON.stringify(input)}\n`);
}

function printDryRunProject(
  name: string,
  changes: ProjectChange[],
  input: ProjectUpdateInput,
): void {
  process.stdout.write(`${chalk.cyan("dry-run")} project/${name}\n`);
  for (const change of changes) {
    process.stdout.write(
      `  ${chalk.bold(change.field)}: ${formatValue(change.from)} → ${formatValue(change.to)}\n`,
    );
  }
  process.stdout.write(`  ${chalk.gray("mutation input:")} ${JSON.stringify(input)}\n`);
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function printLintWarnings(
  label: string,
  warnings: { rule: string; severity: string; message: string; line: number }[],
  strict: boolean,
): void {
  const verb = strict ? chalk.red("blocking") : chalk.yellow("lint");
  process.stderr.write(`${verb} ${chalk.bold(label)}\n`);
  for (const w of warnings) {
    process.stderr.write(`  ${chalk.dim(`L${w.line}:`)} ${chalk.cyan(w.rule)} ${w.message}\n`);
  }
}

function printSummary(results: PushResult[], dryRun: boolean): void {
  for (const r of results) {
    const label = `${r.kind === "issue" ? r.target : `project/${r.target}`}`;
    if (r.status === "pushed") {
      process.stdout.write(
        `${chalk.green("✓")} ${label}  ${chalk.gray(r.fields?.join(", ") ?? "")}\n`,
      );
    } else if (r.status === "dry-run") {
      // already printed per-entity above
    } else if (r.status === "stale") {
      process.stdout.write(`${chalk.yellow("!")} ${label}  stale: ${r.error}\n`);
    } else if (r.status === "lint-blocked") {
      process.stdout.write(`${chalk.red("✗")} ${label}  ${r.error}\n`);
    } else if (r.status === "error") {
      process.stdout.write(`${chalk.red("✗")} ${label}  ${r.error}\n`);
    }
  }
  if (dryRun) {
    const count = results.filter((r) => r.status === "dry-run").length;
    process.stdout.write(
      chalk.gray(`\n${count} mutation(s) planned — rerun without --dry-run to apply\n`),
    );
  }
}
