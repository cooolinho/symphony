import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ChangeStore } from '../src/changes/store.ts';
import type { ChangeEntry } from '../src/changes/types.ts';
import { Logger } from '../src/log.ts';
import { tempDir } from './helpers.ts';

// Acceptance tests of the ChangeStore (#339), written from the issue text.

function entry(n: number, overrides: Partial<ChangeEntry> = {}): ChangeEntry {
  return {
    id: `e${String(n).padStart(5, '0')}`,
    type: 'code',
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    repo: 'acme/app',
    issue: 'acme/app#1',
    role: 'developer',
    title: `change ${n}`,
    files: [{ path: 'a.ts', added: 1, deleted: 0, status: 'added' }],
    pr: null,
    diff: null,
    status: 'committed',
    ...overrides,
  };
}

const jsonl = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');

describe('ChangeStore acceptance', () => {
  it('persists each repository into its own JSONL file below <dir>, appending one line per entry in order', () => {
    const dir = path.join(tempDir(), 'changes');
    const store = new ChangeStore(dir, Logger.silent());
    store.load();
    store.append(entry(1));
    store.append(entry(2));
    store.append(entry(3, { repo: 'acme/web' }));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => !f.includes('/')));
    const app = files.find((f) => f.includes('app'))!;
    assert.deepEqual(jsonl(path.join(dir, app)).map((l) => JSON.parse(l).id), ['e00001', 'e00002']);
    const web = files.find((f) => f.includes('web'))!;
    assert.deepEqual(jsonl(path.join(dir, web)).map((l) => JSON.parse(l).id), ['e00003']);
  });

  it('keeps appending to the existing file after a restart without rewriting earlier lines', () => {
    const dir = tempDir();
    const first = new ChangeStore(dir, Logger.silent());
    first.append(entry(1));
    const file = path.join(dir, fs.readdirSync(dir)[0]!);
    const before = fs.readFileSync(file, 'utf8');
    const second = new ChangeStore(dir, Logger.silent());
    second.load();
    second.append(entry(2));
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.startsWith(before));
    assert.equal(jsonl(file).length, 2);
    assert.deepEqual(second.list().map((e) => e.id), ['e00002', 'e00001']);
  });

  it('loads only the last 500 entries of each repository, independently per repository', () => {
    const dir = tempDir();
    const write = (name: string, repo: string, count: number, offset: number) =>
      fs.writeFileSync(path.join(dir, name), Array.from({ length: count }, (_, i) => JSON.stringify(entry(offset + i, { repo, id: `${repo}:${i}` }))).join('\n') + '\n');
    write('acme_app.jsonl', 'acme/app', 700, 0);
    write('acme_web.jsonl', 'acme/web', 30, 1000);
    const store = new ChangeStore(dir, Logger.silent());
    store.load();
    const collect = (repo: string) => {
      const out: ChangeEntry[] = [];
      let before: string | undefined;
      for (;;) {
        const page = store.list({ repo, limit: 200, ...(before !== undefined ? { before } : {}) });
        if (page.length === 0) return out;
        out.push(...page);
        before = page.at(-1)!.id;
      }
    };
    const app = collect('acme/app');
    assert.equal(app.length, 500);
    assert.equal(app[0]?.id, 'acme/app:699');
    assert.equal(app.at(-1)?.id, 'acme/app:200');
    assert.equal(collect('acme/web').length, 30);
  });

  it('pages newest first over `before` with combined filters, without gaps or duplicates', () => {
    const store = new ChangeStore(null, Logger.silent());
    for (let n = 1; n <= 30; n++) {
      store.append(entry(n, { repo: n % 2 === 0 ? 'acme/app' : 'acme/web', issue: n % 3 === 0 ? 'acme/app#2' : 'acme/app#1', type: n % 5 === 0 ? 'brain' : 'code' }));
    }
    const expected = Array.from({ length: 30 }, (_, i) => 30 - i)
      .filter((n) => n % 2 === 0 && n % 3 !== 0 && n % 5 !== 0)
      .map((n) => `e${String(n).padStart(5, '0')}`);
    const got: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = store.list({ type: 'code', repo: 'acme/app', issue: 'acme/app#1', limit: 3, ...(before !== undefined ? { before } : {}) });
      if (page.length === 0) break;
      assert.ok(page.length <= 3);
      got.push(...page.map((e) => e.id));
      before = page.at(-1)!.id;
    }
    assert.deepEqual(got, expected);
    assert.ok(expected.length > 3);
  });

  it('pages across repositories (no repo filter) in one global newest-first order', () => {
    const store = new ChangeStore(null, Logger.silent());
    for (let n = 1; n <= 9; n++) store.append(entry(n, { repo: ['acme/a', 'acme/b', 'acme/c'][n % 3]! }));
    const ids: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = store.list({ limit: 4, ...(before !== undefined ? { before } : {}) });
      if (page.length === 0) break;
      ids.push(...page.map((e) => e.id));
      before = page.at(-1)!.id;
    }
    assert.deepEqual(ids, Array.from({ length: 9 }, (_, i) => `e${String(9 - i).padStart(5, '0')}`));
  });

  it('lists nothing for an unknown repository or issue, and returns a page of the requested size', () => {
    const store = new ChangeStore(null, Logger.silent());
    for (let n = 1; n <= 10; n++) store.append(entry(n));
    assert.deepEqual(store.list({ repo: 'nobody/none' }), []);
    assert.deepEqual(store.list({ issue: 'acme/app#99' }), []);
    assert.deepEqual(store.list({ type: 'brain' }), []);
    assert.equal(store.list({ limit: 4 }).length, 4);
    assert.equal(store.list({ limit: 4, before: 'e00003' }).length, 2);
  });

  it('does not throw when the directory is unwritable, and still serves the entries from memory', () => {
    const blocker = path.join(tempDir(), 'file');
    fs.writeFileSync(blocker, 'x');
    const store = new ChangeStore(path.join(blocker, 'changes'), Logger.silent());
    store.load();
    assert.doesNotThrow(() => store.append(entry(1)));
    assert.deepEqual(store.list().map((e) => e.id), ['e00001']);
  });

  it('skips broken lines on load and keeps the readable ones', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'acme_app.jsonl'), `${JSON.stringify(entry(1))}\nnot json at all\n\n${JSON.stringify(entry(2))}\n{"half":\n`);
    const store = new ChangeStore(dir, Logger.silent());
    assert.doesNotThrow(() => store.load());
    assert.deepEqual(store.list().map((e) => e.id), ['e00002', 'e00001']);
  });
});
