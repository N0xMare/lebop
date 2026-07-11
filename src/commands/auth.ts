import chalk from "chalk";
import type { Command } from "commander";
import { importFromSchpet, loadAuth } from "../lib/auth.ts";
import { envelope } from "../lib/envelope.ts";
import { AuthError, ValidationError } from "../lib/errors.ts";
import { AUTH_FILE_DISPLAY } from "../lib/paths.ts";
import { promptHidden } from "../lib/prompt.ts";
import {
  authDefaultReadPayload,
  buildAuthLoginInputFromCli,
  buildAuthLogoutInputFromCli,
  buildAuthTokenInputFromCli,
  buildListWorkspacesInputFromCli,
  buildRefreshWhoamiInputFromCli,
  buildSetDefaultWorkspaceInputFromCli,
  buildSetWorkspaceDefaultTeamInputFromCli,
  buildWhoamiInputFromCli,
  executeAuthLogin,
  executeAuthLogout,
  executeAuthToken,
  executeListWorkspaces,
  executeRefreshWhoami,
  executeSetDefaultWorkspace,
  executeSetWorkspaceDefaultTeam,
  executeWhoami,
  listWorkspacesPayload,
  setDefaultWorkspacePayload,
  setWorkspaceDefaultTeamPayload,
  whoamiPayload,
} from "../surface/auth.ts";

