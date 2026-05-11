---
description: Push locally-modified lebop cache entries back to Linear (CAS-guarded)
argument-hint: [issue-ids…] [--dry-run] [--force] [--strict] [--json]
---

Before pushing:
1. Run `lebop status` to surface what's about to be pushed. If nothing's modified, stop and tell the user.
2. If the user didn't pass `--dry-run` AND the changes look risky (multi-issue, project content, or modifications to fields they didn't explicitly ask you to change), default to a `--dry-run` first and report the plan before applying.

Then run `lebop push $ARGUMENTS`.

After it completes:
- If any entity came back `stale`, the cache is behind Linear — surface this and recommend `lebop pull <id> --refresh` (do NOT auto-`--force` without asking).
- If any came back `lint-blocked`, show the lint warnings inline and offer to either fix them (`lebop lint --fix`) or push without `--strict` (with a clear explanation of why that's worse).
- On success, run `lebop status` once more to confirm the cache is clean.

If `lebop` isn't on PATH, stop and report.
