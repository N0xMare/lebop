---
description: Review then publish Linear plan or cache changes through lebop
argument-hint: [--plan DIR | --cache IDS... | --cache --project-id UUID... | --cache --all-modified] [--team KEY] [--strict]
---

Use the reviewed publish workflow instead of applying high-risk Linear writes directly.

Default flow:
1. Treat `$ARGUMENTS` as review arguments only. If the user included `--no-verify`, remove it from the review command and remember it only for the approved apply step.
2. Run `lebop publish review $REVIEW_ARGUMENTS --json`.
3. Inspect the returned readiness summary, blockers, validation errors, lint warnings, drift, and planned operations.
4. If the review is not ready, stop and explain the blockers.
5. If the review is ready but the user has not explicitly approved the publish, show the review summary and wait.
6. After approval, run `lebop publish apply <review-id> --json`.
7. Confirm the apply response reports `status: "verified"`.

`--no-verify` is apply-only. Do not pass it to `publish review`; after approval, append it only when the user explicitly asks to skip post-publish verification, and report that the result is unverified.

For cache edits, prefer `--cache IDS...` for issue rows, `--cache --project-id UUID...` for project rows, or `--cache --all-modified` only when the user intended every modified cache row.

For MCP sessions, use `review_linear_changes` followed by `publish_linear_changes`.

If `lebop` is not on PATH, stop and report the missing binary.
