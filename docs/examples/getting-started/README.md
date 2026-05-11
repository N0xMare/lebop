# getting-started — example lebop plan

A minimal three-issue plan that demonstrates the major plan features:

- A project (`_project.md`) with metadata + body
- Issues with `priority`, `estimate`, `labels`
- A `blocks` / `blocked_by` link pair
- A `parent:` sub-issue relationship
- A `related:` cross-link

## How to run it

```sh
# 1. Edit _project.md and set `team:` to your Linear team key
#    (run `lebop teams` to list keys).

# 2. Validate the plan (no Linear writes; just parses + checks).
lebop plan validate docs/examples/getting-started

# 3. Preview what `apply` would do.
lebop plan apply docs/examples/getting-started --dry-run

# 4. Apply for real. Creates the project + 3 issues + relations in Linear,
#    then writes `linear_id:` into each frontmatter.
lebop plan apply docs/examples/getting-started

# 5. Re-apply is idempotent — same files, no changes, no-op.
lebop plan apply docs/examples/getting-started
```

After step 4, all slug references (`blocks: [02-impl]`) become real Linear
identifiers (`blocks: [TEAM-42]`). The plan directory is now the source of
truth — edit the markdown, run `apply` again to push diffs.

## Cleanup

To clean up the issues this plan created in Linear:

```sh
# Lists the linear_ids written back into the plan files
grep linear_id docs/examples/getting-started/*.md

# Archive each one (reversible from the Linear UI)
lebop archive TEAM-42 TEAM-43 TEAM-44

# To archive the project too, use raw GraphQL (no first-class verb):
lebop raw 'mutation($id:String!){projectArchive(id:$id){success}}' \
  --variables-json '{"id":"<project-uuid-from-_project.md>"}'
```

## See also

- `docs/spec.md` — full plan format reference (frontmatter schema, apply
  semantics, idempotency rules, lint rules)
- `lebop plan --help` — CLI surface
