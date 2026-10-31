import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BrainAccessLog } from '../src/brain/access-log.ts';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { Logger } from '../src/log.ts';
import { renderPage, tempDir, until } from './helpers.ts';
import { issueDetail, scoreTeam } from './helpers/page-fixtures.ts';

// Independent acceptance tests for #377: Brain-Zugriffe and Changes of the issue in the sidebar of the team view.

const ID = 'acme/app#1';
const opts = { url: 'http://127.0.0.1/issue?id=acme%2Fapp%231' };

const change = (i: number, over: Record<string, unknown> = {}) => ({
  id: `c${i}`, type: 'code', at: `2026-10-30T11:${String(10 + i)}:00Z`, role: i % 2 ? 'reviewer' : 'developer', title: `Titel ${i}`, repo: 'acme/app', issue: ID,
  files: [{ path: `src/file${i}.ts`, added: 10 + i, deleted: i }], pr: null, ...over,
});
const tenChanges = Array.from({ length: 10 }, (_, i) => change(i));
const row = (i: number, over: Record<string, unknown> = {}) => ({
  at: `2026-10-30T11:${String(20 + i)}:00Z`, run: 'r', issue: ID, role: 'developer', op: 'read', path_or_query: `Notes/n${i}.md`, purpose: '', result: 'ok', ...over,
});
const rejectedWrite = row(5, { op: 'write', path_or_query: 'Inbox/clash.md', result: 'rejected', reason: 'hash_mismatch', clash_id: 'x' });

interface Feeds { changes?: unknown[]; access?: unknown[]; brain?: boolean; brainStatus?: number }

function fixture(feeds: Feeds = {}, mutate?: { changes?: () => unknown[] | undefined; access?: () => unknown[] | undefined; brain?: () => boolean | undefined }) {
  return (url: string): unknown => {
    if (url.startsWith('/api/v1/changes?')) return { entries: mutate?.changes?.() ?? feeds.changes ?? tenChanges, counts: {}, next_before: null };
    if (url.startsWith('/api/v1/brain/access?')) {
      const brain = mutate?.brain?.() ?? feeds.brain ?? true;
      if (!brain) return { __status: feeds.brainStatus ?? 404, error: { code: 'brain_disabled' } };
      return { access: mutate?.access?.() ?? feeds.access ?? [row(0), rejectedWrite], next_before: null };
    }
    if (url.endsWith('/team')) return scoreTeam();
    return issueDetail({ timeline_seq: 0 });
  };
}
const sideUrls = (page: ReturnType<typeof renderPage>) => page.fetches.map((f) => f.url).filter((u) => u.startsWith('/api/v1/changes?') || u.startsWith('/api/v1/brain/access?'));

describe('team view sidebar #377: Changes', () => {
  it('requests the changes of exactly this issue, limited to 10', async () => {
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture() });
    await until(() => page.$('changes-list').children.length === 10, 3_000, 'changes');
    const urls = sideUrls(page);
    assert.ok(urls.some((u) => u.startsWith('/api/v1/changes?')), 'changes requested');
    assert.ok(urls.some((u) => u.startsWith('/api/v1/brain/access?')), 'access requested');
    for (const u of urls) {
      const q = new URL(u, 'http://x').searchParams;
      assert.equal(q.get('issue'), ID, u);
      assert.equal(q.get('limit'), '10', u);
    }
  });

  it('shows time, role, title, file with +/- and the PR chip per entry', async () => {
    const entries = tenChanges.map((c, i) => (i === 0 ? { ...c, pr: { number: 42, status: 'failure' } } : c));
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture({ changes: entries }) });
    await until(() => page.$('changes-list').children.length === 10, 3_000, 'changes');
    const li = page.$('changes-list').children[0]!;
    const text = li.textContent;
    assert.match(text, /developer/);
    assert.match(text, /Titel 0/);
    assert.match(text, /src\/file0\.ts/);
    assert.match(text, /\+10/);
    assert.match(text, /[−-]0/);
    assert.match(text, /#42/);
    assert.ok(li.querySelectorAll('time').length >= 1, 'a time element');
    assert.match(page.$('changes-list').children[1]!.textContent, /reviewer/);
    assert.doesNotMatch(page.$('changes-list').children[1]!.textContent, /#\d/, 'no PR chip without a PR');
  });

  it('shows no more than 10 entries even if the API returned more', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => change(i));
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture({ changes: eleven }) });
    await until(() => page.$('changes-list').children.length > 0, 3_000, 'changes');
    assert.equal(page.$('changes-list').children.length, 10);
  });

  it('links "Alle Changes" to /changes?issue=<id>, URL-encoded', async () => {
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture() });
    await until(() => page.$('changes-list').children.length === 10, 3_000, 'changes');
    const link = page.$('changes-all');
    assert.equal(link.textContent, 'Alle Changes');
    assert.equal(link.getAttribute('href'), '/changes?issue=acme%2Fapp%231');
  });

  it('shows "Noch keine Änderungen." without entries, and not while entries exist', async () => {
    const empty = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture({ changes: [] }) });
    await until(() => !empty.$('changes-empty').hidden, 3_000, 'empty note');
    assert.equal(empty.$('changes-empty').textContent, 'Noch keine Änderungen.');
    assert.equal(empty.$('changes-section').hidden, false);
    const full = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture() });
    await until(() => full.$('changes-list').children.length === 10, 3_000, 'changes');
    assert.equal(full.$('changes-empty').hidden, true);
  });

  it('puts titles and paths in as text, never as markup', async () => {
    const evil = [change(0, { title: '<script>x</script><b>t</b>', files: [{ path: '<img src=x onerror=1>', added: 1, deleted: 1 }] })];
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture({ changes: evil }) });
    await until(() => page.$('changes-list').children.length === 1, 3_000, 'changes');
    assert.match(page.$('changes-list').textContent, /<script>x<\/script><b>t<\/b>/);
    assert.equal(page.query('#changes-section script').length, 0);
    assert.equal(page.query('#changes-section img').length, 0);
    assert.equal(page.query('#changes-section b').length, 0);
  });
});

