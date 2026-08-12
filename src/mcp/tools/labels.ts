import { invalidateTeamMetadata } from "../../lib/cache.ts";
import { resolveConfig } from "../../lib/config.ts";
import { envelope } from "../../lib/envelope.ts";
import { mcpGetNext } from "../../lib/nextStubs.ts";
import {
  buildLabelCreateInputFromMcp,
  buildLabelCreateMcpInputSchema,
  buildLabelDeleteInputFromMcp,
  buildLabelDeleteMcpInputSchema,
  buildLabelListInputFromMcp,
  buildLabelListMcpInputSchema,
  buildLabelLookupInputFromMcp,
  buildLabelLookupMcpInputSchema,
  buildLabelUpdateInputFromMcp,
  buildLabelUpdateMcpInputSchema,
  executeLabelCreate,
  executeLabelDelete,
  executeLabelList,
  executeLabelLookup,
  executeLabelUpdate,
  type LabelCreateMcpInput,
  type LabelDeleteMcpInput,
  type LabelListMcpInput,
  type LabelLookupMcpInput,
  type LabelUpdateMcpInput,
  labelCreateOperation,
  labelDeleteOperation,
  labelListOperation,
  labelListPayload,
  labelLookupByNameOperation,
  labelUpdateOperation,
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
        return text(
          envelope({
            ...labelListPayload(result),
            next: mcpGetNext("list_issues", "create_label", "lookup_label_by_name"),
          }),
        );
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
            next: mcpGetNext("list_labels", "list_issues"),
          }),
        );
      },
    },
    {
      name: "update_label",
      config: mcpToolConfig(
        labelUpdateOperation,
        buildLabelUpdateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: LabelUpdateMcpInput) => {
        const label = await executeLabelUpdate(buildLabelUpdateInputFromMcp(args));
        await invalidateTeamMetadata(
          resolveMcpRepoCacheContext(undefined).repoHash,
          label.team?.key ?? undefined,
        );
        return text(envelope({ label, next: mcpGetNext("list_labels", "list_issues") }));
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
            next: mcpGetNext("list_labels"),
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
            next: mcpGetNext("list_labels", "list_issues", "update_issue"),
          }),
        );
      },
    },
  ];
}
