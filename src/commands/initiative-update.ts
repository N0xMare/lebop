import chalk from "chalk";
import type { Command } from "commander";
import { wantsMachineOutput } from "../lib/encode.ts";
import { resolveBody } from "../lib/io.ts";
import { writeMachineEnvelope } from "../lib/output.ts";
import {
  buildInitiativeUpdateCreateInputFromCli,
  buildInitiativeUpdateDeleteInputFromCli,
  buildInitiativeUpdateListInputFromCli,
  buildInitiativeUpdateUpdateInputFromCli,
  executeInitiativeUpdateCreate,
  executeInitiativeUpdateDelete,
  executeInitiativeUpdateList,
  executeInitiativeUpdateUpdate,
  initiativeUpdateListPayload,
} from "../surface/initiative-updates.ts";

export function registerInitiativeUpdate(program: Command): void {
  const cmd = program
    .command("initiative-update")
    .description("manage initiative status updates (with health)");

  cmd
    .command("create <initiative>")
    .description("post a status update on an initiative; <initiative> is name or UUID")
    .option("--body <text>")
    .option("--body-file <path>")
    .option("--stdin", "read body from stdin")
    .option("--health <state>", "onTrack | atRisk | offTrack")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (
        initiative: string,
        opts: {
          body?: string;
          bodyFile?: string;
          stdin?: boolean;
          health?: string;
          json?: boolean;
          format?: string;
          pretty?: boolean;
        },
      ) => {
        const body = await resolveBody(opts);
        const result = await executeInitiativeUpdateCreate(
          buildInitiativeUpdateCreateInputFromCli({
            initiative,
            body,
            health: opts.health,
          }),
        );

        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope(
            { initiative_update: result.initiative_update } as Record<string, unknown>,
            { json: true, format: opts.format, pretty: opts.pretty },
          );
          return;
        }
        const health = result.initiative_update.health;
        process.stdout.write(
          `${chalk.green("✓")} posted update on initiative ${chalk.gray(result.initiative_id)}${health ? `  ${chalk.cyan(health)}` : ""}\n`,
        );
      },
    );

  cmd
    .command("list <initiative>")
    .description("list status updates on an initiative")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (initiative: string, opts: { json?: boolean; format?: string; pretty?: boolean }) => {
        const result = await executeInitiativeUpdateList(
          buildInitiativeUpdateListInputFromCli({ initiative }),
        );
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope(
            {
              ...initiativeUpdateListPayload(result),
              next: ["initiative-update create <initiative>", "initiative view <id>"],
            } as Record<string, unknown>,
            {
              json: true,
              format: opts.format,
              pretty: opts.pretty,
            },
          );
          return;
        }
        if (result.updates.length === 0) {
          process.stdout.write("no updates\n");
          return;
        }
        for (const u of result.updates) {
          const health = u.health ? `  ${chalk.cyan(u.health)}` : "";
          const who = u.user ? `${u.user.name} <${u.user.email}>` : "unknown";
          process.stdout.write(
            `\n${chalk.dim(u.created_at)}  ${chalk.bold(who)}${health}  ${chalk.gray(u.id)}\n${u.body}\n`,
          );
        }
      },
    );

  cmd
    .command("update <id>")
    .description("edit an initiative status update by UUID")
    .option("--body <text>")
    .option("--body-file <path>")
    .option("--stdin", "read body from stdin")
    .option("--health <state>", "onTrack | atRisk | offTrack")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty-printed JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action(
      async (
        id: string,
        opts: {
          body?: string;
          bodyFile?: string;
          stdin?: boolean;
          health?: string;
          json?: boolean;
          format?: string;
          pretty?: boolean;
        },
      ) => {
        const body =
          opts.body !== undefined || opts.bodyFile || opts.stdin
            ? await resolveBody(opts)
            : undefined;
        const initiative_update = await executeInitiativeUpdateUpdate(
          buildInitiativeUpdateUpdateInputFromCli({
            id,
            body,
            health: opts.health,
          }),
        );
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope({ initiative_update } as Record<string, unknown>, {
            json: true,
            format: opts.format,
            pretty: opts.pretty,
          });
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} updated initiative update ${chalk.gray(initiative_update.id)}\n`,
        );
      },
    );

  cmd
    .command("soft-delete <id>")
    .description("archive (soft-delete) an initiative status update by UUID")
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
        const result = await executeInitiativeUpdateDelete(
          buildInitiativeUpdateDeleteInputFromCli({ id, opts }),
        );
        if (wantsMachineOutput(opts)) {
          writeMachineEnvelope(result as Record<string, unknown>, {
            json: true,
            format: opts.format,
            pretty: opts.pretty,
          });
          return;
        }
        if (result.status === "already-absent") {
          process.stdout.write(
            `${chalk.gray("·")} initiative update ${chalk.gray(result.id)} already absent\n`,
          );
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} deleted initiative update ${chalk.gray(result.id)}\n`,
        );
      },
    );
}
