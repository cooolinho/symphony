import fs from 'node:fs/promises';
import path from 'node:path';
import type { ScreenshotPolicy } from '../workflow/config.ts';
import { matchesAnyGlob } from '../workflow/glob.ts';

/** Offending files named in a refusal; more are counted. */
const FILES_SHOWN = 5;

/** The agent instructions of a repository that may ask for screenshots. */
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];

/** What decides whether a developer's hand-off owes screenshots. */
export interface ScreenshotFacts {
  /** `pipeline.ui_paths`; `[]` turns the check off. */
  uiPaths: readonly string[];
  /** `pipeline.screenshot_paths`: a changed file there means screenshots were delivered. */
  screenshotPaths: readonly string[];
  /** `pipeline.require_screenshots`. */
  policy: ScreenshotPolicy;
  /** The workspace root, where AGENTS.md and CLAUDE.md are read. */
  workspace: string;
  /** Title and description of the issue. */
  issueText: () => string;
  /** The repository-relative files the branch changes against the base branch; throws when that cannot be told. */
  changedFiles: () => Promise<string[]>;
}

export type ScreenshotDecision = { missing: false } | { missing: true; uiFiles: string[]; more: number };

const MENTIONS_SCREENSHOTS = /screenshot/i;

/** Whether the project asks for screenshots: AGENTS.md or CLAUDE.md of the workspace, or the issue, mention them. */
export async function projectAsksForScreenshots(facts: Pick<ScreenshotFacts, 'workspace' | 'issueText'>): Promise<boolean> {
  if (MENTIONS_SCREENSHOTS.test(facts.issueText())) return true;
  for (const name of INSTRUCTION_FILES) {
    try {
      if (MENTIONS_SCREENSHOTS.test(await fs.readFile(path.join(facts.workspace, name), 'utf8'))) return true;
    } catch {
      // No such file: the project does not ask there.
    }
  }
  return false;
}

/**
 * Whether the change touches the UI (a changed file matches `ui_paths`), the project asks for screenshots and neither a
 * screenshot file changed. The cheap conditions come first; git is asked only when the policy does not rule it out.
 * Throws when the changed files cannot be determined.
 */
export async function screenshotsMissing(facts: ScreenshotFacts): Promise<ScreenshotDecision> {
  if (facts.policy === 'never' || facts.uiPaths.length === 0) return { missing: false };
  const files = await facts.changedFiles();
  const uiFiles = files.filter((file) => matchesAnyGlob(file, facts.uiPaths));
  if (uiFiles.length === 0) return { missing: false };
  if (files.some((file) => matchesAnyGlob(file, facts.screenshotPaths))) return { missing: false };
  if (facts.policy === 'auto' && !(await projectAsksForScreenshots(facts))) return { missing: false };
  return { missing: true, uiFiles: uiFiles.slice(0, FILES_SHOWN), more: Math.max(0, uiFiles.length - FILES_SHOWN) };
}
