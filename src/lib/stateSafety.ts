import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve as resolvePath } from "node:path";
import { AuthError, ValidationError } from "./errors.ts";
import { LEBOP_HOME } from "./paths.ts";

type ErrorFactory = (message: string, hint: string) => Error;

interface StateSafetyOptions {
  label: string;
  mode?: number;
  errorFactory?: ErrorFactory;
}

export const authStateSafetyError: ErrorFactory = (message, hint) => new AuthError(message, hint);

export function ensureLebopHomeForWrite(options: Partial<StateSafetyOptions> = {}): void {
  ensureStateDirectoryForWrite(LEBOP_HOME, {
    label: options.label ?? "LEBOP_HOME",
    mode: options.mode ?? 0o700,
    errorFactory: options.errorFactory,
  });
}

export function ensureStateDirectoryForWrite(
  dir: string,
  options: Partial<StateSafetyOptions> = {},
): void {
  const label = options.label ?? "lebop state directory";
  const root = resolvePath(LEBOP_HOME);
  const absolute = resolvePath(dir);
  assertWithinStateRoot(root, absolute, label, options.errorFactory);

  if (absolute === root) {
    assertNoSymlinkedExistingAncestorsSync(root, {
      label,
      hint: "choose a normal directory for LEBOP_HOME",
      errorFactory: options.errorFactory,
    });
  } else {
    ensureStateDirectoryForWrite(root, {
      label: "LEBOP_HOME",
      mode: 0o700,
      errorFactory: options.errorFactory,
    });
    assertNoSymlinkedExistingAncestorsSync(absolute, {
      label,
      stopAt: root,
      hint: "remove the symlinked state directory or choose a new LEBOP_HOME",
      errorFactory: options.errorFactory,
    });
  }

  const existing = lstatSync(absolute, { throwIfNoEntry: false });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw makeStateSafetyError(
        `refusing to write ${label} through unsafe state directory: ${absolute}`,
        "replace it with a normal directory, then retry",
        options.errorFactory,
      );
    }
  } else {
    mkdirSync(absolute, { recursive: true, mode: options.mode });
  }

  const after = lstatSync(absolute, { throwIfNoEntry: false });
  if (!after || after.isSymbolicLink() || !after.isDirectory()) {
    throw makeStateSafetyError(
      `refusing to write ${label} through unsafe state directory: ${absolute}`,
      "replace it with a normal directory, then retry",
      options.errorFactory,
    );
  }

  if (options.mode !== undefined) {
    chmodSync(absolute, options.mode);
  }
}

export function assertNoSymlinkedExistingAncestorsSync(
  path: string,
  options: {
    label: string;
    stopAt?: string;
    hint?: string;
    errorFactory?: ErrorFactory;
  },
): void {
  const target = resolvePath(path);
  const stopAt = options.stopAt ? resolvePath(options.stopAt) : null;
  let current = dirname(target);
  const checked = new Set<string>();

  while (!checked.has(current)) {
    checked.add(current);
    if (stopAt && current === stopAt) return;

    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat) {
      if (stat.isSymbolicLink()) {
        if (!stopAt && dirname(current) === dirname(dirname(current))) return;
        throw makeStateSafetyError(
          `refusing to write ${options.label} through symlinked ancestor: ${current}`,
          options.hint ?? "choose a normal directory path",
          options.errorFactory,
        );
      }
      current = dirname(current);
      continue;
    }

    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function assertWithinStateRoot(
  root: string,
  absolute: string,
  label: string,
  errorFactory?: ErrorFactory,
): void {
  const rel = relative(root, absolute);
  if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\"))) {
    return;
  }
  throw makeStateSafetyError(
    `refusing to write ${label} outside LEBOP_HOME: ${absolute}`,
    "state writes must stay under the configured LEBOP_HOME",
    errorFactory,
  );
}

function makeStateSafetyError(message: string, hint: string, errorFactory?: ErrorFactory): Error {
  return errorFactory ? errorFactory(message, hint) : new ValidationError(message, hint);
}
