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
import { registerCustomField } from "./commands/custom-field.ts";
import { registerCycle } from "./commands/cycle.ts";
import { registerDiff } from "./commands/diff.ts";
import { registerDocument } from "./commands/document.ts";
import { registerHelp } from "./commands/help.ts";
import { registerHistory } from "./commands/history.ts";
import { runHome } from "./commands/home.ts";
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
import { registerNotifications } from "./commands/notifications.ts";
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
import { registerSearch } from "./commands/search.ts";
import { registerSet } from "./commands/set.ts";
import { registerShow } from "./commands/show.ts";
import { registerStatus } from "./commands/status.ts";
import { registerTeam } from "./commands/team.ts";
import { registerTeams } from "./commands/teams.ts";
import { registerUnarchive } from "./commands/unarchive.ts";
import { registerUpdate } from "./commands/update.ts";
import { registerView } from "./commands/view.ts";
import { registerWorkspace } from "./commands/workspace.ts";
import { formatCommanderHelp } from "./lib/agentHelp.ts";
import { preprocessSetArgv } from "./lib/argvPrep.ts";
import { encodeErrorEnvelope } from "./lib/encode.ts";
import { LebopError } from "./lib/errors.ts";
import { resolveWorkspaceSlugForState, UNSET_WORKSPACE_SLUG } from "./lib/paths.ts";
import { runWithRequestContext, setRequestOverrides } from "./lib/requestContext.ts";
import { LEBOP_VERSION } from "./lib/version.ts";

// Captured by the preAction hook so the top-level catch can emit a structured
// `{ok:false, schema_version, error: {code, message, hint}}` envelope to stdout
// when `--json` is set. Per-command `--json` does not propagate to the
// top-level catch otherwise. Reset on each `run()` call so test harnesses that
// re-invoke the CLI in the same process do not leak state.
let _wantsJsonError = false;
/** Argv for the current `run()` call — used by error-envelope format resolution. */
let _runArgv: string[] = [];
let _restoreParserStderr: (() => void) | null = null;

export async function run(rawArgv: string[]): Promise<void> {
  _wantsJsonError = false;
  _runArgv = [];
  restoreParserStderr();
  // Enforce NO_COLOR precedence per no-color.org. Chalk honors FORCE_COLOR
  // over NO_COLOR by default, so hard-disable chalk when NO_COLOR is set even
  // if CI also exports FORCE_COLOR.
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    chalk.level = 0;
  }

  const argv = preprocessSetArgv(rawArgv);
  _runArgv = argv;
  // Agent product: structured machine errors by default; opt out with --human / LEBOP_HUMAN.
  _wantsJsonError = !argvWantsHuman(argv);
  if (_wantsJsonError) _restoreParserStderr = silenceStderr();
  const program = buildCliProgram();

  try {
    await runWithRequestContext({}, () => program.parseAsync(argv));
    restoreParserStderr();
  } catch (err) {
    // Agent-first: structured error envelopes on stdout by default.
    if (_wantsJsonError) {
      restoreParserStderr();
      const error =
        err instanceof LebopError
          ? {
              code: err.code,
              message: err.message,
              hint: err.hint,
              ...(err.details ? { details: err.details } : {}),
            }
          : { code: "unknown", message: (err as Error).message ?? String(err) };
      const errFormat = resolveMachineErrorFormat(_runArgv);
      process.stdout.write(`${encodeErrorEnvelope(error, { format: errFormat })}\n`);
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
    .description("agentic Linear CLI — dense agent control plane over Linear")
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
        format?: string;
        pretty?: boolean;
        human?: boolean;
      };
      const explicitWs = (leafOpts.workspace ?? (rootOpts.workspace as string | undefined)) as
        | string
        | undefined;
      const team = (leafOpts.team ?? (rootOpts.team as string | undefined)) as string | undefined;
      // Lane 3: when no explicit --workspace, resolve auth.default / single-ws into
      // request context so cache/context paths match API workspace selection.
      let ws = explicitWs;
      if (!ws) {
        try {
          const resolved = resolveWorkspaceSlugForState(undefined);
          if (resolved !== UNSET_WORKSPACE_SLUG) ws = resolved;
        } catch {
          // fail-closed multi-ws will throw later at path resolve; leave unset here
        }
      }
      setRequestOverrides({ workspace: ws, team });
      restoreParserStderr();
      // Agent default: machine errors. Only flip off for explicit human mode.
      if (leafOpts.human === true) _wantsJsonError = false;
      else if (leafOpts.json === true || leafOpts.format || leafOpts.pretty) _wantsJsonError = true;
    })
    // Agent product: never dump human Commander manpages after errors.
    .showHelpAfterError(false)
    .configureHelp({
      formatHelp: (cmd) => formatCommanderHelp(cmd),
    })
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
        restoreParserStderr();
        if (argvWantsHuman(_runArgv)) {
          process.stderr.write(`${err.message}\n`);
          process.exit(2);
        }
        const unknownCmd =
          err.message.match(/unknown command ['"]([^'"]+)['"]/i)?.[1] ??
          err.message.match(/got \d+:\s*([^\s.]+)/i)?.[1];
        const suggestions = unknownCmd ? suggestCommandNames(program, unknownCmd) : [];
        const message =
          unknownCmd && /too many arguments/i.test(err.message)
            ? `unknown command '${unknownCmd}'`
            : err.message;
        process.stdout.write(
          `${encodeErrorEnvelope(
            {
              code: "invalid_arguments",
              message,
              hint: "run `lebop help` for the dense catalog",
              ...(suggestions.length ? { details: { did_you_mean: suggestions } } : {}),
            },
            { format: resolveMachineErrorFormat(_runArgv) },
          )}\n`,
        );
        process.exit(2);
      }
      // Any other CommanderError shape: re-throw so the top-level catch
      // formats it like other errors.
      throw err;
    });

  registerHelp(program);
  registerAuth(program);

  registerList(program);
  registerMine(program);
  registerSearch(program);
  registerHistory(program);
  registerView(program);
  registerCustomField(program);
  registerNotifications(program);
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
  registerUpdate(program);
  registerMcp(program);
  registerCompletions(program);

  // AXI content-first + agent-only: bare `lebop` is always dense machine home (TOON).
  // Do NOT put --json/--format on the root program — they collide with leaf
  // subcommand flags (commander binds them to root and leaves never see them).
  // Home format: LEBOP_MACHINE_FORMAT; offline: --offline or LEBOP_HOME_OFFLINE=1.
  program
    .option("--offline", "home without Linear API (no mine list)")
    .allowExcessArguments(false)
    .action(async (opts: { offline?: boolean }, cmd: Command) => {
      // Unknown tokens on bare `lebop` surface as excess args — emit dense error + suggestions.
      const excess = (cmd.args ?? []).filter((a) => typeof a === "string" && a.length > 0);
      if (excess.length > 0) {
        const token = String(excess[0]);
        const suggestions = suggestCommandNames(program, token);
        process.stdout.write(
          `${encodeErrorEnvelope(
            {
              code: "invalid_arguments",
              message: `unknown command '${token}'`,
              hint: "run `lebop help` for the dense catalog",
              ...(suggestions.length ? { details: { did_you_mean: suggestions } } : {}),
            },
            { format: resolveMachineErrorFormat(_runArgv) },
          )}\n`,
        );
        process.exitCode = 2;
        return;
      }
      await runHome({
        json: true,
        format: process.env.LEBOP_MACHINE_FORMAT,
        offline: opts.offline || process.env.LEBOP_HOME_OFFLINE === "1",
      });
    });

  return program;
}

