import chalk from "chalk";
import { Command } from "commander";
import { registerAgentSession } from "./commands/agent-session.ts";
import { registerArchive } from "./commands/archive.ts";
import { registerAuth } from "./commands/auth.ts";
import { registerComment } from "./commands/comment.ts";
import { registerCompletions } from "./commands/completions.ts";
import { registerCycle } from "./commands/cycle.ts";
import { registerDiff } from "./commands/diff.ts";
import { registerDocument } from "./commands/document.ts";
import { registerInitiativeUpdate } from "./commands/initiative-update.ts";
import { registerInitiative } from "./commands/initiative.ts";
import { registerLabel } from "./commands/label.ts";
import { registerLink } from "./commands/link.ts";
import { registerLint } from "./commands/lint.ts";
import { registerList } from "./commands/list.ts";
import { registerMcp } from "./commands/mcp.ts";
import { registerMilestone } from "./commands/milestone.ts";
import { registerMine } from "./commands/mine.ts";
import { registerNew } from "./commands/new.ts";
import { registerPlan } from "./commands/plan.ts";
import { registerProjectUpdate } from "./commands/project-update.ts";
import { registerProject } from "./commands/project.ts";
import { registerProjects } from "./commands/projects.ts";
import { registerPull } from "./commands/pull.ts";
import { registerPush } from "./commands/push.ts";
import { registerRaw } from "./commands/raw.ts";
import { registerRelation } from "./commands/relation.ts";
import { registerSchema } from "./commands/schema.ts";
import { registerSet } from "./commands/set.ts";
import { registerShow } from "./commands/show.ts";
import { registerStatus } from "./commands/status.ts";
import { registerTeam } from "./commands/team.ts";
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
    .option(
      "--team <key>",
      "select Linear team (overrides config default + LEBOP_TEAM env). Per-command --team still wins.",
    )
    .hook("preAction", (thisCommand) => {
      // Propagate --workspace and --team into env vars so every subcommand
      // picks them up without per-command plumbing. Per-command flags still
      // take precedence — they're checked first inside resolveConfig and
      // loadAuthForWorkspace.
      const ws = thisCommand.opts().workspace as string | undefined;
      if (ws) process.env.LEBOP_WORKSPACE = ws;
      const team = thisCommand.opts().team as string | undefined;
      if (team) process.env.LEBOP_TEAM = team;
    })
    .showHelpAfterError();

  registerAuth(program);

  registerList(program);
  registerMine(program);
  registerProjects(program);
  registerProject(program);
  registerProjectUpdate(program);
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
  registerLabel(program);
  registerMilestone(program);
  registerInitiative(program);
  registerInitiativeUpdate(program);
  registerCycle(program);
  registerDocument(program);
  registerAgentSession(program);
  registerTeam(program);
  registerLink(program);

  registerNew(program);
  registerArchive(program);
  registerUnarchive(program);
  registerPlan(program);

  registerSchema(program);
  registerRaw(program);
  registerMcp(program);
  registerCompletions(program);

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
