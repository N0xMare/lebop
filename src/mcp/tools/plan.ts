import { envelope } from "../../lib/envelope.ts";
import { ValidationError } from "../../lib/errors.ts";
import {
  buildPlanApplyInputFromMcp,
  buildPlanApplyMcpInputSchema,
  buildPlanDiffInputFromMcp,
  buildPlanDiffMcpInputSchema,
  buildPlanLintInputFromMcp,
  buildPlanLintMcpInputSchema,
  buildPlanPullInputFromMcp,
  buildPlanPullMcpInputSchema,
  buildPlanValidateInputFromMcp,
  buildPlanValidateMcpInputSchema,
  executePlanApply,
  executePlanDiff,
  executePlanLint,
  executePlanPull,
  executePlanValidate,
  type PlanApplyMcpInput,
  type PlanDiffMcpInput,
  type PlanLintMcpInput,
  type PlanPullMcpInput,
  type PlanValidateMcpInput,
  planApplyMcpPayload,
  planApplyOperation,
  planDiffMcpPayload,
  planDiffOperation,
  planLintMcpPayload,
  planLintOperation,
  planPullMcpPayload,
  planPullOperation,
  planValidateMcpPayload,
  planValidateOperation,
} from "../../surface/plan.ts";
import { text } from "../response.ts";
import type { McpToolSpec } from "../types.ts";
import { mcpToolConfig } from "./config.ts";

export interface PlanToolDeps {
  workspaceParamDescription: string;
  requireConfirm: (args: { confirm?: boolean }, toolName: string) => void;
}

export function buildPlanToolSpecs(deps: PlanToolDeps): McpToolSpec[] {
  return [
    {
      name: "plan_validate",
      config: mcpToolConfig(
        planValidateOperation,
        buildPlanValidateMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: PlanValidateMcpInput) => {
        const result = await executePlanValidate(buildPlanValidateInputFromMcp(args));
        return text(envelope(planValidateMcpPayload(result)));
      },
    },
    {
      name: "plan_lint",
      config: mcpToolConfig(
        planLintOperation,
        buildPlanLintMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: PlanLintMcpInput) => {
        const result = await executePlanLint(buildPlanLintInputFromMcp(args));
        return text(envelope(planLintMcpPayload(result)));
      },
    },
    {
      name: "plan_apply",
      config: mcpToolConfig(
        planApplyOperation,
        buildPlanApplyMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: PlanApplyMcpInput) => {
        const dryRun = args.dry_run === true;
        if (args.force === true && !dryRun) {
          deps.requireConfirm(args, "plan_apply force");
        }
        const result = await executePlanApply(buildPlanApplyInputFromMcp(args));
        return text(envelope(planApplyMcpPayload(result)));
      },
    },
    {
      name: "plan_diff",
      config: mcpToolConfig(
        planDiffOperation,
        buildPlanDiffMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: PlanDiffMcpInput) => {
        const result = await executePlanDiff(buildPlanDiffInputFromMcp(args));
        return text(envelope(planDiffMcpPayload(result)));
      },
    },
    {
      name: "plan_pull",
      config: mcpToolConfig(
        planPullOperation,
        buildPlanPullMcpInputSchema(deps.workspaceParamDescription),
      ),
      handler: async (args: PlanPullMcpInput) => {
        if (args.force === true) deps.requireConfirm(args, "plan_pull force");
        const outcome = await executePlanPull(buildPlanPullInputFromMcp(args));
        if (outcome.kind === "refused") {
          throw new ValidationError(outcome.mcpMessage, outcome.mcpHint);
        }
        return text(envelope(planPullMcpPayload(outcome)));
      },
    },
  ];
}
