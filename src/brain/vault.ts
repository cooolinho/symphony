import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../log.ts';
import { isRepositoryName } from '../tracker/github-project/settings.ts';
import { errorMessage } from '../util/errors.ts';
import { isStrictlyInside } from '../util/paths.ts';
import type { BrainConfig } from '../workflow/config.ts';

export const VAULT_FOLDERS = ['Inbox', 'Repos', 'Decisions', 'Lessons', 'Issues', 'Agents'] as const;

export const README_TEXT = `# Symphony brain

The knowledge vault of Symphony: one vault for all repositories. Symphony creates the structure below at startup
and never overwrites an existing file or folder.

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

## Rules

- Symphony never overwrites existing files or folders.
- \`.obsidian/\` belongs to the human editing the vault; Symphony never creates, reads or writes it.
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
