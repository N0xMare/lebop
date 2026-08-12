# Workspace lib modules

Public entrypoint:

| Path | Role |
|------|------|
| `lib/workspaceFetch.ts` | Thin orchestrator: `fetchLinearWorkspace` |
| `lib/workspace/fetchTypes.ts` | Shared fetch types |
| `lib/workspace/fetchShared.ts` | Constants + materialize/include/completeness helpers |
| `lib/workspace/fetchProject.ts` | Project kind context |
| `lib/workspace/fetchIssue.ts` | Issue kind context |
| `lib/workspace/fetchInitiative.ts` | Initiative kind context |
| `lib/workspace/fetchDocument.ts` | Document kind context |
| `lib/workspace/fetchCycle.ts` | Cycle kind context |
| `lib/workspace/fetchMilestone.ts` | Milestone kind context |
| `lib/workspace/fetchAgentSession.ts` | Agent-session kind context |
| `lib/workspaceExplore.ts` | Explore orchestrator + cursors |
| `lib/workspace/exploreItems.ts` | Pure explore row shapes |
| `lib/workspacePaths.ts` | Path parse |
| `lib/workspaceContextWriter.ts` | Dossier writes |

Extracts are **behavior-preserving** mechanical moves for maintainability.
