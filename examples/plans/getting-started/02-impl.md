---
title: "Implementation"
state: Backlog
priority: normal
estimate: 5
labels: [type:feature]
parent: 01-design                   # this issue is a sub-issue of 01-design
blocked_by:
  - 01-design
---

# Implementation

Build the design. Land in small, reviewable PRs.

Note the `parent: 01-design` frontmatter — this issue will render as a
sub-issue of "Design" in Linear. Parents are created before children;
lebop topologically sorts the apply order.
