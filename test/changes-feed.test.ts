import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildChangesPage, changeCounts, changeStats } from '../src/changes/feed.ts';
import { ChangeStore } from '../src/changes/store.ts';
import type { ChangeEntry } from '../src/changes/types.ts';
import { Logger } from '../src/log.ts';

const NOW = new Date('2026-10-30T12:00:00Z');

function entry(id: string, at: string, over: Partial<ChangeEntry> = {}): ChangeEntry {
  return {
    id, type: 'code', at, repo: 'acme/app', issue: 'acme/app#1', role: 'developer', title: id,
    files: [{ path: 'a.ts', added: 2, deleted: 1, status: 'modified' }], pr: null, diff: null, status: 'committed', ...over,
  };
}

describe('changeStats', () => {
  it('counts brain writes of today (no conflicts) without touching code figures or hotspots', () => {
    const brain = (id: string, at: string, status: ChangeEntry['status']) =>
      entry(id, at, { type: 'brain', status, files: [{ path: 'Inbox/x.md', added: 3, deleted: 0, status: 'added' }] });
    const stats = changeStats(
      [
        entry('c1', '2026-10-30T10:00:00Z'),
        brain('b1', '2026-10-30T10:10:00Z', 'created'),
        brain('b2', '2026-10-30T10:20:00Z', 'approved'),
        brain('b3', '2026-10-30T10:30:00Z', 'conflict'),
        brain('b4', '2026-10-29T10:30:00Z', 'created'),
      ],
      NOW,
      'UTC',
    );
    assert.deepEqual(stats.today, { commits: 1, merges: 0, files: 1, added: 2, deleted: 1, brain: 2 });
    assert.deepEqual(stats.hotspots.map((h) => h.path), ['a.ts']);
  });

  it('counts commits and merges of today separately; merges add no files or lines', () => {
    const stats = changeStats(
      [
        entry('c1', '2026-10-30T10:00:00Z'),
        entry('c2', '2026-10-30T11:00:00Z', { files: [{ path: 'a.ts', added: 1, deleted: null, status: 'modified' }, { path: 'b.png', added: null, deleted: null, status: 'binary' }] }),
        entry('m1', '2026-10-30T11:30:00Z', { status: 'merged' }),
        entry('old', '2026-10-29T10:00:00Z'),
      ],
      NOW,
      'UTC',
    );
    assert.deepEqual(stats.today, { commits: 2, merges: 1, files: 2, added: 3, deleted: 1, brain: 0 });
  });

  it('takes the calendar day in the time zone', () => {
    const e = [entry('late', '2026-10-29T23:30:00Z')];
    assert.equal(changeStats(e, NOW, 'UTC').today.commits, 0);
    assert.equal(changeStats(e, NOW, 'Europe/Berlin').today.commits, 1);
  });

  it('ranks at most 10 hotspots of the last 7 days by count, then repo and path', () => {
    const entries = [entry('old', '2026-10-22T11:00:00Z', { files: [{ path: 'gone.ts', added: 1, deleted: 0, status: 'added' }] })];
    for (let i = 0; i < 12; i++) entries.push(entry(`e${i}`, '2026-10-28T10:00:00Z', { files: [{ path: `f${String(i).padStart(2, '0')}.ts`, added: 1, deleted: 0, status: 'added' }] }));
    entries.push(entry('x', '2026-10-27T10:00:00Z', { files: [{ path: 'f05.ts', added: 1, deleted: 0, status: 'added' }] }));
    const { hotspots } = changeStats(entries, NOW, 'UTC');
    assert.equal(hotspots.length, 10);
    assert.deepEqual(hotspots[0], { path: 'f05.ts', repo: 'acme/app', count: 2 });
    assert.equal(hotspots[1]!.path, 'f00.ts');
    assert.ok(!hotspots.some((h) => h.path === 'gone.ts'));
  });
});

