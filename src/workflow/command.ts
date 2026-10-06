import fs from 'node:fs';
import path from 'node:path';

/** Valid command and skill names: lowercase words joined by dashes. */
export const COMMAND_NAME = /^[a-z0-9][a-z0-9-]*$/;

const COMMAND_LINE = /^\/([a-z0-9][a-z0-9-]*)(?:\s+(.*))?$/i;

/** A `/<name> [args]` line at the top of an issue description. */
export interface IssueCommand {
  name: string;
  /** Everything after the name, trimmed; empty when the line has no arguments. */
  args: string;
}

/** An issue command that has a skill in one of the plugins, as the prompt template sees it. */
export interface ResolvedCommand extends IssueCommand {
  /** Name the agent loads with the Skill tool, `<plugin>:<name>`. */
  skill: string;
}

/**
 * The command in the first non-empty line of `description`, or null. Only that line counts, so a path such as
 * `/api/users` or a sentence that mentions `/refactoring` further down stays an ordinary issue.
 */
export function parseIssueCommand(description: string | null): IssueCommand | null {
  if (description === null) return null;
  const first = description.split(/\r?\n/).find((line) => line.trim() !== '');
  const match = first === undefined ? null : COMMAND_LINE.exec(first.trim());
  if (match === null || match[1] === undefined) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

/** Plugin name from `.claude-plugin/plugin.json`, else the directory name. */
function pluginName(dir: string): string {
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
    const name = typeof manifest === 'object' && manifest !== null ? (manifest as { name?: unknown }).name : undefined;
    if (typeof name === 'string' && name.trim() !== '') return name.trim();
  } catch {
    // no readable manifest: the directory name is what Claude Code falls back to
  }
  return path.basename(path.resolve(dir));
}

/**
 * Skills the plugins ship, by directory name, mapped to the name the Skill tool takes (`symphony:refactoring`).
 * The first plugin that ships a name wins.
 */
export function commandSkills(pluginDirs: readonly string[]): ReadonlyMap<string, string> {
  const skills = new Map<string, string>();
  for (const dir of pluginDirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, 'skills'), { withFileTypes: true });
    } catch {
      continue;
    }
    const plugin = pluginName(dir);
    for (const entry of entries) {
      if (!entry.isDirectory() || !COMMAND_NAME.test(entry.name) || skills.has(entry.name)) continue;
      if (fs.existsSync(path.join(dir, 'skills', entry.name, 'SKILL.md'))) skills.set(entry.name, `${plugin}:${entry.name}`);
    }
  }
  return skills;
}

/** The command of `description` when a plugin ships a skill of that name; an unknown command is no command. */
export function resolveIssueCommand(description: string | null, skills: ReadonlyMap<string, string>): ResolvedCommand | null {
  const command = parseIssueCommand(description);
  const skill = command === null ? undefined : skills.get(command.name);
  return command === null || skill === undefined ? null : { ...command, skill };
}
