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

// Independent acceptance tests for E8-3 (#360): the issue text is the specification.

const sh = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
let clock = 0;

function entry(kind: string, role: string, verdict: string, summary: string, round: number | null, extra: Record<string, unknown> = {}, at?: string): PersistedResult {
  clock += 1;
  const result = { schema: 'symphony.result/v1', kind, verdict, summary, blockers: [], follow_ups: [], ...extra } as unknown as StageResult;
  const meta: ResultMeta = {
    role,
    run: `acc-run-${clock}`,
    round,
    profile: null,
    workflow_hash: null,
    head_sha: null,
    checks: null,
    target: null,
    created_at: at ?? new Date(Date.UTC(2026, 9, 30, 11, 0, clock)).toISOString(),
  };
  return { result, meta };
}

const issue = (number: string, extra: Partial<IssueSummarySubject> = {}): IssueSummarySubject => ({
  repo: 'acme/app',
  identifier: `acme/app#${number}`,
  number,
  title: 'Add the thing',
  description: 'The goal line.\nMore detail.',
  pullRequest: 12,
  pullRequestUrl: 'https://github.com/acme/app/pull/12',
  ...extra,
});

async function setup(onCommit?: (sha: string, paths: string[]) => void) {
  const dir = path.join(tempDir(), 'vault');
  await ensureVault(dir, ['acme/app'], new Date('2026-10-30T00:00:00Z'));
  const logger = Logger.create({ sinks: [], level: 'error' });
  return { dir, versioning: createVaultGit(dir, logger, onCommit ? { onCommit } : {}) };
}

const DAY1 = (): Date => new Date('2026-10-31T10:00:00Z');
const DAY2 = (): Date => new Date('2026-11-02T10:00:00Z');
const noCost = { issueCostUsd: () => 0 };

