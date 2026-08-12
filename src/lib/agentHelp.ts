/**
 * Agent-first dense help catalog (AXI control plane).
 *
 * Replaces Commander human manpages with TOON/compact structured catalogs.
 * Product is agent-only — no human-oriented help path by default.
 */

import type { Command } from "commander";
import { encodeEnvelope, type OutputFormat, parseFormatFlag } from "./encode.ts";
import { LEBOP_VERSION } from "./version.ts";

export type HelpCmdRow = {
  n: string;
  s?: string;
  g?: string;
};

export type HelpFlagRow = {
  n: string;
  s?: string;
};

export type HelpDetail = {
  schema_version?: number;
  cmd: string;
  usage?: string;
  s?: string;
  flags?: HelpFlagRow[];
  cmds?: HelpCmdRow[];
  next?: string[];
};

/** Collapse Commander description to one dense line. */
export function densifyDescription(raw: string | undefined, max = 72): string {
  if (!raw) return "";
  const one = raw.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

/** Group top-level verbs for progressive disclosure. */
export function groupForCommand(name: string): string {
  const n = name.toLowerCase();
  if (["auth", "update", "mcp", "completions", "schema", "help"].includes(n)) return "meta";
  if (["list", "mine", "search", "history", "show", "teams", "projects", "lookup"].includes(n))
    return "read";
  if (["workspace", "view", "custom-field", "notifications", "cycle", "agent-session"].includes(n))
    return "research";
  if (
    [
      "project",
      "project-update",
      "initiative",
      "initiative-update",
      "milestone",
      "document",
      "label",
      "team",
    ].includes(n)
  )
    return "pm";
  if (
    [
      "new",
      "set",
      "comment",
      "relation",
      "link",
      "attachment",
      "archive",
      "unarchive",
      "bulk",
    ].includes(n)
  )
    return "write";
  if (["pull", "push", "status", "diff", "lint", "cache"].includes(n)) return "cache";
  if (["plan", "publish"].includes(n)) return "plan";
  if (["raw"].includes(n)) return "escape";
  return "other";
}

function visibleCommands(cmd: Command): Command[] {
  // commander private-ish API: commands array
  const list = (cmd as unknown as { commands: Command[] }).commands ?? [];
  return list.filter((c) => {
    const hidden = (c as unknown as { _hidden?: boolean })._hidden;
    return !hidden && Boolean(c.name());
  });
}

function visibleOptions(cmd: Command): { flags: string; description: string }[] {
  const opts = (
    cmd as unknown as { options: { flags: string; description: string; hidden?: boolean }[] }
  ).options;
  if (!Array.isArray(opts)) return [];
  return opts
    .filter((o) => !o.hidden && o.flags && !o.flags.includes("--help"))
    .map((o) => ({ flags: o.flags, description: o.description ?? "" }));
}

export function buildRootCatalog(program: Command): {
  v: string;
  n: number;
  cmds: HelpCmdRow[];
  next: string[];
} {
  const cmds = visibleCommands(program).map((c) => {
    const name = c.name();
    const s = densifyDescription(c.description(), 56);
    return {
      n: name,
      g: groupForCommand(name),
      ...(s ? { s } : {}),
    };
  });
  return {
    v: LEBOP_VERSION,
    n: cmds.length,
    cmds,
    next: ["help <cmd>", "list --assignee me", "workspace explore /", "search --query …"],
  };
}

export function buildCommandHelp(cmd: Command): HelpDetail {
  const name = cmd.name() || "lebop";
  const pathNames: string[] = [];
  let walk: Command | null = cmd;
  while (walk) {
    const n = walk.name();
    if (n && n !== "lebop") pathNames.unshift(n);
    walk = walk.parent as Command | null;
  }
  const cmdPath = pathNames.length ? pathNames.join(" ") : name;

  const flags = visibleOptions(cmd).map((o) => {
    const s = densifyDescription(o.description, 40);
    return s
      ? { n: o.flags.replace(/\s+/g, " ").trim(), s }
      : { n: o.flags.replace(/\s+/g, " ").trim() };
  });

  const sub = visibleCommands(cmd).map((c) => {
    const s = densifyDescription(c.description(), 48);
    return {
      n: c.name(),
      g: groupForCommand(c.name()),
      ...(s ? { s } : {}),
    };
  });

  const usage =
    typeof (cmd as unknown as { usage?: () => string }).usage === "function"
      ? densifyDescription((cmd as unknown as { usage: () => string }).usage(), 96)
      : undefined;

  return {
    cmd: cmdPath === "lebop" || !cmdPath ? "lebop" : cmdPath,
    usage: usage || undefined,
    s: densifyDescription(cmd.description(), 80) || undefined,
    ...(flags.length ? { flags } : {}),
    ...(sub.length ? { cmds: sub } : {}),
    next:
      sub.length > 0
        ? [`help ${cmdPath} <sub>`, `${cmdPath} --help`]
        : [`${cmdPath}`, "help", "list --assignee me"],
  };
}

export function formatAgentHelpText(
  payload: Record<string, unknown>,
  format?: OutputFormat | string,
): string {
  const resolved =
    typeof format === "string"
      ? parseFormatFlag({ format, json: true })
      : (format ?? parseFormatFlag({ json: true }));
  return `${encodeEnvelope(payload, { format: resolved, shape: "auto" })}\n`;
}

/**
 * Commander Help.formatHelp override body: dense catalog for root or detail for leaf.
 */
export function formatCommanderHelp(cmd: Command): string {
  const isRoot = !cmd.parent;
  const payload = isRoot
    ? (buildRootCatalog(cmd) as unknown as Record<string, unknown>)
    : (buildCommandHelp(cmd) as unknown as Record<string, unknown>);
  // Prefer LEBOP_MACHINE_FORMAT; help is always machine (agent product).
  return formatAgentHelpText(payload);
}
