import { ValidationError } from "./errors.ts";
import { isUuid } from "./uuid.ts";

export const ISSUE_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;
export const ISSUE_REFERENCE_PATTERN = /\b[A-Z][A-Z0-9]*-\d+\b/g;
const ISSUE_IDENTIFIER_INPUT_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export interface ParsedIssueIdentifier {
  identifier: string;
  teamKey: string;
  number: number;
}

export function isIssueIdentifier(value: string): boolean {
  return ISSUE_IDENTIFIER_INPUT_PATTERN.test(value.trim());
}

export function parseIssueIdentifier(value: string, label = "identifier"): ParsedIssueIdentifier {
  const normalized = value.trim().toUpperCase();
  if (!ISSUE_IDENTIFIER_PATTERN.test(normalized)) {
    throw new ValidationError(
      `invalid ${label}: ${value}`,
      "expected TEAM-NN form with an alphanumeric team key, e.g. NOX-34 or A1-42",
    );
  }
  const separator = normalized.lastIndexOf("-");
  return {
    identifier: normalized,
    teamKey: normalized.slice(0, separator),
    number: Number(normalized.slice(separator + 1)),
  };
}

export function normalizeIssueIdentifier(value: string, label = "identifier"): string {
  return parseIssueIdentifier(value, label).identifier;
}

export function normalizeIssueIdentifierOrUuid(value: string, label = "identifier"): string {
  const trimmed = value.trim();
  if (isUuid(trimmed)) return trimmed;
  return normalizeIssueIdentifier(trimmed, label);
}
