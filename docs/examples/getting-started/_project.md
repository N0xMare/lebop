---
name: "Getting started: a tiny lebop plan"
description: "Walkthrough plan demonstrating projects, sub-issues, and link relations."
state: backlog
team: TEAM                          # replace with your team key (e.g. "ENG")
---

# Getting started

This is a minimal `lebop plan` directory you can copy and adapt.

To use it:

1. Copy this directory first, for example:
   `mkdir -p plans && cp -R docs/examples/getting-started plans/getting-started-demo`.
2. In the copied `_project.md`, replace `team: TEAM` with your team's key
   (run `lebop teams` to list keys).
3. (Optional) Tweak titles, labels, priorities, and bodies to match a real
   initiative.
4. `lebop plan validate plans/getting-started-demo`
5. `lebop plan apply plans/getting-started-demo --dry-run`
6. `lebop plan apply plans/getting-started-demo`

After the first apply, `linear_id:` is written back to each frontmatter and
slug-based link entries (`blocks: [02-impl]`) are rewritten to the real
identifier (`blocks: [TEAM-42]`). Re-applying the copied plan is idempotent.
