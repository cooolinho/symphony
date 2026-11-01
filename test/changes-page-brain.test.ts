import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHANGES_HTML } from '../src/http/changes-page.ts';
import { CONTROLS_OFF } from '../src/http/tasks-page.ts';
import { renderPage, until } from './helpers.ts';
import { brainChangeEntry, changeEntry, changesFixture, dashboardState } from './helpers/page-fixtures.ts';

// Brain entries in the Changes feed (#376): status chips, diff excerpt, conflicts, candidate actions, filter, stats.

type Page = ReturnType<typeof renderPage>;
const gone = { __status: 404, error: { code: 'brain_disabled' } };

const MIXED = [
  changeEntry(),
  brainChangeEntry(),
  brainChangeEntry({ id: 'brain:b:Decisions/x.md', title: 'Entscheid', status: 'approved', files: [{ path: 'Decisions/x.md', added: 1, deleted: 0, status: 'added' }] }),
  brainChangeEntry({ id: 'brain:h:Notes/o.md', title: 'Von Hand', status: 'human', role: '', issue: '', files: [{ path: 'Notes/o.md', added: 1, deleted: 0, status: 'modified' }] }),
  brainChangeEntry({ id: 'brain:conflict:c1', title: 'Abgewiesen', status: 'conflict', reason: 'hash_mismatch', clash_id: 'c1', diff: null }),
  brainChangeEntry({ id: 'brain:conflict:c2', title: 'Fenster', status: 'conflict', reason: 'window', clash_id: 'c2', diff: null }),
];

function open(opts: { entries?: unknown[]; candidates?: unknown; controls?: unknown; post?: () => unknown; url?: string; counts?: unknown } = {}): Page {
  const state = dashboardState(opts.controls === undefined ? {} : { controls: opts.controls });
  return renderPage(CHANGES_HTML, undefined, {
    url: opts.url ?? 'http://127.0.0.1/changes',
    fetch: (u, init) => {
      if (init.method === 'POST') return opts.post ? opts.post() : {};
      if (u.startsWith('/api/v1/state')) return state;
      if (u.startsWith('/api/v1/brain/vitals')) return opts.candidates === gone ? gone : { obsidian_url: null };
      if (u.startsWith('/api/v1/brain/candidates')) return opts.candidates ?? { candidates: [{ path: 'Inbox/idea.md', title: 'Idee' }] };
      return changesFixture({ entries: opts.entries ?? MIXED, ...(opts.counts ? { counts: opts.counts } : {}) });
    },
  });
}
const card = (p: Page, id: string) => p.query('.chg').find((c) => c.dataset.id === id)!;
const labels = (c: { querySelectorAll(s: string): Array<{ textContent: string }> }) => c.querySelectorAll('.chg-actions button').map((b) => b.textContent);
const changesCalls = (p: Page) => p.fetches.filter((f) => f.url.startsWith('/api/v1/changes'));

