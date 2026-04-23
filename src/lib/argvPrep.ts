/**
 * Commander parses any token beginning with `-` as an option, even in variadic positional
 * slots. That trips up `set labels <id> -type:test` and `set links <id> -blocks:UE-X` — the
 * first `-…` delta is rejected as an unknown option.
 *
 * This preprocessor walks past `set FIELD ID` (accounting for the known options on the
 * `set` subcommand) and inserts a `--` separator before the first unrecognised `-TOKEN`
 * found after the two positionals, so the rest is treated as variadic positional args.
 *
 * Invariant: only rewrites for the `set` subcommand; leaves every other invocation alone.
 * Leaves alone argvs that already contain `--`.
 */

const VALUE_OPTS = ["--team"] as const;
const FLAG_OPTS = ["--json", "-h", "--help"] as const;

const isValueOpt = (a: string): boolean => VALUE_OPTS.some((o) => a === o);
const isValueOptInline = (a: string): boolean => VALUE_OPTS.some((o) => a.startsWith(`${o}=`));
const isFlagOpt = (a: string): boolean => (FLAG_OPTS as readonly string[]).includes(a);

export function preprocessSetArgv(argv: string[]): string[] {
  const setIdx = argv.indexOf("set");
  if (setIdx === -1) return argv;

  let i = setIdx + 1;
  let positionalsSeen = 0;

  while (i < argv.length) {
    const arg = argv[i] ?? "";

    if (arg === "--") return argv;

    if (isValueOpt(arg)) {
      i += 2;
      continue;
    }
    if (isValueOptInline(arg) || isFlagOpt(arg)) {
      i += 1;
      continue;
    }

    if (arg.startsWith("-") && arg !== "-") {
      if (positionalsSeen >= 2) {
        return [...argv.slice(0, i), "--", ...argv.slice(i)];
      }
      // unknown option appearing before both positionals — let commander emit its own error
      return argv;
    }

    positionalsSeen += 1;
    i += 1;
  }

  return argv;
}
