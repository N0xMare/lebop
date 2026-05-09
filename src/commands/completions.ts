import type { Command } from "commander";
import { ValidationError } from "../lib/errors.ts";

type Shell = "bash" | "zsh" | "fish";

interface CmdNode {
  name: string;
  description: string;
  subcommands: CmdNode[];
}

function isHidden(c: Command): boolean {
  return Boolean((c as unknown as { _hidden?: boolean })._hidden);
}

function buildTree(parent: Command): CmdNode[] {
  return parent.commands
    .filter((c) => !isHidden(c) && c.name() !== "completions")
    .map((c) => ({
      name: c.name(),
      description: (c.description() ?? "").replace(/\s+/g, " ").trim(),
      subcommands: buildTree(c),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Single-quote a string for /bin/sh — close, escape, reopen. Works in bash,
// zsh, fish.
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Fish-specific quoting (same close-reopen trick — fish does not interpret
// backslash escapes inside single-quoted strings).
function fishQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function renderBash(tree: CmdNode[]): string {
  const topNames = tree.map((c) => c.name).join(" ");

  const cases = tree
    .filter((c) => c.subcommands.length > 0)
    .map((c) => {
      const subs = c.subcommands.map((s) => s.name).join(" ");
      return `    ${c.name})
      COMPREPLY=( $(compgen -W "${subs}" -- "$cur") )
      return 0
      ;;`;
    })
    .join("\n");

  return `# lebop bash completion
# Install:
#   lebop completions bash > /usr/local/etc/bash_completion.d/lebop
#   (or source it from your ~/.bashrc).
# Note: relies on the 'bash-completion' package for _init_completion;
#   the script falls back gracefully if it's missing.

_lebop_completions() {
  local cur prev words cword
  _init_completion 2>/dev/null || {
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    cword=\$COMP_CWORD
  }

  if [ "\$cword" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "${topNames}" -- "\$cur") )
    return 0
  fi

  if [ "\$cword" -eq 2 ]; then
    case "\${COMP_WORDS[1]}" in
${cases}
    esac
  fi

  COMPREPLY=( \$(compgen -f -- "\$cur") )
}

complete -F _lebop_completions lebop
`;
}

function renderZsh(tree: CmdNode[]): string {
  const topLines = tree.map((c) => `    ${shSingleQuote(`${c.name}:${c.description}`)}`).join("\n");

  const subCases = tree
    .filter((c) => c.subcommands.length > 0)
    .map((c) => {
      const subLines = c.subcommands
        .map((s) => `        ${shSingleQuote(`${s.name}:${s.description}`)}`)
        .join("\n");
      return `    ${c.name})
      local -a sub
      sub=(
${subLines}
      )
      _describe -t '${c.name}-subcommand' '${c.name} subcommand' sub
      ;;`;
    })
    .join("\n");

  return `#compdef lebop
# lebop zsh completion
# Install:
#   lebop completions zsh > "\${fpath[1]}/_lebop"
#   then restart your shell (or run: compinit).

_lebop() {
  local -a top
  top=(
${topLines}
  )

  if (( CURRENT == 2 )); then
    _describe -t commands 'lebop command' top
    return
  fi

  if (( CURRENT == 3 )); then
    case "\$words[2]" in
${subCases}
    esac
    return
  fi

  _files
}

_lebop "\$@"
`;
}

function renderFish(tree: CmdNode[]): string {
  const topLines = tree
    .map(
      (c) =>
        `complete -c lebop -n '__fish_use_subcommand' -a ${fishQuote(c.name)} -d ${fishQuote(c.description)}`,
    )
    .join("\n");

  const subLines = tree
    .filter((c) => c.subcommands.length > 0)
    .map((c) =>
      c.subcommands
        .map(
          (s) =>
            `complete -c lebop -n '__fish_seen_subcommand_from ${c.name}' -a ${fishQuote(s.name)} -d ${fishQuote(s.description)}`,
        )
        .join("\n"),
    )
    .join("\n");

  return `# lebop fish completion
# Install: lebop completions fish > ~/.config/fish/completions/lebop.fish

${topLines}

${subLines}
`;
}

/**
 * `lebop completions <bash|zsh|fish>` — emit a completion script for the
 * requested shell on stdout. The script understands two levels of the
 * commander tree: top-level command names and their direct subcommands
 * (e.g. `lebop auth <TAB>` suggests `login logout list ...`). Beyond level
 * 2, completion falls back to file paths.
 */
export function registerCompletions(program: Command): void {
  program
    .command("completions <shell>")
    .description("emit shell completion script (bash|zsh|fish)")
    .action((shell: string) => {
      const tree = buildTree(program);
      const out = (() => {
        switch (shell as Shell) {
          case "bash":
            return renderBash(tree);
          case "zsh":
            return renderZsh(tree);
          case "fish":
            return renderFish(tree);
          default:
            throw new ValidationError(`unknown shell: ${shell}`, "supported: bash, zsh, fish");
        }
      })();
      process.stdout.write(out);
    });
}
