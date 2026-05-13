/**
 * Shared I/O helpers used by command surfaces. Currently:
 *   - `resolveBody`: resolve a markdown body from one of --body / --body-file
 *     / --stdin (mutually exclusive), used by `comment add`,
 *     `project-update create`, `initiative-update create`.
 *   - `resolveContent`: same shape but the content arg is OPTIONAL — used
 *     by `document create/update` where omitting all three means "leave
 *     unchanged" rather than "empty body."
 */

import { ValidationError } from "./errors.ts";

interface BodyOpts {
  body?: string;
  bodyFile?: string;
  stdin?: boolean;
}

interface ContentOpts {
  content?: string;
  contentFile?: string;
  stdin?: boolean;
}

/**
 * Resolve a required body string. Throws if zero providers are set and
 * stdin is a TTY (no piped input), or if more than one provider is set.
 * Trims trailing whitespace.
 */
export async function resolveBody(opts: BodyOpts): Promise<string> {
  const provided = [opts.body, opts.bodyFile, opts.stdin].filter(Boolean).length;
  if (provided === 0) {
    if (!process.stdin.isTTY) return (await Bun.stdin.text()).trim();
    throw new ValidationError(
      "no body — pass --body, --body-file, or pipe to stdin",
      "supply the body inline via --body, from a file via --body-file, or by piping to stdin",
    );
  }
  if (provided > 1) {
    throw new ValidationError(
      "pick one of --body / --body-file / --stdin",
      "the three body sources are mutually exclusive — pass exactly one",
    );
  }
  if (opts.body) return opts.body;
  if (opts.bodyFile) return (await Bun.file(opts.bodyFile).text()).trim();
  return (await Bun.stdin.text()).trim();
}

/**
 * Resolve an optional content string. Returns `undefined` when no provider
 * is set (signals "don't update this field" for document update). Throws
 * if more than one provider is set. Uses `trimEnd` to preserve leading
 * indentation in markdown content.
 */
export async function resolveContent(opts: ContentOpts): Promise<string | undefined> {
  const provided = [opts.content, opts.contentFile, opts.stdin].filter(Boolean).length;
  if (provided > 1) {
    throw new ValidationError(
      "pick one of --content / --content-file / --stdin",
      "the three content sources are mutually exclusive — pass exactly one",
    );
  }
  if (provided === 0) return undefined;
  if (opts.content) return opts.content;
  if (opts.contentFile) return (await Bun.file(opts.contentFile).text()).trimEnd();
  return (await Bun.stdin.text()).trimEnd();
}