describe('issue summary acceptance (#360)', () => {
  it('collects changed files over all implementation runs without duplicates, and counts repeated roles as rows', async () => {
    const { dir, versioning } = await setup();
    const results = [
      entry('implementation', 'developer', 'done', 'First pass', 1, { changed_files: ['src/z.ts', 'src/shared.ts'], tests_added: [] }),
      entry('review', 'reviewer', 'changes_needed', 'Fix it', 1, { findings: [] }),
      entry('implementation', 'developer', 'done', 'Second pass', 2, { changed_files: ['src/shared.ts', 'src/m.ts'], tests_added: [] }),
      entry('review', 'reviewer', 'approved', 'Fine now', 2, { findings: [] }),
    ];
    await writeIssueSummary(issue('21'), results, noCost, { vaultPath: dir, versioning, now: DAY1 });
    const body = parseNote(fs.readFileSync(path.join(dir, 'Issues/acme-app/21.md'), 'utf8')).body;
    for (const file of ['src/m.ts', 'src/shared.ts', 'src/z.ts']) assert.equal(body.split(`\`${file}\``).length - 1, 1, `${file} listed exactly once`);
    assert.match(body, /First pass/);
    assert.match(body, /Second pass/);
    assert.equal((body.match(/\| reviewer \|/g) ?? []).length, 2, 'one table row per run');
    assert.match(body, /- Rounds: 2/);
  });

  it('puts the issue title and only the first non-empty description line into the goal', async () => {
    const { dir, versioning } = await setup();
    await writeIssueSummary(issue('22', { title: 'Title X', description: '\r\n  \r\nFirst real line\r\nSecond line' }), [], noCost, { vaultPath: dir, versioning, now: DAY1 });
    const body = parseNote(fs.readFileSync(path.join(dir, 'Issues/acme-app/22.md'), 'utf8')).body;
    assert.match(body, /Title X/);
    assert.match(body, /First real line/);
    assert.doesNotMatch(body, /Second line/);
    await writeIssueSummary(issue('23', { description: null }), [], noCost, { vaultPath: dir, versioning, now: DAY1 });
    assert.match(parseNote(fs.readFileSync(path.join(dir, 'Issues/acme-app/23.md'), 'utf8')).body, /Add the thing/);
  });

  it('keeps every stage row on one table line: pipes escaped, line breaks flattened, long summaries cut', async () => {
    const { dir, versioning } = await setup();
    const long = `start ${'word '.repeat(2000)}END-MARKER`;
    const results = [entry('implementation', 'developer', 'done', `a | b\r\nc\n\nd ${long}`, 1, { changed_files: [], tests_added: [] })];
    await writeIssueSummary(issue('24'), results, noCost, { vaultPath: dir, versioning, now: DAY1 });
    const body = parseNote(fs.readFileSync(path.join(dir, 'Issues/acme-app/24.md'), 'utf8')).body;
    const rows = body.split('\n').filter((line) => line.startsWith('| developer'));
    assert.equal(rows.length, 1);
    assert.match(rows[0]!, /a \\\| b c d start/);
    assert.doesNotMatch(body, /END-MARKER/);
    assert.ok(rows[0]!.length < 2000);
  });

  it('is written in English and states cost in USD with the history cost of this very issue', async () => {
    const { dir, versioning } = await setup();
    const asked: string[][] = [];
    await writeIssueSummary(issue('25'), [entry('design', 'architect', 'ready', 'ok', null)], { issueCostUsd: (repo, id) => (asked.push([repo, id]), 3.456) }, { vaultPath: dir, versioning, now: DAY1 });
    assert.deepEqual(asked, [['acme/app', 'acme/app#25']]);
    const body = parseNote(fs.readFileSync(path.join(dir, 'Issues/acme-app/25.md'), 'utf8')).body;
    assert.match(body, /Cost.*USD/);
    assert.match(body, /3\.4[56]/);
    assert.match(body, /Goal/);
    assert.match(body, /Rounds/);
    assert.doesNotMatch(body, /Ziel|Kosten|Runden|Ergebnis/);
  });

  it('keeps one file per issue; a second issue leaves the first file and its commit untouched', async () => {
    const { dir, versioning } = await setup();
    await writeIssueSummary(issue('30'), [], noCost, { vaultPath: dir, versioning, now: DAY1 });
    const first = fs.readFileSync(path.join(dir, 'Issues/acme-app/30.md'), 'utf8');
    await writeIssueSummary(issue('31', { title: 'Other' }), [], noCost, { vaultPath: dir, versioning, now: DAY2 });
    assert.deepEqual(fs.readdirSync(path.join(dir, 'Issues/acme-app')).sort(), ['30.md', '31.md']);
    assert.equal(fs.readFileSync(path.join(dir, 'Issues/acme-app/30.md'), 'utf8'), first);
    assert.equal(sh(dir, 'log', '-1', '--format=%s'), 'acme/app#31: issue summary');
    assert.equal(sh(dir, 'log', '--format=%s', '--', 'Issues/acme-app/30.md'), 'acme/app#30: issue summary');
  });

  it('a repeated run: same bytes, no commit, no onCommit call, clean vault; many repeats stay at one commit', async () => {
    const calls: string[][] = [];
    const { dir, versioning } = await setup((_sha, paths) => void calls.push(paths));
    const results = [entry('implementation', 'developer', 'done', 'Built', 1, { changed_files: ['a.ts'], tests_added: [] })];
    await writeIssueSummary(issue('32'), results, { issueCostUsd: () => 0.5 }, { vaultPath: dir, versioning, now: DAY1 });
    const file = path.join(dir, 'Issues/acme-app/32.md');
    const before = fs.readFileSync(file, 'utf8');
    const commits = sh(dir, 'rev-list', '--count', 'HEAD');
    for (let i = 0; i < 3; i++) await writeIssueSummary(issue('32'), results, { issueCostUsd: () => 0.5 }, { vaultPath: dir, versioning, now: DAY2 });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(sh(dir, 'rev-list', '--count', 'HEAD'), commits);
    assert.equal(sh(dir, 'status', '--porcelain'), '');
    assert.equal(calls.length, 1);
  });

  it('concurrent writes of the same issue end in one file and one commit', async () => {
    const { dir, versioning } = await setup();
    const before = Number(sh(dir, 'rev-list', '--count', 'HEAD'));
    const results = [entry('design', 'architect', 'ready', 'ok', null)];
    await Promise.all([1, 2, 3].map(() => writeIssueSummary(issue('33'), results, noCost, { vaultPath: dir, versioning, now: DAY1 })));
    assert.equal(Number(sh(dir, 'rev-list', '--count', 'HEAD')), before + 1);
    assert.equal(sh(dir, 'status', '--porcelain'), '');
  });

  it('a changed cost alone counts as a change: new commit, created kept, updated moved', async () => {
    const { dir, versioning } = await setup();
    await writeIssueSummary(issue('34'), [], { issueCostUsd: () => 1 }, { vaultPath: dir, versioning, now: DAY1 });
    const out = await writeIssueSummary(issue('34'), [], { issueCostUsd: () => 2 }, { vaultPath: dir, versioning, now: DAY2 });
    assert.equal(out.changed, true);
    const note = parseNote(fs.readFileSync(path.join(dir, 'Issues/acme-app/34.md'), 'utf8'));
    assert.equal(note.frontmatter.created, '2026-10-31');
    assert.equal(note.frontmatter.updated, '2026-11-02');
    assert.match(note.body, /2\.00 USD/);
    assert.equal(sh(dir, 'log', '-1', '--format=%an|%s'), 'symphony|acme/app#34: issue summary');
  });

  it('takes over an edit made in Obsidian as a human commit before it rewrites the summary as symphony', async () => {
    const { dir, versioning } = await setup();
    await writeIssueSummary(issue('35'), [], noCost, { vaultPath: dir, versioning, now: DAY1 });
    const file = path.join(dir, 'Issues/acme-app/35.md');
    fs.appendFileSync(file, '\nmanual note\n');
    fs.writeFileSync(path.join(dir, 'Inbox/loose.md'), 'loose\n');
    await writeIssueSummary(issue('35'), [], noCost, { vaultPath: dir, versioning, now: DAY2 });
    assert.equal(sh(dir, 'status', '--porcelain'), '');
    const authors = sh(dir, 'log', '-3', '--format=%an').split('\n');
    assert.ok(authors.includes('human'), `human commit among ${authors.join(',')}`);
    assert.equal(authors[0], 'symphony');
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /manual note/);
  });

  it('refuses names that leave Issues/<folder>/<number>.md, without writing anything', async () => {
    const { dir, versioning } = await setup();
    const options = { vaultPath: dir, versioning, now: DAY1 };
    for (const bad of [{ number: '../../x' }, { number: 'a/b' }, { number: '' }, { repo: '../evil/x' }, { repo: 'a/b/c' }, { repo: '' }]) {
      await assert.rejects(writeIssueSummary(issue('36', bad), [], noCost, options), JSON.stringify(bad));
    }
    assert.deepEqual(fs.readdirSync(path.join(dir, 'Issues')), []);
    assert.equal(sh(dir, 'status', '--porcelain'), '');
  });

  it('rejects when the vault is not a git repository, so the caller can warn', async () => {
    const dir = path.join(tempDir(), 'plain');
    fs.mkdirSync(dir, { recursive: true });
    const versioning = createVaultGit(dir, Logger.create({ sinks: [], level: 'error' }));
    await assert.rejects(writeIssueSummary(issue('37'), [], noCost, { vaultPath: dir, versioning, now: DAY1 }));
  });
});
