/**
 * Universal Linear-renderer quirks. Each rule is a pure function over a markdown string.
 * Rules emit Warnings; the lint runner aggregates them and (optionally) applies Fixes.
 *
 * Rule IDs follow the spec §9.1 catalog (L001–L005) plus L006 added 2026-04-23 after the
 * sandbox regression caught Linear silently converting `text\n---` into `## text` (setext
 * H2 underline).
 */

export type Severity = "warn" | "info" | "error";

export interface Fix {
  /** 1-indexed, inclusive */
  startLine: number;
  /** 1-indexed, inclusive */
  endLine: number;
  /** each element = one new line; empty array deletes the range */
  replacement: string[];
}

export interface Warning {
  rule: string;
  severity: Severity;
  message: string;
  /** 1-indexed for human display */
  line: number;
  fix?: Fix | null;
}

export interface Rule {
  id: string;
  description: string;
  severity: Severity;
  check: (content: string) => Warning[];
}

// ---------- helpers ----------

/** Heuristic: is this line plausibly inside a Linear/GFM table? */
function isLikelyTableRow(line: string, allLines: string[], idx: number): boolean {
  // Two or more pipes is necessary but not sufficient.
  const pipes = (line.match(/\|/g) ?? []).length;
  if (pipes < 2) return false;

  // Check 3 lines before/after for a table-divider row. Allows one OR more columns.
  // Examples that match: `|---|`, `|---|---|`, `:---:|---|`, `|---|---|---|`
  const dividerRe = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
  for (let i = Math.max(0, idx - 3); i <= Math.min(allLines.length - 1, idx + 3); i++) {
    const candidate = allLines[i];
    if (candidate !== undefined && dividerRe.test(candidate)) return true;
  }
  return false;
}

/** Split a table row by `|`, preserving cell content. */
function splitCells(line: string): string[] {
  const trimmed = line.trim();
  const stripped = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const inner = stripped.endsWith("|") ? stripped.slice(0, -1) : stripped;
  return inner.split("|").map((c) => c);
}

/** Reassemble cells back into a `| a | b | c |` line. */
function joinCells(cells: string[]): string {
  return `| ${cells.map((c) => c.trim()).join(" | ")} |`;
}

// ---------- L001: ordered-list marker in table cell ----------

const L001: Rule = {
  id: "L001",
  description:
    "Table cell begins with `N.` — Linear parses as ordered-list marker and injects \\n\\n",
  severity: "warn",
  check(content) {
    const lines = content.split("\n");
    const out: Warning[] = [];
    lines.forEach((line, i) => {
      if (!isLikelyTableRow(line, lines, i)) return;
      const cells = splitCells(line);
      const offending = cells.some((c) => /^\s*\d+\.\s/.test(c));
      if (!offending) return;

      const fixed = cells.map((c) => c.replace(/^\s*(\d+)\.\s+(.*)$/, "Row $1 — $2"));
      out.push({
        rule: "L001",
        severity: "warn",
        message: 'Table cell starts with "N." — rewrite as "Row N — …" (Linear breaks the row).',
        line: i + 1,
        fix: { startLine: i + 1, endLine: i + 1, replacement: [joinCells(fixed)] },
      });
    });
    return out;
  },
};

// ---------- L002: bullet marker in table cell ----------

const L002: Rule = {
  id: "L002",
  description: "Table cell begins with `- ` or `* ` — Linear parses as bullet list, breaks the row",
  severity: "warn",
  check(content) {
    const lines = content.split("\n");
    const out: Warning[] = [];
    lines.forEach((line, i) => {
      if (!isLikelyTableRow(line, lines, i)) return;
      const cells = splitCells(line);
      const offending = cells.some((c) => /^\s*[-*]\s+/.test(c));
      if (!offending) return;

      const fixed = cells.map((c) => c.replace(/^\s*[-*]\s+(.*)$/, "• $1"));
      out.push({
        rule: "L002",
        severity: "warn",
        message: 'Table cell starts with "- " or "* " — rewrite as "• …".',
        line: i + 1,
        fix: { startLine: i + 1, endLine: i + 1, replacement: [joinCells(fixed)] },
      });
    });
    return out;
  },
};

// ---------- L003: indented code fence ----------

const L003: Rule = {
  id: "L003",
  description: "Code fence with 4+ leading spaces may parse as indented code block",
  severity: "info",
  check(content) {
    const lines = content.split("\n");
    const out: Warning[] = [];
    lines.forEach((line, i) => {
      if (/^\s{4,}```/.test(line)) {
        out.push({
          rule: "L003",
          severity: "info",
          message: "Code fence has 4+ leading spaces — may render as indented code, not fence.",
          line: i + 1,
          fix: null,
        });
      }
    });
    return out;
  },
};

// ---------- L005: bare URL inside backticks ----------

const L005: Rule = {
  id: "L005",
  description: "Bare URL inside backticks — may double-render as auto-link plus code span",
  severity: "info",
  check(content) {
    const lines = content.split("\n");
    const re = /`https?:\/\/[^\s`]+`/g;
    const out: Warning[] = [];
    lines.forEach((line, i) => {
      if (re.test(line)) {
        out.push({
          rule: "L005",
          severity: "info",
          message:
            "URL inside backticks — Linear may auto-link the visual text. Wrap in <…> to keep literal.",
          line: i + 1,
          fix: null,
        });
      }
      re.lastIndex = 0;
    });
    return out;
  },
};

// ---------- L006: setext H2 from `text\n---` ----------

const L006: Rule = {
  id: "L006",
  description: "`text` immediately followed by `---` becomes a setext H2 heading on push",
  severity: "warn",
  check(content) {
    const lines = content.split("\n");
    const out: Warning[] = [];
    for (let i = 0; i < lines.length - 1; i++) {
      const cur = lines[i] ?? "";
      const next = lines[i + 1] ?? "";
      // text line followed immediately by an `---` line (no blank between).
      // If the previous line is blank, this is unambiguously an HR — skip.
      if (cur.trim() === "" || next.trim() !== "---") continue;
      // Also skip if the cur line itself looks like a heading or rule already.
      if (/^#{1,6}\s/.test(cur) || /^[-*_]{3,}\s*$/.test(cur)) continue;

      out.push({
        rule: "L006",
        severity: "warn",
        message:
          "`text` directly above `---` becomes a setext H2 (`## text`) on push. Add a blank line before `---` to keep it as a horizontal rule.",
        line: i + 2, // point at the `---` line
        fix: {
          startLine: i + 2,
          endLine: i + 2,
          replacement: ["", "---"],
        },
      });
    }
    return out;
  },
};

// ---------- registry ----------

export const ALL_RULES: readonly Rule[] = [L001, L002, L003, L005, L006] as const;

export const RULES_BY_ID: Readonly<Record<string, Rule>> = Object.fromEntries(
  ALL_RULES.map((r) => [r.id, r]),
);
