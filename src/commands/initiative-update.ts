import chalk from "chalk";
import type { Command } from "commander";
import {
  createInitiativeUpdate,
  type InitiativeHealth,
  listInitiativeUpdates,
  resolveInitiativeId,
} from "../lib/initiatives.ts";
import { resolveBody } from "../lib/io.ts";

const HEALTH_VALUES = ["onTrack", "atRisk", "offTrack"] as const;

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
    .option("--json", "emit structured result")
    .action(
      async (
        initiative: string,
        opts: {
          body?: string;
          bodyFile?: string;
          stdin?: boolean;
          health?: string;
          json?: boolean;
        },
      ) => {
        const initiativeId = await resolveInitiativeId(initiative);
        if (!initiativeId) throw new Error(`initiative not found: ${initiative}`);

        const body = await resolveBody(opts);
        if (!body.trim()) throw new Error("empty update body");

        let health: InitiativeHealth | undefined;
        if (opts.health) {
          if (!(HEALTH_VALUES as readonly string[]).includes(opts.health)) {
            throw new Error(
              `invalid --health "${opts.health}". expected: ${HEALTH_VALUES.join(", ")}`,
            );
          }
          health = opts.health as InitiativeHealth;
        }

        const created = await createInitiativeUpdate({ initiativeId, body, health });

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify({ schema_version: 1, initiative_update: created }, null, 2)}\n`,
          );
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} posted update on initiative ${chalk.gray(initiativeId)}${health ? `  ${chalk.cyan(health)}` : ""}\n`,
        );
      },
    );

  cmd
    .command("list <initiative>")
    .description("list status updates on an initiative")
    .option("--json", "emit structured records")
    .action(async (initiative: string, opts: { json?: boolean }) => {
      const initiativeId = await resolveInitiativeId(initiative);
      if (!initiativeId) throw new Error(`initiative not found: ${initiative}`);
      const updates = await listInitiativeUpdates(initiativeId);
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            { schema_version: 1, initiative_id: initiativeId, count: updates.length, updates },
            null,
            2,
          )}\n`,
        );
        return;
      }
      if (updates.length === 0) {
        process.stdout.write("no updates\n");
        return;
      }
      for (const u of updates) {
        const health = u.health ? `  ${chalk.cyan(u.health)}` : "";
        const who = u.user ? `${u.user.name} <${u.user.email}>` : "unknown";
        process.stdout.write(
          `\n${chalk.dim(u.created_at)}  ${chalk.bold(who)}${health}  ${chalk.gray(u.id)}\n${u.body}\n`,
        );
      }
    });
}
