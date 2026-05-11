---
description: Pull Linear issues/projects into ~/.lebop cache for editing
argument-hint: [issue-ids…] [--project NAME] [--project-id UUID] [--refresh] [--no-comments] [--to DIR]
---

Run `lebop pull $ARGUMENTS` from the current working directory.

After it completes:
1. If exit code is non-zero AND the failure was per-id (some pulled, some `not found`), summarise which succeeded and which didn't — don't just stop.
2. If the user appears to be starting an edit session, run `lebop status` so they (and you) see baseline cleanliness before any edits.
3. If `--to` was passed, remind that those files are export-only — edits there don't round-trip through `push`.
4. If no arguments were provided, ask the user which issues / project to pull rather than guessing.

If `lebop` isn't on PATH, stop and report — don't fall back to other tools without asking.
