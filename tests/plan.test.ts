import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  it("warns on multi-type relation declarations between the same pair", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nblocks:\n  - b\n---\n\n",
      "b.md": "---\ntitle: b\nrelated:\n  - a\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const result = validatePlan(plan, null);
    expect(result.errors).toEqual([]);
    const warning = result.warnings.find((w) => w.rule === "relation-pair-conflict");
    expect(warning).toBeDefined();
    expect(warning?.message).toMatch(/multiple relation kinds.*"a".*"b".*blocks.*related/);
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

  it("accepts external Linear identifiers as link targets", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nrelated:\n  - UE-321\n---\n\n",
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

  it("warns on slug that matches Linear-identifier regex", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "UE-fake.md": "---\ntitle: a\nslug: UE-99\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const warns = validatePlan(plan, null).warnings;
    expect(warns.some((w) => w.rule === "slug-shadow")).toBe(true);
  });

  it("warns when duplicates:/duplicated_by: appear (side-effect)", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nduplicates:\n  - UE-100\n---\n\n",
    });
    const plan = await parsePlan(dir);
    const warns = validatePlan(plan, null).warnings;
    expect(warns.some((w) => w.rule === "duplicate-side-effect")).toBe(true);
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

  it("accepts valid parent reference (external UE-NN)", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nparent: UE-999\n---\n\n",
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

  it("accepts estimate as a number", async () => {
    dir = writePlanDir({
      "_project.md": "---\nname: T\nteam: UE\n---\n\n",
      "a.md": "---\ntitle: a\nestimate: 3\n---\n\n",
    });
    const plan = await parsePlan(dir);
    expect(plan.issues[0]?.frontmatter.estimate).toBe(3);
    expect(validatePlan(plan, null).errors).toEqual([]);
  });
});