describe('note hotspots and open conflicts', () => {
  const note = (id: string, at: string, notePath: string, status: ChangeEntry['status'] = 'created', over: Partial<ChangeEntry> = {}) =>
    entry(id, at, { type: 'brain', status, files: [{ path: notePath, added: 1, deleted: 0, status: 'modified' }], ...over });

  it('counts the brain changes of the last 7 days per path, rejected writes as clashes, sorted and limited to 10', () => {
    const rows = [
      note('b1', '2026-10-30T10:00:00Z', 'Inbox/a.md'),
      note('b2', '2026-10-29T10:00:00Z', 'Inbox/a.md', 'updated'),
      note('b3', '2026-10-28T10:00:00Z', 'Inbox/a.md', 'conflict', { clash_id: 'k1' }),
      note('b4', '2026-10-30T09:00:00Z', 'Inbox/b.md'),
      note('b5', '2026-10-10T09:00:00Z', 'Inbox/old.md'),
      entry('c1', '2026-10-30T10:00:00Z'),
    ];
    const stats = changeStats(rows, NOW, 'UTC');
    assert.deepEqual(stats.note_hotspots, [{ path: 'Inbox/a.md', count: 2, clashes: 1 }, { path: 'Inbox/b.md', count: 1, clashes: 0 }]);
    const many = Array.from({ length: 12 }, (_, i) => note(`n${i}`, '2026-10-30T10:00:00Z', `Inbox/n${String(i).padStart(2, '0')}.md`));
    assert.equal(changeStats(many, NOW, 'UTC').note_hotspots.length, 10);
    assert.deepEqual(stats.today, { commits: 1, merges: 0, files: 1, added: 2, deleted: 1, brain: 2 });
  });

  it('counts only conflicts whose clash is open', () => {
    const rows = [
      note('x1', '2026-10-01T10:00:00Z', 'Inbox/a.md', 'conflict', { clash_id: 'open' }),
      note('x2', '2026-10-30T10:00:00Z', 'Inbox/a.md', 'conflict', { clash_id: 'done' }),
      note('x3', '2026-10-30T10:00:00Z', 'Inbox/a.md', 'conflict', { clash_id: 'gone' }),
    ];
    const status = (id: string) => (id === 'open' ? 'open' : id === 'done' ? 'resolved' : null);
    assert.equal(changeStats(rows, NOW, 'UTC', status).conflicts_open, 1);
    assert.equal(changeStats(rows, NOW, 'UTC').conflicts_open, 0);
  });

  it('adds clash_status to conflict entries of a page only', () => {
    const store = new ChangeStore(null, Logger.silent());
    store.append(note('x1', '2026-10-30T10:00:00Z', 'Inbox/a.md', 'conflict', { clash_id: 'open' }));
    store.append(note('b1', '2026-10-30T10:01:00Z', 'Inbox/a.md'));
    const page = buildChangesPage(store, {}, NOW, 'UTC', (id) => (id === 'open' ? 'open' : null));
    const byId = new Map(page.entries.map((e) => [e.id, e]));
    assert.equal(byId.get('x1')!.clash_status, 'open');
    assert.ok(!('clash_status' in byId.get('b1')!));
    assert.equal(page.stats!.conflicts_open, 1);
  });
});

describe('buildChangesPage', () => {
  const store = new ChangeStore(null, Logger.silent());
  for (let i = 1; i <= 4; i++) store.append(entry(`code:${i}`, `2026-10-30T10:0${i}:00Z`));
  store.append(entry('brain:1', '2026-10-30T10:09:00Z', { type: 'brain' }));

  it('counts per type and sets next_before only when another page follows', () => {
    assert.deepEqual(changeCounts(store.matching()), { all: 5, code: 4, brain: 1 });
    const exact = buildChangesPage(store, { type: 'code', limit: 4 }, NOW, 'UTC');
    assert.equal(exact.next_before, null);
    const first = buildChangesPage(store, { type: 'code', limit: 3 }, NOW, 'UTC');
    assert.equal(first.entries.length, 3);
    assert.equal(first.next_before, first.entries[2]!.id);
    assert.deepEqual(first.counts, { all: 5, code: 4, brain: 1 });
    assert.notEqual(first.stats, null);
    const second = buildChangesPage(store, { type: 'code', limit: 3, before: first.next_before! }, NOW, 'UTC');
    assert.deepEqual(second.entries.map((e) => e.id), ['code:1']);
    assert.equal(second.next_before, null);
    assert.equal(second.stats, null);
  });
});
