import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SKILL_INSTALLS = [
  { rel: join("cli", "lebop"), name: "lebop-cli" },
  { rel: join("cli", "lebop-program"), name: "lebop-cli-program" },
  { rel: join("cli", "lebop-execution"), name: "lebop-cli-execution" },
  { rel: join("mcp", "lebop"), name: "lebop-mcp" },
  { rel: join("mcp", "lebop-program"), name: "lebop-mcp-program" },
  { rel: join("mcp", "lebop-execution"), name: "lebop-mcp-execution" },
] as const;

const COMMANDS = [
  "lebop-research.md",
  "lebop-pull.md",
  "lebop-push.md",
  "lebop-publish.md",
  "lebop-lint.md",
] as const;

describe("bin/install-claude", () => {
  let claudeHome: string;

  beforeEach(() => {
    claudeHome = mkdtempSync(join(tmpdir(), "lebop-claude-install-"));
  });

  afterEach(() => {
    rmSync(claudeHome, { recursive: true, force: true });
  });

  it("installs all six medium/role skills and slash commands", () => {
    const skillDir = join(claudeHome, "skills", "lebop-cli");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "legacy skill\n");

    execFileSync(join(process.cwd(), "bin", "install-claude"), {
      env: { ...process.env, CLAUDE_HOME: claudeHome },
      encoding: "utf8",
    });

    expect(lstatSync(skillDir).isSymbolicLink()).toBe(true);

    const backups = readdirSync(join(claudeHome, "skills")).filter((name) =>
      name.startsWith("lebop-cli.backup-"),
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(claudeHome, "skills", backups[0] as string, "SKILL.md"), "utf8")).toBe(
      "legacy skill\n",
    );

    for (const { rel, name } of SKILL_INSTALLS) {
      const skill = join(claudeHome, "skills", name);
      expect(existsSync(skill), `${name} was not installed`).toBe(true);
      expect(lstatSync(skill).isSymbolicLink(), `${name} is not a symlink`).toBe(true);
      expect(readlinkSync(skill)).toBe(join(process.cwd(), "agents", "skills", rel));
    }

    for (const name of COMMANDS) {
      const command = join(claudeHome, "commands", name);
      expect(existsSync(command), `${name} was not installed`).toBe(true);
      expect(lstatSync(command).isSymbolicLink(), `${name} is not a symlink`).toBe(true);
    }
  });

  it("ships exactly six isolated skills with matching frontmatter names", () => {
    const skillsRoot = join(process.cwd(), "agents", "skills");
    const found: { path: string; name: string; body: string }[] = [];

    for (const medium of ["cli", "mcp"] as const) {
      const mediumDir = join(skillsRoot, medium);
      expect(existsSync(mediumDir), `missing medium ${medium}`).toBe(true);
      for (const role of readdirSync(mediumDir)) {
        const skillMd = join(mediumDir, role, "SKILL.md");
        if (!existsSync(skillMd)) continue;
        const body = readFileSync(skillMd, "utf8");
        const name = body.match(/^name:\s*(.+)$/m)?.[1]?.trim();
        expect(name, `${medium}/${role} missing name:`).toBeTruthy();
        found.push({ path: `${medium}/${role}`, name: name as string, body });
      }
    }

    expect(found.map((f) => f.name).sort()).toEqual(
      [
        "lebop-cli",
        "lebop-cli-execution",
        "lebop-cli-program",
        "lebop-mcp",
        "lebop-mcp-execution",
        "lebop-mcp-program",
      ].sort(),
    );

    // No references/ progressive disclosure dirs
    expect(existsSync(join(skillsRoot, "cli", "lebop", "references"))).toBe(false);
    expect(existsSync(join(skillsRoot, "mcp", "lebop", "references"))).toBe(false);

    for (const f of found) {
      expect(f.body).toMatch(/^---\nname:\s/m);
      expect(f.body).toMatch(/^description:\s/m);
      // Isolation: no cross-skill path links
      expect(f.body).not.toMatch(/\.\.\/(lebop|cli|mcp)\//);
      expect(f.body).not.toMatch(/agents\/skills\//);
      expect(f.body).not.toMatch(/references\//);
    }

    const allNames = found.map((f) => f.name);
    const mentionsInstallName = (body: string, name: string) =>
      new RegExp(`(?<![A-Za-z0-9-])${name.replace(/-/g, "\\-")}(?![A-Za-z0-9-])`).test(body);
    // Medium purity + isolation: no peer skill install-name references; CLI ≠ MCP inventory
    for (const f of found) {
      for (const other of allNames) {
        if (other === f.name) continue;
        expect(
          mentionsInstallName(f.body, other),
          `${f.name} must not reference peer skill ${other}`,
        ).toBe(false);
      }
    }
    for (const f of found.filter((x) => x.name.startsWith("lebop-cli"))) {
      expect(f.body.toLowerCase()).toMatch(/cli/);
      expect(f.body).not.toMatch(/explore_linear_workspace/);
    }
    for (const f of found.filter((x) => x.name.startsWith("lebop-mcp"))) {
      expect(f.body.toLowerCase()).toMatch(/mcp/);
      expect(f.body).not.toMatch(/```sh\s*\nlebop /);
    }
  });

  it("advertises research surface in CLI and MCP monolith descriptions", () => {
    for (const rel of [join("cli", "lebop"), join("mcp", "lebop")]) {
      const skill = readFileSync(join(process.cwd(), "agents", "skills", rel, "SKILL.md"), "utf8");
      const description = skill.match(/^description:\s*(.+)$/m)?.[1] ?? "";
      for (const term of ["Linear", "explore", "publish", "Personal API key"]) {
        expect(description.toLowerCase()).toContain(term.toLowerCase());
      }
    }
  });

  it("moves an existing real slash command file aside before symlinking", () => {
    const commandsDir = join(claudeHome, "commands");
    mkdirSync(commandsDir, { recursive: true });
    const command = join(commandsDir, "lebop-pull.md");
    writeFileSync(command, "legacy command\n");

    execFileSync(join(process.cwd(), "bin", "install-claude"), {
      env: { ...process.env, CLAUDE_HOME: claudeHome },
      encoding: "utf8",
    });

    expect(lstatSync(command).isSymbolicLink()).toBe(true);
    expect(readlinkSync(command)).toBe(join(process.cwd(), "agents", "commands", "lebop-pull.md"));

    const backups = readdirSync(commandsDir).filter((name) =>
      name.startsWith("lebop-pull.md.backup-"),
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(commandsDir, backups[0] as string), "utf8")).toBe("legacy command\n");
  });

  it("moves an unexpected slash command symlink aside before symlinking", () => {
    const commandsDir = join(claudeHome, "commands");
    mkdirSync(commandsDir, { recursive: true });
    const legacyTarget = join(claudeHome, "legacy-command.md");
    writeFileSync(legacyTarget, "legacy command\n");
    const command = join(commandsDir, "lebop-pull.md");
    symlinkSync(legacyTarget, command);

    execFileSync(join(process.cwd(), "bin", "install-claude"), {
      env: { ...process.env, CLAUDE_HOME: claudeHome },
      encoding: "utf8",
    });

    expect(lstatSync(command).isSymbolicLink()).toBe(true);
    expect(readlinkSync(command)).toBe(join(process.cwd(), "agents", "commands", "lebop-pull.md"));

    const backups = readdirSync(commandsDir).filter((name) =>
      name.startsWith("lebop-pull.md.backup-"),
    );
    expect(backups).toHaveLength(1);
    expect(lstatSync(join(commandsDir, backups[0] as string)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(commandsDir, backups[0] as string))).toBe(legacyTarget);
  });

  it("moves a symlinked commands directory aside instead of following it", () => {
    const commandsDir = join(claudeHome, "commands");
    const externalCommands = join(claudeHome, "external-commands");
    mkdirSync(externalCommands, { recursive: true });
    symlinkSync(externalCommands, commandsDir, "dir");

    execFileSync(join(process.cwd(), "bin", "install-claude"), {
      env: { ...process.env, CLAUDE_HOME: claudeHome },
      encoding: "utf8",
    });

    expect(lstatSync(commandsDir).isSymbolicLink()).toBe(false);
    expect(lstatSync(commandsDir).isDirectory()).toBe(true);
    expect(existsSync(join(commandsDir, "lebop-pull.md"))).toBe(true);
    expect(existsSync(join(externalCommands, "lebop-pull.md"))).toBe(false);

    const backups = readdirSync(claudeHome).filter((name) => name.startsWith("commands.backup-"));
    expect(backups).toHaveLength(1);
    const backup = join(claudeHome, backups[0] as string);
    expect(lstatSync(backup).isSymbolicLink()).toBe(true);
    expect(readlinkSync(backup)).toBe(externalCommands);
  });
});
