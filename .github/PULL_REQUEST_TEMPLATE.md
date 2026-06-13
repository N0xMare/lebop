## Summary

<!-- One paragraph: what changed and why. Link the relevant `docs/spec.md`
section if this touches scope. -->

## Changes

<!-- Bullet list of behavior changes. Mention CLI/MCP surface if affected. -->

-

## Test plan

<!-- What you ran locally and what you observed. -->

- [ ] `bun run check` (biome)
- [ ] `bun run typecheck` (tsc --noEmit)
- [ ] `bun run test` (vitest)
- [ ] `actionlint .github/workflows/*.yml`
- [ ] `bun run check:package`
- [ ] Canary coverage considered if CLI/MCP read surfaces changed (`.github/workflows/canary.yml`, especially daily read smoke plus weekly full `workspace explore` / `workspace fetch` and MCP `explore_linear_workspace` / `fetch_linear_workspace`)
- [ ] Manual NOX/Noxor sandbox run if Linear mutation paths, publish/apply behavior, or full-surface release contracts changed (`LEBOP_LIVE_WORKSPACE=noxor LEBOP_LIVE_TEAM=NOX bun scripts/live-nox-surface-smoke.mjs`)
- [ ] Compiled-binary NOX/Noxor sandbox run if release artifact behavior changed (build a local binary, set `LEBOP_LIVE_BIN=/path/to/lebop`, then validate with compiled-binary provenance expectations when applicable)
- [ ] Validate the generated NOX/Noxor report when the live harness runs (`bun scripts/live-nox-surface-smoke.mjs --validate-report docs/local/live-nox-surface-report-<stamp>.json`)

## Notes for reviewers

<!-- Anything non-obvious: API quirks discovered, deferred follow-ups,
open questions. Delete this section if there's nothing to add. -->
