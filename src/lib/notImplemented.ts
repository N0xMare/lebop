import chalk from "chalk";

export function notImplemented(command: string, phase: string): never {
  process.stderr.write(`${chalk.yellow("not yet implemented:")} ${command} ships in ${phase}\n`);
  process.exit(2);
}
