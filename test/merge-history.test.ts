import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parsePricing } from '../src/costs/pricing.ts';
import { computeHistoryStats, readHistory } from '../src/history/history.ts';
import { formatSummary, mergeHistory, verifyMerge, type MergeOptions } from '../scripts/merge-history.ts';
import { tempDir } from './helpers.ts';

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function started(ts: string, run: string): string {
  return `ts=${ts} event=run_started repo=o/r issue=o/r#1 run=${run} title="t" state=Ready attempt=null model=sonnet`;
}

function finished(ts: string, run: string): string {
  return `ts=${ts} event=run_finished repo=o/r issue=o/r#1 run=${run} outcome=handed_off`;
}

function archive(archivedAt: string, transcript: string, title = 't'): string {
  return JSON.stringify({
    version: 2,
    issue_identifier: 'o/r#1',
    title,
    archived_at: archivedAt,
    timeline: [],
    sessions: [{ run: 'a', transcript }],
    pipeline: [{ id: 'developer', sessions: [{ run: 'a', transcript }] }],
  });
}

function setup(): MergeOptions {
  const root = tempDir('symphony-merge-');
  return { from: path.join(root, 'local'), into: path.join(root, 'server'), dryRun: false };
}

describe('merge-history', () => {
  it('merges repository logs: union, each line once, ordered by ts, idempotent', () => {
    const options = setup();
    const log = 'repositories/o_r.log';
    write(path.join(options.into, log), `${started('2026-10-01T10:00:00.000Z', 's1')}\n${finished('2026-10-01T10:05:00.000Z', 's1')}\n`);
    write(path.join(options.from, log), `${started('2026-10-01T09:00:00.000Z', 'l1')}\n${finished('2026-10-01T10:05:00.000Z', 's1')}\n\n${started('2026-10-02T09:00:00.000Z', 'l2')}\n`);
    write(path.join(options.into, 'repositories/server_only.log'), 'ts=2026-10-01T00:00:00.000Z event=x repo=s/o\n');
    write(path.join(options.from, 'repositories/new_repo.log'), 'ts=2026-10-03T00:00:00.000Z event=x repo=n/r\n');

    const summary = mergeHistory(options);

    assert.deepEqual(summary.logs, [{ file: 'new_repo.log', added: 1 }, { file: 'o_r.log', added: 2 }]);
    assert.deepEqual(read(path.join(options.into, log)).split('\n'), [
      started('2026-10-01T09:00:00.000Z', 'l1'),
      started('2026-10-01T10:00:00.000Z', 's1'),
      finished('2026-10-01T10:05:00.000Z', 's1'),
      started('2026-10-02T09:00:00.000Z', 'l2'),
      '',
    ]);
    assert.equal(read(path.join(options.into, 'repositories/server_only.log')), 'ts=2026-10-01T00:00:00.000Z event=x repo=s/o\n');
    assert.equal(read(path.join(options.into, 'repositories/new_repo.log')), 'ts=2026-10-03T00:00:00.000Z event=x repo=n/r\n');
    assert.deepEqual(verifyMerge(options), []);

    const before = read(path.join(options.into, log));
    assert.deepEqual(mergeHistory(options).logs.map((entry) => entry.added), [0, 0]);
    assert.equal(read(path.join(options.into, log)), before);
  });

  it('counts the runs of both machines in the statistics afterwards', () => {
    const options = setup();
    write(path.join(options.into, 'repositories/o_r.log'), `${started('2026-10-01T10:00:00.000Z', 's1')}\n${finished('2026-10-01T10:05:00.000Z', 's1')}\n`);
    write(path.join(options.from, 'repositories/o_r.log'), `${started('2026-10-02T10:00:00.000Z', 'l1')}\n${finished('2026-10-02T10:05:00.000Z', 'l1')}\n`);
    mergeHistory(options);
    const stats = computeHistoryStats(readHistory(path.join(options.into, 'repositories'), null).entries, parsePricing('default: { input: 1, output: 1 }', 'model-costs.yml'));
    assert.equal(stats.totals.runs, 2);
  });

  it('copies missing transcripts, completes shorter ones and keeps the rest', () => {
    const options = setup();
    write(path.join(options.from, 'sessions/k-1/new.jsonl'), 'a\n');
    write(path.join(options.from, 'sessions/k-1/grown.jsonl'), 'a\nb\n');
    write(path.join(options.into, 'sessions/k-1/grown.jsonl'), 'a\n');
    write(path.join(options.from, 'sessions/k-1/same.jsonl'), 'a\n');
    write(path.join(options.into, 'sessions/k-1/same.jsonl'), 'x\n');
    write(path.join(options.into, 'sessions/k-2/server.jsonl'), 's\n');

    assert.deepEqual(mergeHistory(options).sessions, { copied: 1, completed: 1, present: 1 });
    assert.equal(read(path.join(options.into, 'sessions/k-1/new.jsonl')), 'a\n');
    assert.equal(read(path.join(options.into, 'sessions/k-1/grown.jsonl')), 'a\nb\n');
    assert.equal(read(path.join(options.into, 'sessions/k-1/same.jsonl')), 'x\n');
    assert.equal(read(path.join(options.into, 'sessions/k-2/server.jsonl')), 's\n');
  });

  it('takes over newer issue archives with transcript paths on the target and keeps newer server ones', () => {
    const options = setup();
    write(path.join(options.from, 'sessions/k-1/t.jsonl'), 'a\n');
    write(path.join(options.from, 'issues/o_r_1.json'), archive('2026-10-02T00:00:00.000Z', '/home/someone/.local/state/symphony/sessions/k-1/t.jsonl'));
    write(path.join(options.into, 'issues/o_r_1.json'), archive('2026-10-01T00:00:00.000Z', '/old/sessions/k-0/t.jsonl', 'server'));
    write(path.join(options.from, 'issues/o_r_2.json'), archive('2026-10-01T00:00:00.000Z', '/elsewhere/sessions/k-9/gone.jsonl', 'local'));
    write(path.join(options.into, 'issues/o_r_2.json'), archive('2026-10-03T00:00:00.000Z', '/x', 'server'));
    write(path.join(options.from, 'issues/broken.json'), '{');

    assert.deepEqual(mergeHistory(options).issues, { written: 1, kept: 1, unreadable: ['broken.json'] });
    const merged = JSON.parse(read(path.join(options.into, 'issues/o_r_1.json')));
    const expected = path.join(options.into, 'sessions/k-1/t.jsonl');
    assert.equal(merged.sessions[0].transcript, expected);
    assert.equal(merged.pipeline[0].sessions[0].transcript, expected);
    assert.equal(JSON.parse(read(path.join(options.into, 'issues/o_r_2.json'))).title, 'server');
    assert.deepEqual(verifyMerge(options), []);
  });

  it('writes nothing on a dry run but reports what it would merge', () => {
    const options = setup();
    write(path.join(options.from, 'repositories/o_r.log'), `${started('2026-10-01T09:00:00.000Z', 'l1')}\n`);
    write(path.join(options.from, 'sessions/k-1/t.jsonl'), 'a\n');
    write(path.join(options.from, 'issues/o_r_1.json'), archive('2026-10-02T00:00:00.000Z', '/x'));

    const summary = mergeHistory({ ...options, dryRun: true });

    assert.equal(fs.existsSync(options.into), false);
    const text = formatSummary(summary, true);
    assert.match(text, /^Would merge/);
    assert.match(text, /\+1 lines {2}o_r\.log/);
    assert.match(text, /\+1 new, 0 completed, 0 already there/);
    assert.match(text, /1 taken over/);
  });

  it('reports what is missing on the target', () => {
    const options = setup();
    write(path.join(options.from, 'repositories/o_r.log'), `${started('2026-10-01T09:00:00.000Z', 'l1')}\n`);
    write(path.join(options.from, 'sessions/k-1/t.jsonl'), 'a\nb\n');
    write(path.join(options.into, 'sessions/k-1/t.jsonl'), 'a\n');
    write(path.join(options.from, 'issues/o_r_1.json'), archive('2026-10-02T00:00:00.000Z', '/x'));

    assert.deepEqual(verifyMerge(options), [
      'repositories/o_r.log: 1 lines missing',
      'sessions/k-1/t.jsonl: missing or shorter',
      'issues/o_r_1.json: missing or older',
    ]);
  });
});
