import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IssueAttachment } from '../tracker/types.ts';
import { git } from './git.ts';

/** Workspace directory for the issue's attachments; kept out of commits through `.git/info/exclude`. */
export const ATTACHMENTS_DIR = '.issue-assets';

/** One attachment as the prompt variable `attachments` lists it. */
export interface AttachmentFile {
  /** Workspace-relative path, e.g. `.issue-assets/attachment-1.png`; null when the download failed. */
  path: string | null;
  label: string;
  source: string;
  error: string | null;
}

/** Adds `/<dir>/` to the repository's `info/exclude` (also in a worktree), so no stage commits the attachments. */
async function excludeFromGit(workspacePath: string): Promise<void> {
  let exclude: string;
  try {
    exclude = path.resolve(workspacePath, (await git(workspacePath, ['rev-parse', '--git-path', 'info/exclude'])).trim());
  } catch {
    return; // Not a git repository: nothing to keep out.
  }
  const entry = `/${ATTACHMENTS_DIR}/`;
  const current = await fs.readFile(exclude, 'utf8').catch(() => '');
  if (current.split('\n').includes(entry)) return;
  await fs.mkdir(path.dirname(exclude), { recursive: true });
  await fs.appendFile(exclude, `${current === '' || current.endsWith('\n') ? '' : '\n'}${entry}\n`);
}

/**
 * Replaces the attachments directory of the workspace with these attachments (`attachment-<n>.<ext>` in order of
 * appearance, plus an INDEX.md naming each file's label and source). Without attachments the directory is removed, so
 * no stale file of an earlier attempt stays behind.
 */
export async function writeAttachments(workspacePath: string, attachments: readonly IssueAttachment[]): Promise<AttachmentFile[]> {
  const dir = path.join(workspacePath, ATTACHMENTS_DIR);
  await fs.rm(dir, { recursive: true, force: true });
  if (attachments.length === 0) return [];

  await fs.mkdir(dir, { recursive: true });
  await excludeFromGit(workspacePath);
  const files: AttachmentFile[] = [];
  for (const [index, attachment] of attachments.entries()) {
    if (attachment.data === null) {
      files.push({ path: null, label: attachment.label, source: attachment.source, error: attachment.error ?? 'not downloaded' });
      continue;
    }
    const name = `attachment-${index + 1}.${attachment.extension || 'bin'}`;
    await fs.writeFile(path.join(dir, name), attachment.data);
    files.push({ path: `${ATTACHMENTS_DIR}/${name}`, label: attachment.label, source: attachment.source, error: null });
  }
  const lines = files.map(
    (file, index) =>
      `- ${file.path === null ? `attachment ${index + 1}: not downloaded (${file.error})` : path.basename(file.path)}: ${file.label || 'no label'} (${file.source})`,
  );
  await fs.writeFile(path.join(dir, 'INDEX.md'), `# Issue attachments\n\nIn order of appearance: the description first, then the comments.\n\n${lines.join('\n')}\n`);
  return files;
}