describe('Changes feed: brain entries', () => {
  it('shows title, path, role, issue and the status chip per status', async () => {
    const p = open();
    await until(() => p.query('.chg').length === MIXED.length, 3_000, 'feed');
    const note = card(p, 'brain:abc:Inbox/idea.md');
    for (const t of ['Idee', 'Inbox', 'developer', 'acme/app#1']) assert.ok(note.textContent.includes(t), t);
    const chip = (id: string) => card(p, id).querySelector('.chg-status')!.textContent;
    assert.equal(chip('brain:abc:Inbox/idea.md'), 'Kandidat · wartet auf dich');
    assert.equal(chip('brain:b:Decisions/x.md'), 'approved');
    assert.equal(card(p, 'brain:h:Notes/o.md').querySelector('.chg-kind')!.textContent, 'Notiz geändert');
    assert.equal(chip('brain:conflict:c1'), 'Konflikt');
    assert.equal(card(p, 'brain:h:Notes/o.md').querySelectorAll('a').length, 0, 'no empty issue link');
  });

  it('colours diff lines (max 5, no header line) and renders no block without a diff', async () => {
    const many = '1.md\n' + Array.from({ length: 8 }, (_, i) => `+z${i}`).join('\n');
    const p = open({ entries: [brainChangeEntry(), brainChangeEntry({ id: 'b2', diff: many }), brainChangeEntry({ id: 'b3', diff: null })] });
    await until(() => p.query('.chg').length === 3, 3_000, 'feed');
    const first = card(p, 'brain:abc:Inbox/idea.md');
    assert.equal(first.querySelectorAll('.chg-dl-add').length, 2);
    assert.equal(first.querySelectorAll('.chg-dl-del').length, 1);
    assert.ok(!first.querySelector('.chg-diff')!.textContent.includes('Inbox/idea.md'));
    assert.equal(card(p, 'b2').querySelectorAll('.chg-dl-add').length, 5);
    assert.equal(card(p, 'b2').querySelectorAll('.chg-dl').length, 5);
    assert.equal(card(p, 'b3').querySelectorAll('.chg-diff').length, 0);
  });

  it('shows conflicts in red with the reason as meta', async () => {
    const p = open();
    await until(() => p.query('.chg').length === MIXED.length, 3_000, 'feed');
    const c1 = card(p, 'brain:conflict:c1');
    assert.ok(c1.classList.contains('chg-conflict'));
    assert.match(c1.querySelector('.chg-meta')!.textContent, /Hash-Konflikt/);
    assert.match(card(p, 'brain:conflict:c2').querySelector('.chg-meta')!.textContent, /Schutzfenster/);
    assert.ok(!card(p, 'brain:abc:Inbox/idea.md').classList.contains('chg-conflict'));
  });

  it('offers Befördern/Verwerfen only at candidates, never at code, other notes or conflicts', async () => {
    const entries = [...MIXED, brainChangeEntry({ id: 'brain:conflict:c3', status: 'conflict', reason: 'window', diff: null })];
    const p = open({ entries });
    await until(() => p.query('.chg').length === entries.length, 3_000, 'feed');
    assert.deepEqual(labels(card(p, 'brain:abc:Inbox/idea.md')), ['Befördern', 'Verwerfen']);
    assert.ok(card(p, 'brain:abc:Inbox/idea.md').querySelectorAll('.chg-actions button').every((b) => b.classList.contains('ui-btn-40')));
    assert.equal(p.query('.chg-actions').length, 1);
  });

  it('offers no buttons when controls are off', async () => {
    const p = open({ controls: { retry: false } });
    await until(() => p.query('.chg').length === MIXED.length, 3_000, 'feed');
    assert.equal(p.query('.chg-actions').length, 0);
  });

  it('approves with a POST and switches the chip without reloading the feed', async () => {
    const p = open();
    await until(() => p.query('.chg-actions').length === 1, 3_000, 'buttons');
    const n = changesCalls(p).length;
    p.click(card(p, 'brain:abc:Inbox/idea.md').querySelectorAll('.chg-actions button')[0]!);
    await until(() => card(p, 'brain:abc:Inbox/idea.md').querySelector('.chg-status')!.textContent === 'approved', 3_000, 'chip');
    const post = p.fetches.find((f) => f.method === 'POST')!;
    assert.equal(post.url, '/api/v1/brain/candidates/Inbox%2Fidea.md/approve');
    assert.equal(changesCalls(p).length, n);
    assert.equal(p.query('.chg-actions').length, 0);
  });

  it('rejects after a confirmation and shows "verworfen"', async () => {
    const p = open();
    await until(() => p.query('.chg-actions').length === 1, 3_000, 'buttons');
    p.click(card(p, 'brain:abc:Inbox/idea.md').querySelectorAll('.chg-actions button')[1]!);
    await until(() => p.fetches.some((f) => f.method === 'POST'), 3_000, 'post');
    assert.equal(p.confirms.length, 1);
    assert.equal(p.fetches.find((f) => f.method === 'POST')!.url, '/api/v1/brain/candidates/Inbox%2Fidea.md/reject');
    await until(() => card(p, 'brain:abc:Inbox/idea.md').querySelector('.chg-status')!.textContent === 'verworfen', 3_000, 'chip');
  });

  it('shows a failure at the entry and re-enables the buttons', async () => {
    const p = open({ post: () => ({ __status: 409, error: { code: 'not_candidate', message: 'kein Kandidat' } }) });
    await until(() => p.query('.chg-actions').length === 1, 3_000, 'buttons');
    p.click(card(p, 'brain:abc:Inbox/idea.md').querySelectorAll('.chg-actions button')[0]!);
    await until(() => p.query('.chg-msg')[0]!.textContent !== '', 3_000, 'message');
    assert.match(p.query('.chg-msg')[0]!.textContent, /409.*kein Kandidat/);
    assert.ok(p.query('.chg-actions button').every((b) => !b.disabled));

    const denied = open({ post: () => ({ __status: 403, error: { code: 'forbidden' } }) });
    await until(() => denied.query('.chg-actions').length === 1, 3_000, 'buttons');
    denied.click(denied.query('.chg-actions button')[0]!);
    await until(() => denied.query('.chg-msg')[0]!.textContent !== '', 3_000, 'message');
    assert.equal(denied.query('.chg-msg')[0]!.textContent, CONTROLS_OFF);
  });

  it('filter Brain: query has type=brain, only brain cards, counter from counts', async () => {
    const brain = MIXED.filter((e) => e.type === 'brain');
    const p = open({ entries: brain, url: 'http://127.0.0.1/changes?type=brain', counts: { all: 6, code: 1, brain: 5 } });
    await until(() => p.query('.chg').length === brain.length, 3_000, 'feed');
    assert.match(changesCalls(p)[0]!.url, /type=brain/);
    assert.equal(p.query('.chg-file').length, 0);
    assert.match(p.query('#changes-types .ui-seg-btn')[2]!.textContent, /Brain\s*5/);
  });

  it('shows the brain writes of today as a tile', async () => {
    const p = open();
    await until(() => p.query('.chg').length > 0, 3_000, 'feed');
    assert.match(p.$('changes-today').textContent, /Brain-Änderungen/);
    assert.match(p.$('changes-today').textContent, /5/);
  });

  it('without brain: counter 0, no errors, no buttons', async () => {
    const p = open({ entries: [changeEntry()], candidates: gone, counts: { all: 1, code: 1, brain: 0 } });
    await until(() => p.query('.chg').length === 1, 3_000, 'feed');
    assert.doesNotMatch(p.root.textContent, /konnten nicht geladen werden/);
    assert.equal(p.query('.chg-actions').length, 0);
    assert.equal(p.query('#changes-types .ui-seg-btn').length, 2, 'no Brain segment without the brain');
    const empty = open({ entries: [], candidates: gone, url: 'http://127.0.0.1/changes?type=brain', counts: { all: 0, code: 0, brain: 0 } });
    await until(() => /Noch keine Änderungen für diesen Filter/.test(empty.$('changes-feed').textContent), 3_000, 'empty');
  });
});
