import chalk from "chalk";
import { Command } from "commander";
import { registerArchive } from "./commands/archive.ts";
import { registerAuth } from "./commands/auth.ts";
import { registerComment } from "./commands/comment.ts";
import { registerDiff } from "./commands/diff.ts";
import { registerLint } from "./commands/lint.ts";
import { registerList } from "./commands/list.ts";
import { registerNew } from "./commands/new.ts";
import { registerPlan } from "./commands/plan.ts";
import { registerProjects } from "./commands/projects.ts";
import { registerPull } from "./commands/pull.ts";
import { registerPush } from "./commands/push.ts";
import { registerRaw } from "./commands/raw.ts";
import { registerSet } from "./commands/set.ts";
import { registerShow } from "./commands/show.ts";
import { registerStatus } from "./commands/status.ts";
import { registerTeams } from "./commands/teams.ts";
import { preprocessSetArgv } from "./lib/argvPrep.ts";

export async function run(rawArgv: string[]): Promise<void> {
  const argv = preprocessSetArgv(rawArgv);
  const program = new Command();

  program
    .name("lebop")
    .description("agentic Linear CLI — pull/edit/push loop for coding agents")
    .version("0.1.0")
    .showHelpAfterError();

  registerAuth(program);

  registerList(program);
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

  registerNew(program);
  registerArchive(program);
  registerPlan(program);

  registerRaw(program);

  try {
    await program.parseAsync(argv);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    process.stderr.write(`${chalk.red("error:")} ${msg}\n`);
    process.exit(1);
  }
}
