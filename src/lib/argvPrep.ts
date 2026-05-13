/**
 * Commander parses any token beginning with `-` as an option, even in variadic positional
 * slots. That trips up `set labels <id> -type:test` and `set links <id> -blocks:UE-X` — the
 * first `-…` delta is rejected as an unknown option.
 *
 * This preprocessor walks past `set FIELD ID` (accounting for the known options on the
 * `set` subcommand) and inserts a `--` separator before the first unrecognised `-TOKEN`
 * found after the two positionals, so the rest is treated as variadic positional args.
 *
 * Round-8 backlog: when inserting `--`, also LIFT any recognised flags from the
 * tail (after the unknown `-TOKEN`) to BEFORE the separator. Pre-fix `set labels
 * ID -urgent --json` produced `set labels ID -- -urgent --json` — commander then
 * consumed `--json` as a positional label token (the label parser stripped one
 * leading `-` and threw "unknown label -json"), AND opts.json stayed undefined
 * so the top-level catch never emitted the structured envelope under Q4.
 * Post-fix: `set labels ID -urgent --json` → `set labels ID --json -- -urgent`,
 * which gives commander both the flag (`--json`) and the variadic positional
 * (`-urgent`) cleanly.
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
        // Walk the tail (from i forward), splitting tokens into recognised
        // flags (to LIFT in front of `--`) vs everything else (kept as
        // positional after `--`). Order within each bucket is preserved.
        const tail = argv.slice(i);
        const lifted: string[] = [];
        const kept: string[] = [];
        let j = 0;
        while (j < tail.length) {
          const t = tail[j] ?? "";
          if (isValueOpt(t) && j + 1 < tail.length) {
            // Two-arg form: `--team ENG`. Lift both as a pair.
            lifted.push(t, tail[j + 1] as string);
            j += 2;
            continue;
          }
          if (isValueOptInline(t) || isFlagOpt(t)) {
            lifted.push(t);
            j += 1;
            continue;
          }
          kept.push(t);
          j += 1;
        }
        // Edge case: if no unknown -TOKENs exist in the tail (everything
        // was lifted), don't insert a `--` — there's nothing to escape.
        if (kept.length === 0) {
          return [...argv.slice(0, i), ...lifted];
        }
        return [...argv.slice(0, i), ...lifted, "--", ...kept];
      }
      // unknown option appearing before both positionals — let commander emit its own error
      return argv;
    }

    positionalsSeen += 1;
    i += 1;
  }

  return argv;
}
