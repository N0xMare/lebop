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
- [ ] Manual sandbox run if mutation paths changed (`ENG-359` / `ENG-360` only — these were renamed from `UE-359` / `UE-360` when the workspace team was rekeyed `UE → ENG`; Linear's identifier-redirect still resolves either form)

## Notes for reviewers

<!-- Anything non-obvious: API quirks discovered, deferred follow-ups,
open questions. Delete this section if there's nothing to add. -->
