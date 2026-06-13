---
description: Explore and fetch Linear workspace context into local dossier files
argument-hint: [path-or-query] [explore flags] [fetch flags]
---

Use `lebop workspace explore` first, then `lebop workspace fetch` for the concrete path that best matches the user's request.

Default flow:
1. Parse `$ARGUMENTS` into flags and search text before calling lebop. Do not include recognized flags in the query string.
   - Explore flags: `--team KEY`, `--kind issue|project|initiative|document|cycle|milestone|agent-session`, `--include-archived`, `--limit N`, `--cursor TOKEN`, and explicit `--query TEXT`.
   - Fetch flags: `--include ITEMS`, `--include ""` for an explicit empty include, `--depth shallow|full`, fetch `--limit N`, `--cursor TOKEN` from a fetch continuation, and `--to DIR`.
   - Treat a user-supplied `--limit` as an explore page-size limit unless they clearly asked to bound the fetched dossier or you are following a fetch continuation.
   - `--team` narrows only project, issue, and cycle searches/listings. For initiatives, documents, milestones, and agent sessions, narrow with `--kind`, concrete paths, child paths, smaller limits, or fetch `--include`/`--depth` instead.
2. If the non-flag text is a concrete path or identifier, pass it directly to `lebop workspace explore <path-or-id> --json` plus the parsed explore flags. Bare issue IDs like `TEAM-NN` and already-qualified paths like `/projects/<id>` are both accepted.
3. If the non-flag text is abstract wording, run `lebop workspace explore / --query "<search text>" --json` plus the parsed explore flags, adding an obvious `--kind` when the user did not already supply one. Add `--team` only when the intended scope is project, issue, or cycle.
4. Pick the best fetchable `path` from the result and run `lebop workspace fetch <path> --json` plus the parsed fetch flags.
5. Read the returned manifest and recommended files before answering.
6. If the fetch reports `continuations`, follow only the continuations needed for the user's question.

Fetch defaults: omitted `--include` uses the dossier defaults; `--include ""` fetches only the root entity shell; omitted `--depth` defaults to `full`; fetch `--limit` applies per collection/relation direction, not as a global file budget; `--to DIR` writes the dossier outside the default `~/.lebop/context/` location.

If a JSON result includes `_meta.linear_api`, treat it as Linear API budget telemetry. When request or complexity remaining is low, narrow follow-up calls with a concrete path, `--kind`, child path, smaller explore/fetch `--limit`, fetch `--include`/`--depth`, or `--team` only for project/issue/cycle discovery.

If explore exposes a narrower child path such as `/issues/<id>/documents`, fetch that child path directly when it is the best match for the question.

Do not use `pull` for research-only work. `workspace fetch` writes research dossiers under `~/.lebop/context/`; it does not create editable cache rows for `push`.

For MCP sessions, use the same flow with `explore_linear_workspace` and `fetch_linear_workspace`; bare issue IDs like `TEAM-NN` can be passed directly as the `path` / `target` argument. The fetch equivalents are `fetch_linear_workspace.include` (`include: []` for explicit empty include), `depth`, `limit`, and `to`.

If `lebop` is not on PATH, stop and report the missing binary.
