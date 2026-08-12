import type { Command } from "commander";
import { listNext } from "../lib/nextStubs.ts";
import { addMachineOutputOptions, writeMachineEnvelope } from "../lib/output.ts";
import {
  buildViewCreateInputFromCli,
  buildViewDeleteInputFromCli,
  buildViewGetInput,
  buildViewListInputFromCli,
  buildViewMaterializeInputFromCli,
  buildViewUpdateInputFromCli,
  executeViewCreate,
  executeViewDelete,
  executeViewGet,
  executeViewList,
  executeViewMaterialize,
  executeViewUpdate,
  viewListPayload,
  viewMaterializePayload,
} from "../surface/coverage.ts";

export function registerView(program: Command): void {
  const view = program
    .command("view")
    .description("Linear saved views (CustomView) full CRUD + materialize");

  const list = view
    .command("list")
    .description("list saved views")
    .option("--limit <n>", "max views", "50");
  addMachineOutputOptions(list);
  list.action(
    async (opts: { limit?: string; json?: boolean; format?: string; pretty?: boolean }) => {
      const result = await executeViewList(buildViewListInputFromCli({ opts }));
      writeMachineEnvelope(
        {
          ...viewListPayload(result),
          next: ["view get <id>", "view issues <id>"],
        },
        {
          json: true,
          format: opts.format,
          pretty: opts.pretty,
        },
      );
    },
  );

  const get = view.command("get <id>").description("get one saved view");
  addMachineOutputOptions(get);
  get.action(async (id: string, opts: { json?: boolean; format?: string; pretty?: boolean }) => {
    const v = await executeViewGet(buildViewGetInput(id));
    writeMachineEnvelope(
      { view: v, next: ["view issues <id>", "view update <id>"] },
      { json: true, format: opts.format, pretty: opts.pretty },
    );
  });

  const create = view
    .command("create")
    .description("create a saved view")
    .requiredOption("--name <name>")
    .option("--description <text>")
    .option("--team-id <uuid>")
    .option("--shared");
  addMachineOutputOptions(create);
  create.action(
    async (opts: {
      name: string;
      description?: string;
      teamId?: string;
      shared?: boolean;
      json?: boolean;
      format?: string;
      pretty?: boolean;
    }) => {
      const v = await executeViewCreate(buildViewCreateInputFromCli({ opts }));
      writeMachineEnvelope(
        { view: v, next: ["view issues <id>", "view get <id>"] },
        { json: true, format: opts.format, pretty: opts.pretty },
      );
    },
  );

  const update = view
    .command("update <id>")
    .description("update a saved view")
    .option("--name <name>")
    .option("--description <text>")
    .option("--shared");
  addMachineOutputOptions(update);
  update.action(
    async (
      id: string,
      opts: {
        name?: string;
        description?: string;
        shared?: boolean;
        json?: boolean;
        format?: string;
        pretty?: boolean;
      },
    ) => {
      const v = await executeViewUpdate(buildViewUpdateInputFromCli({ id, opts }));
      writeMachineEnvelope(
        { view: v, next: ["view issues <id>", "view get <id>"] },
        { json: true, format: opts.format, pretty: opts.pretty },
      );
    },
  );

  const del = view
    .command("delete <id>")
    .description("delete a saved view")
    .option("--yes", "confirm delete");
  addMachineOutputOptions(del);
  del.action(
    async (
      id: string,
      opts: { yes?: boolean; json?: boolean; format?: string; pretty?: boolean },
    ) => {
      const result = await executeViewDelete(buildViewDeleteInputFromCli({ id, opts }));
      writeMachineEnvelope(
        { ...result, next: ["view list"] },
        { json: true, format: opts.format, pretty: opts.pretty },
      );
    },
  );

  const issues = view
    .command("issues <id>")
    .description("materialize a saved view into a dense issue list")
    .option("--limit <n>", "page size", "50")
    .option("--cursor <token>");
  addMachineOutputOptions(issues);
  issues.action(
    async (
      id: string,
      opts: {
        limit?: string;
        cursor?: string;
        json?: boolean;
        format?: string;
        pretty?: boolean;
      },
    ) => {
      const result = await executeViewMaterialize(buildViewMaterializeInputFromCli({ id, opts }));
      const body = viewMaterializePayload(result);
      writeMachineEnvelope(
        {
          ...(body as Record<string, unknown>),
          next: listNext(Boolean(body.has_more), body.next_cursor, {
            show: "show <id>",
          }),
        },
        {
          json: true,
          format: opts.format,
          pretty: opts.pretty,
        },
      );
    },
  );
}
