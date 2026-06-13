import { ValidationError } from "./errors.ts";

/**
 * Linear's `icon` field is an internal name (PascalCase, e.g. "BarChart" or
 * "Rocket"). Passing a Unicode emoji silently round-trips as a non-functional
 * string; reject those up-front with a structured ValidationError.
 *
 * Uses `\p{Extended_Pictographic}` (Unicode 9+) which covers emoji, dingbats,
 * symbols, and the bulk of icon-shaped pictographic codepoints.
 */
export function assertIconNotEmoji(icon: string | undefined, field = "icon"): void {
  if (icon === undefined) return;
  if (/^\p{Extended_Pictographic}/u.test(icon)) {
    throw new ValidationError(
      `${field} "${icon}" looks like an emoji — Linear expects an internal icon name (PascalCase)`,
      "use a name like 'BarChart', 'Rocket', 'Target'. Omit if unsure.",
    );
  }
}
