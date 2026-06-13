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
import { registerPublish } from "./commands/publish.ts";
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
import { registerWorkspace } from "./commands/workspace.ts";
import { preprocessSetArgv } from "./lib/argvPrep.ts";
import { SCHEMA_VERSION } from "./lib/envelope.ts";
import { LebopError } from "./lib/errors.ts";
import { runWithRequestContext, setRequestOverrides } from "./lib/requestContext.ts";
import { LEBOP_VERSION } from "./lib/version.ts";

// Captured by the preAction hook so the top-level catch can emit a structured
// `{ok:false, schema_version, error: {code, message, hint}}` envelope to stdout
// when `--json` is set. Per-command `--json` does not propagate to the
// top-level catch otherwise. Reset on each `run()` call so test harnesses that
// re-invoke the CLI in the same process do not leak state.
let _wantsJsonError = false;
let _restoreParserStderr: (() => void) | null = null;

export async function run(rawArgv: string[]): Promise<void> {
  _wantsJsonError = false;
  restoreParserStderr();
  // Enforce NO_COLOR precedence per no-color.org. Chalk honors FORCE_COLOR
  // over NO_COLOR by default, so hard-disable chalk when NO_COLOR is set even
  // if CI also exports FORCE_COLOR.
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    chalk.level = 0;
  }

  const argv = preprocessSetArgv(rawArgv);
  _wantsJsonError = argvRequestsJson(argv);
  if (_wantsJsonError) _restoreParserStderr = silenceStderr();
  const program = buildCliProgram();

  try {
    await runWithRequestContext({}, () => program.parseAsync(argv));
    restoreParserStderr();
  } catch (err) {
    // If the failing command was running in `--json` mode, emit the structured
    // envelope on stdout so the caller's JSON parser gets a parseable payload
    // instead of chalk-formatted human prose. Errors thrown before the
    // preAction hook ran keep the human path since `_wantsJsonError` is false.
    if (_wantsJsonError) {
      restoreParserStderr();
      const payload =
        err instanceof LebopError
          ? {
              ok: false,
              schema_version: SCHEMA_VERSION,
              error: {
                code: err.code,
                message: err.message,
                hint: err.hint,
                ...(err.details ? { details: err.details } : {}),
              },
            }
          : {
              ok: false,
              schema_version: SCHEMA_VERSION,
              error: { code: "unknown", message: (err as Error).message ?? String(err) },
            };
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      process.exit(1);
    }
    restoreParserStderr();
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

function silenceStderr(): () => void {
  const originalWrite = process.stderr.write;
  process.stderr.write = ((_chunk: unknown, encoding?: unknown, cb?: unknown) => {
    if (typeof encoding === "function") encoding();
    if (typeof cb === "function") cb();
    return true;
  }) as typeof process.stderr.write;
  return () => {
    process.stderr.write = originalWrite;
  };
}

function restoreParserStderr(): void {
  _restoreParserStderr?.();
  _restoreParserStderr = null;
}

export function buildCliProgram(): Command {
  const program = new Command();

  program
    .name("lebop")
    .description("agentic Linear CLI — pull/edit/push loop for coding agents")
    .version(LEBOP_VERSION)
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
      // Propagate --workspace and --team through request-local overrides so
      // in-process run() calls cannot leak root flags into the next command.
      // Per-command flags still take precedence inside resolveConfig callers
      // that pass explicit teamOverride values.
      const rootOpts = thisCommand.opts();
      const leafOpts = actionCommand.opts() as {
        workspace?: string;
        team?: string;
        json?: boolean;
      };
      const ws = (leafOpts.workspace ?? (rootOpts.workspace as string | undefined)) as
        | string
        | undefined;
      const team = (leafOpts.team ?? (rootOpts.team as string | undefined)) as string | undefined;
      setRequestOverrides({ workspace: ws, team });
      restoreParserStderr();
      // Capture per-command `--json` from the leaf subcommand so the top-level
      // catch formats LebopError as a structured envelope instead of chalk
      // prose. `--json` lives on individual subcommands, not the root.
      if (leafOpts.json !== undefined) _wantsJsonError = Boolean(leafOpts.json);
    })
    .showHelpAfterError()
    .configureOutput({
      writeErr: (str) => {
        if (!_wantsJsonError) process.stderr.write(str);
      },
      outputError: (str, write) => {
        if (!_wantsJsonError) write(str);
      },
    })
    // Commander exits 1 on unknown options by default. Standard convention is
    // 2 for usage errors and 1 for runtime failures, so classify commander's
    // error code here and rethrow through the existing output path.
    .exitOverride((err) => {
      // Help / version paths keep their natural exit 0.
      if (
        err.code === "commander.help" ||
        err.code === "commander.helpDisplayed" ||
        err.code === "commander.version"
      ) {
        // Successful informational exit — let it pass through cleanly.
        process.exit(0);
      }
      const isUsageError = isCommanderUsageError(err.code);
      if (isUsageError) {
        if (_wantsJsonError) {
          restoreParserStderr();
          process.stdout.write(
            `${JSON.stringify(
              {
                ok: false,
                schema_version: SCHEMA_VERSION,
                error: {
                  code: "invalid_arguments",
                  message: err.message,
                  hint: "run the command with --help to see accepted arguments",
                },
              },
              null,
              2,
            )}\n`,
          );
          process.exit(2);
        }
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
  registerWorkspace(program);

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
  registerPublish(program);

  registerCache(program);

  registerAttachment(program);
  registerBulk(program);
  registerLookup(program);

  registerSchema(program);
  registerRaw(program);
  registerMcp(program);
  registerCompletions(program);

  return program;
}

function isCommanderUsageError(code: string): boolean {
  return (
    code === "commander.unknownOption" ||
    code === "commander.unknownCommand" ||
    code === "commander.missingArgument" ||
    code === "commander.missingMandatoryOptionValue" ||
    code === "commander.optionMissingArgument" ||
    code === "commander.invalidArgument"
  );
}

function argvRequestsJson(argv: string[]): boolean {
  return argv.some((arg) => arg === "--json" || arg.startsWith("--json="));
}
