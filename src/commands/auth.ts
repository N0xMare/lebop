import chalk from "chalk";
import type { Command } from "commander";
import {
  addWorkspace,
  importFromSchpet,
  loadAuth,
  loadAuthForWorkspace,
  removeWorkspace,
  setDefaultWorkspace,
  validateToken,
} from "../lib/auth.ts";
import { AUTH_FILE } from "../lib/paths.ts";
import { promptHidden } from "../lib/prompt.ts";

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
        process.stderr.write(`${chalk.red("no token provided")}\n`);
        process.exitCode = 1;
        return;
      }

      const ws = await addWorkspace(token);
      process.stdout.write(
        `${chalk.green("✓")} authenticated to ${chalk.bold(ws.name)} (${chalk.cyan(ws.slug)}) as ${ws.viewer.name} <${ws.viewer.email}>\n`,
      );
      process.stdout.write(`  credentials saved to ${AUTH_FILE} (mode 0600)\n`);
    });

  auth
    .command("logout [slug]")
    .description("remove credentials for one workspace, or all if only one is configured")
    .action(async (slug: string | undefined) => {
      const removed = await removeWorkspace(slug);
      if (removed) {
        process.stdout.write(
          slug
            ? `${chalk.green("✓")} removed credentials for ${chalk.bold(slug)}\n`
            : `${chalk.green("✓")} credentials removed from ${AUTH_FILE}\n`,
        );
      } else {
        process.stdout.write("no credentials to remove\n");
      }
    });

  auth
    .command("list")
    .description("list configured workspaces")
    .option("--json", "emit structured records")
    .action(async (opts: { json?: boolean }) => {
      const stored = await loadAuth();
      if (!stored) {
        process.stderr.write(
          `${chalk.red("no credentials stored.")} run ${chalk.cyan("lebop auth login")}\n`,
        );
        process.exitCode = 1;
        return;
      }
      const slugs = Object.keys(stored.workspaces);

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              auth_file: AUTH_FILE,
              default: stored.default ?? null,
              workspaces: slugs
                .map((s) => {
                  const ws = stored.workspaces[s];
                  if (!ws) return null;
                  return {
                    slug: ws.slug,
                    name: ws.name,
                    url_key: ws.url_key,
                    viewer: ws.viewer,
                    created_at: ws.created_at,
                    is_default: stored.default === ws.slug,
                  };
                })
                .filter(Boolean),
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      if (slugs.length === 0) {
        process.stdout.write("no workspaces configured\n");
        return;
      }

      const slugWidth = Math.max(...slugs.map((s) => s.length));
      for (const slug of slugs) {
        const ws = stored.workspaces[slug];
        if (!ws) continue;
        const marker = stored.default === slug ? chalk.green("*") : " ";
        process.stdout.write(
          `${marker} ${chalk.bold(slug.padEnd(slugWidth))}  ${ws.name}  ${chalk.gray(ws.viewer.email)}\n`,
        );
      }
      process.stdout.write(
        `\n${chalk.gray("default marked with *. set with `lebop auth default <slug>`.")}\n`,
      );
    });

  auth
    .command("default [slug]")
    .description("show or set the default workspace")
    .action(async (slug: string | undefined) => {
      const stored = await loadAuth();
      if (!stored) {
        process.stderr.write(
          `${chalk.red("no credentials stored.")} run ${chalk.cyan("lebop auth login")}\n`,
        );
        process.exitCode = 1;
        return;
      }
      if (!slug) {
        // Read mode
        if (stored.default) {
          process.stdout.write(`${stored.default}\n`);
        } else {
          process.stdout.write(`${chalk.yellow("no default set")}\n`);
        }
        return;
      }
      // Write mode
      await setDefaultWorkspace(slug);
      process.stdout.write(`${chalk.green("✓")} default workspace set to ${chalk.bold(slug)}\n`);
    });

  auth
    .command("token [slug]")
    .description("print the API token for a workspace (handy for piping to curl)")
    .action(async (slug: string | undefined) => {
      const ws = await loadAuthForWorkspace(slug);
      process.stdout.write(`${ws.token}\n`);
    });

  auth
    .command("whoami [slug]")
    .description("print cached viewer for one workspace (or default); --refresh re-validates")
    .option("--refresh", "re-validate the stored token against Linear")
    .option("--json", "emit structured JSON")
    .action(async (slug: string | undefined, opts: { refresh?: boolean; json?: boolean }) => {
      const ws = await loadAuthForWorkspace(slug);
      let viewer = ws.viewer;
      let refreshed = false;

      if (opts.refresh) {
        viewer = await validateToken(ws.token);
        // Re-add the workspace so the cached viewer is current.
        await addWorkspace(ws.token);
        refreshed = true;
      }

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              schema_version: 1,
              workspace: ws.slug,
              workspace_name: ws.name,
              viewer,
              auth_file: AUTH_FILE,
              refreshed,
              created_at: ws.created_at,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      process.stdout.write(
        `${chalk.bold(viewer.name)} <${viewer.email}>\n  workspace: ${chalk.cyan(ws.slug)} (${ws.name})\n  id: ${viewer.id}\n  auth file: ${AUTH_FILE}\n  created: ${ws.created_at}${refreshed ? chalk.gray(" (just refreshed)") : ""}\n`,
      );
    });
}
