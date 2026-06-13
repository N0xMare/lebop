import { describe, expect, it } from "vitest";
import { applyFixes, lintContent } from "../src/lib/lint.ts";
import type { LintContext } from "../src/lib/quirks.ts";

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

// ---------- L004 — bracket issue refs (repo-scoped) ----------

describe("L004 — bracket issue refs", () => {
  const ctx: LintContext = {
    repoConfig: { conventions: { bracket_issue_refs: true } },
    workspaceUrlPrefix: "https://linear.app/unlink-xyz",
  };

  it("does nothing when conventions.bracket_issue_refs is unset", () => {
    const content = "See UE-321 for context.";
    expect(lintContent(content).warnings).toHaveLength(0);
  });

  it("does nothing when workspaceUrlPrefix is missing", () => {
    const content = "See UE-321 for context.";
    expect(
      lintContent(content, { repoConfig: { conventions: { bracket_issue_refs: true } } }).warnings,
    ).toHaveLength(0);
  });

  it("flags bare `TEAM-NN` refs", () => {
    const content = "See UE-321 for context.";
    const w = lintContent(content, ctx).warnings.filter((x) => x.rule === "L004");
    expect(w).toHaveLength(1);
  });

  it("flags bare refs with digit-bearing team keys", () => {
    const content = "See A1-42 for context.";
    const w = lintContent(content, ctx).warnings.filter((x) => x.rule === "L004");
    expect(w).toHaveLength(1);
    expect(w[0]?.message).toContain("A1-42");
  });

  it("autofix wraps bare refs in markdown links with workspace URL", () => {
    const content = "See UE-321 for context.";
    const { warnings } = lintContent(content, ctx);
    const fixed = applyFixes(content, warnings);
    expect(fixed).toBe("See [UE-321](https://linear.app/unlink-xyz/issue/UE-321) for context.");
  });

  it("ignores refs already wrapped in markdown links", () => {
    const content = "[UE-321](https://linear.app/unlink-xyz/issue/UE-321) is done.";
    expect(lintContent(content, ctx).warnings.filter((w) => w.rule === "L004")).toHaveLength(0);
  });

  it("ignores refs inside code spans", () => {
    const content = "Run `UE-321` to test.";
    expect(lintContent(content, ctx).warnings.filter((w) => w.rule === "L004")).toHaveLength(0);
  });

  it("handles multiple refs on one line", () => {
    const content = "UE-321 blocks UE-322.";
    const { warnings } = lintContent(content, ctx);
    const ue = warnings.filter((w) => w.rule === "L004");
    expect(ue).toHaveLength(2);
    const fixed = applyFixes(content, warnings);
    expect(fixed).toContain("[UE-321](");
    expect(fixed).toContain("[UE-322](");
  });
});

// ---------- R001 — path_rewrites ----------

describe("R001 — path rewrites", () => {
  const ctx: LintContext = {
    repoConfig: {
      path_rewrites: [{ from: "crates/", to: "protocol/backend/crates/" }],
    },
  };

  it("does nothing when path_rewrites is unset", () => {
    const content = "See crates/auth for details.";
    expect(lintContent(content).warnings.filter((w) => w.rule === "R001")).toHaveLength(0);
  });

  it("flags bare `crates/…` that's not under protocol/backend/", () => {
    const content = "See crates/auth for details.";
    const w = lintContent(content, ctx).warnings.filter((x) => x.rule === "R001");
    expect(w).toHaveLength(1);
  });

  it("ignores `crates/…` already prefixed with `protocol/backend/`", () => {
    const content = "See protocol/backend/crates/auth for details.";
    expect(lintContent(content, ctx).warnings.filter((w) => w.rule === "R001")).toHaveLength(0);
  });

  it("autofix prepends the `to` prefix", () => {
    const content = "Edit crates/auth/src/lib.rs.";
    const { warnings } = lintContent(content, ctx);
    const fixed = applyFixes(content, warnings);
    expect(fixed).toBe("Edit protocol/backend/crates/auth/src/lib.rs.");
  });

  it("handles multiple rewrites independently", () => {
    const multiCtx: LintContext = {
      repoConfig: {
        path_rewrites: [
          { from: "crates/", to: "protocol/backend/crates/" },
          { from: "apps/", to: "src/apps/" },
        ],
      },
    };
    const content = "Edit crates/a and apps/b.";
    const fixed = applyFixes(content, lintContent(content, multiCtx).warnings);
    expect(fixed).toBe("Edit protocol/backend/crates/a and src/apps/b.");
  });
});

