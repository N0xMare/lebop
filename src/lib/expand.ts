import { ValidationError } from "./errors.ts";

export function expandIds(args: string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (arg.includes("..")) {
      out.push(...expandRange(arg));
    } else {
      out.push(arg.toUpperCase());
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
  const startMatch = start.match(/^([A-Z]+)-(\d+)$/i);
  const endMatch = end.match(/^([A-Z]+)-(\d+)$/i);
  if (!startMatch || !endMatch) {
    throw new ValidationError(
      `range must be of form TEAM-NN..TEAM-MM (got ${range})`,
      "use the form TEAM-NN..TEAM-MM (e.g. UE-5..UE-8)",
    );
  }
  const [, startPrefix, startNum] = startMatch;
  const [, endPrefix, endNum] = endMatch;
  if (!startPrefix || !startNum || !endPrefix || !endNum) {
    throw new ValidationError(
      `range must be of form TEAM-NN..TEAM-MM (got ${range})`,
      "use the form TEAM-NN..TEAM-MM (e.g. UE-5..UE-8)",
    );
  }
  if (startPrefix.toUpperCase() !== endPrefix.toUpperCase()) {
    throw new ValidationError(
      `range prefixes must match: ${startPrefix} vs ${endPrefix}`,
      "both ends of the range must reference the same team (e.g. UE-5..UE-8, not UE-5..XY-8)",
    );
  }
  const a = Number.parseInt(startNum, 10);
  const b = Number.parseInt(endNum, 10);
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const prefix = startPrefix.toUpperCase();
  const out: string[] = [];
  for (let i = lo; i <= hi; i++) out.push(`${prefix}-${i}`);
  return out;
}
