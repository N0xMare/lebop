import type { Command } from "commander";
import { ValidationError } from "../lib/errors.ts";

type Shell = "bash" | "zsh" | "fish";

interface TopCommand {
  name: string;
  description: string;
}

function collectTopCommands(program: Command): TopCommand[] {
  return program.commands
    .filter((c) => !(c as unknown as { _hidden?: boolean })._hidden)
    .map((c) => ({
      name: c.name(),
      description: c.description() ?? "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function renderBash(cmds: TopCommand[]): string {
  const names = cmds.map((c) => c.name).join(" ");
  return `# lebop bash completion
# Install: lebop completions bash > /usr/local/etc/bash_completion.d/lebop
#   (or source it from your ~/.bashrc)

_lebop_completions() {
  local cur prev words cword
  _init_completion 2>/dev/null || {
    cur="\${COMP_WORDS[COMP_CWORD]}"
    cword=\$COMP_CWORD
  }

  if [ "\$cword" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "${names}" -- "\$cur") )
    return 0
  fi

  # For deeper positions, fall back to file completion.
  COMPREPLY=( \$(compgen -f -- "\$cur") )
}

complete -F _lebop_completions lebop
`;
}

function renderZsh(cmds: TopCommand[]): string {
  const lines = cmds
    .map((c) => `    '${c.name}:${c.description.replace(/'/g, "'\\''")}'`)
    .join("\n");
  return `#compdef lebop
# lebop zsh completion
# Install: lebop completions zsh > "\${fpath[1]}/_lebop"
#   then restart your shell (or run: compinit).

_lebop() {
  local -a _lebop_commands
  _lebop_commands=(
${lines}
  )

  _arguments -C \\
    '1: :->cmd' \\
    '*: :->args'

  case "\$state" in
    cmd)
      _describe -t commands 'lebop command' _lebop_commands
      ;;
    args)
      _files
      ;;
  esac
}

_lebop "\$@"
`;
}

function renderFish(cmds: TopCommand[]): string {
  const lines = cmds
    .map((c) => {
      const desc = c.description.replace(/'/g, "\\'");
      return `complete -c lebop -n '__fish_use_subcommand' -a '${c.name}' -d '${desc}'`;
    })
    .join("\n");
  return `# lebop fish completion
# Install: lebop completions fish > ~/.config/fish/completions/lebop.fish

${lines}
`;
}

/**
 * `lebop completions <bash|zsh|fish>` — emit a completion script for the
 * requested shell on stdout. Top-level subcommand names + descriptions are
 * pulled from the commander program at runtime, so the script stays in sync
 * with whatever commands are registered.
 */
export function registerCompletions(program: Command): void {
  program
    .command("completions <shell>")
    .description("emit shell completion script (bash|zsh|fish)")
    .action((shell: string) => {
      const cmds = collectTopCommands(program).filter(
        // Don't recurse into the completions command itself in suggestions.
        (c) => c.name !== "completions",
      );
      const out = (() => {
        switch (shell as Shell) {
          case "bash":
            return renderBash(cmds);
          case "zsh":
            return renderZsh(cmds);
          case "fish":
            return renderFish(cmds);
          default:
            throw new ValidationError(`unknown shell: ${shell}`, "supported: bash, zsh, fish");
        }
      })();
      process.stdout.write(out);
    });
}