// ---------- R002 — required_formats ----------

describe("R002 — required formats", () => {
  const ctx: LintContext = {
    repoConfig: {
      required_formats: [
        { pattern: "\\bpr-(\\d+)\\b", suggest: "[#$1]", message: "Use [#N] form" },
      ],
    },
  };

  it("does nothing when required_formats is unset", () => {
    const content = "See pr-123 for the fix.";
    expect(lintContent(content).warnings.filter((w) => w.rule === "R002")).toHaveLength(0);
  });

  it("flags patterns that match", () => {
    const content = "See pr-123 for the fix.";
    const w = lintContent(content, ctx).warnings.filter((x) => x.rule === "R002");
    expect(w).toHaveLength(1);
    expect(w[0]?.message).toContain("Use [#N] form");
  });

  it("autofix applies the capture-group replacement", () => {
    const content = "See pr-123 for the fix.";
    const fixed = applyFixes(content, lintContent(content, ctx).warnings);
    expect(fixed).toBe("See [#123] for the fix.");
  });

  it("doesn't match when content already matches the suggest form", () => {
    const content = "See [#123] for the fix.";
    expect(lintContent(content, ctx).warnings.filter((w) => w.rule === "R002")).toHaveLength(0);
  });

  it("emits a structured warning for malformed patterns instead of silently dropping them", () => {
    // Wave 2 / D: replaces the previous "silently skips" behavior. The
    // catch-block in R002 used to `continue;` on regex compile failure,
    // which left the user with zero feedback that their config was broken.
    // Now the rule emits a single line-1 warning naming the bad pattern
    // and the compile-error reason, so the user sees actionable output
    // from `lebop lint`.
    const bad: LintContext = {
      repoConfig: {
        required_formats: [{ pattern: "[unclosed", suggest: "x" }],
      },
    };
    const { warnings } = lintContent("anything", bad);
    const r002 = warnings.filter((w) => w.rule === "R002");
    expect(r002).toHaveLength(1);
    expect(r002[0]?.line).toBe(1);
    expect(r002[0]?.message).toContain("[unclosed");
    expect(r002[0]?.message).toMatch(/invalid `required_formats\[\]\.pattern`/);
    // No fix should be attached — config errors aren't auto-fixable.
    expect(r002[0]?.fix).toBeNull();
  });

  it("does not throw when the regex is malformed", () => {
    // Backstop for the prior contract — lintContent must remain total.
    const bad: LintContext = {
      repoConfig: {
        required_formats: [{ pattern: "[unclosed", suggest: "x" }],
      },
    };
    expect(() => lintContent("anything", bad)).not.toThrow();
  });

  it("still applies valid patterns alongside an invalid one", () => {
    // Mixed config: one good entry + one malformed entry. The good entry
    // must keep working so a single typo doesn't disable the whole rule.
    const mixed: LintContext = {
      repoConfig: {
        required_formats: [
          { pattern: "[unclosed", suggest: "x" }, // invalid
          {
            pattern: "\\bpr-(\\d+)\\b",
            suggest: "[#$1]",
            message: "Use [#N] form",
          },
        ],
      },
    };
    const { warnings } = lintContent("See pr-7 for the fix.", mixed);
    const r002 = warnings.filter((w) => w.rule === "R002");
    // One config-error warning at line 1 + one content warning at line 1
    // (both happen to land on the same line; the content one carries a fix).
    expect(r002.length).toBeGreaterThanOrEqual(2);
    const configWarn = r002.find((w) => w.message.includes("[unclosed"));
    const contentWarn = r002.find((w) => w.message.includes("Use [#N] form"));
    expect(configWarn).toBeTruthy();
    expect(contentWarn).toBeTruthy();
    expect(contentWarn?.fix).toBeTruthy();
  });
});