describe('team view sidebar #377: Brain-Zugriffe', () => {
  it('shows time, role, operation, path and result chip for ok rows', async () => {
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture({ access: [row(0, { op: 'search', path_or_query: 'caching strategy' })] }) });
    await until(() => page.$('access-list').children.length === 1, 3_000, 'access');
    assert.equal(page.$('access-section').hidden, false);
    const li = page.$('access-list').children[0]!;
    assert.match(li.textContent, /developer/);
    assert.match(li.textContent, /search/);
    assert.match(li.textContent, /caching strategy/);
    assert.match(li.textContent, /ok/);
    assert.ok(li.querySelectorAll('time').length >= 1);
    assert.equal(li.querySelectorAll('a').length, 0, 'no clash link for an ok row');
    assert.doesNotMatch(li.className, /rejected/);
  });

  it('marks a rejected write red and links to /brain#clashes; ok rows stay plain', async () => {
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture() });
    await until(() => page.$('access-list').children.length === 2, 3_000, 'access');
    const items = page.$('access-list').children;
    const bad = items.filter((li) => /rejected/.test(li.className));
    assert.equal(bad.length, 1);
    assert.match(bad[0]!.textContent, /Inbox\/clash\.md/);
    const hrefs = page.query('#access-section a').map((a) => a.getAttribute('href'));
    assert.ok(hrefs.includes('/brain#clashes'), `clash link in ${JSON.stringify(hrefs)}`);
    const good = items.filter((li) => !/rejected/.test(li.className));
    assert.equal(good.length, 1);
    assert.equal(good[0]!.querySelectorAll('a').length, 0);
  });

  it('shows at most 10 access rows', async () => {
    const many = Array.from({ length: 12 }, (_, i) => row(i));
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture({ access: many }) });
    await until(() => page.$('access-list').children.length > 0, 3_000, 'access');
    assert.equal(page.$('access-list').children.length, 10);
  });

  it('puts paths in as text, never as markup', async () => {
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture({ access: [row(0, { path_or_query: '<img src=x onerror=1>' })] }) });
    await until(() => page.$('access-list').children.length === 1, 3_000, 'access');
    assert.match(page.$('access-list').textContent, /<img src=x onerror=1>/);
    assert.equal(page.query('#access-section img').length, 0);
  });

  it('is hidden on 404 (no brain) while the changes stay visible', async () => {
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture({ brain: false }) });
    await until(() => page.$('changes-list').children.length === 10, 3_000, 'changes');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(page.$('access-section').hidden, true);
    assert.equal(page.$('access-list').children.length, 0);
    assert.equal(page.query('#access-section a').filter((a) => a.getAttribute('href') === '/brain#clashes').length, 0);
    assert.equal(page.$('changes-section').hidden, false);
  });

  it('is not visible before the first answer', () => {
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: () => new Promise(() => {}) as unknown });
    assert.equal(page.$('access-section').hidden, true);
  });
});

