import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "../src/lib/errors.ts";
import { countRemainingPlanLintWarnings, lintPlanFiles } from "../src/lib/planLint.ts";
import { parsePlan, slugFromPath, splitFrontmatter } from "../src/lib/planParse.ts";
import { validatePlan } from "../src/lib/planValidate.ts";

// ---------- parse helpers ----------

describe("splitFrontmatter", () => {
  it("parses frontmatter + body", () => {
    const raw = ["---", "title: Hello", "state: Backlog", "---", "", "body goes here"].join("\n");
    const { frontmatter, body } = splitFrontmatter(raw);
    expect(frontmatter).toEqual({ title: "Hello", state: "Backlog" });
    expect(body.trim()).toBe("body goes here");
  });

  it("throws on missing frontmatter", () => {
    expect(() => splitFrontmatter("plain body only")).toThrow(/missing YAML frontmatter/);
  });

  it("accepts empty frontmatter", () => {
    const raw = ["---", "---", "body"].join("\n");
    const { frontmatter } = splitFrontmatter(raw);
    expect(frontmatter).toEqual({});
  });

  it("rejects scalar frontmatter", () => {
    const raw = ["---", "just a string", "---", "body"].join("\n");
    expect(() => splitFrontmatter(raw)).toThrow(/must be an object/);
  });

  // Wave 3 / structured-error taxonomy: parse failures must surface as
  // ValidationError with code + hint.
  it("missing-frontmatter error is a ValidationError with code + hint", () => {
    const err = (() => {
      try {
        splitFrontmatter("plain body only");
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "validation_error", hint: expect.any(String) });
  });

  it("scalar-frontmatter error is a ValidationError with code + hint", () => {
    const raw = ["---", "just a string", "---", "body"].join("\n");
    const err = (() => {
      try {
        splitFrontmatter(raw);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "validation_error", hint: expect.any(String) });
  });

  it("malformed YAML frontmatter is a ValidationError with a useful hint", () => {
    const raw = ["---", "labels: [unterminated", "---", "body"].join("\n");
    const err = (() => {
      try {
        splitFrontmatter(raw);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("frontmatter YAML is invalid"),
      hint: expect.stringContaining("frontmatter block"),
    });
  });
});

describe("slugFromPath", () => {
  it("strips .md extension", () => {
    expect(slugFromPath("/a/b/01-foo.md")).toBe("01-foo");
  });
  it("preserves casing + dashes", () => {
    expect(slugFromPath("Hello-World.md")).toBe("Hello-World");
  });
});

// ---------- parsePlan + validatePlan integration ----------

function writePlanDir(contents: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lebop-plan-test-"));
  for (const [name, content] of Object.entries(contents)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

describe("parsePlan", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it("parses a valid plan", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\n---\n\nbody",
      "01-first.md": "---\ntitle: First\n---\n\nfirst body",
      "02-second.md": "---\ntitle: Second\nblocked_by:\n  - 01-first\n---\n\nsecond body",
    });
    const plan = await parsePlan(dir);
    expect(plan.project.frontmatter.name).toBe("Test");
    expect(plan.issues.map((i) => i.slug).sort()).toEqual(["01-first", "02-second"]);
    expect(plan.issues.find((i) => i.slug === "02-second")?.frontmatter.blocked_by).toEqual([
      "01-first",
    ]);
  });

  it("throws when _project.md is missing", async () => {
    dir = writePlanDir({ "01-first.md": "---\ntitle: First\n---\n\nbody" });
    await expect(parsePlan(dir)).rejects.toThrow(/missing required `_project.md`/);
  });

  it("does not treat _initiative.md as a plan root (project+issues only)", async () => {
    // Product freeze: declarative plans are _project.md + issue files; initiatives
    // remain imperative CLI/MCP CRUD (not initiative-as-plan-root).
    dir = writePlanDir({
      "_initiative.md": "---\nname: Org Initiative\nteam: UE\n---\n\nbody\n",
      "01.md": "---\ntitle: Child\n---\n\n",
    });
    await expect(parsePlan(dir)).rejects.toThrow(/missing required `_project.md`/);
  });

  // Wave 3 / structured-error taxonomy: parsePlan throws must be typed.
  it("missing _project.md surfaces as ValidationError with code + hint", async () => {
    dir = writePlanDir({ "01-first.md": "---\ntitle: First\n---\n\nbody" });
    const err = await parsePlan(dir).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "validation_error", hint: expect.any(String) });
  });

  it("non-existent plan directory surfaces as NotFoundError with code + hint", async () => {
    const err = await parsePlan("/__lebop_does_not_exist__/nope").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toMatchObject({ code: "not_found", hint: expect.any(String) });
  });

  it("missing project.name surfaces as ValidationError with code + hint", async () => {
    dir = writePlanDir({
      "_project.md": "---\nteam: UE\n---\n\n",
      "01.md": "---\ntitle: x\n---\n\n",
    });
    const err = await parsePlan(dir).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "validation_error", hint: expect.any(String) });
  });

  it("missing issue.title surfaces as ValidationError with code + hint", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "01.md": "---\nstate: Backlog\n---\n\n",
    });
    const err = await parsePlan(dir).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "validation_error", hint: expect.any(String) });
  });

  it("malformed issue frontmatter includes the source path in the ValidationError", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "01.md": "---\ntitle: [unterminated\n---\n\n",
    });
    const err = await parsePlan(dir).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({
      code: "validation_error",
      message: expect.stringContaining(join(dir, "01.md")),
      hint: expect.stringContaining("frontmatter block"),
    });
  });

  it("throws when project.name is missing", async () => {
    dir = writePlanDir({
      "_project.md": "---\nteam: UE\n---\n\n",
      "01.md": "---\ntitle: x\n---\n\n",
    });
    await expect(parsePlan(dir)).rejects.toThrow(
      /project frontmatter missing required field `name`/,
    );
  });

  it("throws when issue.title is missing", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: Test\nteam: UE\n---\n\n",
      "01.md": "---\nstate: Backlog\n---\n\n",
    });
    await expect(parsePlan(dir)).rejects.toThrow(
      /issue frontmatter missing required field `title`/,
    );
  });

  it("respects explicit `slug:` override", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "01-foo.md": "---\ntitle: Foo\nslug: alpha\n---\n\n",
    });
    const plan = await parsePlan(dir);
    expect(plan.issues[0]?.slug).toBe("alpha");
  });

  it("ignores non-.md files and subdirectories", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "01.md": "---\ntitle: x\n---\n\n",
      "README.txt": "ignore me",
    });
    const plan = await parsePlan(dir);
    expect(plan.issues.map((i) => i.slug)).toEqual(["01"]);
  });

  it("lints only parsed plan files and skips documentation siblings", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "01.md": "---\ntitle: x\n---\n\nClean body.\n",
      "README.md": "Doc body.\n---\nthis should not be linted or fixed\n",
      "CHANGELOG.md": "Another doc.\n---\nthis should not be linted or fixed\n",
    });
    const plan = await parsePlan(dir);
    const beforeReadme = readFileSync(join(dir, "README.md"), "utf8");
    const beforeChangelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
    const previousBun = (globalThis as { Bun?: unknown }).Bun;
    (globalThis as { Bun?: unknown }).Bun = {
      file: (path: string) => ({
        text: async () => readFileSync(path, "utf8"),
      }),
    };

    try {
      const result = await lintPlanFiles(plan, { fix: true });

      expect(result.map((row) => row.path).sort()).toEqual(
        [join(dir, "_project.md"), join(dir, "01.md")].sort(),
      );
      expect(readFileSync(join(dir, "README.md"), "utf8")).toBe(beforeReadme);
      expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toBe(beforeChangelog);
    } finally {
      (globalThis as { Bun?: unknown }).Bun = previousBun;
    }
  });

  it("reports post-fix warnings after applying safe plan lint fixes", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "01.md": ["---", "title: x", "---", "| Header |", "| --- |", "| 1. inline list |", ""].join(
        "\n",
      ),
    });
    const plan = await parsePlan(dir);
    const previousBun = (globalThis as { Bun?: unknown }).Bun;
    (globalThis as { Bun?: unknown }).Bun = {
      file: (path: string) => ({
        text: async () => readFileSync(path, "utf8"),
      }),
      write: async (path: string, content: string) => {
        writeFileSync(path, content);
      },
    };

    try {
      const result = await lintPlanFiles(plan, { fix: true });
      const issueFile = result.find((row) => row.path.endsWith("01.md"));

      expect(issueFile?.fixed).toBe(1);
      expect(issueFile?.warnings).toEqual([]);
      expect(countRemainingPlanLintWarnings(result, true)).toBe(0);
      expect(readFileSync(join(dir, "01.md"), "utf8")).toContain("Row 1");
    } finally {
      (globalThis as { Bun?: unknown }).Bun = previousBun;
    }
  });
});

