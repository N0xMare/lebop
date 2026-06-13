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

describe("bin/install-claude", () => {
  let claudeHome: string;

  beforeEach(() => {
    claudeHome = mkdtempSync(join(tmpdir(), "lebop-claude-install-"));
  });

  afterEach(() => {
    rmSync(claudeHome, { recursive: true, force: true });
  });

  it("moves an existing real skill directory aside before symlinking", () => {
    const skillDir = join(claudeHome, "skills", "lebop");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "legacy skill\n");

    execFileSync(join(process.cwd(), "bin", "install-claude"), {
      env: { ...process.env, CLAUDE_HOME: claudeHome },
      encoding: "utf8",
    });

    expect(lstatSync(skillDir).isSymbolicLink()).toBe(true);

    const backups = readdirSync(join(claudeHome, "skills")).filter((name) =>
      name.startsWith("lebop.backup-"),
    );
    expect(backups).toHaveLength(1);
    const backupSkill = join(claudeHome, "skills", backups[0] as string, "SKILL.md");
    expect(readFileSync(backupSkill, "utf8")).toBe("legacy skill\n");

    for (const name of [
      "lebop-research.md",
      "lebop-pull.md",
      "lebop-push.md",
      "lebop-publish.md",
      "lebop-lint.md",
    ]) {
      const command = join(claudeHome, "commands", name);
      expect(existsSync(command), `${name} was not installed`).toBe(true);
      expect(lstatSync(command).isSymbolicLink(), `${name} is not a symlink`).toBe(true);
    }
  });

  it("advertises the full Linear research surface in skill trigger metadata", () => {
    const skill = readFileSync(
      join(process.cwd(), "agents", "skills", "lebop", "SKILL.md"),
      "utf8",
    );
    const description = skill.match(/^description:\s*(.+)$/m)?.[1] ?? "";

    for (const term of [
      "workspace research",
      "explore/fetch",
      "initiatives",
      "milestones",
      "cycles",
      "documents",
      "agent sessions",
      "reviewed publish",
      "CLI/MCP",
    ]) {
      expect(description.toLowerCase()).toContain(term.toLowerCase());
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
