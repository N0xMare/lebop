/**
 * Agent content size policy (0.0.6+).
 *
 * Large Linear text fields (issue description, document content, …) default
 * to a per-field UTF-8 byte cap so coding-harness envelopes stay token-cheap.
 * Agents recover full content via:
 *   - CLI `--full-content` / MCP `full_content: true` (full on wire), or
 *   - CLI `--content-file <path>` / MCP `content_file` (full on disk; preferred).
 */

import { existsSync, lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ValidationError } from "./errors.ts";

/** Default per-field cap (64 KiB UTF-8). Override with LEBOP_CONTENT_MAX_BYTES. */
export const DEFAULT_CONTENT_MAX_BYTES = 65_536;

export function getContentMaxBytes(): number {
  const raw = process.env.LEBOP_CONTENT_MAX_BYTES?.trim();
  if (!raw) return DEFAULT_CONTENT_MAX_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CONTENT_MAX_BYTES;
  return Math.floor(n);
}

export type ContentPolicyMode = "default" | "full_wire" | "content_file";

export interface ContentPolicyInput {
  /** Full source text (may be empty). */
  text: string;
  fullContent?: boolean;
  contentFile?: string | null;
  /** Cap override (tests). */
  maxBytes?: number;
}

export interface AppliedContentField {
  /** Text on the wire (prefix when truncated; full when full_wire; preview or empty when file). */
  value: string;
  /** True when wire value is a truncated prefix of the source. */
  truncated: boolean;
  original_bytes: number;
  limit_bytes: number;
  /** Absolute path when content was written to disk. */
  content_file?: string;
  content_bytes?: number;
  /** How the agent should treat the body for rewrites. */
  body_source: "wire" | "truncated_wire" | "file";
}

/**
 * Apply size policy to one text field.
 * - default: cap at maxBytes; truncate with newline-friendly cut when possible
 * - full_wire: full text on wire
 * - content_file: write full text to path; wire gets optional short preview (≤ cap)
 */
export async function applyContentPolicy(input: ContentPolicyInput): Promise<AppliedContentField> {
  const maxBytes = input.maxBytes ?? getContentMaxBytes();
  const source = input.text ?? "";
  const originalBytes = utf8ByteLength(source);
  const wantFile = typeof input.contentFile === "string" && input.contentFile.trim() !== "";
  const wantFull = input.fullContent === true;

  if (wantFile) {
    const abs = resolve(input.contentFile!.trim());
    await writeContentFile(abs, source);
    const preview = originalBytes <= maxBytes ? source : truncateUtf8Prefix(source, maxBytes).text;
    return {
      value: preview,
      truncated: false,
      original_bytes: originalBytes,
      limit_bytes: maxBytes,
      content_file: abs,
      content_bytes: originalBytes,
      body_source: "file",
    };
  }

  if (wantFull || originalBytes <= maxBytes) {
    return {
      value: source,
      truncated: false,
      original_bytes: originalBytes,
      limit_bytes: maxBytes,
      body_source: "wire",
    };
  }

  const { text } = truncateUtf8Prefix(source, maxBytes);
  return {
    value: text,
    truncated: true,
    original_bytes: originalBytes,
    limit_bytes: maxBytes,
    body_source: "truncated_wire",
  };
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Truncate to ≤ maxBytes UTF-8, preferring a prior newline when present in the tail window. */
export function truncateUtf8Prefix(
  text: string,
  maxBytes: number,
): { text: string; bytes: number } {
  if (maxBytes < 1) return { text: "", bytes: 0 };
  if (utf8ByteLength(text) <= maxBytes) return { text, bytes: utf8ByteLength(text) };

  let end = Math.min(text.length, maxBytes);
  let slice = text.slice(0, end);
  while (utf8ByteLength(slice) > maxBytes && end > 0) {
    end -= 1;
    slice = text.slice(0, end);
  }
  // Prefer cutting at a newline in the last ~512 code units of the kept prefix.
  const windowStart = Math.max(0, slice.length - 512);
  const nl = slice.lastIndexOf("\n", slice.length - 1);
  if (nl >= windowStart && nl > 0) {
    slice = slice.slice(0, nl + 1);
  }
  return { text: slice, bytes: utf8ByteLength(slice) };
}

/** Atomic-ish write: ensure parent dir, write via temp + rename when possible. */
export async function writeContentFile(absolutePath: string, content: string): Promise<void> {
  const abs = resolve(absolutePath);
  if (!abs || abs === "/" || abs.endsWith("/")) {
    throw new ValidationError(
      "content file path is empty or invalid",
      "pass a file path, e.g. ./issue.md or /tmp/LEB-1.description.md",
    );
  }
  // Refuse writing *through* an existing final symlink (host FS safety).
  if (existsSync(abs)) {
    try {
      if (lstatSync(abs).isSymbolicLink()) {
        throw new ValidationError(
          `content file path is a symlink: ${abs}`,
          "pass a regular file path (not a symlink) for --content-file / content_file",
        );
      }
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(
        `cannot inspect content file path: ${abs}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  try {
    mkdirSync(dirname(abs), { recursive: true });
  } catch (err) {
    throw new ValidationError(
      `cannot create parent directory for content file: ${abs}`,
      err instanceof Error ? err.message : String(err),
    );
  }
  const tmp = `${abs}.lebop-tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, abs);
  } catch {
    try {
      writeFileSync(abs, content, { encoding: "utf8", mode: 0o600 });
    } catch (err2) {
      throw new ValidationError(
        `cannot write content file: ${abs}`,
        err2 instanceof Error ? err2.message : String(err2),
      );
    }
  }
}

/** Truncation control-plane fields for machine envelopes (generic field name). */
export function contentFieldMeta(
  applied: AppliedContentField,
  fieldLabel = "description",
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    [`${fieldLabel}_truncated`]: applied.truncated,
    [`${fieldLabel}_original_bytes`]: applied.original_bytes,
    [`${fieldLabel}_limit_bytes`]: applied.limit_bytes,
    body_source: applied.body_source,
  };
  if (applied.content_file) {
    meta.content_file = applied.content_file;
    meta.content_bytes = applied.content_bytes ?? applied.original_bytes;
  }
  if (applied.truncated) {
    meta.hint = `${fieldLabel} truncated for agent token budget; prefer --content-file / content_file (writes host FS) before editing; or --full-content / full_content for full wire body. Never rewrite from a truncated body.`;
  }
  return meta;
}

/**
 * Apply size policy to one string field on an entity; returns clone + control meta.
 * Used by document/project/initiative getters (content size phase-2).
 */
export async function applyEntityTextField<T extends Record<string, unknown>>(
  entity: T,
  field: keyof T & string,
  opts: { fullContent?: boolean; contentFile?: string },
): Promise<{ entity: T; content: Record<string, unknown>; truncated: boolean }> {
  const raw = entity[field];
  const text = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  const applied = await applyContentPolicy({
    text,
    fullContent: opts.fullContent,
    contentFile: opts.contentFile,
  });
  return {
    entity: { ...entity, [field]: applied.value },
    content: contentFieldMeta(applied, field === "content" ? "content" : "description"),
    truncated: applied.truncated,
  };
}
