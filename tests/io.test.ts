/**
 * Wave 3 / structured-error taxonomy: `resolveBody` + `resolveContent` mutex
 * errors must surface as ValidationError with code + hint, not raw Error.
 *
 * The body/content readers use `Bun.file()` + `Bun.stdin.text()`; vitest runs
 * under Node, so we stub the Bun global per-test. Only the mutex / no-source
 * error paths are covered here — happy-path reading is exercised by the CLI
 * + MCP integration tests.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../src/lib/errors.ts";
import { resolveBody, resolveContent } from "../src/lib/io.ts";

describe("resolveBody (structured errors)", () => {
  let prevBun: unknown;
  let prevIsTTY: boolean | undefined;
  let fileText = "";
  let stdinText = "";

  beforeEach(() => {
    prevBun = (globalThis as { Bun?: unknown }).Bun;
    prevIsTTY = process.stdin.isTTY;
    fileText = "";
    stdinText = "";
    // Force TTY so the "no body" path is taken (otherwise it falls back to
    // reading from piped stdin).
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    (globalThis as { Bun?: unknown }).Bun = {
      file: () => ({ text: async () => fileText }),
      stdin: { text: async () => stdinText },
    };
  });

  afterEach(() => {
    (globalThis as { Bun?: unknown }).Bun = prevBun;
    Object.defineProperty(process.stdin, "isTTY", { value: prevIsTTY, configurable: true });
  });

  it("no-source-with-tty is a ValidationError with code + hint", async () => {
    const err = await resolveBody({}).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "validation_error", hint: expect.any(String) });
  });

  it("multiple-source mutex is a ValidationError with code + hint", async () => {
    const err = await resolveBody({ body: "x", bodyFile: "/tmp/y" }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "validation_error", hint: expect.any(String) });
  });

  it("empty inline body is an explicit body provider", async () => {
    await expect(resolveBody({ body: "" })).resolves.toBe("");
  });

  it("empty inline body still participates in source mutex checks", async () => {
    const err = await resolveBody({ body: "", stdin: true }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "validation_error", hint: expect.any(String) });
  });

  it("body-file preserves leading whitespace and trims trailing whitespace", async () => {
    fileText = "  indented\n";

    await expect(resolveBody({ bodyFile: "/tmp/body.md" })).resolves.toBe("  indented");
  });

  it("explicit stdin preserves leading whitespace and trims trailing whitespace", async () => {
    stdinText = "  indented\n";

    await expect(resolveBody({ stdin: true })).resolves.toBe("  indented");
  });

  it("implicit piped stdin preserves leading whitespace and trims trailing whitespace", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    stdinText = "  indented\n";

    await expect(resolveBody({})).resolves.toBe("  indented");
  });
});

describe("resolveContent (structured errors)", () => {
  let prevBun: unknown;

  beforeEach(() => {
    prevBun = (globalThis as { Bun?: unknown }).Bun;
    (globalThis as { Bun?: unknown }).Bun = {
      file: () => ({ text: async () => "" }),
      stdin: { text: async () => "" },
    };
  });

  afterEach(() => {
    (globalThis as { Bun?: unknown }).Bun = prevBun;
  });

  it("multiple-source mutex is a ValidationError with code + hint", async () => {
    const err = await resolveContent({ content: "x", contentFile: "/tmp/y" }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "validation_error", hint: expect.any(String) });
  });

  it("empty inline content is an explicit content provider", async () => {
    await expect(resolveContent({ content: "" })).resolves.toBe("");
  });

  it("empty inline content still participates in source mutex checks", async () => {
    const err = await resolveContent({ content: "", stdin: true }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "validation_error", hint: expect.any(String) });
  });

  it("no-source returns undefined (signals 'leave unchanged')", async () => {
    const result = await resolveContent({});
    expect(result).toBeUndefined();
  });
});
