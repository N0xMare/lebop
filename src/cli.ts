import chalk from "chalk";
import { Command } from "commander";
import { registerAgentSession } from "./commands/agent-session.ts";
import { registerArchive } from "./commands/archive.ts";
import { registerAttachment } from "./commands/attachment.ts";
import { registerAuth } from "./commands/auth.ts";
import { registerBulk } from "./commands/bulk.ts";
import { registerCache } from "./commands/cache.ts";
import { registerComment } from "./commands/comment.ts";
import { registerCompletions } from "./commands/completions.ts";
import { registerCycle } from "./commands/cycle.ts";
import { registerDiff } from "./commands/diff.ts";
import { registerDocument } from "./commands/document.ts";
import { registerInitiative } from "./commands/initiative.ts";
import { registerInitiativeUpdate } from "./commands/initiative-update.ts";
import { registerLabel } from "./commands/label.ts";
import { registerLink } from "./commands/link.ts";
import { registerLint } from "./commands/lint.ts";
import { registerList } from "./commands/list.ts";
import { registerLookup } from "./commands/lookup.ts";
import { registerMcp } from "./commands/mcp.ts";
import { registerMilestone } from "./commands/milestone.ts";
import { registerMine } from "./commands/mine.ts";
import { registerNew } from "./commands/new.ts";
import { registerPlan } from "./commands/plan.ts";
import { registerProject } from "./commands/project.ts";
import { registerProjectUpdate } from "./commands/project-update.ts";
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
import { SCHEMA_VERSION } from "./lib/envelope.ts";
import { LebopError } from "./lib/errors.ts";

// Round-7 / Q4: captured by the preAction hook so the top-level catch can
// emit a structured `{ok:false, schema_version, error: {code, message, hint}}`
// envelope to stdout when `--json` is set (vs. the human-prose stderr path).
// Module-level flag because per-command `--json` doesn't propagate to the
// top-level catch otherwise. Reset on each `run()` call so test harnesses
// that re-invoke the CLI in the same process don't leak state.
let _wantsJsonError = false;

export async function run(rawArgv: string[]): Promise<void> {
  _wantsJsonError = false;
  // Round-6 / H18: enforce NO_COLOR precedence per no-color.org spec.
  // chalk honors FORCE_COLOR over NO_COLOR by default — pin the priority
  // back to "NO_COLOR wins" by hard-disabling chalk when NO_COLOR is set,
  // regardless of FORCE_COLOR's value. Tests that set NO_COLOR=1 expect
  // ANSI-free output even when their CI also exports FORCE_COLOR.
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    chalk.level = 0;
  }

  const argv = preprocessSetArgv(rawArgv);
  const program = new Command();

  program
    .name("lebop")
    .description("agentic Linear CLI — pull/edit/push loop for coding agents")
    .version("0.0.2")
    .option(
      "--workspace <slug>",
      "select Linear workspace (overrides default + LEBOP_WORKSPACE env)",
    )
    .option(
      "--team <key>",
      "select Linear team (overrides config default + LEBOP_TEAM env). Per-command --team still wins.",
    )
    .hook("preAction", (thisCommand, actionCommand) => {
      // `thisCommand` is the root program (the hook was registered on it).
      // `actionCommand` is the leaf subcommand being invoked — that's the
      // one whose opts we want for `--json`, `--workspace`, `--team`.
      //
      // Propagate --workspace and --team into env vars so every subcommand
      // picks them up without per-command plumbing. Per-command flags still
      // take precedence — they're checked first inside resolveConfig and
      // loadAuthForWorkspace.
      const rootOpts = thisCommand.opts();
      const leafOpts = actionCommand.opts() as {
        workspace?: string;
        team?: string;
        json?: boolean;
      };
      const ws = (leafOpts.workspace ?? (rootOpts.workspace as string | undefined)) as
        | string
        | undefined;
      if (ws) process.env.LEBOP_WORKSPACE = ws;
      const team = (leafOpts.team ?? (rootOpts.team as string | undefined)) as string | undefined;
      if (team) process.env.LEBOP_TEAM = team;
      // Round-7 / Q4: capture per-command `--json` from the LEAF subcommand
      // so the top-level catch formats LebopError as a structured envelope
      // instead of chalk prose when the failing command was running in
      // JSON mode. `--json` lives on individual subcommands, not the root.
      if (leafOpts.json !== undefined) _wantsJsonError = Boolean(leafOpts.json);
    })
    .showHelpAfterError()
    // Round-8 / R8-LOW-7: Commander exits 1 on unknown options by default
    // (it throws a CommanderError, our top-level catch sets exitCode=1).
    // Standard convention is 2 for usage errors, 1 for runtime. Hook
    // `exitOverride` to differentiate: commander's CommanderError has a
    // `.code` that lets us pick the right exit code. We then rethrow so
    // the existing catch path still handles output formatting.
    .exitOverride((err) => {
      // Round-8 / R8-LOW-7: differentiate usage errors (exit 2) from
      // runtime errors (exit 1) per Unix tradition. Commander's default
      // is to exit 1 for everything; we re-classify the usage-error family
      // here. Help / version paths keep their natural exit 0.
      if (
        err.code === "commander.help" ||
        err.code === "commander.helpDisplayed" ||
        err.code === "commander.version"
      ) {
        // Successful informational exit — let it pass through cleanly.
        process.exit(0);
      }
      const isUsageError =
        err.code === "commander.unknownOption" ||
        err.code === "commander.unknownCommand" ||
        err.code === "commander.missingArgument" ||
        err.code === "commander.missingMandatoryOptionValue" ||
        err.code === "commander.optionMissingArgument" ||
        err.code === "commander.invalidArgument";
      if (isUsageError) {
        process.stderr.write(`${err.message}\n`);
        process.exit(2);
      }
      // Any other CommanderError shape: re-throw so the top-level catch
      // formats it like other errors.
      throw err;
    });

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

  registerCache(program);

  registerAttachment(program);
  registerBulk(program);
  registerLookup(program);

  registerSchema(program);
  registerRaw(program);
  registerMcp(program);
  registerCompletions(program);

  try {
    await program.parseAsync(argv);
  } catch (err) {
    // Round-7 / Q4: if the failing command was running in `--json` mode,
    // emit the structured envelope on stdout so the caller's `jq` pipe
    // (or equivalent JSON parser) gets a parseable payload instead of
    // chalk-formatted human prose. Errors thrown BEFORE the preAction
    // hook ran (e.g., top-level --workspace resolution failures) keep
    // the human path since `_wantsJsonError` stays false.
    if (_wantsJsonError) {
      const payload =
        err instanceof LebopError
          ? {
              ok: false,
              schema_version: SCHEMA_VERSION,
              error: { code: err.code, message: err.message, hint: err.hint },
            }
          : {
              ok: false,
              schema_version: SCHEMA_VERSION,
              error: { code: "unknown", message: (err as Error).message ?? String(err) },
            };
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      process.exit(1);
    }
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
