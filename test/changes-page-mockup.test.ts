import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHANGES_HTML } from '../src/http/changes-page.ts';
import { renderPage, until } from './helpers.ts';
import { brainChangeEntry, changeEntry, changesFixture, dashboardState } from './helpers/page-fixtures.ts';

// The Changes page after the mockup (#390): title block, date labels, card kinds, feed end, side column, brain off.

type Page = ReturnType<typeof renderPage>;
type Obj = Record<string, unknown>;
const gone = { __status: 404, error: { code: 'brain_disabled' } };
const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-10-30T12:00:00Z');

function open(opts: { data?: (u: string) => unknown; url?: string; vitals?: unknown; candidates?: unknown; controls?: unknown; post?: () => unknown } = {}): Page {
  const state = dashboardState({ health: { repositories: ['acme/app', 'acme/lib'] }, ...(opts.controls === undefined ? {} : { controls: opts.controls }) });
  return renderPage(CHANGES_HTML, undefined, {
    now: NOW,
    url: opts.url ?? 'http://127.0.0.1/changes',
    fetch: (u, init) => {
      if (init.method === 'POST') return opts.post ? opts.post() : {};
      if (u.startsWith('/api/v1/state')) return state;
      if (u.startsWith('/api/v1/brain/vitals')) return opts.vitals ?? { obsidian_url: null };
      if (u.startsWith('/api/v1/brain/candidates')) return opts.candidates ?? { candidates: [] };
      return (opts.data ?? (() => changesFixture()))(u);
    },
  });
}
const calls = (p: Page) => p.fetches.filter((f) => f.url.startsWith('/api/v1/changes'));
const cards = (p: Page) => p.query('.chg');
const card = (p: Page, id: string) => cards(p).find((c) => c.dataset.id === id)!;
const ready = (p: Page, n: number) => until(() => cards(p).length === n, 3_000, `${n} cards`);
const text = (p: Page, sel: string) => p.query(sel).map((n) => n.textContent);
const iso = (ms: number) => new Date(ms).toISOString();

describe('Changes page: title block (#390)', () => {
  it('has the h1, the subtitle, the segment with counts and the Repository select', async () => {
    const p = open();
    await ready(p, 1);
    assert.equal(p.query('h1')[0]!.textContent, 'Changes');
    assert.equal(p.query('.page-sub')[0]!.textContent, 'Was sich im Code und im Brain geändert hat, neueste zuerst');
    const group = p.query('#changes-types [role="group"]')[0]!;
    assert.equal(group.getAttribute('aria-label'), 'Art der Änderung');
    assert.deepEqual(text(p, '#changes-types .ui-seg-btn'), ['Alle3', 'Code2', 'Brain1'].map((t) => t.replace(/(\D)(\d)/, '$1$2')));
    assert.deepEqual(text(p, '#changes-types .ui-seg-count'), ['3', '2', '1']);
    assert.match(p.query('label.chg-repo')[0]!.textContent, /Repository/);
    assert.deepEqual(text(p, '#changes-repo option'), ['Alle', 'acme/app', 'acme/lib']);
  });

  it('reads type, repo and issue from the URL into the first request and the pressed button', async () => {
    const p = open({ url: 'http://127.0.0.1/changes?type=brain&repo=acme%2Fapp&issue=acme%2Fapp%231' });
    await ready(p, 1);
    const url = calls(p)[0]!.url;
    assert.match(url, /type=brain/);
    assert.match(url, /repo=acme%2Fapp/);
    assert.match(url, /issue=acme%2Fapp%231/);
    assert.deepEqual(p.query('#changes-types .ui-seg-btn').map((b) => b.getAttribute('aria-pressed')), ['false', 'false', 'true']);
    assert.equal((p.$('changes-repo') as unknown as { value: string }).value, 'acme/app');
  });

  it('writes a click and a repository change into the URL and reloads', async () => {
    const p = open();
    await ready(p, 1);
    const n = calls(p).length;
    p.click(p.query('#changes-types .ui-seg-btn')[1]!);
    await until(() => calls(p).length > n, 3_000, 'reload');
    assert.match(String(p.location.search), /type=code/);
    (p.$('changes-repo') as unknown as { value: string }).value = 'acme/lib';
    p.$('changes-repo').dispatch('change');
    await until(() => calls(p).length > n + 1, 3_000, 'reload 2');
    assert.match(String(p.location.search), /type=code/);
    assert.match(String(p.location.search), /repo=acme%2Flib/);
    assert.match(calls(p).at(-1)!.url, /repo=acme%2Flib/);
  });
});

