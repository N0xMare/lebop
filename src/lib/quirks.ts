/**
 * Universal Linear-renderer quirks + repo-scoped convention rules. Each rule is a pure
 * function over a markdown string (and optional LintContext carrying repo config).
 * Rules emit Warnings; the lint runner aggregates them and (optionally) applies Fixes.
 *
 * Rule IDs follow spec §9:
 *   Universal (§9.1): L001–L006
 *   Repo-scoped (§9.2): L004 (bracket issue refs), R001 (path rewrites),
 *                       R002 (required identifier formats).
 *
 * Repo-scoped rules self-skip when their enabling config is absent in ctx.
 */

import type { RepoConfig } from "./types.ts";

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

/**
 * Optional context passed to every rule. Universal rules ignore it; repo-scoped rules
 * key off specific fields (`repoConfig.conventions.bracket_issue_refs`,
 * `repoConfig.path_rewrites`, `repoConfig.required_formats`).
 */
export interface LintContext {
  repoConfig?: RepoConfig;
  workspaceUrlPrefix?: string;
}

export interface Rule {
  id: string;
  description: string;
  severity: Severity;
  check: (content: string, ctx: LintContext) => Warning[];
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

// ---------- L004: bracket issue refs (repo-scoped) ----------

/** Global `TEAM-NN` regex used by L004 to find unbracketed refs. */
const ISSUE_REF_RE = /\b[A-Z]+-\d+\b/g;

const L004: Rule = {
  id: "L004",
  description:
    "Issue ref TEAM-NN not wrapped as `[TEAM-NN](url)`; enabled by `conventions.bracket_issue_refs: true`",
  severity: "warn",
  check(content, ctx) {
    if (!ctx.repoConfig?.conventions?.bracket_issue_refs) return [];
    if (!ctx.workspaceUrlPrefix) return []; // can't construct the link without the prefix
    const prefix = ctx.workspaceUrlPrefix.replace(/\/+$/, "");
    const lines = content.split("\n");
    const out: Warning[] = [];

    lines.forEach((line, i) => {
      // Collect spans of existing markdown links `[...](...)` so any TEAM-XXX inside —
      // whether in the label or the URL — is left alone.
      const linkRanges: [number, number][] = [];
      for (const m of line.matchAll(/\[[^\]]*\]\([^)]*\)/g)) {
        if (m.index !== undefined) linkRanges.push([m.index, m.index + m[0].length]);
      }
      // Also skip refs inside code spans (between single backticks).
      const codeRanges = findBacktickRanges(line);

      let rewrote = false;
      const fixed = line.replace(ISSUE_REF_RE, (ref, ...args) => {
        const offset = args[args.length - 2] as number;
        if (inAny(linkRanges, offset)) return ref;
        if (inAny(codeRanges, offset)) return ref;
        rewrote = true;
        out.push({
          rule: "L004",
          severity: "warn",
          message: `\`${ref}\` should be rendered as a markdown link. Wrap as \`[${ref}](${prefix}/issue/${ref})\`.`,
          line: i + 1,
          fix: null, // we'll attach a line-level fix below once we know if any changed
        });
        return `[${ref}](${prefix}/issue/${ref})`;
      });

      if (rewrote) {
        // Every warning above that belongs to this line gets the same line-replace fix.
        for (
          let j = out.length - 1;
          j >= 0 && out[j]?.line === i + 1 && out[j]?.rule === "L004";
          j--
        ) {
          const w = out[j];
          if (w) w.fix = { startLine: i + 1, endLine: i + 1, replacement: [fixed] };
        }
      }
    });

    return out;
  },
};

/** Find `[start, end)` ranges of single-backtick code spans on a line. */
function findBacktickRanges(line: string): [number, number][] {
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < line.length) {
    const open = line.indexOf("`", i);
    if (open === -1) break;
    const close = line.indexOf("`", open + 1);
    if (close === -1) break;
    ranges.push([open, close + 1]);
    i = close + 1;
  }
  return ranges;
}

function inAny(ranges: [number, number][], pos: number): boolean {
  return ranges.some(([a, b]) => pos >= a && pos < b);
}

// ---------- R001: path_rewrites (repo-scoped) ----------

