/**
 * Honest unit/contract tests for P0/P1 shipped surfaces the skeptic flagged:
 * search entrypoint, view CRUD shapes, custom-field name resolution helpers,
 * document create scope validation, and set machine encoding density.
 */
import { describe, expect, it, vi } from "vitest";
import { encodeEnvelope, parseFormatFlag, resolveOutputFormat } from "../src/lib/encode.ts";
import { ValidationError } from "../src/lib/errors.ts";
import { shapeHistoryNode } from "../src/lib/issueHistory.ts";
import { normalizeDueDate } from "../src/lib/issues.ts";
import { writeMachineEnvelope } from "../src/lib/output.ts";
import {
  buildDocumentCreateInputFromCli,
  buildDocumentCreateInputFromMcp,
} from "../src/surface/documents.ts";

describe("search entrypoint (shipped module)", () => {
  it("exports searchLinear from semanticSearch module", async () => {
    const mod = await import("../src/lib/semanticSearch.ts");
    expect(typeof mod.searchLinear).toBe("function");
    expect(mod.searchLinear.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects empty search queries via ValidationError without network", async () => {
    const { searchLinear } = await import("../src/lib/semanticSearch.ts");
    await expect(searchLinear({ query: "   " })).rejects.toBeInstanceOf(ValidationError);
    await expect(searchLinear({ query: "" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("custom views entrypoint (shipped module)", () => {
  it("exports full CRUD + materialize functions", async () => {
    const mod = await import("../src/lib/customViews.ts");
    for (const name of [
      "listCustomViews",
      "getCustomView",
      "createCustomView",
      "updateCustomView",
      "deleteCustomView",
      "materializeCustomView",
    ] as const) {
      expect(typeof mod[name], name).toBe("function");
    }
  });

  it("createCustomView rejects empty name without network", async () => {
    const { createCustomView } = await import("../src/lib/customViews.ts");
    await expect(createCustomView({ name: "  " })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("custom fields entrypoint (shipped module)", () => {
  it("exports list/get/set/resolve helpers", async () => {
    const mod = await import("../src/lib/customFields.ts");
    expect(typeof mod.listCustomFieldDefs).toBe("function");
    expect(typeof mod.getIssueCustomFields).toBe("function");
    expect(typeof mod.setIssueCustomField).toBe("function");
    expect(typeof mod.resolveCustomFieldIdByName).toBe("function");
  });
});

describe("lifecycle entrypoints (shipped modules)", () => {
  it("exports label update", async () => {
    const { updateLabel } = await import("../src/lib/labels.ts");
    expect(typeof updateLabel).toBe("function");
  });

  it("exports project update edit/delete", async () => {
    const mod = await import("../src/lib/projects.ts");
    expect(typeof mod.updateProjectUpdateEntry).toBe("function");
    expect(typeof mod.deleteProjectUpdateEntry).toBe("function");
  });

  it("exports initiative update edit/delete", async () => {
    const mod = await import("../src/lib/initiatives.ts");
    expect(typeof mod.updateInitiativeUpdateEntry).toBe("function");
    expect(typeof mod.deleteInitiativeUpdateEntry).toBe("function");
  });
});

describe("document create scope (surface + lib)", () => {
  it("CLI accepts --issue without project", () => {
    const input = buildDocumentCreateInputFromCli({
      title: "Spec",
      opts: { issue: "TEAM-1" },
      content: "body",
    });
    expect(input.issueId).toBe("TEAM-1");
    expect(input.project).toBeUndefined();
    expect(input.projectId).toBeUndefined();
  });

  it("CLI rejects neither project nor issue", () => {
    expect(() =>
      buildDocumentCreateInputFromCli({ title: "Spec", opts: {}, content: "x" }),
    ).toThrow(ValidationError);
  });

  it("CLI rejects both project and issue", () => {
    expect(() =>
      buildDocumentCreateInputFromCli({
        title: "Spec",
        opts: { project: "P", issue: "TEAM-1" },
        content: "x",
      }),
    ).toThrow(ValidationError);
  });

  it("MCP accepts issue_id without project", () => {
    const input = buildDocumentCreateInputFromMcp({
      title: "Spec",
      issue_id: "TEAM-9",
      content: "body",
    });
    expect(input.issueId).toBe("TEAM-9");
  });

  it("lib createDocument requires projectId or issueId", async () => {
    const { createDocument } = await import("../src/lib/documents.ts");
    await expect(createDocument({ title: "x" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("set machine encoding density (WS1)", () => {
  it("writeMachineEnvelope does not pretty-print by default", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    writeMachineEnvelope(
      {
        identifier: "TEAM-1",
        field: "due_date",
        input: { dueDate: "2026-09-01" },
        status: "updated",
      },
      { json: true },
    );
    spy.mockRestore();
    const out = writes.join("");
    expect(out).toContain("TEAM-1");
    expect(out).toContain("due_date");
    // Agent default is TOON (not pretty JSON object dump with braces).
    expect(out.trimStart().startsWith("{")).toBe(false);
    // Must not be pretty-printed JSON (which is `{` + newline + 2-space indent keys).
    expect(out).not.toMatch(/^\{\s*\n {2}"/);
    expect(parseFormatFlag({ json: true })).toBe("toon");
  });

  it("encodeEnvelope uses schema_version 2 and TOON for flat update acks", () => {
    const out = encodeEnvelope({
      identifier: "TEAM-1",
      field: "due_date",
      status: "updated",
    });
    expect(out).toContain("schema_version");
    expect(out).toContain("2");
    expect(
      resolveOutputFormat({ identifier: "TEAM-1", field: "due_date", status: "updated" }),
    ).toBe("toon");
  });
});

describe("P0 pure helpers still hold", () => {
  it("history shape + due date", () => {
    expect(
      shapeHistoryNode({
        id: "h",
        createdAt: "2026-01-01T00:00:00.000Z",
        fromState: { name: "Todo" },
        toState: { name: "Done" },
        actor: { name: "alice" },
      }),
    ).toEqual([
      {
        at: "2026-01-01T00:00:00.000Z",
        actor: "alice",
        kind: "state",
        from: "Todo",
        to: "Done",
      },
    ]);
    expect(normalizeDueDate("2026-08-08")).toBe("2026-08-08");
  });
});
