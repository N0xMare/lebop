# getting-started — example lebop plan

A minimal three-issue plan that demonstrates the major plan features:

- A project (`_project.md`) with metadata + body
- Issues with `priority`, `estimate`, `labels`
- A `blocks` / `blocked_by` link pair
- A `parent:` sub-issue relationship
- A `related:` cross-link

## How to run it

```sh
# 1. Copy the template out of docs/examples before applying.
mkdir -p plans
rm -rf plans/getting-started-demo
cp -R docs/examples/getting-started plans/getting-started-demo
plan_dir=plans/getting-started-demo

# 2. Edit "$plan_dir/_project.md" and set `team:` to your Linear team key
#    (run `lebop teams` to list keys).

# (Optional) The three issue files include a `labels: [type:feature]` line
# as an example. If your workspace doesn't have that label, either:
#   - create one first:  lebop label create --team YOUR-TEAM type:feature
#   - or delete the `labels:` line from each issue file before running.

# 3. Validate the plan (no Linear writes; just parses + checks).
lebop plan validate "$plan_dir"

# 4. Preview what `apply` would do.
lebop plan apply "$plan_dir" --dry-run

# 5. Apply for real. Creates the project + 3 issues + relations in Linear,
#    then writes `linear_id:` into each frontmatter.
lebop plan apply "$plan_dir"

# 6. Re-apply is idempotent — same files, no changes, no-op.
lebop plan apply "$plan_dir"
```

`docs/examples/getting-started` is a read-only template. After step 5, all
slug references (`blocks: [02-impl]`) in your copied plan become real Linear
identifiers (`blocks: [TEAM-42]`). The copied plan directory is now the
source of truth — edit the markdown, run `apply` again to push diffs.

## Cleanup

To clean up the issues this plan created in Linear:

```sh
# Lists the linear_ids written back into the plan files
grep linear_id plans/getting-started-demo/*.md

# Archive each one (reversible from the Linear UI)
lebop archive TEAM-42 TEAM-43 TEAM-44 --yes

# To clean up the project too, use the first-class project command:
lebop project delete <project-uuid-from-_project.md> --yes
```

## See also

- `docs/spec.md` — full plan format reference (frontmatter schema, apply
  semantics, idempotency rules, lint rules)
- `lebop plan --help` — CLI surface
