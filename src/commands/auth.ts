import chalk from "chalk";
import type { Command } from "commander";
import { deleteAuth, importFromSchpet, loadAuth, saveAuth, validateToken } from "../lib/auth.ts";
import { AUTH_FILE } from "../lib/paths.ts";
import { promptHidden } from "../lib/prompt.ts";

export function registerAuth(program: Command): void {
  const auth = program.command("auth").description("manage Linear credentials");

  auth
    .command("login")
    .description("store a Linear personal API key (PAK)")
    .option("--from-schpet", "import the token currently stored by @schpet/linear-cli")
    .option("--token <token>", "provide the token directly (avoid — leaks to shell history)")
    .option("--token-file <path>", "read the token from a file")
    .action(async (opts: { fromSchpet?: boolean; token?: string; tokenFile?: string }) => {
      let token: string;

      if (opts.fromSchpet) {
        token = importFromSchpet();
      } else if (opts.token) {
        token = opts.token.trim();
      } else if (opts.tokenFile) {
        token = (await Bun.file(opts.tokenFile).text()).trim();
      } else {
        process.stdout.write(
          `create a personal API key at ${chalk.cyan("https://linear.app/settings/account/security")} (look for "Personal API keys")\n`,
        );
        token = (await promptHidden("paste key (input hidden): ")).trim();
      }

      if (!token) {
        process.stderr.write(`${chalk.red("no token provided")}\n`);
        process.exit(1);
      }

      const viewer = await validateToken(token);
      await saveAuth(token, viewer);
      process.stdout.write(
        `${chalk.green("✓")} authenticated as ${chalk.bold(viewer.name)} <${viewer.email}>\n`,
      );
      process.stdout.write(`  credentials saved to ${AUTH_FILE} (mode 0600)\n`);
    });

  auth
    .command("logout")
    .description("delete stored Linear credentials")
    .action(() => {
      const removed = deleteAuth();
      if (removed) {
        process.stdout.write(`${chalk.green("✓")} credentials removed from ${AUTH_FILE}\n`);
      } else {
        process.stdout.write("no credentials to remove\n");
      }
    });

  auth
    .command("whoami")
    .description("print cached viewer; --refresh re-validates against Linear")
    .option("--refresh", "re-validate the stored token against Linear")
    .option("--json", "emit structured JSON")
    .action(async (opts: { refresh?: boolean; json?: boolean }) => {
      const stored = await loadAuth();
      if (!stored) {
        process.stderr.write(
          `${chalk.red("no credentials stored.")} run ${chalk.cyan("lebop auth login")}\n`,
        );
        process.exit(1);
      }

      let viewer = stored.viewer;
      let refreshed = false;

      if (opts.refresh) {
        viewer = await validateToken(stored.token);
        await saveAuth(stored.token, viewer);
        refreshed = true;
      }

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              viewer,
              auth_file: AUTH_FILE,
              refreshed,
              created_at: stored.created_at,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      process.stdout.write(
        `${chalk.bold(viewer.name)} <${viewer.email}>\n  id: ${viewer.id}\n  auth file: ${AUTH_FILE}\n  created: ${stored.created_at}${refreshed ? chalk.gray(" (just refreshed)") : ""}\n`,
      );
    });
}
