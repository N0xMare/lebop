import chalk from "chalk";
import type { Command } from "commander";
import {
  type IssueCacheRefreshResult,
  refreshCachedIssueByIdentifier,
} from "../lib/cacheRefresh.ts";
import { envelope } from "../lib/envelope.ts";
import { NotFoundError, ValidationError } from "../lib/errors.ts";
import {
  assertRelationCreateConfirmed,
  createLink,
  deleteLink,
  findLink,
  LINK_KINDS,
  type LinkKind,
  listRelations,
  preflightCreateLink,
} from "../lib/relations.ts";
import { withClient } from "../lib/sdk.ts";

/**
 * `lebop relation add|delete|list` — first-class wrapper around lib/relations.ts.
 * Pair with `lebop set links +KIND:TARGET -KIND:TARGET ...` for batched delta
 * mutations on a single issue. The two surfaces are equivalent under the hood;
 * `relation` is per-pair, more readable for one-offs and MCP tools.
 */
export function registerRelation(program: Command): void {
  const rel = program
    .command("relation")
    .description("manage issue relations (blocks, related, etc.)");

  rel
    .command("add <id> <kind> <other>")
    .description(
      `add a relation between two issues. kinds: ${LINK_KINDS.join(" | ")}. (use \`lebop raw\` for \`similar\`, which lebop deliberately omits.)`,
    )
    .option(
      "--yes",
      "confirm replacement/destructive relation creation when an existing pair relation would be replaced or a duplicate relation may move issue state",
    )
    .option("--json", "emit structured result")
    .action(
      async (id: string, kind: string, other: string, opts: { json?: boolean; yes?: boolean }) => {
        const linkKind = parseKind(kind);
        const upperId = id.toUpperCase();
        const upperOther = other.toUpperCase();
        const preflight = await preflightCreateLink(upperId, upperOther, linkKind);
        assertRelationCreateConfirmed(preflight, opts.yes === true);

        // Resolve both issues to UUIDs in parallel.
        const [self, target] = await Promise.all([
          withClient((c) => c.issue(upperId)),
          withClient((c) => c.issue(upperOther)),
        ]);
        if (!self) throw new NotFoundError(`issue not found: ${upperId}`);
        if (!target) throw new NotFoundError(`link target not found: ${upperOther}`);

        if (preflight.exact) {
          const cacheWriteback: IssueCacheRefreshResult = {
            checked: false,
            present: false,
            refreshed: false,
            identifier: upperId,
          };
          if (opts.json) {
            process.stdout.write(
              `${JSON.stringify(
                envelope({
                  op: "add",
                  from: upperId,
                  kind: linkKind,
                  to: upperOther,
                  status: "unchanged",
                  relation_id: preflight.exact.id,
                  relation_preflight: preflight,
                  cache_writeback: cacheWriteback,
                }),
                null,
                2,
              )}\n`,
            );
            return;
          }
          process.stdout.write(
            `${chalk.gray("·")} ${chalk.bold(upperId)} ${chalk.cyan(linkKind)} ${chalk.bold(upperOther)} ${chalk.gray(`(${preflight.exact.id}, already present)`)}\n`,
          );
          return;
        }

        const result = await createLink(self.id, target.id, linkKind);
        const cacheWriteback = await refreshCachedIssueByIdentifier(upperId);
        const status = relationStatus("created", cacheWriteback);

        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(
              envelope({
                op: "add",
                from: upperId,
                kind: linkKind,
                to: upperOther,
                status,
                relation_id: result.id,
                relation_preflight: preflight,
                cache_writeback: cacheWriteback,
              }),
              null,
              2,
            )}\n`,
          );
          if (relationWritebackFailed(cacheWriteback)) process.exitCode = 1;
          return;
        }
        if (relationWritebackFailed(cacheWriteback)) {
          process.stdout.write(
            `${chalk.red("✗")} ${chalk.bold(upperId)} ${chalk.cyan(linkKind)} ${chalk.bold(upperOther)} created in Linear but local cache writeback failed: ${cacheWriteback.error?.message ?? "unknown error"}\n`,
          );
          process.exitCode = 1;
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} ${chalk.bold(upperId)} ${chalk.cyan(linkKind)} ${chalk.bold(upperOther)} ${chalk.gray(`(${result.id})`)}${cacheWriteback.refreshed ? chalk.gray(" (cache refreshed)") : ""}\n`,
        );
      },
    );

  rel
    .command("delete <id> <kind> <other>")
    .description("remove a relation between two issues (requires --yes)")
    .option("--yes", "confirm destructive operation (required)")
    .option("--json", "emit structured result")
    .action(
      async (id: string, kind: string, other: string, opts: { json?: boolean; yes?: boolean }) => {
        if (!opts.yes) {
          throw new ValidationError(
            "refusing to delete relation without --yes",
            "re-run with --yes to confirm this destructive state change",
          );
        }
        const linkKind = parseKind(kind);
        const upperId = id.toUpperCase();
        const upperOther = other.toUpperCase();

        const relationId = await findLink(upperId, upperOther, linkKind);
        if (!relationId) {
          if (opts.json) {
            process.stdout.write(
              `${JSON.stringify(
                envelope({
                  op: "delete",
                  from: upperId,
                  kind: linkKind,
                  to: upperOther,
                  status: "already-absent",
                }),
                null,
                2,
              )}\n`,
            );
          } else {
            process.stdout.write(
              `${chalk.gray("·")} ${chalk.bold(upperId)} ${chalk.cyan(linkKind)} ${chalk.bold(upperOther)} ${chalk.gray("(already absent)")}\n`,
            );
          }
          return;
        }

        await deleteLink(relationId);
        const cacheWriteback = await refreshCachedIssueByIdentifier(upperId);
        const status = relationStatus("deleted", cacheWriteback);
        if (opts.json) {
          process.stdout.write(
            `${JSON.stringify(
              envelope({
                op: "delete",
                from: upperId,
                kind: linkKind,
                to: upperOther,
                status,
                relation_id: relationId,
                cache_writeback: cacheWriteback,
              }),
              null,
              2,
            )}\n`,
          );
          if (relationWritebackFailed(cacheWriteback)) process.exitCode = 1;
          return;
        }
        if (relationWritebackFailed(cacheWriteback)) {
          process.stdout.write(
            `${chalk.red("✗")} removed ${chalk.bold(upperId)} ${chalk.cyan(linkKind)} ${chalk.bold(upperOther)} in Linear but local cache writeback failed: ${cacheWriteback.error?.message ?? "unknown error"}\n`,
          );
          process.exitCode = 1;
          return;
        }
        process.stdout.write(
          `${chalk.green("✓")} removed ${chalk.bold(upperId)} ${chalk.cyan(linkKind)} ${chalk.bold(upperOther)} ${chalk.gray(`(${relationId})`)}${cacheWriteback.refreshed ? chalk.gray(" (cache refreshed)") : ""}\n`,
        );
      },
    );

  rel
    .command("list <id>")
    .description("list outbound + inbound relations for an issue")
    .option("--json", "emit structured records")
    .action(async (id: string, opts: { json?: boolean }) => {
      const upperId = id.toUpperCase();
      const { outbound, inbound } = await listRelations(upperId);

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            envelope({
              identifier: upperId,
              outbound,
              inbound,
            }),
            null,
            2,
          )}\n`,
        );
        return;
      }

      if (outbound.length === 0 && inbound.length === 0) {
        process.stdout.write(`${chalk.gray("(no relations)")}\n`);
        return;
      }
      for (const r of outbound) {
        process.stdout.write(
          `${chalk.gray("→")} ${chalk.cyan(r.type)} ${chalk.bold(r.otherIdentifier)}\n`,
        );
      }
      for (const r of inbound) {
        process.stdout.write(
          `${chalk.gray("←")} ${chalk.cyan(r.type)} ${chalk.bold(r.otherIdentifier)}\n`,
        );
      }
    });
}

function relationWritebackFailed(cache: IssueCacheRefreshResult): boolean {
  return cache.present && !cache.refreshed && cache.error !== undefined;
}

function relationStatus(
  base: "created" | "deleted",
  cache: IssueCacheRefreshResult,
): "created" | "deleted" | "created-writeback-failed" | "deleted-writeback-failed" {
  if (!relationWritebackFailed(cache)) return base;
  return base === "created" ? "created-writeback-failed" : "deleted-writeback-failed";
}

function parseKind(input: string): LinkKind {
  const normalized = input.toLowerCase().replace(/_/g, "-");
  if (!(LINK_KINDS as readonly string[]).includes(normalized)) {
    // Round-8 / R8-LOW-3: ValidationError instead of raw Error so `--json`
    // emits `code: "validation_error"` (matches the documented taxonomy)
    // instead of falling through to the `code: "unknown"` fallback.
    throw new ValidationError(
      `unknown relation kind "${input}". supported: ${LINK_KINDS.join(", ")}`,
      `pick one of: ${LINK_KINDS.join(", ")} (use \`lebop raw\` for similar)`,
    );
  }
  return normalized as LinkKind;
}
