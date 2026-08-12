---
description: Push locally modified lebop cache entries to Linear (CLI, stale-guarded)
argument-hint: [optional ids / --project-id …]
---

**CLI only.** If `lebop` is missing, stop and report.

```sh
lebop status
lebop push --dry-run $ARGUMENTS
lebop push $ARGUMENTS
```

Stale remote → refuse; reconcile with `pull --refresh --yes` or deliberate `--force --yes` (skips all freshness preflight).  
Lint runs on push; `--strict` blocks on warnings.
