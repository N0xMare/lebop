import type { Command } from "commander";
import { buildCommandHelp, buildRootCatalog, formatAgentHelpText } from "../lib/agentHelp.ts";
import { parseFormatFlag } from "../lib/encode.ts";

/**
 * `lebop help [cmd…]` — dense agent catalog (same payload as --help).
 */
export function registerHelp(program: Command): void {
  program
    .command("help")
    .description("dense agent command catalog (TOON); optional cmd path for detail")
    .argument("[path...]", "command path e.g. workspace fetch")
    .option("--json", "machine output (default; TOON)")
    .option("--format <fmt>", "toon | json | pretty")
    .option("--pretty", "pretty JSON")
    .option("--human", "maintainer/dev chalk tables (opt-in; not agent path; bodies uncapped)")
    .action((pathParts: string[], opts: { json?: boolean; format?: string; pretty?: boolean }) => {
      const format = parseFormatFlag({
        json: true,
        format: opts.format,
        pretty: opts.pretty,
      });

      if (!pathParts?.length) {
        process.stdout.write(
          formatAgentHelpText(
            buildRootCatalog(program) as unknown as Record<string, unknown>,
            format,
          ),
        );
        return;
      }

      let cmd: Command = program;
      for (const part of pathParts) {
        const next = cmd.commands.find((c) => c.name() === part || c.aliases().includes(part));
        if (!next) {
          process.stdout.write(
            formatAgentHelpText(
              {
                ok: false,
                error: {
                  code: "not_found",
                  message: `unknown command path: ${pathParts.join(" ")}`,
                  hint: "run `lebop help` for the dense catalog",
                },
              },
              format,
            ),
          );
          process.exitCode = 1;
          return;
        }
        cmd = next;
      }
      process.stdout.write(
        formatAgentHelpText(buildCommandHelp(cmd) as unknown as Record<string, unknown>, format),
      );
    });
}