function isCommanderUsageError(code: string): boolean {
  return (
    code === "commander.unknownOption" ||
    code === "commander.unknownCommand" ||
    code === "commander.missingArgument" ||
    code === "commander.missingMandatoryOptionValue" ||
    code === "commander.optionMissingArgument" ||
    code === "commander.invalidArgument" ||
    code === "commander.excessArguments"
  );
}

function argvWantsHuman(argv: string[]): boolean {
  if (process.env.LEBOP_HUMAN === "1" || process.env.LEBOP_HUMAN === "true") return true;
  return argv.some((arg) => arg === "--human" || arg.startsWith("--human="));
}

/** Dense did-you-mean for unknown top-level commands. */
function suggestCommandNames(program: Command, unknown: string, limit = 5): string[] {
  const names = program.commands.map((c) => c.name()).filter(Boolean);
  const u = unknown.toLowerCase();
  const scored = names
    .map((n) => {
      const nl = n.toLowerCase();
      let score = 0;
      if (nl === u) score = 100;
      else if (nl.startsWith(u) || u.startsWith(nl)) score = 80;
      else if (nl.includes(u) || u.includes(nl)) score = 50;
      else {
        // cheap edit distance bound
        let d = 0;
        const a = nl;
        const b = u;
        const m = Math.max(a.length, b.length);
        for (let i = 0; i < m; i++) if (a[i] !== b[i]) d++;
        score = Math.max(0, 40 - d * 8);
      }
      return { n, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.n);
}

/** Resolve error-envelope format from argv flags, then LEBOP_MACHINE_FORMAT, else TOON. */
function resolveMachineErrorFormat(argv: string[]): "toon" | "json" | "pretty" {
  if (argv.includes("--pretty")) return "pretty";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg.startsWith("--format=")) {
      const v = arg.slice("--format=".length);
      if (v === "json" || v === "pretty" || v === "toon") return v;
    }
    if (arg === "--format") {
      const v = argv[i + 1];
      if (v === "json" || v === "pretty" || v === "toon") return v;
    }
  }
  if (process.env.LEBOP_MACHINE_FORMAT === "json") return "json";
  if (process.env.LEBOP_MACHINE_FORMAT === "pretty") return "pretty";
  return "toon";
}
