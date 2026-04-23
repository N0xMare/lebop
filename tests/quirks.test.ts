import { describe, expect, it } from "vitest";
import { applyFixes, lintContent } from "../src/lib/lint.ts";

describe("L001 — ordered-list marker in table cell", () => {
  it("flags a table row with `1.`", () => {
    const content = ["| header | other |", "|---|---|", "| 1. First thing | other |"].join("\n");
    const { warnings } = lintContent(content);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.rule).toBe("L001");
    expect(warnings[0]?.line).toBe(3);
  });

  it("rewrites `N. text` to `Row N — text` on autofix", () => {
    const content = ["| col |", "|---|", "| 2. second item |"].join("\n");
    const { warnings } = lintContent(content);
    const fixed = applyFixes(content, warnings);
    expect(fixed).toContain("Row 2 — second item");
    expect(fixed).not.toContain("2. second item");
  });

  it("ignores `1.` outside of tables", () => {
    const content = "Just a sentence with 1. inside it.";
    expect(lintContent(content).warnings).toHaveLength(0);
  });

  it("ignores `1.` in a normal numbered list", () => {
    const content = ["- intro", "", "1. first", "2. second"].join("\n");
    expect(lintContent(content).warnings).toHaveLength(0);
  });
});

describe("L002 — bullet marker in table cell", () => {
  it("flags `- ` at cell start", () => {
    const content = ["| col |", "|---|", "| - bullet inside cell |"].join("\n");
    const { warnings } = lintContent(content);
    expect(warnings.some((w) => w.rule === "L002")).toBe(true);
  });

  it("rewrites `- text` to `• text` on autofix", () => {
    const content = ["| col |", "|---|", "| * starred |"].join("\n");
    const { warnings } = lintContent(content);
    const fixed = applyFixes(content, warnings);
    expect(fixed).toContain("• starred");
  });
});

describe("L003 — code fence with leading spaces", () => {
  it("flags `    ```` ", () => {
    const content = "    ```\n    some code\n    ```";
    const w = lintContent(content).warnings;
    expect(w.some((x) => x.rule === "L003")).toBe(true);
  });

  it("ignores fences without indent", () => {
    const content = "```\nfoo\n```";
    expect(lintContent(content).warnings).toHaveLength(0);
  });
});

describe("L005 — bare URL inside backticks", () => {
  it("flags `http(s)://...` in code span", () => {
    const content = "see `https://example.com` for details";
    const w = lintContent(content).warnings;
    expect(w.some((x) => x.rule === "L005")).toBe(true);
  });

  it("ignores plain URLs without backticks", () => {
    const content = "see https://example.com for details";
    expect(lintContent(content).warnings).toHaveLength(0);
  });
});

describe("L006 — setext-H2 from `text\\n---`", () => {
  it("flags the discovered Linear quirk", () => {
    const content = "Some intro text.\n---\nMore content below.";
    const { warnings } = lintContent(content);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.rule).toBe("L006");
    expect(warnings[0]?.line).toBe(2); // points at the `---` line
  });

  it("inserts blank line before `---` on autofix", () => {
    const content = "Some intro.\n---\nrest";
    const { warnings } = lintContent(content);
    const fixed = applyFixes(content, warnings);
    expect(fixed).toBe("Some intro.\n\n---\nrest");
    // re-running lint on fixed content emits no L006
    expect(lintContent(fixed).warnings.filter((w) => w.rule === "L006")).toHaveLength(0);
  });

  it("ignores `---` after a blank line (real horizontal rule)", () => {
    const content = "Some text.\n\n---\nrest";
    expect(lintContent(content).warnings.filter((w) => w.rule === "L006")).toHaveLength(0);
  });

  it("ignores `---` after a heading", () => {
    const content = "## Heading\n---\nrest";
    expect(lintContent(content).warnings.filter((w) => w.rule === "L006")).toHaveLength(0);
  });

  it("ignores `---` after another rule line", () => {
    const content = "***\n---\nrest";
    expect(lintContent(content).warnings.filter((w) => w.rule === "L006")).toHaveLength(0);
  });
});

describe("applyFixes ordering", () => {
  it("applies bottom-up so earlier line numbers don't shift later fixes", () => {
    const content = ["intro 1", "---", "middle", "intro 2", "---", "tail"].join("\n");
    const { warnings } = lintContent(content);
    expect(warnings.filter((w) => w.rule === "L006")).toHaveLength(2);
    const fixed = applyFixes(content, warnings);
    // both `---` should now have a blank line before
    expect(fixed).toBe(["intro 1", "", "---", "middle", "intro 2", "", "---", "tail"].join("\n"));
  });
});
