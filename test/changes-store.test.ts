import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ChangeStore, changesFileName } from '../src/changes/store.ts';
import { CHANGES_LOAD_LIMIT, type ChangeEntry } from '../src/changes/types.ts';
import { Logger } from '../src/log.ts';
import { tempDir } from './helpers.ts';

function entry(n: number, overrides: Partial<ChangeEntry> = {}): ChangeEntry {
  return {
    id: `code:acme/app:${String(n).padStart(4, '0')}`,
    type: 'code',
    at: new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString(),
    repo: 'acme/app',
    issue: 'acme/app#1',
    role: 'developer',
    title: `commit ${n}`,
    files: [
      { path: 'src/a.ts', added: 3, deleted: 1, status: 'modified' },
      { path: 'logo.png', added: null, deleted: null, status: 'binary' },
    ],
    pr: { number: 7, status: 'success' },
    diff: 'src/a.ts\n+one',
    status: 'committed',
    ...overrides,
  };
}

function lines(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
}

describe('ChangeStore', () => {
  it('names the file of a repository safely', () => {
    assert.equal(changesFileName('acme/app'), 'acme_app.jsonl');
    assert.equal(changesFileName('../evil'), '.._evil.jsonl');
  });

  it('appends one JSON line per entry to <dir>/<owner>_<name>.jsonl and loads it again', () => {
    const dir = path.join(tempDir(), 'changes');
    const store = new ChangeStore(dir, Logger.silent());
    store.load();
    assert.equal(store.append(entry(1)), true);
    assert.equal(store.append(entry(2, { repo: 'acme/web', id: 'code:acme/web:2' })), true);
    assert.equal(lines(path.join(dir, 'acme_app.jsonl')).length, 1);
    assert.deepEqual(JSON.parse(lines(path.join(dir, 'acme_app.jsonl'))[0]!), entry(1));
    assert.equal(lines(path.join(dir, 'acme_web.jsonl')).length, 1);

    const again = new ChangeStore(dir, Logger.silent());
    again.load();
    assert.deepEqual(again.list().map((e) => e.id), ['code:acme/web:2', entry(1).id]);
    assert.deepEqual(again.list({ repo: 'acme/app' })[0], entry(1));
  });

  it('ignores a known id and writes nothing for it', () => {
    const dir = tempDir();
    const store = new ChangeStore(dir, Logger.silent());
    store.append(entry(1));
    assert.equal(store.has(entry(1).id), true);
    assert.equal(store.append(entry(1, { title: 'again' })), false);
    assert.equal(lines(path.join(dir, 'acme_app.jsonl')).length, 1);
    assert.equal(store.list()[0]?.title, 'commit 1');
  });

  it('loads the newest 500 readable lines per repository and skips broken ones', () => {
    const dir = tempDir();
    const text = Array.from({ length: 600 }, (_, i) => JSON.stringify(entry(i))).join('\n');
    fs.writeFileSync(path.join(dir, 'acme_app.jsonl'), `${text}\n{not json\n"a string"\n`);
    const store = new ChangeStore(dir, Logger.silent());
    store.load();
    const all = store.list({ limit: 200 });
    assert.equal(all[0]?.id, entry(599).id);
    let page = all;
    const seen = [...all];
    while (page.length > 0) {
      page = store.list({ limit: 200, before: page.at(-1)!.id });
      seen.push(...page);
    }
    assert.equal(seen.length, CHANGES_LOAD_LIMIT);
    assert.equal(seen.at(-1)?.id, entry(100).id);
    assert.equal(store.has(entry(99).id), false);
  });

  it('keeps entries in memory only without a directory, and when the directory cannot be written', () => {
    const memory = new ChangeStore(null, Logger.silent());
    memory.load();
    assert.equal(memory.append(entry(1)), true);
    assert.equal(memory.list().length, 1);

    const file = path.join(tempDir(), 'not-a-dir');
    fs.writeFileSync(file, '');
    const broken = new ChangeStore(file, Logger.silent());
    broken.load();
    assert.equal(broken.append(entry(1)), true);
    assert.equal(broken.append(entry(2)), true);
    assert.equal(broken.list().length, 2);
  });

  it('filters by type, repository and issue, newest first', () => {
    const store = new ChangeStore(null, Logger.silent());
    store.append(entry(1));
    store.append(entry(3, { issue: 'acme/app#2' }));
    store.append(entry(2, { repo: 'acme/web', id: 'code:acme/web:2' }));
    store.append(entry(4, { type: 'brain', id: 'brain:4' }));
    assert.deepEqual(store.list().map((e) => e.title), ['commit 4', 'commit 3', 'commit 2', 'commit 1']);
    assert.deepEqual(store.list({ type: 'code' }).map((e) => e.title), ['commit 3', 'commit 2', 'commit 1']);
    assert.deepEqual(store.list({ repo: 'acme/web' }).map((e) => e.title), ['commit 2']);
    assert.deepEqual(store.list({ issue: 'acme/app#2' }).map((e) => e.title), ['commit 3']);
    assert.deepEqual(store.list({ type: 'code', repo: 'acme/app', issue: 'acme/app#1' }).map((e) => e.title), ['commit 1']);
  });

  it('pages over `before` without gaps or duplicates, also for entries of the same time', () => {
    const store = new ChangeStore(null, Logger.silent());
    const at = '2026-10-01T00:00:00.000Z';
    for (let n = 1; n <= 5; n++) store.append(entry(n, n <= 3 ? { at } : {}));
    const pages: string[][] = [];
    let before: string | undefined;
    for (;;) {
      const page = store.list({ limit: 2, ...(before !== undefined ? { before } : {}) });
      if (page.length === 0) break;
      pages.push(page.map((e) => e.title));
      before = page.at(-1)!.id;
    }
    assert.deepEqual(pages, [['commit 5', 'commit 4'], ['commit 3', 'commit 2'], ['commit 1']]);
    assert.deepEqual(store.list({ limit: 2, before: 'unknown' }).map((e) => e.title), ['commit 5', 'commit 4'], 'an unknown cursor starts over');
  });

  it('keeps the page size between 1 and 200, 50 by default', () => {
    const store = new ChangeStore(null, Logger.silent());
    for (let n = 0; n < 300; n++) store.append(entry(n));
    assert.equal(store.list().length, 50);
    assert.equal(store.list({ limit: 1000 }).length, 200);
    assert.equal(store.list({ limit: 0 }).length, 1);
  });
});
