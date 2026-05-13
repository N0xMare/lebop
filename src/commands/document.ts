import chalk from "chalk";
import type { Command } from "commander";
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
} from "../lib/documents.ts";
import { envelope } from "../lib/envelope.ts";
import { NotFoundError, tryIdempotentDelete } from "../lib/errors.ts";
import { resolveContent } from "../lib/io.ts";
import { resolveProjectId } from "../lib/milestones.ts";

export function registerDocument(program: Command): void {
  const cmd = program.command("document").description("manage Linear documents");

  cmd
    .command("list")
    .description("list documents; --project filters to one project")
    .option("--project <name-or-id>", "project name or UUID")
    .option("--limit <n>", "default 50; pass 0 for no limit", "50")
    .option("--json", "emit structured records")
    .action(async (opts: { project?: string; limit?: string; json?: boolean }) => {
      let projectId: string | undefined;
      if (opts.project) {
        const resolved = await resolveProjectId(opts.project);
        if (!resolved) throw new NotFoundError(`project not found: ${opts.project}`);
        projectId = resolved;
      }
      const requested = Number.parseInt(opts.limit ?? "50", 10);
      const max = requested === 0 ? Number.POSITIVE_INFINITY : Math.max(1, requested);
      const documents = await listDocuments({ projectId, max });

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope({ count: documents.length, documents }), null, 2)}\n`,
        );
        return;
      }
      if (documents.length === 0) {
        process.stdout.write("no documents\n");
        return;
      }
      const titleWidth = Math.max(...documents.map((d) => d.title.length));
      for (const d of documents) {
        const project = d.project ? chalk.cyan(d.project.name) : chalk.gray("(no project)");
        const arch = d.archived_at ? chalk.gray(" [archived]") : "";
        process.stdout.write(`${chalk.bold(d.title.padEnd(titleWidth))}  ${project}${arch}\n`);
      }
    });

  cmd
    .command("view <id>")
    .description("show one document by UUID (with content)")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { json?: boolean }) => {
      const doc = await getDocument(id);
      if (!doc) throw new NotFoundError(`document not found: ${id}`);

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ document: doc }), null, 2)}\n`);
        return;
      }
      process.stdout.write(`${chalk.bold(doc.title)}\n`);
      if (doc.project) process.stdout.write(`  project: ${doc.project.name}\n`);
      if (doc.creator) {
        process.stdout.write(`  creator: ${doc.creator.name} <${doc.creator.email}>\n`);
      }
      process.stdout.write(`  url: ${chalk.gray(doc.url)}\n`);
      if (doc.content) process.stdout.write(`\n${doc.content}\n`);
    });

  cmd
    .command("create <title>")
    .description("create a document in a project")
    // Round-6 / H17: parity with `lebop new` — `--project-id <uuid>` is the
    // UUID-only sibling of `--project <name-or-id>`. Exactly one is required.
    .option("--project <name-or-id>", "project name or UUID")
    .option("--project-id <uuid>", "project UUID (alternative to --project)")
    .option("--content <text>")
    .option("--content-file <path>")
    .option("--stdin", "read content from stdin")
    .option("--icon <name>")
    .option("--json", "emit structured result")
    .action(
      async (
        title: string,
        opts: {
          project?: string;
          projectId?: string;
          content?: string;
          contentFile?: string;
          stdin?: boolean;
          icon?: string;
          json?: boolean;
        },
      ) => {
        // Round-7 / MED-5: mutual-exclusion (round-6 H17 silently let
        // --project-id win when both passed).
        if (opts.project && opts.projectId) {
          throw new Error("pass exactly one of --project / --project-id, not both");
        }
        if (!opts.project && !opts.projectId) {
          throw new Error("either --project <name-or-id> or --project-id <uuid> is required");
        }
        const projectId = opts.projectId ?? (await resolveProjectId(opts.project as string));
        if (!projectId) throw new NotFoundError(`project not found: ${opts.project}`);
        const content = await resolveContent(opts);
        const created = await createDocument({
          title,
          projectId,
          content,
          icon: opts.icon,
        });

        if (opts.json) {
          process.stdout.write(`${JSON.stringify(envelope({ document: created }), null, 2)}\n`);
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} created ${chalk.bold(created.title)} ${chalk.gray(`(${created.id})`)}\n${chalk.gray(created.url)}\n`,
        );
      },
    );

  cmd
    .command("update <id>")
    .description("update a document (idempotent)")
    .option("--title <text>")
    .option("--content <text>")
    .option("--content-file <path>")
    .option("--stdin", "read content from stdin")
    .option("--icon <name>")
    .option("--json", "emit structured result")
    .action(
      async (
        id: string,
        opts: {
          title?: string;
          content?: string;
          contentFile?: string;
          stdin?: boolean;
          icon?: string;
          json?: boolean;
        },
      ) => {
        const input: Parameters<typeof updateDocument>[1] = {};
        if (opts.title !== undefined) input.title = opts.title;
        if (opts.icon !== undefined) input.icon = opts.icon;
        const provided = [opts.content, opts.contentFile, opts.stdin].filter(Boolean).length;
        if (provided > 0) input.content = await resolveContent(opts);
        if (Object.keys(input).length === 0) {
          throw new Error("nothing to update — pass at least one field");
        }
        const updated = await updateDocument(id, input);
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(envelope({ document: updated }), null, 2)}\n`);
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} updated ${chalk.bold(updated.title)} ${chalk.gray(`(${updated.id})`)}\n`,
        );
      },
    );

  cmd
    .command("delete <id>")
    .description("delete a document permanently (irreversible — requires --yes)")
    .option("--yes", "confirm destructive operation (required)")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { yes?: boolean; json?: boolean }) => {
      if (!opts.yes) {
        process.stderr.write(
          `${chalk.red("error:")} refusing to delete document ${chalk.bold(id)} without --yes\n` +
            `  ${chalk.cyan("hint:")} re-run with --yes to confirm. This operation is irreversible.\n`,
        );
        process.exitCode = 1;
        return;
      }
      // Round-8 / N2: discriminated union — narrow via `r.status`.
      const r = await tryIdempotentDelete(() => deleteDocument(id));
      const succeeded = r.status === "deleted" && r.result;
      if (r.status === "deleted" && !r.result) process.exitCode = 1;
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope({ id, status: r.status, success: succeeded }), null, 2)}\n`,
        );
        return;
      }
      if (r.status === "already-absent") {
        process.stdout.write(`${chalk.gray("✓")} already absent: ${chalk.bold(id)} (no-op)\n`);
      } else if (r.result) {
        process.stdout.write(`${chalk.green("✓")} deleted ${chalk.bold(id)}\n`);
      }
    });
}
