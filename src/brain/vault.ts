import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../log.ts';
import { isRepositoryName } from '../tracker/github-project/settings.ts';
import { errorMessage } from '../util/errors.ts';
import { isStrictlyInside } from '../util/paths.ts';
import type { BrainConfig } from '../workflow/config.ts';
import { initVaultGit } from './git.ts';

export const VAULT_FOLDERS = ['Inbox', 'Repos', 'Decisions', 'Lessons', 'Issues', 'Agents'] as const;

export const GITIGNORE_TEXT = `.obsidian/workspace*.json\n.trash/\n`;

export const README_TEXT = `# Symphony brain

The knowledge vault of Symphony: one vault for all repositories. Symphony creates the structure below at startup
and never overwrites an existing file or folder.

## Views

\`Kandidaten-Review.base\` (inbox, oldest first) and \`Neueste Lessons.base\` (latest lessons) are Obsidian Bases views that Symphony creates once.

## Folders

- \`Inbox/\`: new notes; every note starts here as \`candidate\`.
- \`Repos/<owner>-<name>/\`: knowledge about one repository, starting with its \`index.md\`.
- \`Decisions/\`: decisions and their reasons.
- \`Lessons/\`: lessons learned from runs.
- \`Issues/\`: notes about single issues.
- \`Agents/\`: notes about roles and agents.

## Frontmatter

Every note starts with a YAML frontmatter block with these fields:

- \`type\`: kind of note (for example \`index\`, \`decision\`, \`lesson\`).
- \`status\`: \`candidate\`, \`approved\` or \`deprecated\` (see below).
- \`repo\`: the repository the note is about (\`owner/name\`).
- \`issue\`: the issue number or reference.
- \`role\`: the role that wrote the note.
- \`run\`: the run that produced the note.
- \`created\`: creation date (\`YYYY-MM-DD\`).
- \`updated\`: date of the last change (\`YYYY-MM-DD\`).
- \`sources\`: where the knowledge comes from (issues, pull requests, files).

## Status

- \`candidate\`: new and not reviewed yet.
- \`approved\`: reviewed; preferred when searching.
- \`deprecated\`: outdated; never used in searches.

## Versioning

The vault is a git repository. Every write by an agent is one commit: the author is \`symphony-<role>\`, the message is \`<issue> <run>: <purpose>\` with the path below it.
Changes made in Obsidian are committed as \`human\` (\`Obsidian: <n> Dateien\`) before the next agent write; \`.obsidian/\` is never committed.
Undo a change with \`git revert <sha>\`.

## Rules

- Symphony never overwrites existing files or folders.
- \`.obsidian/\` belongs to the human editing the vault; Symphony never creates, reads or writes it.
`;

export const CANDIDATE_REVIEW_BASE_FILE = 'Kandidaten-Review.base';
export const LATEST_LESSONS_BASE_FILE = 'Neueste Lessons.base';

export const CANDIDATE_REVIEW_BASE = `filters:
  and:
    - status == "candidate"
views:
  - type: table
    name: Kandidaten-Review
    order:
      - file.name
      - type
      - repo
      - issue
      - role
      - created
    sort:
      - property: created
        direction: ASC
`;

export const LATEST_LESSONS_BASE = `filters:
  and:
    - type == "lesson"
views:
  - type: table
    name: Neueste Lessons
    order:
      - file.name
      - status
      - repo
      - updated
    sort:
      - property: updated
        direction: DESC
    limit: 50
`;

/** `owner/name` becomes `owner-name`, lower case (GitHub names are case-insensitive). */
export function repoFolderName(repository: string): string {
  return repository.replace('/', '-').toLowerCase();
}

function indexText(repository: string, date: string): string {
  return `---
type: index
status: approved
repo: ${repository}
created: ${date}
updated: ${date}
---

# ${repository}

Entry point to the knowledge about this repository.
`;
}

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

/** Creates a folder; false when it already exists (nothing is touched then). */
async function createDir(dir: string): Promise<boolean> {
  try {
    await fs.mkdir(dir);
    return true;
  } catch (error) {
    if (isExists(error)) return false;
    throw error;
  }
}

/** Creates a file; false when it already exists (it is neither read nor changed). */
async function createFile(file: string, text: string): Promise<boolean> {
  try {
    await fs.writeFile(file, text, { flag: 'wx' });
    return true;
  } catch (error) {
    if (isExists(error)) return false;
    throw error;
  }
}

/** Creates the vault structure under `root`; returns the newly created paths relative to `root`. */
export async function ensureVault(root: string, repositories: readonly string[] = [], now: Date = new Date()): Promise<string[]> {
  const created: string[] = [];
  await fs.mkdir(root, { recursive: true });
  if (await createFile(path.join(root, 'README.md'), README_TEXT)) created.push('README.md');
  if (await createFile(path.join(root, '.gitignore'), GITIGNORE_TEXT)) created.push('.gitignore');
  const baseFiles: [string, string][] = [
    [CANDIDATE_REVIEW_BASE_FILE, CANDIDATE_REVIEW_BASE],
    [LATEST_LESSONS_BASE_FILE, LATEST_LESSONS_BASE],
  ];
  for (const [name, text] of baseFiles) {
    if (await createFile(path.join(root, name), text)) created.push(name);
  }
  for (const folder of VAULT_FOLDERS) {
    if (await createDir(path.join(root, folder))) created.push(folder);
  }
  const reposDir = path.join(root, 'Repos');
  const date = now.toISOString().slice(0, 10);
  for (const repository of repositories.filter(isRepositoryName)) {
    const dir = path.join(reposDir, repoFolderName(repository));
    if (!isStrictlyInside(reposDir, dir)) continue;
    const relative = path.join('Repos', path.basename(dir));
    if (await createDir(dir)) created.push(relative);
    if (await createFile(path.join(dir, 'index.md'), indexText(repository, date))) created.push(path.join(relative, 'index.md'));
  }
  await initVaultGit(root);
  return created;
}

/** Startup hook: does nothing unless `brain.enabled`; a failure is logged and never stops the service. */
export async function prepareBrain(config: BrainConfig, repositories: readonly string[], logger: Logger): Promise<void> {
  if (!config.enabled) return;
  try {
    const created = await ensureVault(config.path, repositories);
    logger.info('brain vault ready', { path: config.path, created: created.length });
  } catch (error) {
    logger.error('brain vault could not be prepared; continuing without it', { path: config.path, error: errorMessage(error) });
  }
}
