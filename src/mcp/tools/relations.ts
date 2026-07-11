import { envelope } from "../../lib/envelope.ts";
import {
  buildRelationAddInputFromMcp,
  buildRelationAddMcpInputSchema,
  buildRelationDeleteInputFromMcp,
  buildRelationDeleteMcpInputSchema,
  buildRelationListInputFromMcp,
  buildRelationListMcpInputSchema,
  buildRelationUpdateInputFromMcp,
  buildRelationUpdateMcpInputSchema,
  executeRelationAdd,
  executeRelationDelete,
  executeRelationList,
  executeRelationUpdate,
  type RelationAddMcpInput,
  type RelationDeleteMcpInput,
  type RelationListMcpInput,
  type RelationMutationDeps,
  type RelationUpdateMcpInput,
  relationAddMcpPayload,
  relationAddOperation,
  relationDeleteMcpPayload,
  relationDeleteOperation,
  relationListOperation,
  relationListPayload,
  relationUpdateMcpPayload,
  relationUpdateOperation,
  relationUpdateRequiresConfirm,
} from "../../surface/relations.ts";
import { resolveMcpRepoCacheContext } from "../common.ts";
import { text } from "../response.ts";
import type { McpToolSpec } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface RelationToolDeps {
  workspaceParamDescription: string;
  requireConfirm: (args: { confirm?: boolean }, toolName: string) => void;
}

const mcpCacheDeps: RelationMutationDeps = {
  resolveCacheContext: (repoRoot) => resolveMcpRepoCacheContext(repoRoot),
};

export function buildRelationToolSpecs(deps: RelationToolDeps): McpToolSpec[] {
  return [
    {
      name: "add_relation",
      config: mcpToolConfig(
        relationAddOperation,
        buildRelationAddMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: RelationAddMcpInput) => {
        const result = await executeRelationAdd(buildRelationAddInputFromMcp(args), mcpCacheDeps);
        return text(envelope(relationAddMcpPayload(result)));
      },
    },
    {
      name: "update_relations",
      config: mcpToolConfig(
        relationUpdateOperation,
        buildRelationUpdateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: RelationUpdateMcpInput) => {
        // Confirm must run before execute (and before target resolution) for
        // remove / multi-kind-pair adds — behavior freeze with legacy handler.
        const preview = buildRelationUpdateInputFromMcp(args);
        if (relationUpdateRequiresConfirm(preview.deltas)) {
          deps.requireConfirm(args, "update_relations");
        }
        const result = await executeRelationUpdate(preview, mcpCacheDeps);
        return text(envelope(relationUpdateMcpPayload(result)));
      },
    },
    {
      name: "list_relations",
      config: mcpToolConfig(
        relationListOperation,
        buildRelationListMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: RelationListMcpInput) => {
        const result = await executeRelationList(buildRelationListInputFromMcp(args));
        return text(envelope(relationListPayload(result)));
      },
    },
    {
      name: "delete_relation",
      config: mcpToolConfig(
        relationDeleteOperation,
        buildRelationDeleteMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: RelationDeleteMcpInput) => {
        deps.requireConfirm(args, "delete_relation");
        const result = await executeRelationDelete(
          buildRelationDeleteInputFromMcp(args),
          mcpCacheDeps,
        );
        return text(envelope(relationDeleteMcpPayload(result)));
      },
    },
  ];
}