export function registerAuth(program: Command): void {
  const auth = program.command("auth").description("manage Linear credentials");

  auth
    .command("login")
    .description("add or replace a Linear personal API key (PAK) for a workspace")
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
        throw new ValidationError(
          "no token provided",
          "pass --token, --token-file, --from-schpet, or enter a token at the prompt",
        );
      }

      const { workspace: ws } = await executeAuthLogin(buildAuthLoginInputFromCli({ token }));
      process.stdout.write(
        `${chalk.green("✓")} authenticated to ${chalk.bold(ws.name)} (${chalk.cyan(ws.slug)}) as ${ws.viewer.name} <${ws.viewer.email}>\n`,
      );
      process.stdout.write(`  credentials saved to ${AUTH_FILE_DISPLAY} (mode 0600)\n`);
    });

  auth
    .command("logout [slug]")
    .description("remove credentials for one workspace, or all if only one is configured")
    .action(async (slug: string | undefined) => {
      const { removed } = await executeAuthLogout(buildAuthLogoutInputFromCli({ slug }));
      if (removed) {
        process.stdout.write(
          slug
            ? `${chalk.green("✓")} removed credentials for ${chalk.bold(slug)}\n`
            : `${chalk.green("✓")} credentials removed from ${AUTH_FILE_DISPLAY}\n`,
        );
      } else {
        // Round-8 / R8-LOW-5: when a slug was explicitly named but doesn't
        // exist in auth.json, exit 1 with a clearer message. Pre-fix this
        // silently exited 0 with "no credentials to remove", which let
        // scripts treat a typoed slug as success.
        if (slug) {
          process.stderr.write(
            `${chalk.red("error:")} workspace slug not found in ${AUTH_FILE_DISPLAY}: ${chalk.bold(slug)}\n` +
              `  ${chalk.cyan("hint:")} run \`lebop auth list\` to see configured workspaces.\n`,
          );
          process.exitCode = 1;
          return;
        }
        process.stdout.write("no credentials to remove\n");
      }
    });

  auth
    .command("list")
    .description("list configured workspaces")
    .option("--json", "emit structured records")
    .action(async (opts: { json?: boolean }) => {
      const result = await executeListWorkspaces(buildListWorkspacesInputFromCli());

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope(listWorkspacesPayload(result)), null, 2)}\n`,
        );
        return;
      }

      if (result.workspaces.length === 0) {
        process.stdout.write("no workspaces configured\n");
        return;
      }

      const slugWidth = Math.max(...result.workspaces.map((ws) => ws.slug.length));
      for (const ws of result.workspaces) {
        const marker = ws.is_default ? chalk.green("*") : " ";
        process.stdout.write(
          `${marker} ${chalk.bold(ws.slug.padEnd(slugWidth))}  ${ws.name}  ${chalk.gray(ws.viewer.email)}\n`,
        );
      }
      process.stdout.write(
        `\n${chalk.gray("default marked with *. set with `lebop auth default <slug>`.")}\n`,
      );
    });

  auth
    .command("default [slug]")
    .description("show or set the default workspace")
    .option("--json", "emit structured result")
    .action(async (slug: string | undefined, opts: { json?: boolean }) => {
      if (!slug) {
        // Read mode — maps to list_workspaces.default
        const listed = await executeListWorkspaces(buildListWorkspacesInputFromCli());
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(envelope(authDefaultReadPayload(listed)), null, 2)}\n`,
          );
          return;
        }
        if (listed.default) {
          process.stdout.write(`${listed.default}\n`);
        } else {
          process.stdout.write(`${chalk.yellow("no default set")}\n`);
        }
        return;
      }
      // Write mode — CLI-specific pre-check message (behavior freeze vs MCP).
      const stored = await loadAuth();
      if (!stored) {
        throw new AuthError("no credentials stored", "run `lebop auth login` first");
      }
      const result = await executeSetDefaultWorkspace(
        buildSetDefaultWorkspaceInputFromCli({ slug }),
      );
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(envelope(setDefaultWorkspacePayload(result)), null, 2)}\n`,
        );
        return;
      }
      process.stdout.write(
        `${chalk.green("✓")} default workspace set to ${chalk.bold(result.default)}\n`,
      );
    });

  auth
    .command("token [slug]")
    .description(
      "print a masked preview of the API token for a workspace. Use `--unsafe` to print the full token (for piping to curl).",
    )
    // Round-6 / CLI 19: prints a masked preview by default
    // (`lin_api_***************XXXX`, last 4 chars revealed) so a careless
    // copy-paste into a chat / screenshot doesn't leak the full PAK. Pass
    // `--unsafe` to opt into the original full-token print.
    .option("--unsafe", "print the full token (legacy behavior; required to pipe into curl)")
    .action(async (slug: string | undefined, opts: { unsafe?: boolean }) => {
      const result = await executeAuthToken(
        buildAuthTokenInputFromCli({ slug, unsafe: opts.unsafe }),
      );
      if (!result.is_full_token) {
        process.stderr.write(`${chalk.gray("(masked — pass --unsafe to print the full token)")}\n`);
      }
      process.stdout.write(`${result.value}\n`);
    });

  auth
    .command("whoami [slug]")
    .description("print cached viewer for one workspace (or default); --refresh re-validates")
    .option("--refresh", "re-validate the stored token against Linear")
    .option("--json", "emit structured JSON")
    .action(async (slug: string | undefined, opts: { refresh?: boolean; json?: boolean }) => {
      const result = opts.refresh
        ? await executeRefreshWhoami(buildRefreshWhoamiInputFromCli({ slug }))
        : await executeWhoami(buildWhoamiInputFromCli({ slug }));

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope(whoamiPayload(result)), null, 2)}\n`);
        return;
      }

      const defaultMarker = result.is_default ? chalk.gray(" [default]") : "";
      process.stdout.write(
        `${chalk.bold(result.viewer.name)} <${result.viewer.email}>\n  workspace: ${chalk.cyan(result.workspace)} (${result.workspace_name})${defaultMarker}\n  id: ${result.viewer.id}\n  auth file: ${result.auth_file}\n  created: ${result.created_at}${result.refreshed ? chalk.gray(" (just refreshed)") : ""}\n`,
      );
    });

  auth
    .command("set-default-team <workspace> <team>")
    .description(
      "set the per-workspace default team (writes workspace_team_defaults in ~/.lebop/config.yaml)",
    )
    .option("--json", "emit structured result")
    .action(async (workspace: string, team: string, opts: { json?: boolean }) => {
      const result = await executeSetWorkspaceDefaultTeam(
        buildSetWorkspaceDefaultTeamInputFromCli({ workspace, team }),
        {
          teamNotFoundHint: `run \`lebop --workspace ${workspace} teams\` to list valid keys`,
        },
      );
      if (opts.json) {
        process.stdout.write(
          // Round-7 / HIGH-3: response envelope key renamed `team_key` →
          // `team` to match the MCP-side `set_workspace_default_team`
          // rename (round-6 / C1). Both surfaces now agree on `team`.
          `${JSON.stringify(envelope(setWorkspaceDefaultTeamPayload(result)), null, 2)}\n`,
        );
        return;
      }
      process.stdout.write(
        `${chalk.green("✓")} default team for ${chalk.cyan(result.workspace_slug)} set to ${chalk.bold(result.team)}\n`,
      );
    });
}
