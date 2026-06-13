import { registerMcpToolSpecs } from "../adapter.ts";
import type { McpServerLike } from "../types.ts";
import {
  buildIssueBulkToolSpecs,
  buildIssueLifecycleToolSpecs,
  buildIssueListToolSpecs,
  type IssueToolDeps,
} from "./issues.ts";
import { buildProjectToolSpecs, type ProjectToolDeps } from "./projects.ts";
import { buildPublishToolSpecs, type PublishToolDeps } from "./publish.ts";
import { buildPullToolSpecs, type PullToolDeps } from "./pull.ts";
import { buildWorkspaceToolSpecs, type WorkspaceToolDeps } from "./workspace.ts";

export interface RegisterAllMcpToolsDeps {
  workspace: WorkspaceToolDeps;
  issues: IssueToolDeps;
  projects: ProjectToolDeps;
  pull: PullToolDeps;
  publish: PublishToolDeps;
}

export interface LegacyMcpToolRegistrars {
  afterIssueListBeforeProjects: (server: McpServerLike) => void;
  afterProjectsBeforeIssueLifecycle: (server: McpServerLike) => void;
  afterIssueLifecycleBeforePull: (server: McpServerLike) => void;
  afterPullBeforePublish: (server: McpServerLike) => void;
  afterPublishBeforeBulk: (server: McpServerLike) => void;
  afterBulk: (server: McpServerLike) => void;
}

export function registerAllMcpTools(
  server: McpServerLike,
  deps: RegisterAllMcpToolsDeps,
  legacy: LegacyMcpToolRegistrars,
): void {
  registerMcpToolSpecs(server, buildWorkspaceToolSpecs(deps.workspace));
  registerMcpToolSpecs(server, buildIssueListToolSpecs(deps.issues));
  legacy.afterIssueListBeforeProjects(server);
  registerMcpToolSpecs(server, buildProjectToolSpecs(deps.projects));
  legacy.afterProjectsBeforeIssueLifecycle(server);
  registerMcpToolSpecs(server, buildIssueLifecycleToolSpecs(deps.issues));
  legacy.afterIssueLifecycleBeforePull(server);
  registerMcpToolSpecs(server, buildPullToolSpecs(deps.pull));
  legacy.afterPullBeforePublish(server);
  registerMcpToolSpecs(server, buildPublishToolSpecs(deps.publish));
  legacy.afterPublishBeforeBulk(server);
  registerMcpToolSpecs(server, buildIssueBulkToolSpecs(deps.issues));
  legacy.afterBulk(server);
}
