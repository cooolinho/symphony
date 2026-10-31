import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { renderPage, until } from './helpers.ts';
import { issueDetail, scoreTeam } from './helpers/page-fixtures.ts';

// Team view sidebar (E3-5b, #377): Brain-Zugriffe and Changes of the issue, loaded with the page's poll.

const opts = { url: 'http://127.0.0.1/issue?id=acme%2Fapp%231' };
const change = (i: number, over: Record<string, unknown> = {}) => ({
  id: `c${i}`, type: 'code', at: '2026-10-30T11:0' + (i % 10) + ':00Z', role: 'developer', title: `Change ${i}`, repo: 'acme/app', issue: 'acme/app#1',
  files: [{ path: `src/f${i}.ts`, added: 3, deleted: 1 }], pr: null, ...over,
});
const many = Array.from({ length: 10 }, (_, i) => change(i, i === 0 ? { title: '<img src=x>', pr: { number: 7, status: 'success' }, files: [1, 2, 3, 4].map((n) => ({ path: `f${n}.ts`, added: n, deleted: 0 })) } : {}));
const access = [
  { at: '2026-10-30T11:50:00Z', run: 'r', issue: 'acme/app#1', role: 'developer', op: 'read', path_or_query: '<img src=x>', purpose: '', result: 'ok' },
  { at: '2026-10-30T11:51:00Z', run: 'r', issue: 'acme/app#1', role: 'developer', op: 'write', path_or_query: 'Inbox/a.md', purpose: '', result: 'rejected', reason: 'hash_mismatch', clash_id: 'c1' },
];

function fixture(over: { changes?: unknown[]; brain?: boolean; failChanges?: () => boolean } = {}) {
  return (url: string): unknown => {
    if (url.startsWith('/api/v1/changes?')) {
      if (over.failChanges?.()) throw new Error('boom');
      return { entries: over.changes ?? many, counts: {}, next_before: null };
    }
    if (url.startsWith('/api/v1/brain/access?')) return over.brain === false ? { __status: 404 } : { access, next_before: null };
    if (url.endsWith('/team')) return scoreTeam();
    return issueDetail({ timeline_seq: 0 });
  };
}

describe('team view sidebar: Brain-Zugriffe and Changes (#377)', () => {
  it('lists ten changes with role, title, files, PR chip and the link to all changes', async () => {
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture() });
    assert.equal(page.$('changes-empty').hidden, true);
    await until(() => page.$('changes-list').children.length === 10, 3_000, 'changes');
    const first = page.$('changes-list').children[0]!;
    assert.match(first.textContent, /developer/);
    assert.match(first.textContent, /<img src=x>/);
    assert.match(first.textContent, /\+1 weitere/);
    assert.match(first.textContent, /\+1/);
    assert.match(first.textContent, /−0/);
    assert.match(first.textContent, /#7/);
    assert.equal(first.querySelectorAll('.side-files li').length, 4);
    assert.equal(page.$('changes-all').textContent, 'Alle Changes');
    assert.equal(page.$('changes-all').getAttribute('href'), '/changes?issue=acme%2Fapp%231');
    const urls = page.fetches.map((f) => f.url).filter((u) => u.startsWith('/api/v1/changes?') || u.startsWith('/api/v1/brain/access?'));
    for (const u of urls) assert.ok(u.includes('issue=acme%2Fapp%231&limit=10'), u);
    assert.equal(page.query('#changes-section img').length, 0, 'titles are text');
  });

  it('shows a rejected write in red with the clash link, and the ok line without one', async () => {
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture() });
    await until(() => page.$('access-list').children.length === 2, 3_000, 'access');
    assert.equal(page.$('access-section').hidden, false);
    const rejected = page.$('access-list').querySelectorAll('li.side-acc.rejected');
    assert.equal(rejected.length, 1);
    assert.match(rejected[0]!.textContent, /write/);
    assert.match(rejected[0]!.textContent, /Inbox\/a\.md/);
    assert.match(rejected[0]!.textContent, /abgewiesen/);
    assert.equal(rejected[0]!.querySelector('a.side-clash')!.getAttribute('href'), '/brain#clashes');
    assert.equal(page.$('access-list').querySelectorAll('a.side-clash').length, 1);
    assert.equal(page.query('#access-section img').length, 0, 'paths are text');
  });

  it('hides the Brain-Zugriffe without a brain (404) but keeps the changes', async () => {
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture({ brain: false }) });
    await until(() => page.$('changes-list').children.length === 10, 3_000, 'changes');
    assert.equal(page.$('access-section').hidden, true);
    assert.equal(page.$('access-list').children.length, 0);
    assert.equal(page.$('changes-section').hidden, false);
  });

  it('says "Noch keine Änderungen." without changes', async () => {
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture({ changes: [] }) });
    assert.equal(page.$('changes-empty').hidden, true, 'not before the first load');
    await until(() => !page.$('changes-empty').hidden, 3_000, 'empty note');
    assert.equal(page.$('changes-empty').textContent, 'Noch keine Änderungen.');
    assert.equal(page.$('changes-list').children.length, 0);
  });

  it('reloads with the poll and keeps the shown entries when a call fails', async () => {
    let fail = false;
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture({ failChanges: () => fail }) });
    await until(() => page.$('changes-list').children.length === 10, 3_000, 'changes');
    const loads = () => page.fetches.filter((f) => f.url.startsWith('/api/v1/changes?')).length;
    const n = loads();
    const poll = page.intervals.find((i) => i.ms === 2000 && i.fn.name === 'poll')!.fn;
    await poll();
    await until(() => loads() > n, 3_000, 'reload');
    fail = true;
    const m = loads();
    await poll();
    await until(() => loads() > m, 3_000, 'failing reload');
    await new Promise((r) => setImmediate(r));
    assert.equal(page.$('changes-list').children.length, 10);
  });
});
