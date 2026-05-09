import chalk from "chalk";
import { Command } from "commander";
import { registerArchive } from "./commands/archive.ts";
import { registerAuth } from "./commands/auth.ts";
import { registerComment } from "./commands/comment.ts";
import { registerDiff } from "./commands/diff.ts";
import { registerLint } from "./commands/lint.ts";
import { registerList } from "./commands/list.ts";
import { registerMcp } from "./commands/mcp.ts";
import { registerMine } from "./commands/mine.ts";
import { registerNew } from "./commands/new.ts";
import { registerPlan } from "./commands/plan.ts";
import { registerProjects } from "./commands/projects.ts";
import { registerPull } from "./commands/pull.ts";
import { registerPush } from "./commands/push.ts";
import { registerRaw } from "./commands/raw.ts";
import { registerRelation } from "./commands/relation.ts";
import { registerSet } from "./commands/set.ts";
import { registerShow } from "./commands/show.ts";
import { registerStatus } from "./commands/status.ts";
import { registerTeams } from "./commands/teams.ts";
import { registerUnarchive } from "./commands/unarchive.ts";
import { preprocessSetArgv } from "./lib/argvPrep.ts";
import { LebopError } from "./lib/errors.ts";

export async function run(rawArgv: string[]): Promise<void> {
  const argv = preprocessSetArgv(rawArgv);
  const program = new Command();

  program
    .name("lebop")
    .description("agentic Linear CLI — pull/edit/push loop for coding agents")
    .version("0.1.0")
    .option(
      "--workspace <slug>",
      "select Linear workspace (overrides default + LEBOP_WORKSPACE env)",
    )
    .hook("preAction", (thisCommand) => {
      // Propagate --workspace into LEBOP_WORKSPACE so every subcommand picks
      // it up via loadAuthForWorkspace's env-var path. One global flag,
      // zero per-command plumbing.
      const ws = thisCommand.opts().workspace as string | undefined;
      if (ws) process.env.LEBOP_WORKSPACE = ws;
    })
    .showHelpAfterError();

  registerAuth(program);

  registerList(program);
  registerMine(program);
  registerProjects(program);
  registerTeams(program);

  registerShow(program);
  registerPull(program);
  registerPush(program);
  registerStatus(program);
  registerDiff(program);
  registerLint(program);

  registerComment(program);
  registerSet(program);
  registerRelation(program);

  registerNew(program);
  registerArchive(program);
  registerUnarchive(program);
  registerPlan(program);

  registerRaw(program);
  registerMcp(program);

  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof LebopError) {
      process.stderr.write(`${chalk.red(`error[${err.code}]:`)} ${err.message}\n`);
      if (err.hint) process.stderr.write(`  ${chalk.cyan("hint:")} ${err.hint}\n`);
    } else {
      const msg = (err as Error).message ?? String(err);
      process.stderr.write(`${chalk.red("error:")} ${msg}\n`);
    }
    process.exit(1);
  }
}
