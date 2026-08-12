import { invalidateTeamMetadata } from "../../lib/cache.ts";
import { envelope } from "../../lib/envelope.ts";
import { mcpGetNext, mcpListNext } from "../../lib/nextStubs.ts";
import {
  buildProjectCreateInputFromMcp,
  buildProjectCreateMcpInputSchema,
  buildProjectDeleteInputFromMcp,
  buildProjectDeleteMcpInputSchema,
  buildProjectGetInput,
  buildProjectGetMcpInputSchema,
  buildProjectListInputFromMcp,
  buildProjectListMcpInputSchema,
  buildProjectUpdateInputFromMcp,
  buildProjectUpdateMcpInputSchema,
  executeProjectCreate,
  executeProjectDelete,
  executeProjectGet,
  executeProjectList,
  executeProjectUpdate,
  type ProjectCreateMcpInput,
  type ProjectDeleteMcpInput,
  type ProjectListMcpInput,
  type ProjectUpdateMcpInput,
  projectCreateOperation,
  projectDeleteOperation,
  projectGetOperation,
  projectListOperation,
  projectListPayload,
  projectUpdateOperation,
} from "../../surface/projects.ts";
import { text } from "../response.ts";
import type { McpToolSpec, ToolHandlerArgs } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface ProjectToolDeps {
  workspaceParamDescription: string;
  requireConfirm: (args: { confirm?: boolean }, toolName: string) => void;
  resolveTeamSelectorToId: (team: string) => Promise<string>;
  resolveDefaultTeamKey: () => Promise<string>;
  resolveTeam: (team: string | undefined) => Promise<string>;
  resolveMcpRepoCacheContext: (repoRoot: string | undefined) => {
    repoHash: string;
    repoRoot: string | null;
  };
  refreshCachedProjectAfterUpdate: Parameters<typeof executeProjectUpdate>[1]["refreshCache"];
}

export function buildProjectToolSpecs(deps: ProjectToolDeps): McpToolSpec[] {
  return [
    {
      name: "list_projects",
      config: mcpToolConfig(
        projectListOperation,
        buildProjectListMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ProjectListMcpInput) => {
        const result = await executeProjectList(buildProjectListInputFromMcp(args), {
          resolveTeam: deps.resolveTeam,
        });
        const body = projectListPayload(result);
        return text(
          envelope({
            ...body,
            // Core-profile-safe next (list_project_updates / milestones are full-only).
            next: mcpListNext("list_projects", body.has_more, body.next_cursor, [
              "get_project",
              "list_issues",
              "fetch_linear_workspace",
            ]),
          }),
        );
      },
    },
    {
      name: "get_project",
      config: mcpToolConfig(
        projectGetOperation,
        buildProjectGetMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ToolHandlerArgs) => {
        const { mcpEntityTruncatedNext } = await import("../../lib/nextStubs.ts");
        const { project, content, truncated } = await executeProjectGet(
          buildProjectGetInput(args.id as string, {
            fullContent: args.full_content === true,
            contentFile: typeof args.content_file === "string" ? args.content_file : undefined,
          }),
          "verify the project UUID; run list_projects to discover ids",
        );
        return text(
          envelope({
            project,
            content,
            next: truncated
              ? mcpEntityTruncatedNext("get_project", `id=${args.id}`)
              : mcpGetNext("list_issues", "fetch_linear_workspace", "pull_issues"),
          }),
        );
      },
    },
    {
      name: "create_project",
      config: mcpToolConfig(
        projectCreateOperation,
        buildProjectCreateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ProjectCreateMcpInput) => {
        const { project, teamIds } = await executeProjectCreate(
          buildProjectCreateInputFromMcp(args),
          {
            defaultTeamKey: deps.resolveDefaultTeamKey,
            resolveTeamKeyToId: deps.resolveTeamSelectorToId,
          },
        );
        await invalidateTeamMetadata(deps.resolveMcpRepoCacheContext(undefined).repoHash);
        return text(
          envelope({
            project,
            team_ids: teamIds,
            next: mcpGetNext("get_project", "list_issues", "fetch_linear_workspace"),
          }),
        );
      },
    },
    {
      name: "update_project",
      config: mcpToolConfig(
        projectUpdateOperation,
        buildProjectUpdateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ProjectUpdateMcpInput) => {
        const result = await executeProjectUpdate(buildProjectUpdateInputFromMcp(args), {
          refreshCache: deps.refreshCachedProjectAfterUpdate,
          resolveCacheContext: deps.resolveMcpRepoCacheContext,
        });
        await invalidateTeamMetadata(
          deps.resolveMcpRepoCacheContext(args.repo_root as string | undefined).repoHash,
        );
        return text(
          envelope({
            ...result,
            next: mcpGetNext("get_project", "list_issues"),
          }),
        );
      },
    },
    {
      name: "soft_delete_project",
      // Required true for deletion. The schema builder owns the field shape.
      config: mcpToolConfig(
        projectDeleteOperation,
        buildProjectDeleteMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: ProjectDeleteMcpInput) => {
        deps.requireConfirm(args, "soft_delete_project");
        const result = await executeProjectDelete(buildProjectDeleteInputFromMcp(args));
        if (result.status === "deleted") {
          await invalidateTeamMetadata(deps.resolveMcpRepoCacheContext(undefined).repoHash);
        }
        return text(envelope({ ...result, next: mcpGetNext("list_projects") }));
      },
    },
  ];
}
