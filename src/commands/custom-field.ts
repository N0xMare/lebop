import type { Command } from "commander";
import { addMachineOutputOptions, writeMachineEnvelope } from "../lib/output.ts";
import {
  buildCustomFieldGetIssueInputFromCli,
  buildCustomFieldListInputFromCli,
  buildCustomFieldSetIssueInputFromCli,
  executeCustomFieldGetIssue,
  executeCustomFieldList,
  executeCustomFieldSetIssue,
} from "../surface/coverage.ts";

export function registerCustomField(program: Command): void {
  const cf = program
    .command("custom-field")
    .description("Linear custom fields — list definitions, get/set issue values");

  const list = cf
    .command("list")
    .description("list custom field definitions")
    .option("--team-id <uuid>")
    .option("--limit <n>", "default 100", "100");
  addMachineOutputOptions(list);
  list.action(
    async (opts: {
      teamId?: string;
      limit?: string;
      json?: boolean;
      format?: string;
      pretty?: boolean;
    }) => {
      const result = await executeCustomFieldList(buildCustomFieldListInputFromCli({ opts }));
      writeMachineEnvelope(
        { ...result, next: ["custom-field get <issue>", "show <id>"] },
        { json: true, format: opts.format, pretty: opts.pretty },
      );
    },
  );

  const get = cf.command("get <issue>").description("get custom field values on an issue");
  addMachineOutputOptions(get);
  get.action(async (issue: string, opts: { json?: boolean; format?: string; pretty?: boolean }) => {
    const result = await executeCustomFieldGetIssue(
      buildCustomFieldGetIssueInputFromCli({ issue }),
    );
    writeMachineEnvelope(
      { ...result, next: ["custom-field set <issue> <field> <value>", "show <id>"] },
      { json: true, format: opts.format, pretty: opts.pretty },
    );
  });

  const set = cf
    .command("set <issue> <field> <value>")
    .description("set a custom field by name or id")
    .option("--team-id <uuid>");
  addMachineOutputOptions(set);
  set.action(
    async (
      issue: string,
      field: string,
      value: string,
      opts: { teamId?: string; json?: boolean; format?: string; pretty?: boolean },
    ) => {
      let parsed: unknown = value;
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = value;
      }
      const result = await executeCustomFieldSetIssue(
        buildCustomFieldSetIssueInputFromCli({
          issue,
          field,
          value: parsed,
          opts,
        }),
      );
      writeMachineEnvelope(
        { ...result, next: ["custom-field get <issue>", "show <id>"] },
        { json: true, format: opts.format, pretty: opts.pretty },
      );
    },
  );
}
