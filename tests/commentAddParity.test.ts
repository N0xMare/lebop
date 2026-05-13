/**
 * Wave-4 round-B item #7: CLI `lebop comment add --json` field-name parity
 * with MCP `add_comment`. Both surfaces now emit `{schema_version, identifier,
 * comment: {...}}`. The CLI previously emitted `{schema_version, issue,
 * comment: {...}}` — same semantics, different key.
 *
 * Unit-level rather than CLI-integration because `addComment` uses the SDK-typed
 * `c.issue(id)` path that requires a 60+ field fragment to hydrate. Mocking the
 * full fragment is brittle and unrelated to what this test is asserting (the
 * envelope field name). We mock the lib `addComment` directly and exercise the
 * command's stdout-write path.
 */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the lib so the command's stdout-write path is the only thing exercised.
// Round-8 backlog / N4: extend mock to return the full A26 shape (body/url/
// user) so the CLI's MED-4 full-echo behavior is regression-locked here too.
// Pre-fix this mock only returned `{id, created_at}` and the test couldn't
// validate that the new fields land in the JSON envelope.
vi.mock("../src/lib/comments.ts", () => ({
  addComment: vi.fn(async () => ({
    id: "comment-uuid-aa",
    created_at: "2026-05-11T18:00:00.000Z",
    body: "hi there",
    url: "https://linear.app/test/comment/comment-uuid-aa",
    user: { id: "u-1", name: "Test Viewer", email: "viewer@example.com" },
  })),
  listComments: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
}));

import { registerComment } from "../src/commands/comment.ts";

describe("comment add --json envelope (wave-4 round-B item #7)", () => {
  let writes: string[];
  let restore: () => void;

  beforeEach(() => {
    writes = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    restore = () => {
      process.stdout.write = orig;
    };
  });

  afterEach(() => {
    restore();
  });

  it("emits `identifier` (not legacy `issue`) in the --json envelope", async () => {
    const program = new Command();
    registerComment(program);
    await program.parseAsync(["comment", "add", "NOX-1", "--body", "hi there", "--json"], {
      from: "user",
    });

    const out = writes.join("");
    const parsed = JSON.parse(out);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.identifier).toBe("NOX-1");
    // Legacy field is gone — agents shouldn't see it any more.
    expect(parsed).not.toHaveProperty("issue");
    expect(parsed.comment.id).toBe("comment-uuid-aa");
  });

  it("echoes the full A26 comment shape (body/url/user) in the --json envelope (round-8 / N4)", async () => {
    // Round-7 / MED-4 changed the CLI to echo `result` directly instead of
    // a hand-picked `{id, created_at}` subset, picking up the A26-added
    // body/url/user fields automatically. Round-8 / N4 extends this test's
    // mock to assert they actually land in the envelope.
    const program = new Command();
    registerComment(program);
    await program.parseAsync(["comment", "add", "NOX-1", "--body", "hi there", "--json"], {
      from: "user",
    });

    const out = writes.join("");
    const parsed = JSON.parse(out);
    expect(parsed.comment.body).toBe("hi there");
    expect(parsed.comment.url).toBe("https://linear.app/test/comment/comment-uuid-aa");
    expect(parsed.comment.user).toEqual({
      id: "u-1",
      name: "Test Viewer",
      email: "viewer@example.com",
    });
  });
});