describe('team view sidebar #377: polling', () => {
  const pollOf = (page: ReturnType<typeof renderPage>) => page.intervals.find((i) => i.fn.name === 'poll')!.fn;

  it('reloads both feeds with the page poll and registers no extra timer for them', async () => {
    let changes: unknown[] = [change(0)];
    let access: unknown[] = [row(0)];
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture({}, { changes: () => changes, access: () => access }) });
    await until(() => page.$('changes-list').children.length === 1 && page.$('access-list').children.length === 1, 3_000, 'first load');
    const before = page.intervals.length;
    changes = [change(1), change(0)];
    access = [rejectedWrite, row(0)];
    await pollOf(page)();
    await until(() => page.$('changes-list').children.length === 2 && page.$('access-list').children.length === 2, 3_000, 'reload');
    assert.match(page.$('changes-list').children[0]!.textContent, /Titel 1/);
    assert.equal(page.$('access-list').children.filter((li) => /rejected/.test(li.className)).length, 1);
    assert.equal(page.intervals.length, before, 'no additional interval');
  });

  it('shows the Brain-Zugriffe once the brain appears, and hides them again when it disappears', async () => {
    let brain = false;
    const page = renderPage(AGENT_HTML, undefined, { ...opts, fetch: fixture({}, { brain: () => brain }) });
    await until(() => page.$('changes-list').children.length === 10, 3_000, 'changes');
    assert.equal(page.$('access-section').hidden, true);
    brain = true;
    await pollOf(page)();
    await until(() => !page.$('access-section').hidden, 3_000, 'brain on');
    assert.equal(page.$('access-list').children.length, 2);
    brain = false;
    await pollOf(page)();
    await until(() => page.$('access-section').hidden, 3_000, 'brain off');
  });

  it('keeps the rest of the page when the feeds fail', async () => {
    const page = renderPage(AGENT_HTML, undefined, {
      ...opts,
      fetch: (url: string) => {
        if (url.startsWith('/api/v1/changes?') || url.startsWith('/api/v1/brain/access?')) throw new Error('boom');
        if (url.endsWith('/team')) return scoreTeam();
        return issueDetail({ timeline_seq: 0 });
      },
    });
    await until(() => sideUrls(page).length >= 2, 3_000, 'feed calls');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(page.$('changes-list').children.length, 0);
    assert.equal(page.$('access-section').hidden, true);
    assert.ok(page.fetches.some((f) => f.url.endsWith('/team')), 'the page still loads its other data');
  });
});

describe('BrainAccessLog.readAccess issue filter #377', () => {
  const write = (lines: Record<string, unknown>[]) => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'access.jsonl'), lines.map((l) => JSON.stringify({ run: 'r', role: 'developer', op: 'read', purpose: '', result: 'ok', ...l }) + '\n').join(''));
    return new BrainAccessLog(dir, Logger.silent());
  };

  it('compares exactly (no prefix, no case folding) and applies the filter before the limit', () => {
    const lines: Record<string, unknown>[] = [{ at: '2026-10-30T10:00:00.000Z', issue: 'acme/app#1', path_or_query: 'mine.md' }];
    for (let i = 1; i <= 12; i++) lines.push({ at: `2026-10-30T10:${String(i).padStart(2, '0')}:00.000Z`, issue: i % 2 ? 'acme/app#12' : 'ACME/app#1', path_or_query: `other${i}.md` });
    lines.push({ at: '2026-10-30T11:00:00.000Z', issue: null, path_or_query: 'none.md' });
    const log = write(lines);
    assert.deepEqual(log.readAccess({ issue: 'acme/app#1', limit: 1 }).access.map((a) => a.path_or_query), ['mine.md']);
    assert.equal(log.readAccess({ issue: 'acme/app#1', limit: 1 }).next_before, null);
    assert.equal(log.readAccess({ issue: 'acme/app#99' }).access.length, 0);
    assert.equal(log.readAccess().access.length, 14);
  });

  it('combines with the role filter', () => {
    const log = write([
      { at: '2026-10-30T10:00:00.000Z', issue: 'acme/app#1', role: 'developer', path_or_query: 'a.md' },
      { at: '2026-10-30T10:01:00.000Z', issue: 'acme/app#1', role: 'reviewer', path_or_query: 'b.md' },
      { at: '2026-10-30T10:02:00.000Z', issue: 'acme/app#2', role: 'reviewer', path_or_query: 'c.md' },
    ]);
    assert.deepEqual(log.readAccess({ issue: 'acme/app#1', role: 'reviewer' }).access.map((a) => a.path_or_query), ['b.md']);
  });
});
