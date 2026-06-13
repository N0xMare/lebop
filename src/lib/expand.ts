import { ValidationError } from "./errors.ts";
import { normalizeIssueIdentifierOrUuid, parseIssueIdentifier } from "./issueIdentifiers.ts";

export function expandIds(args: string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (arg.includes("..")) {
      out.push(...expandRange(arg));
    } else {
      out.push(normalizeIssueIdentifierOrUuid(arg));
    }
  }
  return Array.from(new Set(out));
}

function expandRange(range: string): string[] {
  const [start, end] = range.split("..");
  if (!start || !end) {
    throw new ValidationError(
      `invalid range: ${range}`,
      "use the form TEAM-NN..TEAM-MM (e.g. UE-5..UE-8)",
    );
  }
  let parsedStart: ReturnType<typeof parseIssueIdentifier>;
  let parsedEnd: ReturnType<typeof parseIssueIdentifier>;
  try {
    parsedStart = parseIssueIdentifier(start, "range start");
    parsedEnd = parseIssueIdentifier(end, "range end");
  } catch {
    throw new ValidationError(
      `range must be of form TEAM-NN..TEAM-MM (got ${range})`,
      "use the form TEAM-NN..TEAM-MM (e.g. UE-5..UE-8)",
    );
  }
  if (parsedStart.teamKey !== parsedEnd.teamKey) {
    throw new ValidationError(
      `range prefixes must match: ${parsedStart.teamKey} vs ${parsedEnd.teamKey}`,
      "both ends of the range must reference the same team (e.g. UE-5..UE-8, not UE-5..XY-8)",
    );
  }
  const a = parsedStart.number;
  const b = parsedEnd.number;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const out: string[] = [];
  for (let i = lo; i <= hi; i++) out.push(`${parsedStart.teamKey}-${i}`);
  return out;
}
