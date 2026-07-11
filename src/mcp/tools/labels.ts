import { invalidateTeamMetadata } from "../../lib/cache.ts";
import { resolveConfig } from "../../lib/config.ts";
import { envelope } from "../../lib/envelope.ts";
import {
  buildLabelCreateInputFromMcp,
  buildLabelCreateMcpInputSchema,
  buildLabelDeleteInputFromMcp,
  buildLabelDeleteMcpInputSchema,
  buildLabelListInputFromMcp,
  buildLabelListMcpInputSchema,
  buildLabelLookupInputFromMcp,
  buildLabelLookupMcpInputSchema,
  executeLabelCreate,
  executeLabelDelete,
  executeLabelList,
  executeLabelLookup,
  type LabelCreateMcpInput,
  type LabelDeleteMcpInput,
  type LabelListMcpInput,
  type LabelLookupMcpInput,
  labelCreateOperation,
  labelDeleteOperation,
  labelListOperation,
  labelListPayload,
  labelLookupByNameOperation,
} from "../../surface/labels.ts";
import { resolveMcpRepoCacheContext, resolveTeamSelectorToId } from "../common.ts";
import { text } from "../response.ts";
import type { McpToolSpec } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface LabelToolDeps {
  workspaceParamDescription: string;
  requireConfirm: (args: { confirm?: boolean }, toolName: string) => void;
}

export function buildLabelToolSpecs(deps: LabelToolDeps): McpToolSpec[] {
  return [
    {
      name: "list_labels",
      config: mcpToolConfig(
        labelListOperation,
        buildLabelListMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: LabelListMcpInput) => {
        const result = await executeLabelList(buildLabelListInputFromMcp(args));
        return text(envelope(labelListPayload(result)));
      },
    },
    {
      name: "create_label",
      config: mcpToolConfig(
        labelCreateOperation,
        buildLabelCreateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: LabelCreateMcpInput) => {
        const result = await executeLabelCreate(buildLabelCreateInputFromMcp(args), {
          resolveTeamKey: async (team) => {
            const config = await resolveConfig({ teamOverride: team });
            return {
              teamId: await resolveTeamSelectorToId(config.team),
              teamKey: config.team,
              repoHash: config.repoHash,
            };
          },
        });
        await invalidateTeamMetadata(
          result.repoHash ?? resolveMcpRepoCacheContext(undefined).repoHash,
          result.invalidateTeam,
        );
        return text(
          envelope({
            label: result.label,
            scope: result.scope,
            team: result.team,
            team_id: result.team_id,
          }),
        );
      },
    },
    {
      name: "delete_label",
      config: mcpToolConfig(
        labelDeleteOperation,
        buildLabelDeleteMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: LabelDeleteMcpInput) => {
        deps.requireConfirm(args, "delete_label");
        const result = await executeLabelDelete(buildLabelDeleteInputFromMcp(args));
        if (result.mutated) {
          await invalidateTeamMetadata(
            resolveMcpRepoCacheContext(undefined).repoHash,
            result.team ?? undefined,
          );
        }
        return text(
          envelope({
            id: result.id,
            selector: result.selector,
            scope: result.scope,
            team: result.team,
            status: result.status,
            success: result.success,
          }),
        );
      },
    },
    {
      name: "lookup_label_by_name",
      config: mcpToolConfig(
        labelLookupByNameOperation,
        buildLabelLookupMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: LabelLookupMcpInput) => {
        const result = await executeLabelLookup(buildLabelLookupInputFromMcp(args));
        return text(
          envelope({
            label: result.label,
            scope: result.scope,
            team: result.team,
          }),
        );
      },
    },
  ];
}
