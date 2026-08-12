---
description: Explore and fetch Linear workspace context into local research dossiers (CLI)
argument-hint: [path-or-query] [explore/fetch flags]
---

**CLI only.** Machine output is default (TOON). If `lebop` is missing from PATH, stop and report.

1. Parse `$ARGUMENTS` into flags vs search text (do not put flags in the query).
2. Explore: `lebop workspace explore <path-or-id>` or `explore / --query "…"` with explore flags.
3. Pick a fetchable path; `lebop workspace fetch <path>` with fetch flags.
4. Read manifest / recommended files. Follow `continuations` only as needed.

Defaults: explore page size via `--limit`; fetch **depth shallow** unless `--depth full`; `--include ""` for shell only; `--team` only for project/issue/cycle.

Research files under `~/.lebop/context/…` — not cache. Do not `pull` for research-only.
