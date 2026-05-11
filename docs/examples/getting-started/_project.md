---
name: "Getting started: a tiny lebop plan"
description: "Walkthrough plan demonstrating projects, sub-issues, and link relations."
state: backlog
team: TEAM                          # replace with your team key (e.g. "ENG")
---

# Getting started

This is a minimal `lebop plan` directory you can copy and adapt.

To use it:

1. Replace `team: TEAM` with your team's key (run `lebop teams` to list keys).
2. (Optional) Tweak titles, labels, priorities, and bodies to match a real
   initiative.
3. `lebop plan validate docs/examples/getting-started`
4. `lebop plan apply docs/examples/getting-started --dry-run`
5. `lebop plan apply docs/examples/getting-started`

After the first apply, `linear_id:` is written back to each frontmatter and
slug-based link entries (`blocks: [02-impl]`) are rewritten to the real
identifier (`blocks: [TEAM-42]`). Re-applying is idempotent.
