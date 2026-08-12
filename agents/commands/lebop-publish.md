---
description: Review then apply plan or cache changes via publish workflow (CLI)
argument-hint: --plan <dir> | --cache [ids…] | apply <review_id>
---

**CLI only.** If `lebop` is missing, stop and report.

**Review** (preview + store `review_id`):

```sh
lebop publish review --plan <dir>
# or
lebop publish review --cache [IDS…]   # or --all-modified
```

**Apply** only the reviewed snapshot:

```sh
lebop publish apply <review_id>
```

Apply refuses if local review hash or remote `updatedAt` drifted.