describe('Changes page: layout and date labels (#390)', () => {
  it('has the feed section and the side column', async () => {
    const p = open();
    await ready(p, 1);
    const feed = p.query('section.g')[0]!;
    assert.equal(feed.getAttribute('aria-label'), 'Änderungs-Feed');
    assert.ok(feed.querySelector('#changes-feed'));
    assert.match(CHANGES_HTML, /\.chg-feed \{ flex: 999 1 640px/);
    assert.match(CHANGES_HTML, /\.chg-side \{ flex: 1 1 340px/);
    assert.match(CHANGES_HTML, /#changes-feed \{[^}]*gap: 12px/);
  });

  it('groups by day: Heute, Gestern, then a plain date; a further page of the same day adds no label', async () => {
    const now = NOW;
    const entries = [
      changeEntry({ id: 'c1', at: iso(now - 1000) }),
      changeEntry({ id: 'c2', at: iso(now - 2000) }),
      changeEntry({ id: 'c3', at: iso(now - DAY) }),
      changeEntry({ id: 'c4', at: iso(now - 20 * DAY) }),
    ];
    const p = open({ data: (u) => (u.includes('before=') ? changesFixture({ entries: [changeEntry({ id: 'c5', at: iso(now - 20 * DAY - 1000) })], next_before: null }) : changesFixture({ entries, next_before: 'c4' })) });
    await ready(p, 4);
    const labels = text(p, '.chg-day');
    assert.equal(labels.length, 3);
    assert.match(labels[0]!, /^Heute · /);
    assert.match(labels[1]!, /^Gestern · /);
    assert.doesNotMatch(labels[2]!, /^(Heute|Gestern)/);
    assert.match(labels[2]!, /\d/);
    assert.ok(p.query('.chg-day')[0]!.className.includes('lbl'));
    p.click(p.query('#changes-more button')[0]!);
    await ready(p, 5);
    assert.equal(p.query('.chg-day').length, 3);
  });
});

describe('Changes page: cards (#390)', () => {
  it('a commit has icon tile, kind chip, meta line and bars relative to the largest sum', async () => {
    const p = open({ data: () => changesFixture({ entries: [changeEntry({ id: 'code:acme/app:abc1234def', branch: 'symphony/issue-1' })] }) });
    await ready(p, 1);
    const c = cards(p)[0]!;
    assert.ok(c.classList.contains('gi'));
    assert.equal(c.tagName.toLowerCase(), 'article');
    assert.ok(c.querySelector('.chg-ico-code svg'));
    assert.equal(c.querySelector('.chg-kind')!.textContent, 'Commit');
    assert.equal(c.querySelector('.chg-meta')!.textContent, 'acme/app · symphony/issue-1 · abc1234');
    assert.deepEqual(c.querySelectorAll('.chg-bar-add').map((b) => b.style.width), ['100%', '20%']);
    assert.deepEqual(c.querySelectorAll('.chg-bar-del').map((b) => b.style.width), ['0%', '30%']);
    assert.deepEqual(c.querySelectorAll('.chg-nums').map((n) => n.textContent), ['+10−0', '+2−3']);
    assert.equal(c.querySelector('.chg-status')!.textContent, 'PR #7 · Checks grün');
    assert.equal(c.querySelectorAll('.chg-role .ui-dot').length, 1);
  });

  it('a commit without a branch has the meta without it', async () => {
    const p = open({ data: () => changesFixture({ entries: [changeEntry({ id: 'code:acme/app:abc1234def' })] }) });
    await ready(p, 1);
    assert.equal(cards(p)[0]!.querySelector('.chg-meta')!.textContent, 'acme/app · abc1234');
  });

  it('the role Symphony is shown as "Symphony"', async () => {
    const p = open({ data: () => changesFixture({ entries: [changeEntry({ role: 'symphony' }), changeEntry({ id: 'x', role: '' })] }) });
    await ready(p, 2);
    assert.deepEqual(text(p, '.chg-role'), ['Symphony', 'Symphony']);
  });

  it('PR chips: checks running, green, red; a merge is "gemerged" with the kind Merge', async () => {
    const entry = (id: string, over: Obj) => changeEntry({ id, ...over });
    const p = open({
      data: () => changesFixture({
        entries: [
          entry('a', { pr: { number: 3, status: 'pending' } }), entry('b', { pr: { number: 4, status: 'success' } }),
          entry('c', { pr: { number: 5, status: 'failure' } }), entry('d', { status: 'merged', pr: { number: 6, status: 'success' } }),
        ],
      }),
    });
    await ready(p, 4);
    assert.deepEqual(text(p, '.chg-status'), ['PR #3 · Checks laufen', 'PR #4 · Checks grün', 'PR #5 · Checks rot', 'gemerged']);
    assert.equal(card(p, 'd').querySelector('.chg-kind')!.textContent, 'Merge');
    const colours = p.query('.chg-status').map((c) => c.style.color);
    assert.equal(new Set(colours).size, 4);
  });

  it('shows at most 8 files and "+k weitere"', async () => {
    const files = Array.from({ length: 11 }, (_, i) => ({ path: `src/f${i}.ts`, added: i, deleted: 0, status: 'modified' }));
    const p = open({ data: () => changesFixture({ entries: [changeEntry({ files })] }) });
    await ready(p, 1);
    assert.equal(p.query('.chg-file').length, 8);
    assert.equal(p.query('.chg-file-more')[0]!.textContent, '+3 weitere');
  });

  it('a new note as candidate has the chip and the three actions; Obsidian only with obsidian_url', async () => {
    const data = () => changesFixture({ entries: [brainChangeEntry({ note_status: 'candidate' })] });
    const candidates = { candidates: [{ path: 'Inbox/idea.md' }] };
    const plain = open({ data, candidates });
    await ready(plain, 1);
    const c = cards(plain)[0]!;
    assert.ok(c.querySelector('.chg-ico-brain svg'));
    assert.equal(c.querySelector('.chg-kind')!.textContent, 'Notiz neu');
    assert.equal(c.querySelector('.chg-meta')!.textContent, 'Inbox · status: candidate');
    assert.equal(c.querySelector('.chg-status')!.textContent, 'Kandidat · wartet auf dich');
    assert.deepEqual(text(plain, '.chg-actions .ui-btn-label'), ['Befördern', 'Verwerfen']);
    const withUrl = open({ data, candidates, vitals: { obsidian_url: 'obsidian://open?vault=brain' } });
    await until(() => withUrl.query('.chg-actions').length === 1, 3_000, 'actions');
    assert.deepEqual(text(withUrl, '.chg-actions .ui-btn-label'), ['Befördern', 'In Obsidian öffnen', 'Verwerfen']);
    const link = withUrl.query('.chg-actions a')[0]!;
    assert.equal(link.getAttribute('href'), 'obsidian://open?vault=brain&file=Inbox%2Fidea');
    assert.ok(link.textContent.includes('↗'));
    const off = open({ data, candidates, controls: { retry: false } });
    await ready(off, 1);
    assert.equal(off.query('.chg-actions').length, 0);
  });

  it('approving switches the chip to "approved" without loading the feed again', async () => {
    const p = open({ data: () => changesFixture({ entries: [brainChangeEntry()] }), candidates: { candidates: [{ path: 'Inbox/idea.md' }] } });
    await until(() => p.query('.chg-actions').length === 1, 3_000, 'actions');
    const n = calls(p).length;
    p.click(p.query('.chg-actions button')[0]!);
    await until(() => p.query('.chg-status')[0]!.textContent === 'approved', 3_000, 'chip');
    assert.equal(calls(p).length, n);
    assert.equal(p.query('.chg-actions').length, 0);
  });

  it('a rejected write has the red border, kind, meta and the clash state', async () => {
    const conflict = (id: string, clash_status: string | null) =>
      brainChangeEntry({
        id, status: 'conflict', reason: 'hash_mismatch', clash_id: id, diff: null, role: 'reviewer', clash_status,
        other_role: 'developer', other_at: '2026-10-30T10:15:00.000Z', files: [{ path: 'Inbox/idea.md', added: 0, deleted: 0, status: 'modified' }],
      });
    const p = open({ data: () => changesFixture({ entries: [conflict('k1', 'open'), conflict('k2', 'resolved'), conflict('k3', null)] }) });
    await ready(p, 3);
    const c = card(p, 'k1');
    assert.ok(c.classList.contains('chg-conflict'));
    assert.match(CHANGES_HTML, /\.chg-conflict \{ border-color: rgba\(248, 113, 113, \.45\)/);
    assert.equal(c.querySelector('.chg-kind')!.textContent, 'Schreiben abgewiesen');
    assert.match(c.querySelector('.chg-meta')!.textContent, /^Hash-Konflikt · developer schrieb um \d{2}:\d{2}$/);
    assert.deepEqual(text(p, '.chg-status'), ['Konflikt offen', 'Konflikt gelöst', 'Konflikt']);
    assert.equal(p.query('.chg-actions').length, 0);
  });

  it('an issue summary has its meta text, the approved chip and no actions', async () => {
    const summary = brainChangeEntry({ id: 'brain:s:Issues/acme/1.md', role: 'symphony', status: 'created', files: [{ path: 'Issues/acme/1.md', added: 5, deleted: 0, status: 'added' }] });
    const p = open({ data: () => changesFixture({ entries: [summary] }), candidates: { candidates: [{ path: 'Issues/acme/1.md' }] } });
    await ready(p, 1);
    assert.equal(p.query('.chg-meta')[0]!.textContent, 'automatisch nach dem Merge · status: approved');
    assert.equal(p.query('.chg-status')[0]!.textContent, 'approved');
    assert.equal(p.query('.chg-actions').length, 0);
  });

  it('the diff box shows at most 5 lines, coloured, without the path line', async () => {
    const diff = ['Inbox/idea.md', '+a', '-b', ' c', '+d', '+e', '+f', '+g'].join('\n');
    const p = open({ data: () => changesFixture({ entries: [brainChangeEntry({ diff })] }) });
    await ready(p, 1);
    assert.equal(p.query('.chg-dl').length, 5);
    assert.equal(p.query('.chg-dl-add').length, 3);
    assert.equal(p.query('.chg-dl-del').length, 1);
    assert.equal(p.query('.chg-dl-ctx').length, 1);
    assert.ok(!p.query('.chg-diff')[0]!.textContent.includes('idea.md'));
  });
});

describe('Changes page: feed end and empty state (#390)', () => {
  it('"Ältere laden" requests before=, appends, and ends with "Keine älteren Änderungen"', async () => {
    const p = open({ data: (u) => (u.includes('before=') ? changesFixture({ entries: [changeEntry({ id: 'c2' })], next_before: null }) : changesFixture({ next_before: 'cursor-1' })) });
    await until(() => p.query('#changes-more button').length === 1, 3_000, 'button');
    assert.equal(p.query('#changes-more button')[0]!.textContent, 'Ältere laden');
    p.click(p.query('#changes-more button')[0]!);
    await ready(p, 2);
    assert.match(calls(p).at(-1)!.url, /before=cursor-1/);
    assert.equal(p.query('#changes-more button').length, 0);
    assert.equal(p.$('changes-more').textContent, 'Keine älteren Änderungen');
  });

  it('an empty feed says so and has no button', async () => {
    const p = open({ data: () => changesFixture({ entries: [], counts: { all: 0, code: 0, brain: 0 } }) });
    await until(() => /Noch keine Änderungen für diesen Filter/.test(p.$('changes-feed').textContent), 3_000, 'empty');
    assert.equal(p.query('#changes-more button').length, 0);
    assert.equal(p.$('changes-more').textContent, '');
  });
});

describe('Changes page: side column (#390)', () => {
  const stats = (over: Obj = {}) => ({
    today: { commits: 7, merges: 2, files: 3, added: 1, deleted: 1, brain: 4 }, conflicts_open: 3,
    hotspots: Array.from({ length: 7 }, (_, i) => ({ path: `src/h${i}.ts`, repo: 'acme/app', count: 9 - i })),
    note_hotspots: Array.from({ length: 6 }, (_, i) => ({ path: `Inbox/n${i}.md`, count: 2, clashes: i === 0 ? 1 : 0 })), ...over,
  });

  it('shows four tiles with the figures and colours', async () => {
    const p = open({ data: () => changesFixture({ stats: stats() }) });
    await ready(p, 1);
    assert.deepEqual(text(p, '#changes-today .ui-kpi-label'), ['Code-Commits', 'Brain-Änderungen', 'PRs gemerged', 'Konflikte offen']);
    assert.deepEqual(text(p, '#changes-today .ui-kpi-value'), ['7', '4', '2', '3']);
    const colours = p.query('#changes-today .ui-kpi-value').map((v) => v.style.color);
    assert.ok(!colours[0]);
    assert.ok(colours[1] && colours[2] && colours[3]);
  });

  it('shows 0 open conflicts in --fg-3', async () => {
    const p = open({ data: () => changesFixture({ stats: stats({ conflicts_open: 0 }) }) });
    await ready(p, 1);
    assert.equal(p.query('#changes-today .ui-kpi-value')[3]!.style.color, 'var(--fg-3)');
  });

  it('lists at most 5 files and 5 notes, with the clash count in red', async () => {
    const p = open({ data: () => changesFixture({ stats: stats() }) });
    await ready(p, 1);
    assert.deepEqual(text(p, '.chg-hot-h'), ['Dateien', 'Notizen']);
    const [files, notes] = p.query('.chg-hot');
    assert.equal(files!.children.length, 10);
    assert.equal(notes!.children.length, 10);
    assert.match(files!.textContent, /src\/h0\.ts9×/);
    assert.equal(p.query('.chg-clash')[0]!.textContent, '2× · 1 Clash');
    assert.match(CHANGES_HTML, /\.chg-clash \{ color: #fca5a5/);
  });

  it('says "Keine Hotspots" without data', async () => {
    const p = open({ data: () => changesFixture({ stats: stats({ hotspots: [], note_hotspots: [] }) }) });
    await ready(p, 1);
    assert.equal(p.$('changes-hotspots').textContent, 'Keine Hotspots');
  });
});

describe('Changes page: brain off (#390)', () => {
  it('has no Brain segment, asks for code only, shows no note hotspots and ignores ?type=brain', async () => {
    const p = open({
      url: 'http://127.0.0.1/changes?type=brain', vitals: gone, candidates: gone,
      data: () => changesFixture({ counts: { all: 3, code: 2, brain: 1 }, stats: { ...changesFixture().stats as Obj, note_hotspots: [{ path: 'Inbox/x.md', count: 2, clashes: 0 }] } }),
    });
    await ready(p, 1);
    assert.deepEqual(text(p, '#changes-types .ui-seg-btn').map((t) => t.replace(/\d+/g, '')), ['Alle', 'Code']);
    assert.match(calls(p)[0]!.url, /type=code/);
    assert.doesNotMatch(String(p.location.search), /type=/);
    assert.deepEqual(p.query('#changes-types .ui-seg-btn').map((b) => b.getAttribute('aria-pressed')), ['true', 'false']);
    assert.deepEqual(text(p, '.chg-hot-h'), ['Dateien']);
    assert.deepEqual(text(p, '#changes-types .ui-seg-count'), ['2', '2']);
  });
});
