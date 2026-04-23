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
  if (!start || !end) throw new Error(`invalid range: ${range}`);
  const startMatch = start.match(/^([A-Z]+)-(\d+)$/i);
  const endMatch = end.match(/^([A-Z]+)-(\d+)$/i);
  if (!startMatch || !endMatch) {
    throw new Error(`range must be of form TEAM-NN..TEAM-MM (got ${range})`);
  }
  const [, startPrefix, startNum] = startMatch;
  const [, endPrefix, endNum] = endMatch;
  if (!startPrefix || !startNum || !endPrefix || !endNum) {
    throw new Error(`range must be of form TEAM-NN..TEAM-MM (got ${range})`);
  }
  if (startPrefix.toUpperCase() !== endPrefix.toUpperCase()) {
    throw new Error(`range prefixes must match: ${startPrefix} vs ${endPrefix}`);
  }
  const a = Number.parseInt(startNum, 10);
  const b = Number.parseInt(endNum, 10);
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const prefix = startPrefix.toUpperCase();
  const out: string[] = [];
  for (let i = lo; i <= hi; i++) out.push(`${prefix}-${i}`);
  return out;
}