describe("validatePlan", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it("passes a well-formed plan", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nblocks:\n  - b\n---\n\n",
      "b.md": "---\ntitle: b\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const result = validatePlan(plan, null);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("keeps the bundled getting-started example syntactically valid", async () => {
    const plan = await parsePlan(join("docs", "examples", "getting-started"));
    const result = validatePlan(plan, null);

    expect(result.errors).toEqual([]);
  });

  it("rejects emoji project icon", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\nicon: 🚀\n---\n\n",
      "a.md": "---\ntitle: a\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const errs = validatePlan(plan, null).errors;
    expect(errs.some((e) => e.message.includes("looks like an emoji"))).toBe(true);
  });

  it("flags unresolvable link references", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nblocks:\n  - missing-slug\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const errs = validatePlan(plan, null).errors;
    expect(errs).toHaveLength(1);
    expect(errs[0]?.message).toMatch(/doesn't match any slug.*isn't a Linear identifier/);
  });

  it("errors on multi-type relation declarations between the same pair", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nblocks:\n  - b\n---\n\n",
      "b.md": "---\ntitle: b\nrelated:\n  - a\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const result = validatePlan(plan, null);
    expect(result.warnings.find((w) => w.rule === "relation-pair-conflict")).toBeUndefined();
    const error = result.errors.find((e) => /multiple relation kinds/.test(e.message));
    expect(error).toBeDefined();
    expect(error?.message).toMatch(/multiple relation kinds.*"a".*"b".*blocks.*related/);
  });

  it("errors on multi-type relation declarations that reference local linear_id values", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nlinear_id: UE-100\nblocks:\n  - UE-200\n---\n\n",
      "b.md": "---\ntitle: b\nlinear_id: UE-200\nrelated:\n  - UE-100\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const result = validatePlan(plan, null);
    expect(result.warnings.find((w) => w.rule === "relation-pair-conflict")).toBeUndefined();
    const error = result.errors.find((e) => /multiple relation kinds/.test(e.message));
    expect(error).toBeDefined();
    expect(error?.message).toMatch(/multiple relation kinds.*"a".*"b".*blocks.*related/);
  });

  it("does NOT warn when same-pair declarations describe the same relation kind", async () => {
    // A.blocks: [B] and B.blocked_by: [A] are equivalent — same kind, just
    // declared from both sides. No conflict.
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nblocks:\n  - b\n---\n\n",
      "b.md": "---\ntitle: b\nblocked_by:\n  - a\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const result = validatePlan(plan, null);
    expect(result.warnings.find((w) => w.rule === "relation-pair-conflict")).toBeUndefined();
  });

  it("errors on opposite blocker declarations for the same pair", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nblocks:\n  - b\n---\n\n",
      "b.md": "---\ntitle: b\nblocks:\n  - a\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const result = validatePlan(plan, null);
    expect(result.errors.find((e) => /opposite blocker relations/.test(e.message))).toBeDefined();
  });

  it("accepts external Linear identifiers as link targets", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nrelated:\n  - UE-321\n  - A1-42\n---\n\n",
    });
    const plan = await parsePlan(dir);
    expect(validatePlan(plan, null).errors).toEqual([]);
  });

  it("detects slug collisions via explicit `slug:` override", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nslug: same\n---\n\n",
      "b.md": "---\ntitle: b\nslug: same\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const errs = validatePlan(plan, null).errors;
    expect(errs.some((e) => e.message.includes("duplicate slug"))).toBe(true);
  });

  it("warns on cycle in blocks graph", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nblocks:\n  - b\n---\n\n",
      "b.md": "---\ntitle: b\nblocks:\n  - a\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const warns = validatePlan(plan, null).warnings;
    expect(warns.some((w) => w.rule === "blocks-cycle")).toBe(true);
  });

  it("warns on cycle in blocks graph through local linear_id references", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nlinear_id: UE-100\nblocks:\n  - UE-200\n---\n\n",
      "b.md": "---\ntitle: b\nlinear_id: UE-200\nblocks:\n  - UE-100\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const warns = validatePlan(plan, null).warnings;
    expect(warns.some((w) => w.rule === "blocks-cycle")).toBe(true);
  });

  it("warns on slug that matches Linear-identifier regex", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "UE-fake.md": "---\ntitle: a\nslug: UE-99\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const warns = validatePlan(plan, null).warnings;
    expect(warns.some((w) => w.rule === "slug-shadow")).toBe(true);
  });

  it("warns when duplicates:/duplicated_by: appear without blocking pulled round trips", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nduplicates:\n  - UE-100\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const result = validatePlan(plan, null);
    expect(result.errors).toEqual([]);
    expect(result.warnings.find((w) => w.rule === "duplicate-side-effect")).toBeDefined();
  });

  it("surfaces lint warnings on issue bodies", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\n---\nSome text.\n---\nmore",
    });
    const plan = await parsePlan(dir);
    const warns = validatePlan(plan, null).warnings;
    expect(warns.some((w) => w.rule === "L006")).toBe(true);
  });

  it("accepts valid parent reference (slug)", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\n---\n\n",
      "b.md": "---\ntitle: b\nparent: a\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const errs = validatePlan(plan, null).errors;
    expect(errs).toEqual([]);
  });

  it("accepts valid parent reference (external TEAM-NN)", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nparent: A1-999\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const errs = validatePlan(plan, null).errors;
    expect(errs).toEqual([]);
  });

  it("flags unknown parent slug", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nparent: missing\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const errs = validatePlan(plan, null).errors;
    expect(errs.some((e) => e.message.includes("parent: missing"))).toBe(true);
  });

  it("detects cycle in parent chain", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nparent: b\n---\n\n",
      "b.md": "---\ntitle: b\nparent: a\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const errs = validatePlan(plan, null).errors;
    expect(errs.some((e) => e.message.includes("cycle in parent chain"))).toBe(true);
  });

  it("detects cycle in parent chain through local linear_id references", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nlinear_id: UE-100\nparent: UE-200\n---\n\n",
      "b.md": "---\ntitle: b\nlinear_id: UE-200\nparent: UE-100\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const errs = validatePlan(plan, null).errors;
    expect(errs.some((e) => e.message.includes("cycle in parent chain"))).toBe(true);
  });

  it("accepts estimate as a number", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nestimate: 3\n---\n\n",
    });
    const plan = await parsePlan(dir);
    expect(plan.issues[0]?.frontmatter.estimate).toBe(3);
    expect(validatePlan(plan, null).errors).toEqual([]);
  });

  it("rejects malformed scalar frontmatter types before semantic resolution", async () => {
    dir = writePlanDir({
      "_project.md":
        "---\nname: T\nteam: UE\nlinear_id:\n  - not-a-string\ndescription:\n  nested: true\nicon: 123\nstate: false\n_server: stale\n---\n\n",
      "a.md":
        '---\ntitle: a\nlinear_id: 42\nstate: false\npriority:\n  - high\nestimate: "3"\nlabels: label-as-string\nassignee:\n  name: Alice\nslug: 99\n_server:\n  updated_at: 123\nblocks: blocked-as-string\n---\n\n',
    });
    const plan = await parsePlan(dir);
    const errors = validatePlan(plan, {
      team_id: "team-uuid",
      team_key: "UE",
      fetched_at: "2026-01-01T00:00:00Z",
      states: [],
      labels: [],
      members: [],
      projects: [],
    }).errors.map((error) => error.message);

    expect(errors).toContain("project frontmatter field `linear_id` must be a string");
    expect(errors).toContain("project frontmatter field `description` must be a string");
    expect(errors).toContain("project frontmatter field `icon` must be a string or null");
    expect(errors).toContain("project frontmatter field `state` must be a string");
    expect(errors).toContain("project frontmatter field `_server` must be an object");
    expect(errors).toContain("issue frontmatter field `linear_id` must be a string");
    expect(errors).toContain("issue frontmatter field `state` must be a string");
    expect(errors).toContain("issue frontmatter field `priority` must be a string or number");
    expect(errors).toContain("issue frontmatter field `estimate` must be a number or null");
    expect(errors).toContain("`labels:` must be a list of strings");
    expect(errors).toContain("issue frontmatter field `assignee` must be a string or null");
    expect(errors).toContain("issue frontmatter field `slug` must be a string");
    expect(errors).toContain("issue frontmatter field `_server.updated_at` must be a string");
    expect(errors).toContain("`blocks:` must be a list of strings");
  });

  it("rejects unsupported project and issue frontmatter keys", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\ntarget_dtae: 2026-06-30\n---\n\n",
      "a.md": "---\ntitle: a\nmilestone: M1\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const errors = validatePlan(plan, null).errors.map((error) => error.message);
    expect(errors).toContain("unsupported project frontmatter field: target_dtae");
    expect(errors).toContain("unsupported issue frontmatter field: milestone");
  });

  it("accepts project date frontmatter fields", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\nstart_date: 2026-06-01\ntarget_date: null\n---\n\n",
      "a.md": "---\ntitle: a\n---\n\n",
    });
    const plan = await parsePlan(dir);
    expect(plan.project.frontmatter.start_date).toBe("2026-06-01");
    expect(plan.project.frontmatter.target_date).toBeNull();
    expect(validatePlan(plan, null).errors).toEqual([]);
  });

  it("rejects malformed project date frontmatter fields", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\nstart_date: soon\n---\n\n",
      "a.md": "---\ntitle: a\n---\n\n",
    });
    const plan = await parsePlan(dir);
    expect(validatePlan(plan, null).errors[0]?.message).toContain(
      "project frontmatter field `start_date` must use YYYY-MM-DD format",
    );
  });

  it("validates assignee names against team metadata", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nassignee: Missing Person\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const result = validatePlan(plan, {
      team_id: "team-uuid",
      team_key: "UE",
      fetched_at: "2026-01-01T00:00:00Z",
      states: [],
      labels: [],
      members: [{ id: "user-alice", name: "Alice Example", email: "alice@example.com" }],
      projects: [],
    });
    expect(result.errors.some((e) => e.message.includes('unknown assignee "Missing Person"'))).toBe(
      true,
    );
  });

  it("accepts @me as an assignee validation keyword", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": '---\ntitle: a\nassignee: "@me"\n---\n\n',
    });
    const plan = await parsePlan(dir);
    const result = validatePlan(plan, {
      team_id: "team-uuid",
      team_key: "UE",
      fetched_at: "2026-01-01T00:00:00Z",
      states: [],
      labels: [],
      members: [],
      projects: [],
    });
    expect(result.errors).toEqual([]);
  });
});
