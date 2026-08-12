---
description: Lint markdown for Linear renderer quirks (CLI)
argument-hint: [paths…] [--fix] [--strict]
---

**CLI only.** If `lebop` is missing, stop and report.

```sh
lebop lint $ARGUMENTS
```

Omit paths to lint the repo cache. `--fix` safe rewrites; `--strict` fail on warnings.

Rules catch table-cell list markers and setext H2 (`text` + `---` with no blank line).
