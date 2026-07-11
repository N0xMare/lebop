import chalk from "chalk";
import type { Command } from "commander";
import { envelope } from "../lib/envelope.ts";
import { resolveContent } from "../lib/io.ts";
import {
  buildDocumentCreateInputFromCli,
  buildDocumentDeleteInputFromCli,
  buildDocumentGetInput,
  buildDocumentListInputFromCli,
  buildDocumentUpdateInputFromCli,
  documentDeleteSuccessForCli,
  documentListPayload,
  executeDocumentCreate,
  executeDocumentDelete,
  executeDocumentGet,
  executeDocumentList,
  executeDocumentUpdate,
} from "../surface/documents.ts";

export function registerDocument(program: Command): void {
  const cmd = program.command("document").description("manage Linear documents");

  cmd
    .command("list")
    .description("list documents; --project filters to one project")
    .option("--project <name-or-id>", "project name or UUID")
    .option("--limit <n>", "default 50; pass 0 for no limit", "50")
    .option("--json", "emit structured records")
    .action(async (opts: { project?: string; limit?: string; json?: boolean }) => {
      const result = await executeDocumentList(buildDocumentListInputFromCli({ opts }));

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope(documentListPayload(result)), null, 2)}\n`);
        return;
      }
      if (result.documents.length === 0) {
        process.stdout.write("no documents\n");
        return;
      }
      const titleWidth = Math.max(...result.documents.map((d) => d.title.length));
      for (const d of result.documents) {
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
      const doc = await executeDocumentGet(buildDocumentGetInput(id));

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
        const content = await resolveContent(opts);
        const created = await executeDocumentCreate(
          buildDocumentCreateInputFromCli({ title, opts, content }),
        );

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
        const provided = [opts.content, opts.contentFile, opts.stdin].filter(Boolean).length;
        const content = provided > 0 ? await resolveContent(opts) : undefined;
        const updated = await executeDocumentUpdate(
          buildDocumentUpdateInputFromCli({ id, opts, content }),
        );
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
      // Round-8 / N2: discriminated union — narrow via `r.status`.
      const r = await executeDocumentDelete(buildDocumentDeleteInputFromCli({ id, opts }));
      const success = documentDeleteSuccessForCli(r);
      if (r.status === "deleted" && !success) process.exitCode = 1;
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope({ id: r.id, status: r.status, success }), null, 2)}\n`,
        );
        return;
      }
      if (r.status === "already-absent") {
        process.stdout.write(`${chalk.gray("✓")} already absent: ${chalk.bold(id)} (no-op)\n`);
      } else if (success) {
        process.stdout.write(`${chalk.green("✓")} deleted ${chalk.bold(id)}\n`);
      }
    });
}