const R001: Rule = {
  id: "R001",
  description:
    "Path prefix in `path_rewrites[].from` should be rewritten to the corresponding `to`",
  severity: "warn",
  check(content, ctx) {
    const rewrites = ctx.repoConfig?.path_rewrites;
    if (!rewrites || rewrites.length === 0) return [];
    const lines = content.split("\n");
    const out: Warning[] = [];

    lines.forEach((line, i) => {
      let fixed = line;
      let any = false;
      const localMessages: string[] = [];

      for (const { from, to } of rewrites) {
        if (!from || !to || from === to) continue;
        if (!to.endsWith(from)) continue; // `to` must end with `from` for the prefix model to make sense

        // Find occurrences of `from` that are NOT already preceded by the full `to`.
        const fromEscaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(
          `(?<!${to.slice(0, to.length - from.length).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})${fromEscaped}`,
          "g",
        );
        const replaced = fixed.replace(re, to);
        if (replaced !== fixed) {
          any = true;
          localMessages.push(`\`${from}\` → \`${to}\``);
          fixed = replaced;
        }
      }

      if (any) {
        out.push({
          rule: "R001",
          severity: "warn",
          message: `path prefix needs rewrite: ${localMessages.join(", ")}`,
          line: i + 1,
          fix: { startLine: i + 1, endLine: i + 1, replacement: [fixed] },
        });
      }
    });

    return out;
  },
};

// ---------- R002: required identifier formats (repo-scoped) ----------

/**
 * Pre-compile every `required_formats[].pattern`. Invalid patterns produce a
 * `Warning` at line 1 naming the offending pattern + the compile-error
 * reason, so the user gets actionable feedback that their config is broken.
 * Wave 1 silently dropped malformed entries via `catch { continue; }`, which
 * left users staring at a lint pass that mysteriously did nothing.
 *
 * Successfully compiled patterns are returned for the per-line scan; invalid
 * ones are skipped so the rest of the config still runs.
 */
function compileRequiredFormats(fmts: { pattern: string; suggest: string; message?: string }[]): {
  compiled: { re: RegExp; suggest: string; message?: string }[];
  configWarnings: Warning[];
} {
  const compiled: { re: RegExp; suggest: string; message?: string }[] = [];
  const configWarnings: Warning[] = [];
  for (const { pattern, suggest, message } of fmts) {
    try {
      compiled.push({ re: new RegExp(pattern, "g"), suggest, message });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      configWarnings.push({
        rule: "R002",
        severity: "warn",
        message: `invalid \`required_formats[].pattern\` in repo config: \`${pattern}\` — ${reason}. fix the pattern in lebop's repo config (\`required_formats\`) or remove the entry.`,
        line: 1,
        fix: null,
      });
    }
  }
  return { compiled, configWarnings };
}

const R002: Rule = {
  id: "R002",
  description:
    "Identifier pattern from `required_formats[]` config should be rewritten to the declared form",
  severity: "warn",
  check(content, ctx) {
    const fmts = ctx.repoConfig?.required_formats;
    if (!fmts || fmts.length === 0) return [];

    const { compiled, configWarnings } = compileRequiredFormats(fmts);
    const lines = content.split("\n");
    const out: Warning[] = [...configWarnings];

    if (compiled.length === 0) return out;

    lines.forEach((line, i) => {
      let fixed = line;
      let any = false;
      const msgs: string[] = [];

      for (const { re, suggest, message } of compiled) {
        // Reset lastIndex defensively — the regex is `g` and reused across
        // lines, so a previous .replace's internal state could otherwise
        // affect subsequent calls on some runtimes.
        re.lastIndex = 0;
        const replaced = fixed.replace(re, suggest);
        if (replaced !== fixed) {
          any = true;
          msgs.push(message ?? `pattern \`${re.source}\` → \`${suggest}\``);
          fixed = replaced;
        }
      }

      if (any) {
        out.push({
          rule: "R002",
          severity: "warn",
          message: msgs.join("; "),
          line: i + 1,
          fix: { startLine: i + 1, endLine: i + 1, replacement: [fixed] },
        });
      }
    });

    return out;
  },
};

// ---------- registry ----------

export const ALL_RULES: readonly Rule[] = [L001, L002, L003, L004, L005, L006, R001, R002] as const;

export const RULES_BY_ID: Readonly<Record<string, Rule>> = Object.fromEntries(
  ALL_RULES.map((r) => [r.id, r]),
);
