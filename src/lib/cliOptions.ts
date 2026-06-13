import { ValidationError } from "./errors.ts";

export interface CliLimitOptions {
  defaultValue?: number;
  max?: number;
  optionName?: string;
  zeroMeansInfinity?: boolean;
}

export interface CliNumberOptions {
  optionName?: string;
  allowNegative?: boolean;
  allowNullHint?: boolean;
}

export function parseCliLimit(raw: string | undefined, options: CliLimitOptions = {}): number {
  const optionName = options.optionName ?? "--limit";
  const value = raw ?? String(options.defaultValue ?? 50);
  const normalized = value.trim();

  if (!/^\d+$/.test(normalized)) {
    throw new ValidationError(
      `invalid ${optionName} value "${value}"`,
      limitHint(optionName, options),
    );
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new ValidationError(
      `invalid ${optionName} value "${value}"`,
      limitHint(optionName, options),
    );
  }

  if (parsed === 0) {
    if (options.zeroMeansInfinity) return Number.POSITIVE_INFINITY;
    throw new ValidationError(
      `invalid ${optionName} value "${value}"`,
      limitHint(optionName, options),
    );
  }

  if (options.max !== undefined && parsed > options.max) {
    throw new ValidationError(
      `invalid ${optionName} value "${value}"`,
      limitHint(optionName, options),
    );
  }

  return parsed;
}

export function parseCliNumber(raw: string, options: CliNumberOptions = {}): number {
  const optionName = options.optionName ?? "--value";
  const normalized = raw.trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) {
    throw invalidNumber(optionName, raw, options);
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || (!options.allowNegative && parsed < 0)) {
    throw invalidNumber(optionName, raw, options);
  }
  return parsed;
}

function limitHint(optionName: string, options: CliLimitOptions): string {
  if (options.zeroMeansInfinity) {
    return `${optionName} must be an integer 0 or greater; 0 means no user-specified cap`;
  }
  if (options.max !== undefined) {
    return `${optionName} must be an integer between 1 and ${options.max}`;
  }
  return `${optionName} must be a positive integer`;
}

function invalidNumber(
  optionName: string,
  raw: string,
  options: CliNumberOptions,
): ValidationError {
  const sign = options.allowNegative ? "" : "non-negative ";
  const nullHint = options.allowNullHint ? " or `null`" : "";
  return new ValidationError(
    `invalid ${optionName} value "${raw}"`,
    `${optionName} must be a ${sign}number${nullHint}`,
  );
}
