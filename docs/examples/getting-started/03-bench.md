---
title: "Benchmark + verify"
state: Backlog
priority: normal
estimate: 3
labels: [type:feature]
blocked_by:
  - 02-impl
related:
  - 01-design
---

# Benchmark + verify

Validate the implementation meets the design's success criteria. Capture
numbers; add regression coverage.

`blocked_by` is the inverse of `blocks`. Either side of the relation can
declare it; lebop normalizes when the plan is applied.
