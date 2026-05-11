import chalk from "chalk";
import type { Command } from "commander";
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
} from "../lib/documents.ts";
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
        if (!resolved) throw new Error(`project not found: ${opts.project}`);
        projectId = resolved;
      }
      const requested = Number.parseInt(opts.limit ?? "50", 10);
      const max = requested === 0 ? Number.POSITIVE_INFINITY : Math.max(1, requested);
      const documents = await listDocuments({ projectId, max });

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify({ schema_version: 1, count: documents.length, documents }, null, 2)}\n`,
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
      if (!doc) throw new Error(`document not found: ${id}`);

      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ schema_version: 1, document: doc }, null, 2)}\n`);
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
    .requiredOption("--project <name-or-id>", "project name or UUID (required)")
    .option("--content <text>")
    .option("--content-file <path>")
    .option("--stdin", "read content from stdin")
    .option("--icon <name>")
    .option("--json", "emit structured result")
    .action(
      async (
        title: string,
        opts: {
          project: string;
          content?: string;
          contentFile?: string;
          stdin?: boolean;
          icon?: string;
          json?: boolean;
        },
      ) => {
        const projectId = await resolveProjectId(opts.project);
        if (!projectId) throw new Error(`project not found: ${opts.project}`);
        const content = await resolveContent(opts);
        const created = await createDocument({
          title,
          projectId,
          content,
          icon: opts.icon,
        });

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify({ schema_version: 1, document: created }, null, 2)}\n`,
          );
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
          process.stdout.write(
            `${JSON.stringify({ schema_version: 1, document: updated }, null, 2)}\n`,
          );
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} updated ${chalk.bold(updated.title)} ${chalk.gray(`(${updated.id})`)}\n`,
        );
      },
    );

  cmd
    .command("delete <id>")
    .description("delete a document permanently")
    .option("--json", "emit structured result")
    .action(async (id: string, opts: { json?: boolean }) => {
      const success = await deleteDocument(id);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ schema_version: 1, id, success }, null, 2)}\n`);
        return;
      }
      if (success) process.stdout.write(`${chalk.green("✓")} deleted ${chalk.bold(id)}\n`);
      else process.exitCode = 1;
    });
}
