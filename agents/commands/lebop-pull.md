---
description: Pull Linear issues/projects into ~/.lebop cache for editing (CLI)
argument-hint: [ids or --project …]
---

**CLI only.** If `lebop` is missing, stop and report.

```sh
lebop pull $ARGUMENTS
```

Prefer ids, ranges (`TEAM-1..TEAM-5`), or `--project` / `--project-id`.  
Overwrite dirty cache only with `--refresh --yes`.  
Export without cache: `--to DIR`.

Print the cache path from output. Edit `description.md` / `metadata.yaml` (not `_server:`). Then `/lebop-push` or `publish review --cache` → `publish apply`.
