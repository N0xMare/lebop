import chalk from "chalk";
import type { Command } from "commander";
import { wantsMachineOutput } from "../lib/encode.ts";
import { resolveContent } from "../lib/io.ts";
import { writeMachineEnvelope } from "../lib/output.ts";
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
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (opts: {
        project?: string;
        limit?: string;
        json?: boolean;
        format?: string;
        pretty?: boolean;
      }) => {
        const result = await executeDocumentList(buildDocumentListInputFromCli({ opts }));

        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope(
            {
              ...documentListPayload(result),
              next: ["document view <id>", "document create"],
            } as Record<string, unknown>,
            {
              json: true,
              format: opts.format,
              pretty: opts.pretty,
            },
          );
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
      },
    );

  cmd
    .command("view <id>")
    .description("show one document by UUID (with content; 64 KiB agent size cap by default)")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .option("--full-content", "full document content on the wire (bypass 64 KiB cap)")
    .option(
      "--content-file <path>",
      "write full content to path (host FS); wire stays dense — prefer for large bodies",
    )
    .action(
      async (
        id: string,
        opts: {
          json?: boolean;
          format?: string;
          pretty?: boolean;
          fullContent?: boolean;
          contentFile?: string;
        },
      ) => {
        const fullForHuman = !wantsMachineOutput(opts);
        const { document: doc, content, truncated } = await executeDocumentGet(
          buildDocumentGetInput(id, {
            fullContent: opts.fullContent === true || fullForHuman,
            contentFile: opts.contentFile,
          }),
        );

        if (wantsMachineOutput(opts)) {
          const next = truncated
            ? [
                `document view ${id} --content-file ./content.md`,
                `document view ${id} --full-content`,
              ]
            : ["document update <id>", "document list"];
          writeMachineEnvelope(
            {
              document: doc,
              content,
              next,
            } as Record<string, unknown>,
            {
              json: true,
              format: opts.format,
              pretty: opts.pretty,
            },
          );
          return;
        }
        process.stdout.write(`${chalk.bold(String(doc.title))}\n`);
        if (doc.project) process.stdout.write(`  project: ${doc.project.name}\n`);
        if (doc.creator) {
          process.stdout.write(`  creator: ${doc.creator.name} <${doc.creator.email}>\n`);
        }
        process.stdout.write(`  url: ${chalk.gray(doc.url)}\n`);
        if (content.content_file) {
          process.stdout.write(`  content_file: ${content.content_file}\n`);
        }
        if (doc.content) process.stdout.write(`\n${doc.content}\n`);
      },
    );

  cmd
    .command("create <title>")
    .description("create a document in a project or attached to an issue")
    // Round-6 / H17: parity with `lebop new` — `--project-id <uuid>` is the
    // UUID-only sibling of `--project <name-or-id>`.
    // 0.0.6: also accept --issue for issue-scoped documents.
    .option("--project <name-or-id>", "project name or UUID")
    .option("--project-id <uuid>", "project UUID (alternative to --project)")
    .option("--issue <id>", "issue identifier or UUID (issue-scoped document)")
    .option("--content <text>")
    .option("--content-file <path>")
    .option("--stdin", "read content from stdin")
    .option("--icon <name>")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (
        title: string,
        opts: {
          project?: string;
          projectId?: string;
          issue?: string;
          content?: string;
          contentFile?: string;
          stdin?: boolean;
          icon?: string;
          json?: boolean;
          format?: string;
          pretty?: boolean;
        },
      ) => {
        const content = await resolveContent(opts);
        const created = await executeDocumentCreate(
          buildDocumentCreateInputFromCli({ title, opts, content }),
        );

        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope({ document: created } as Record<string, unknown>, {
            json: true,
            format: opts.format,
            pretty: opts.pretty,
          });
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
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
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
          format?: string;
          pretty?: boolean;
        },
      ) => {
        const provided = [opts.content, opts.contentFile, opts.stdin].filter(Boolean).length;
        const content = provided > 0 ? await resolveContent(opts) : undefined;
        const updated = await executeDocumentUpdate(
          buildDocumentUpdateInputFromCli({ id, opts, content }),
        );
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope({ document: updated } as Record<string, unknown>, {
            json: true,
            format: opts.format,
            pretty: opts.pretty,
          });
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} updated ${chalk.bold(updated.title)} ${chalk.gray(`(${updated.id})`)}\n`,
        );
      },
    );

  cmd
    .command("soft-delete <id>")
    .description(
      "soft-delete a document (sets archived_at; not restored by lebop unarchive — requires --yes)",
    )
    .option("--yes", "confirm destructive operation (required)")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (
        id: string,
        opts: { yes?: boolean; json?: boolean; format?: string; pretty?: boolean },
      ) => {
        // Round-8 / N2: discriminated union — narrow via `r.status`.
        const r = await executeDocumentDelete(buildDocumentDeleteInputFromCli({ id, opts }));
        const success = documentDeleteSuccessForCli(r);
        if (r.status === "deleted" && !success) process.exitCode = 1;
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope({ id: r.id, status: r.status, success } as Record<string, unknown>, {
            json: true,
            format: opts.format,
            pretty: opts.pretty,
          });
          return;
        }
        if (r.status === "already-absent") {
          process.stdout.write(`${chalk.gray("✓")} already absent: ${chalk.bold(id)} (no-op)\n`);
        } else if (success) {
          process.stdout.write(`${chalk.green("✓")} deleted ${chalk.bold(id)}\n`);
        }
      },
    );
}
