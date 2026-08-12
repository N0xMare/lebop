import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  buildRootCatalog,
  densifyDescription,
  formatAgentHelpText,
  formatCommanderHelp,
  groupForCommand,
} from "../src/lib/agentHelp.ts";

describe("agentHelp", () => {
  it("densifyDescription collapses whitespace and truncates", () => {
    expect(densifyDescription("  a   b  ", 10)).toBe("a b");
    expect(densifyDescription("x".repeat(100), 20).endsWith("…")).toBe(true);
  });

  it("groupForCommand maps verbs", () => {
    expect(groupForCommand("list")).toBe("read");
    expect(groupForCommand("pull")).toBe("cache");
    expect(groupForCommand("auth")).toBe("meta");
  });

  it("formatCommanderHelp emits machine envelope not Usage:", () => {
    const program = new Command();
    program.name("lebop").description("test");
    program.command("list").description("discover issues");
    program.command("pull").description("fetch into cache");
    const out = formatCommanderHelp(program);
    expect(out).toContain("schema_version");
    expect(out).not.toMatch(/^Usage:/m);
    expect(out).toContain("list");
    expect(out).toContain("pull");
  });

  it("buildRootCatalog counts cmds", () => {
    const program = new Command();
    program.command("a").description("alpha");
    program.command("b").description("beta");
    const cat = buildRootCatalog(program);
    expect(cat.n).toBe(2);
    expect(cat.cmds.map((c) => c.n).sort()).toEqual(["a", "b"]);
  });

  it("formatAgentHelpText respects format json", () => {
    const text = formatAgentHelpText({ ok: true, n: 1 }, "json");
    expect(text.startsWith("{")).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ ok: true, n: 1, schema_version: 2 });
  });
});
