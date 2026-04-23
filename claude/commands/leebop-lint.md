---
description: Lint local markdown for Linear renderer quirks (table-cell markers, setext H2, etc.)
argument-hint: [paths…] [--fix] [--strict] [--json]
---

Run `leebop lint $ARGUMENTS` from the current working directory.

If no paths are provided, leebop scans `description.md` and `content.md` across the current repo's cache.

After it completes:
- If warnings were emitted and `--fix` was NOT passed, summarise which rules fired (e.g. "L001×2, L006×1") and offer to re-run with `--fix`. Don't auto-fix without asking — some fixes (like L006 inserting a blank line) shift line numbers and may not match the user's intent.
- If `--strict` was passed and exit was 1, that's the expected pre-commit gate — surface the count clearly.
- L003 / L005 are info-only with no autofix; flag those without offering `--fix`.

The rule catalog (full reference in the leebop SKILL):
- L001 — `N.` at table-cell start (autofix → `Row N — …`)
- L002 — `- ` / `* ` at table-cell start (autofix → `• …`)
- L003 — code fence with 4+ leading spaces (info)
- L005 — bare URL inside backticks (info)
- L006 — `text\n---` becomes `## text` setext H2 on push (autofix inserts blank line)

If `leebop` isn't on PATH, stop and report.
