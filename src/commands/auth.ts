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
import { setWorkspaceDefaultTeam } from "../lib/configWrite.ts";
import { envelope } from "../lib/envelope.ts";
import { AuthError, NotFoundError, ValidationError } from "../lib/errors.ts";
import { AUTH_FILE_DISPLAY, AUTH_STORAGE_KIND } from "../lib/paths.ts";
import { promptHidden } from "../lib/prompt.ts";
import { runWithRequestContext } from "../lib/requestContext.ts";
import { getTeam } from "../lib/teams.ts";

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

      const ws = await addWorkspace(token);
      process.stdout.write(
        `${chalk.green("✓")} authenticated to ${chalk.bold(ws.name)} (${chalk.cyan(ws.slug)}) as ${ws.viewer.name} <${ws.viewer.email}>\n`,
      );
      process.stdout.write(`  credentials saved to ${AUTH_FILE_DISPLAY} (mode 0600)\n`);
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
      const stored = await loadAuth();
      if (!stored) {
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(
              envelope({
                auth_file: AUTH_FILE_DISPLAY,
                auth_storage: AUTH_STORAGE_KIND,
                default: null,
                workspaces: [],
              }),
              null,
              2,
            )}\n`,
          );
          return;
        }
        process.stdout.write("no workspaces configured\n");
        return;
      }
      const slugs = Object.keys(stored.workspaces);

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            envelope({
              auth_file: AUTH_FILE_DISPLAY,
              auth_storage: AUTH_STORAGE_KIND,
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
            }),
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
    .option("--json", "emit structured result")
    .action(async (slug: string | undefined, opts: { json?: boolean }) => {
      const stored = await loadAuth();
      if (!slug) {
        // Read mode
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(envelope({ default: stored?.default ?? null }), null, 2)}\n`,
          );
          return;
        }
        if (stored?.default) {
          process.stdout.write(`${stored.default}\n`);
        } else {
          process.stdout.write(`${chalk.yellow("no default set")}\n`);
        }
        return;
      }
      // Write mode
      if (!stored) {
        throw new AuthError("no credentials stored", "run `lebop auth login` first");
      }
      await setDefaultWorkspace(slug);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(envelope({ default: slug }), null, 2)}\n`);
        return;
      }
      process.stdout.write(`${chalk.green("✓")} default workspace set to ${chalk.bold(slug)}\n`);
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
      const ws = await loadAuthForWorkspace(slug);
      if (opts.unsafe) {
        process.stdout.write(`${ws.token}\n`);
        return;
      }
      // Mask all but the last 4 chars; preserve the `lin_api_` (or whatever)
      // prefix so callers can still verify which kind of token it is.
      const t = ws.token;
      const tail = t.slice(-4);
      // Find the prefix separator (`_` after the kind), else fall back to
      // the first 8 chars as a stable "head" window.
      const sepIdx = t.indexOf("_", 4);
      const head = sepIdx > 0 ? t.slice(0, sepIdx + 1) : t.slice(0, 8);
      const hidden = "*".repeat(Math.max(4, t.length - head.length - tail.length));
      process.stderr.write(`${chalk.gray("(masked — pass --unsafe to print the full token)")}\n`);
      process.stdout.write(`${head}${hidden}${tail}\n`);
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

      // Round-6 / CLI 11: surface the workspace-default marker so callers
      // can tell whether `lebop` is talking to the default workspace
      // without a separate `auth list` round-trip. Matches the `*` marker
      // emitted in human mode by `auth list`.
      const fullAuth = await loadAuth();
      const isDefault = fullAuth?.default === ws.slug;

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            envelope({
              workspace: ws.slug,
              workspace_name: ws.name,
              is_default: isDefault,
              viewer,
              auth_file: AUTH_FILE_DISPLAY,
              auth_storage: AUTH_STORAGE_KIND,
              refreshed,
              created_at: ws.created_at,
            }),
            null,
            2,
          )}\n`,
        );
        return;
      }

      const defaultMarker = isDefault ? chalk.gray(" [default]") : "";
      process.stdout.write(
        `${chalk.bold(viewer.name)} <${viewer.email}>\n  workspace: ${chalk.cyan(ws.slug)} (${ws.name})${defaultMarker}\n  id: ${viewer.id}\n  auth file: ${AUTH_FILE_DISPLAY}\n  created: ${ws.created_at}${refreshed ? chalk.gray(" (just refreshed)") : ""}\n`,
      );
    });

  auth
    .command("set-default-team <workspace> <team>")
    .description(
      "set the per-workspace default team (writes workspace_team_defaults in ~/.lebop/config.yaml)",
    )
    .option("--json", "emit structured result")
    .action(async (workspace: string, team: string, opts: { json?: boolean }) => {
      let canonicalTeam = team;
      // Round-11 / M-2: validate the team exists in the target workspace
      // before writing to config. Scoped via `LEBOP_WORKSPACE` env var so
      // `getTeam` (which uses `withClient` → the workspace-aware
      // `linear()` selector) targets the right Linear org.
      await runWithRequestContext({ workspace }, async () => {
        const t = await getTeam(team);
        if (!t) {
          throw new NotFoundError(
            `team not found: ${team}`,
            `run \`lebop --workspace ${workspace} teams\` to list valid keys`,
          );
        }
        canonicalTeam = t.key;
      });
      await setWorkspaceDefaultTeam(workspace, canonicalTeam);
      if (opts.json) {
        process.stdout.write(
          // Round-7 / HIGH-3: response envelope key renamed `team_key` →
          // `team` to match the MCP-side `set_workspace_default_team`
          // rename (round-6 / C1). Both surfaces now agree on `team`.
          `${JSON.stringify(envelope({ workspace_slug: workspace, team: canonicalTeam }), null, 2)}\n`,
        );
        return;
      }
      process.stdout.write(
        `${chalk.green("✓")} default team for ${chalk.cyan(workspace)} set to ${chalk.bold(canonicalTeam)}\n`,
      );
    });
}
