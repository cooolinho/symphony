import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createVaultGit } from '../src/brain/git.ts';
import { writeIssueSummary, type IssueSummarySubject } from '../src/brain/issue-summary.ts';
import { parseNote } from '../src/brain/note.ts';
import { ensureVault } from '../src/brain/vault.ts';
import { Logger } from '../src/log.ts';
import type { PersistedResult } from '../src/orchestrator/stage-history.ts';
import type { ResultMeta, StageResult } from '../src/workflow/results.ts';
import { tempDir } from './helpers.ts';

const sh = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
let clock = 0;

function entry(kind: string, role: string, verdict: string, summary: string, round: number | null, extra: Record<string, unknown> = {}): PersistedResult {
  clock += 1;
  const result = { schema: 'symphony.result/v1', kind, verdict, summary, blockers: [], follow_ups: [], ...extra } as unknown as StageResult;
  const meta: ResultMeta = {
    role,
    run: `run-${clock}`,
    round,
    profile: null,
    workflow_hash: null,
    head_sha: null,
    checks: null,
    target: null,
    created_at: new Date(Date.UTC(2026, 9, 30, 10, 0, clock)).toISOString(),
  };
  return { result, meta };
}

const RESULTS = (): PersistedResult[] => [
  entry('design', 'architect', 'ready', 'Design ready', null),
  entry('implementation', 'developer', 'done', 'Built it | with a pipe\nand a newline', 1, { changed_files: ['src/b.ts', 'src/a.ts'], tests_added: [] }),
  entry('review', 'reviewer', 'approved', 'Looks good', 2, { findings: [] }),
];

const ISSUE: IssueSummarySubject = {
  repo: 'acme/app',
  identifier: 'acme/app#7',
  number: '7',
  title: 'Add the thing',
  description: '\n\nFirst real line.\nSecond line.',
  pullRequest: 7,
  pullRequestUrl: 'https://github.com/acme/app/pull/7',
};

async function setup(onCommit?: (sha: string, paths: string[]) => void) {
  const dir = path.join(tempDir(), 'vault');
  await ensureVault(dir, ['acme/app'], new Date('2026-10-30T00:00:00Z'));
  const logger = Logger.create({ sinks: [{ name: 'memory', write: () => undefined }], level: 'debug' } as never);
  return { dir, versioning: createVaultGit(dir, logger, onCommit ? { onCommit } : {}) };
}

const DAY1 = (): Date => new Date('2026-10-31T10:00:00Z');
const DAY2 = (): Date => new Date('2026-11-01T10:00:00Z');

describe('writeIssueSummary', () => {
  it('writes frontmatter, stage table, totals, files and links, committed as symphony', async () => {
    const hooked: string[][] = [];
    const { dir, versioning } = await setup((_sha, paths) => void hooked.push(paths));
    const out = await writeIssueSummary(ISSUE, RESULTS(), { issueCostUsd: () => 1.5 }, { vaultPath: dir, versioning, now: DAY1, extraCostUsd: 0.25 });
    assert.equal(out.path, 'Issues/acme-app/7.md');
    assert.equal(out.changed, true);
    const note = parseNote(fs.readFileSync(path.join(dir, out.path), 'utf8'));
    assert.deepEqual(note.frontmatter, {
      type: 'issue',
      status: 'approved',
      repo: 'acme/app',
      issue: 'acme/app#7',
      role: 'symphony',
      created: '2026-10-31',
      updated: '2026-10-31',
      sources: ['https://github.com/acme/app/pull/7'],
    });
    const body = note.body;
    assert.match(body, /First real line\./);
    assert.doesNotMatch(body, /Second line/);
    assert.match(body, /\| Role \| Verdict \| Round \| Summary \|/);
    assert.match(body, /\| architect \| ready \|  \| Design ready \|/);
    assert.match(body, /\| developer \| done \| 1 \| Built it \\\| with a pipe and a newline \|/);
    assert.match(body, /\| reviewer \| approved \| 2 \| Looks good \|/);
    assert.match(body, /- Rounds: 2/);
    assert.match(body, /- Cost: 1.75 USD/);
    assert.ok(body.indexOf('`src/a.ts`') > 0 && body.indexOf('`src/a.ts`') < body.indexOf('`src/b.ts`'));
    assert.match(body, /\[\[Repos\/acme-app\/index\]\]/);
    assert.match(body, /\[#7\]\(https:\/\/github\.com\/acme\/app\/pull\/7\)/);
    assert.equal(sh(dir, 'log', '-1', '--format=%an|%s'), 'symphony|acme/app#7: issue summary');
    assert.deepEqual(hooked, [['Issues/acme-app/7.md']]);
  });

  it('is idempotent: no second commit and unchanged bytes; a change keeps created and moves updated', async () => {
    const { dir, versioning } = await setup();
    const results = RESULTS();
    const history = { issueCostUsd: () => 1 };
    await writeIssueSummary(ISSUE, results, history, { vaultPath: dir, versioning, now: DAY1 });
    const file = path.join(dir, 'Issues/acme-app/7.md');
    const before = fs.readFileSync(file, 'utf8');
    const commits = sh(dir, 'rev-list', '--count', 'HEAD');
    const again = await writeIssueSummary(ISSUE, results, history, { vaultPath: dir, versioning, now: DAY2 });
    assert.deepEqual(again, { path: 'Issues/acme-app/7.md', sha: null, changed: false });
    assert.equal(sh(dir, 'rev-list', '--count', 'HEAD'), commits);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    const third = await writeIssueSummary(ISSUE, [...results, entry('test', 'tester', 'passed', 'ok', 2)], history, { vaultPath: dir, versioning, now: DAY2 });
    assert.equal(third.changed, true);
    assert.notEqual(third.sha, null);
    assert.equal(sh(dir, 'rev-list', '--count', 'HEAD'), String(Number(commits) + 1));
    const fm = parseNote(fs.readFileSync(file, 'utf8')).frontmatter;
    assert.equal(fm.created, '2026-10-31');
    assert.equal(fm.updated, '2026-11-01');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'Issues/acme-app')), ['7.md']);
  });

  it('handles no results, no history and no pull request request', async () => {
    const { dir, versioning } = await setup();
    await writeIssueSummary({ ...ISSUE, pullRequest: null, pullRequestUrl: null }, [], null, { vaultPath: dir, versioning, now: DAY1 });
    const note = parseNote(fs.readFileSync(path.join(dir, 'Issues/acme-app/7.md'), 'utf8'));
    assert.deepEqual(note.frontmatter.sources, []);
    assert.match(note.body, /No stage results recorded\./);
    assert.match(note.body, /- Rounds: 0/);
    assert.match(note.body, /- Cost: 0.00 USD/);
    assert.match(note.body, /- none recorded/);
    assert.match(note.body, /- Pull request: none/);
  });

  it('rejects an invalid repository or issue number without writing', async () => {
    const { dir, versioning } = await setup();
    const options = { vaultPath: dir, versioning, now: DAY1 };
    await assert.rejects(writeIssueSummary({ ...ISSUE, number: '../x' }, [], null, options));
    await assert.rejects(writeIssueSummary({ ...ISSUE, repo: 'bad' }, [], null, options));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'Issues')), []);
    assert.equal(sh(dir, 'status', '--porcelain'), '');
  });
});
