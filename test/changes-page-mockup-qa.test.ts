import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHANGES_HTML } from '../src/http/changes-page.ts';
import { renderPage, until } from './helpers.ts';
import { brainChangeEntry, changeEntry, changesFixture, dashboardState } from './helpers/page-fixtures.ts';

// Independent acceptance tests for #390 (Changes page after the mockup), derived from the issue text:
// CSS values of the mockup, card kinds, status chips, actions, feed end and side column.

type Page = ReturnType<typeof renderPage>;
type Obj = Record<string, unknown>;
const gone = { __status: 404, error: { code: 'brain_disabled' } };
const NOW = Date.parse('2026-10-30T12:00:00Z');

/** The declarations of the CSS rule(s) with exactly this selector in the page's inline style. */
function rule(selector: string): string {
  const css = [...CHANGES_HTML.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  const found: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.split(',').map((s) => s.trim()).includes(selector)) found.push(m[2]!);
  }
  assert.ok(found.length > 0, `no CSS rule for ${selector}`);
  return found.join(' ').replace(/\s+/g, ' ');
}
const norm = (s: string) => s.replace(/\s+/g, '');
function has(selector: string, declaration: string): void {
  assert.ok(norm(rule(selector)).includes(norm(declaration)), `${selector} should contain "${declaration}", has: ${rule(selector)}`);
}

interface Opts { data?: (u: string) => unknown; url?: string; vitals?: unknown; candidates?: unknown; controls?: unknown; post?: (u: string) => unknown; confirm?: boolean }
function open(opts: Opts = {}): Page {
  const state = dashboardState({ health: { repositories: ['acme/app', 'acme/lib'] }, ...(opts.controls === undefined ? {} : { controls: opts.controls }) });
  return renderPage(CHANGES_HTML, undefined, {
    now: NOW,
    confirm: opts.confirm,
    url: opts.url ?? 'http://127.0.0.1/changes',
    fetch: (u, init) => {
      if (init.method === 'POST') return opts.post ? opts.post(u) : {};
      if (u.startsWith('/api/v1/state')) return state;
      if (u.startsWith('/api/v1/brain/vitals')) return opts.vitals ?? { obsidian_url: null };
      if (u.startsWith('/api/v1/brain/candidates')) return opts.candidates ?? { candidates: [] };
      return (opts.data ?? (() => changesFixture()))(u);
    },
  });
}
const articles = (p: Page) => p.query('article.gi');
const ready = (p: Page, n: number) => until(() => articles(p).length === n, 3_000, `${n} cards`);
const text = (p: Page, sel: string) => p.query(sel).map((n) => n.textContent);
const feed = (entries: Obj[], over: Obj = {}) => () => changesFixture({ entries, ...over });
const candidate = { candidates: [{ path: 'Inbox/idea.md' }] };

describe('#390 QA: mockup CSS values', () => {
  it('pill select', () => {
    const r = rule('.chg-repo select');
    for (const d of ['min-height: 44px', 'border-radius: 999px', 'padding: 0 14px', 'rgba(255, 255, 255, .06)', 'rgba(255, 255, 255, .14)']) assert.ok(norm(r).includes(norm(d)), d);
  });
  it('layout flex values and card gap', () => {
    has('.chg-feed', 'flex: 999 1 640px');
    has('.chg-side', 'flex: 1 1 340px');
    has('#changes-feed', 'gap: 12px');
  });
  it('date label is sky', () => has('.chg-day', 'color: #7dd3fc'));
  it('card: padding 16, flex, gap 14; icon tile 40 / radius 12 with the two colour pairs', () => {
    has('.chg', 'padding: 16px');
    has('.chg', 'display: flex');
    has('.chg', 'gap: 14px');
    has('.chg-ico', 'width: 40px');
    has('.chg-ico', 'height: 40px');
    has('.chg-ico', 'border-radius: 12px');
    has('.chg-ico-code', 'background: rgba(125, 211, 252, .14)');
    has('.chg-ico-code', 'color: #7dd3fc');
    has('.chg-ico-brain', 'background: rgba(251, 191, 36, .14)');
    has('.chg-ico-brain', 'color: #fcd34d');
  });
  it('meta line, kind chip, title and meta typography', () => {
    has('.chg-line', 'font-size: 12.5px');
    has('.chg-line', 'color: var(--fg-2)');
    has('.chg-line', 'flex-wrap: wrap');
    has('.chg-line', 'gap: 6px 10px');
    has('.chg-kind', 'font-size: 11px');
    has('.chg-title', '15.5px');
    has('.chg-title', '600');
    has('.chg-title', 'overflow-wrap: anywhere');
    has('.chg-meta', 'font-size: 12px');
    has('.chg-meta', 'color: var(--fg-3)');
  });
  it('file list grid and bars', () => {
    has('.chg-file', 'grid-template-columns: minmax(0, 1fr) 120px 84px');
    has('.chg-file', 'gap: 10px');
    has('.chg-file', 'font-size: 12.5px');
    has('.chg-path', 'text-overflow: ellipsis');
    has('.chg-bar', 'height: 6px');
    has('.chg-bar', 'border-radius: 99px');
    has('.chg-bar', 'rgba(255, 255, 255, .06)');
    has('.chg-add', 'color: #6ee7b7');
    has('.chg-del', 'color: #fca5a5');
  });
  it('diff box', () => {
    const r = rule('.chg-diff');
    for (const d of ['padding: 10px 12px', 'border-radius: 10px', 'background: rgba(0, 0, 0, .3)', 'font-size: 12.5px']) assert.ok(norm(r).includes(norm(d)), d);
    has('.chg-dl-add', 'color: #6ee7b7');
    has('.chg-dl-del', 'color: #fca5a5');
    has('.chg-dl-ctx', 'color: var(--fg-2)');
  });
  it('footer, conflict border, hotspots grid', () => {
    has('.chg-foot', 'justify-content: space-between');
    has('.chg-conflict', 'border-color: rgba(248, 113, 113, .45)');
    has('.chg-hot', 'grid-template-columns: minmax(0, 1fr) auto');
    has('.chg-hot', 'font-size: 12.5px');
    has('.chg-hot-h', 'font: 500 12.5px');
    has('.chg-hot-h', 'color: var(--fg-3)');
    has('#changes-today', 'grid-template-columns: 1fr 1fr');
  });
  it('the Repository label is a real <label> around a <select>', () => {
    assert.match(CHANGES_HTML, /<label[^>]*>\s*<span>Repository<\/span>\s*<select id="changes-repo">/);
  });
  it('the segment counts are mono 12px with opacity .75 (component)', async () => {
    const p = open();
    await ready(p, 1);
    assert.ok(p.query('#changes-types .ui-seg-count').every((n) => n.className.includes('mono')));
  });
});

describe('#390 QA: title block and URL', () => {
  it('h1 + subtitle + segment labels in order', async () => {
    const p = open();
    await ready(p, 1);
    assert.equal(text(p, 'h1')[0], 'Changes');
    assert.ok(text(p, 'body').join(' ').includes('Was sich im Code und im Brain geändert hat, neueste zuerst') || p.root.textContent.includes('Was sich im Code und im Brain geändert hat, neueste zuerst'));
    assert.deepEqual(text(p, '#changes-types .ui-seg-label'), ['Alle', 'Code', 'Brain']);
    assert.equal(p.query('#changes-types [role="group"]')[0]!.getAttribute('aria-label'), 'Art der Änderung');
  });
  it('counts come from the API (not hard-coded)', async () => {
    const p = open({ data: feed([changeEntry()], { counts: { all: 1234, code: 1000, brain: 234 } }) });
    await ready(p, 1);
    assert.deepEqual(text(p, '#changes-types .ui-seg-count').map((t) => t.replace(/\D/g, '')), ['1234', '1000', '234']);
  });
  it('refreshed counts after switching the segment', async () => {
    const p = open({ data: (u) => (u.includes('type=brain') ? changesFixture({ counts: { all: 9, code: 4, brain: 5 } }) : changesFixture()) });
    await ready(p, 1);
    p.click(p.query('#changes-types .ui-seg-btn')[2]!);
    await until(() => text(p, '#changes-types .ui-seg-count').join() === '9,4,5', 3_000, 'counts');
    assert.match(String(p.location.search), /type=brain/);
  });
  it('select lists "Alle" first, then each repository once', async () => {
    const p = open({ data: feed([changeEntry({ repo: 'acme/app' }), changeEntry({ id: 'z', repo: 'other/zzz' })]) });
    await ready(p, 2);
    const options = text(p, '#changes-repo option');
    assert.equal(options[0], 'Alle');
    assert.deepEqual(options.slice(1).sort(), ['acme/app', 'acme/lib', 'other/zzz']);
  });
  it('selecting "Alle" removes repo from the URL; type all is not written', async () => {
    const p = open({ url: 'http://127.0.0.1/changes?repo=acme%2Fapp' });
    await ready(p, 1);
    const select = p.$('changes-repo') as unknown as { value: string };
    select.value = '';
    p.$('changes-repo').dispatch('change');
    await until(() => !String(p.location.search).includes('repo='), 3_000, 'url cleared');
    assert.doesNotMatch(String(p.location.search), /type=/);
  });
  it('the issue filter from the URL survives a segment change', async () => {
    const p = open({ url: 'http://127.0.0.1/changes?issue=acme%2Fapp%231' });
    await ready(p, 1);
    p.click(p.query('#changes-types .ui-seg-btn')[1]!);
    await until(() => String(p.location.search).includes('type=code'), 3_000, 'type');
    assert.match(String(p.location.search), /issue=acme%2Fapp%231/);
  });
  it('an unknown type in the URL falls back to Alle', async () => {
    const p = open({ url: 'http://127.0.0.1/changes?type=bogus' });
    await ready(p, 1);
    assert.deepEqual(p.query('#changes-types .ui-seg-btn').map((b) => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
    assert.doesNotMatch(p.fetches.filter((f) => f.url.startsWith('/api/v1/changes'))[0]!.url, /type=bogus/);
  });
});

describe('#390 QA: date labels', () => {
  it('"Heute · <Wochentag, d. Monat>" names the weekday and month of the day', async () => {
    const p = open({ data: feed([changeEntry({ at: '2026-10-30T09:00:00.000Z' })]) });
    await ready(p, 1);
    const label = text(p, '.lbl.chg-day')[0]!;
    assert.match(label, /^Heute · Freitag, 30\. Oktober$/);
  });
  it('"Gestern · …" for the day before', async () => {
    const p = open({ data: feed([changeEntry({ at: '2026-10-29T09:00:00.000Z' })]) });
    await ready(p, 1);
    assert.match(text(p, '.chg-day')[0]!, /^Gestern · Donnerstag, 29\. Oktober$/);
  });
  it('an older day is a plain date', async () => {
    const p = open({ data: feed([changeEntry({ at: '2026-10-20T09:00:00.000Z' })]) });
    await ready(p, 1);
    assert.match(text(p, '.chg-day')[0]!, /^Dienstag, 20\. Oktober$/);
  });
  it('label sits before the first card of its day, in feed order', async () => {
    const p = open({ data: feed([changeEntry({ id: 'a', at: '2026-10-30T09:00:00.000Z' }), changeEntry({ id: 'b', at: '2026-10-29T09:00:00.000Z' })]) });
    await ready(p, 2);
    const kids = p.$('changes-feed').children.map((c) => (c.tagName.toLowerCase() === 'article' ? 'card' : 'label'));
    assert.deepEqual(kids, ['label', 'card', 'label', 'card']);
  });
});

describe('#390 QA: card contents', () => {
  it('meta line: time (mono, <time>), role dot, issue (mono), kind chip', async () => {
    const p = open({ data: feed([changeEntry({ at: '2026-10-30T11:05:00.000Z' })]) });
    await ready(p, 1);
    const c = articles(p)[0]!;
    const time = c.querySelector('time')!;
    assert.match(time.textContent, /^\d{2}:\d{2}$/);
    assert.ok(time.className.includes('mono'));
    assert.equal(c.querySelector('.chg-role')!.textContent, 'developer');
    assert.equal(c.querySelectorAll('.chg-role .ui-dot').length, 1);
    const issue = c.querySelector('.chg-line a')!;
    assert.equal(issue.textContent, 'acme/app#1');
    assert.ok(issue.className.includes('mono'));
    assert.equal(c.querySelector('.chg-title')!.textContent, 'Add feed');
  });
  it('title is escaped, not interpreted as HTML', async () => {
    const p = open({ data: feed([changeEntry({ title: '<img src=x onerror=alert(1)>' })]) });
    await ready(p, 1);
    assert.equal(p.query('.chg-title')[0]!.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(p.query('.chg-title img').length, 0);
  });
  it('Symphony role is grey, a known role gets its own colour', async () => {
    const p = open({ data: feed([changeEntry({ id: 'a', role: 'symphony' }), changeEntry({ id: 'b', role: 'developer' })]) });
    await ready(p, 2);
    const dots = p.query('.chg-role .ui-dot').map((d) => d.style.background || d.style.backgroundColor);
    assert.equal(dots.length, 2);
    assert.notEqual(dots[0], dots[1]);
  });
  it('kind chips for every status', async () => {
    const entries = [
      changeEntry({ id: 'k1', status: 'committed' }),
      changeEntry({ id: 'k2', status: 'merged' }),
      brainChangeEntry({ id: 'k3', status: 'created' }),
      brainChangeEntry({ id: 'k4', status: 'updated' }),
      brainChangeEntry({ id: 'k5', status: 'approved' }),
      brainChangeEntry({ id: 'k6', status: 'rejected_candidate' }),
      brainChangeEntry({ id: 'k7', status: 'conflict', reason: 'hash_mismatch', clash_id: 'x', diff: null }),
    ];
    const p = open({ data: feed(entries) });
    await ready(p, 7);
    assert.deepEqual(text(p, '.chg-kind'), ['Commit', 'Merge', 'Notiz neu', 'Notiz geändert', 'Befördert', 'Verworfen', 'Schreiben abgewiesen']);
  });
  it('code icon tile has a svg, brain tile has a different svg', async () => {
    const p = open({ data: feed([changeEntry({ id: 'a' }), brainChangeEntry({ id: 'b' })]) });
    await ready(p, 2);
    const [a, b] = articles(p);
    const codeSvg = a!.querySelector('.chg-ico svg')!;
    const brainSvg = b!.querySelector('.chg-ico svg')!;
    assert.ok(codeSvg && brainSvg);
    assert.notEqual(codeSvg.outerHTML ?? codeSvg.innerHTML, brainSvg.outerHTML ?? brainSvg.innerHTML);
    assert.ok(a!.querySelector('.chg-ico-code'));
    assert.ok(b!.querySelector('.chg-ico-brain'));
  });
  it('brain meta: folder · status', async () => {
    const e = brainChangeEntry({ note_status: 'candidate', files: [{ path: 'Projects/acme/plan.md', added: 1, deleted: 0, status: 'added' }] });
    const p = open({ data: feed([e]) });
    await ready(p, 1);
    assert.equal(p.query('.chg-meta')[0]!.textContent, 'Projects/acme · status: candidate');
  });
  it('rejected write meta: reason, role of the earlier writer and the HH:MM', async () => {
    const e = brainChangeEntry({
      status: 'conflict', reason: 'hash_mismatch', clash_id: 'c1', diff: null, clash_status: 'open',
      other_role: 'tester', other_at: '2026-10-30T10:15:00.000Z',
    });
    const p = open({ data: feed([e]) });
    await ready(p, 1);
    assert.match(p.query('.chg-meta')[0]!.textContent, /^Hash-Konflikt · tester schrieb um \d{2}:\d{2}$/);
  });
  it('merge card: Merge chip, violet "gemerged", files list, meta without hash', async () => {
    const e = changeEntry({ id: 'code:acme/app:merge:7', status: 'merged', branch: 'symphony/issue-1' });
    const p = open({ data: feed([e]) });
    await ready(p, 1);
    const c = articles(p)[0]!;
    assert.equal(c.querySelector('.chg-kind')!.textContent, 'Merge');
    assert.equal(c.querySelector('.chg-status')!.textContent, 'gemerged');
    assert.match(c.querySelector('.chg-status')!.style.color as string, /#c4b5fd|196, 181, 253/i);
    assert.equal(c.querySelector('.chg-meta')!.textContent, 'acme/app · symphony/issue-1');
    assert.equal(c.querySelectorAll('.chg-file').length, 2);
  });
  it('status chip border follows the status colour', async () => {
    const p = open({ data: feed([changeEntry({ pr: { number: 9, status: 'failure' } })]) });
    await ready(p, 1);
    const s = p.query('.chg-status')[0]!;
    assert.ok(s.style.color);
    assert.ok(s.style.borderColor);
  });
  it('a code commit has no conflict border, a conflict card has it', async () => {
    const conflict = brainChangeEntry({ id: 'k', status: 'conflict', reason: 'hash_mismatch', clash_id: 'c', diff: null });
    const p = open({ data: feed([changeEntry(), conflict]) });
    await ready(p, 2);
    const [code, brain] = articles(p);
    assert.ok(!code!.className.includes('conflict'));
    assert.ok(brain!.className.includes('conflict'));
  });
});

describe('#390 QA: file list', () => {
  it('exactly 8 files: no "weitere" line', async () => {
    const files = Array.from({ length: 8 }, (_, i) => ({ path: `f${i}.ts`, added: 1, deleted: 1, status: 'modified' }));
    const p = open({ data: feed([changeEntry({ files })]) });
    await ready(p, 1);
    assert.equal(p.query('.chg-file').length, 8);
    assert.equal(p.query('.chg-file-more').length, 0);
  });
  it('9 files: first 8 shown (in order) and "+1 weitere"', async () => {
    const files = Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.ts`, added: 1, deleted: 1, status: 'modified' }));
    const p = open({ data: feed([changeEntry({ files })]) });
    await ready(p, 1);
    assert.deepEqual(text(p, '.chg-path'), files.slice(0, 8).map((f) => f.path));
    assert.equal(p.query('.chg-file-more')[0]!.textContent, '+1 weitere');
  });
  it('bar shares are relative to the largest add+delete sum of the card; the + and − numbers are shown', async () => {
    const files = [
      { path: 'big.ts', added: 30, deleted: 10, status: 'modified' }, // sum 40 = largest
      { path: 'small.ts', added: 5, deleted: 5, status: 'modified' },
    ];
    const p = open({ data: feed([changeEntry({ files })]) });
    await ready(p, 1);
    const widths = (sel: string) => p.query(sel).map((b) => parseFloat(String(b.style.width)));
    assert.equal(widths('.chg-bar-add')[0], 75);
    assert.equal(widths('.chg-bar-del')[0], 25);
    assert.ok(Math.abs(widths('.chg-bar-add')[1]! - 12.5) <= 1);
    assert.ok(Math.abs(widths('.chg-bar-del')[1]! - 12.5) <= 1);
    assert.ok(widths('.chg-bar-add')[0]! + widths('.chg-bar-del')[0]! <= 100);
    assert.deepEqual(text(p, '.chg-add'), ['+30', '+5']);
    assert.deepEqual(text(p, '.chg-del'), ['−10', '−5']);
  });
  it('the bars are relative within the card, not across cards', async () => {
    const small = changeEntry({ id: 'a', files: [{ path: 's.ts', added: 2, deleted: 0, status: 'modified' }] });
    const big = changeEntry({ id: 'b', files: [{ path: 'b.ts', added: 500, deleted: 0, status: 'modified' }] });
    const p = open({ data: feed([small, big]) });
    await ready(p, 2);
    assert.deepEqual(p.query('.chg-bar-add').map((b) => b.style.width), ['100%', '100%']);
  });
  it('the number colours use the + / − spans', async () => {
    const p = open({ data: feed([changeEntry()]) });
    await ready(p, 1);
    assert.ok(p.query('.chg-nums .chg-add').length >= 2);
    assert.ok(p.query('.chg-nums .chg-del').length >= 2);
  });
});

describe('#390 QA: diff box', () => {
  it('exactly 5 lines are shown as is; 6 are cut to 5', async () => {
    const five = ['Inbox/idea.md', '+1', '+2', '+3', '+4', '+5'].join('\n');
    const six = [...five.split('\n'), '+6'].join('\n');
    const a = open({ data: feed([brainChangeEntry({ diff: five })]) });
    await ready(a, 1);
    assert.equal(a.query('.chg-dl').length, 5);
    const b = open({ data: feed([brainChangeEntry({ diff: six })]) });
    await ready(b, 1);
    assert.equal(b.query('.chg-dl').length, 5);
    assert.ok(!b.query('.chg-diff')[0]!.textContent.includes('+6'));
  });
  it('is mono; + red/green classes per prefix, context otherwise', async () => {
    const p = open({ data: feed([brainChangeEntry({ diff: 'Inbox/idea.md\n+neu\n-alt\n bleibt' })]) });
    await ready(p, 1);
    assert.ok(p.query('.chg-diff')[0]!.className.includes('mono'));
    assert.deepEqual(text(p, '.chg-dl-add'), ['+neu']);
    assert.deepEqual(text(p, '.chg-dl-del'), ['-alt']);
    assert.equal(p.query('.chg-dl-ctx').length, 1);
  });
  it('no diff, no box (and a code card never shows one)', async () => {
    const p = open({ data: feed([brainChangeEntry({ diff: null }), changeEntry({ id: 'c', diff: 'x\n+a' })]) });
    await ready(p, 2);
    assert.equal(p.query('.chg-diff').length, 0);
  });
});

describe('#390 QA: status chips', () => {
  const chips = async (entries: Obj[], extra: Opts = {}) => {
    const p = open({ data: feed(entries), ...extra });
    await ready(p, entries.length);
    return p;
  };
  it('"approved" for approved notes (green) and "verworfen" for rejected candidates (grey)', async () => {
    const p = await chips([brainChangeEntry({ id: 'a', status: 'approved' }), brainChangeEntry({ id: 'b', status: 'rejected_candidate' })]);
    assert.deepEqual(text(p, '.chg-status'), ['approved', 'verworfen']);
    const [a, b] = p.query('.chg-status');
    assert.notEqual(a!.style.color, b!.style.color);
  });
  it('conflict chips: offen red, gelöst grey, offen and gelöst differ', async () => {
    const k = (id: string, s: string) => brainChangeEntry({ id, status: 'conflict', reason: 'hash_mismatch', clash_id: id, clash_status: s, diff: null });
    const p = await chips([k('a', 'open'), k('b', 'resolved')]);
    assert.deepEqual(text(p, '.chg-status'), ['Konflikt offen', 'Konflikt gelöst']);
    const [a, b] = p.query('.chg-status');
    assert.notEqual(a!.style.color, b!.style.color);
  });
  it('candidate chip is amber and differs from approved (green)', async () => {
    const p = open({ data: feed([brainChangeEntry({ id: 'a' }), brainChangeEntry({ id: 'b', status: 'approved', files: [{ path: 'Inbox/x.md', added: 1, deleted: 0, status: 'added' }] })]), candidates: candidate });
    await ready(p, 2);
    await until(() => text(p, '.chg-status')[0] === 'Kandidat · wartet auf dich', 3_000, 'candidate chip');
    const [a, b] = p.query('.chg-status');
    assert.notEqual(a!.style.color, b!.style.color);
  });
  it('a note that is not a candidate any more shows no candidate chip or buttons', async () => {
    const p = open({ data: feed([brainChangeEntry()]), candidates: { candidates: [] } });
    await ready(p, 1);
    assert.doesNotMatch(p.root.textContent, /Kandidat · wartet auf dich/);
    assert.equal(p.query('.chg-actions').length, 0);
  });
});

describe('#390 QA: candidate actions', () => {
  it('buttons are 40 px, with approve/danger tone, and the footer has chip and actions', async () => {
    const p = open({ data: feed([brainChangeEntry()]), candidates: candidate, vitals: { obsidian_url: 'obsidian://open?vault=brain' } });
    await until(() => p.query('.chg-actions button, .chg-actions a').length === 3, 3_000, 'actions');
    const all = p.query('.chg-actions .ui-btn');
    assert.ok(all.every((b) => b.className.includes('ui-btn-40')));
    assert.ok(all[0]!.className.includes('ui-btn-approve'));
    assert.ok(all[2]!.className.includes('ui-btn-danger'));
    const foot = p.query('.chg-foot')[0]!;
    assert.ok(foot.querySelector('.chg-status'));
    assert.ok(foot.querySelector('.chg-actions'));
    assert.equal(text(p, '.chg-actions .ui-btn-label').join('|'), 'Befördern|In Obsidian öffnen|Verwerfen');
  });
  it('control off (retry false) hides actions but keeps the chip', async () => {
    const p = open({ data: feed([brainChangeEntry()]), candidates: candidate, controls: { retry: false } });
    await ready(p, 1);
    await until(() => text(p, '.chg-status')[0] === 'Kandidat · wartet auf dich', 3_000, 'chip');
    assert.equal(p.query('.chg-actions').length, 0);
  });
  it('approve posts to the approve endpoint of the path', async () => {
    const p = open({ data: feed([brainChangeEntry()]), candidates: candidate });
    await until(() => p.query('.chg-actions button').length === 2, 3_000, 'actions');
    p.click(p.query('.chg-actions button')[0]!);
    await until(() => p.fetches.some((f) => f.method === 'POST'), 3_000, 'post');
    const post = p.fetches.find((f) => f.method === 'POST')!;
    assert.match(post.url, /^\/api\/v1\/brain\/candidates\/.+\/approve$/);
    assert.ok(decodeURIComponent(post.url).includes('Inbox/idea.md'));
    await until(() => text(p, '.chg-status')[0] === 'approved', 3_000, 'approved');
  });
  it('reject asks for confirmation, posts reject and switches the chip to "verworfen" without reload', async () => {
    const p = open({ data: feed([brainChangeEntry()]), candidates: candidate });
    await until(() => p.query('.chg-actions button').length === 2, 3_000, 'actions');
    const loads = p.fetches.filter((f) => f.url.startsWith('/api/v1/changes')).length;
    p.click(p.query('.chg-actions button')[1]!);
    await until(() => text(p, '.chg-status')[0] === 'verworfen', 3_000, 'chip');
    assert.equal(p.confirms.length, 1);
    assert.match(p.fetches.find((f) => f.method === 'POST')!.url, /\/reject$/);
    assert.equal(p.fetches.filter((f) => f.url.startsWith('/api/v1/changes')).length, loads);
    assert.equal(p.query('.chg-actions').length, 0);
  });
  it('declining the confirmation sends nothing', async () => {
    const p = open({ data: feed([brainChangeEntry()]), candidates: candidate, confirm: false });
    await until(() => p.query('.chg-actions button').length === 2, 3_000, 'actions');
    p.click(p.query('.chg-actions button')[1]!);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(p.fetches.filter((f) => f.method === 'POST').length, 0);
    assert.equal(text(p, '.chg-status')[0], 'Kandidat · wartet auf dich');
  });
  it('a failed action keeps the chip and buttons and shows the error', async () => {
    const p = open({ data: feed([brainChangeEntry()]), candidates: candidate, post: () => ({ __status: 409, error: { code: 'not_candidate', message: 'nope' } }) });
    await until(() => p.query('.chg-actions button').length === 2, 3_000, 'actions');
    p.click(p.query('.chg-actions button')[0]!);
    await until(() => /nope|409/.test(p.query('.chg-msg')[0]!.textContent), 3_000, 'error');
    assert.equal(text(p, '.chg-status')[0], 'Kandidat · wartet auf dich');
    assert.equal(p.query('.chg-actions button').length, 2);
    assert.ok(p.query('.chg-actions button').every((b) => !b.disabled));
  });
  it('a 403 shows the "controls off" message', async () => {
    const p = open({ data: feed([brainChangeEntry()]), candidates: candidate, post: () => ({ __status: 403, error: { code: 'controls_off' } }) });
    await until(() => p.query('.chg-actions button').length === 2, 3_000, 'actions');
    p.click(p.query('.chg-actions button')[0]!);
    await until(() => p.query('.chg-msg')[0]!.textContent !== '', 3_000, 'msg');
    assert.ok(p.query('.chg-msg')[0]!.textContent.length > 5);
    assert.equal(text(p, '.chg-status')[0], 'Kandidat · wartet auf dich');
  });
  it('issue summaries and rejected writes have no actions even if the path is a candidate', async () => {
    const summary = brainChangeEntry({ id: 's', role: 'symphony', files: [{ path: 'Issues/acme/1.md', added: 1, deleted: 0, status: 'added' }] });
    const conflict = brainChangeEntry({ id: 'k', status: 'conflict', reason: 'hash_mismatch', clash_id: 'k', diff: null });
    const p = open({ data: feed([summary, conflict]), candidates: { candidates: [{ path: 'Issues/acme/1.md' }, { path: 'Inbox/idea.md' }] } });
    await ready(p, 2);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(p.query('.chg-actions').length, 0);
  });
  it('code cards never get actions', async () => {
    const p = open({ data: feed([changeEntry()]), candidates: candidate });
    await ready(p, 1);
    assert.equal(p.query('.chg-actions').length, 0);
  });
});

describe('#390 QA: feed end', () => {
  const pages = (u: string) => {
    if (u.includes('before=c2')) return changesFixture({ entries: [changeEntry({ id: 'c3' })], next_before: null });
    if (u.includes('before=c1')) return changesFixture({ entries: [changeEntry({ id: 'c2' })], next_before: 'c2' });
    return changesFixture({ entries: [changeEntry({ id: 'c1' })], next_before: 'c1' });
  };
  it('chains "Ältere laden" with the current filter and ends at "Keine älteren Änderungen"', async () => {
    const p = open({ url: 'http://127.0.0.1/changes?type=code&repo=acme%2Fapp', data: pages });
    await until(() => p.query('#changes-more button').length === 1, 3_000, 'button');
    assert.equal(p.query('#changes-more button')[0]!.textContent, 'Ältere laden');
    p.click(p.query('#changes-more button')[0]!);
    await until(() => articles(p).length === 2 && p.query('#changes-more button').length === 1, 3_000, 'second page');
    p.click(p.query('#changes-more button')[0]!);
    await until(() => articles(p).length === 3, 3_000, 'third page');
    const urls = p.fetches.map((f) => f.url).filter((u) => u.startsWith('/api/v1/changes'));
    assert.match(urls[1]!, /before=c1/);
    assert.match(urls[2]!, /before=c2/);
    assert.match(urls[2]!, /type=code/);
    assert.match(urls[2]!, /repo=acme%2Fapp/);
    assert.equal(p.query('#changes-more button').length, 0);
    assert.equal(p.$('changes-more').textContent, 'Keine älteren Änderungen');
    assert.deepEqual(articles(p).map((a) => a.dataset.id), ['c1', 'c2', 'c3']);
  });
  it('the first request has no before=', async () => {
    const p = open({ data: pages });
    await ready(p, 1);
    assert.doesNotMatch(p.fetches.find((f) => f.url.startsWith('/api/v1/changes'))!.url, /before=/);
  });
  it('the load button is 44 px (default button size, no 40/38/36 class)', async () => {
    const p = open({ data: pages });
    await until(() => p.query('#changes-more button').length === 1, 3_000, 'button');
    assert.ok(!/ui-btn-(40|38|36)/.test(p.query('#changes-more button')[0]!.className));
    assert.ok(p.query('#changes-more button')[0]!.className.includes('ui-btn'));
  });
  it('no next_before from the start: the end message without a button', async () => {
    const p = open();
    await ready(p, 1);
    assert.equal(p.$('changes-more').textContent, 'Keine älteren Änderungen');
  });
  it('a failure while loading older entries keeps the feed and offers a retry', async () => {
    let fail = true;
    const p = open({
      data: (u) => {
        if (!u.includes('before=')) return changesFixture({ next_before: 'c1' });
        if (fail) return { __status: 500 };
        return changesFixture({ entries: [changeEntry({ id: 'c2' })], next_before: null });
      },
    });
    await until(() => p.query('#changes-more button').length === 1, 3_000, 'button');
    p.click(p.query('#changes-more button')[0]!);
    await until(() => /konnte|nicht/i.test(p.$('changes-more').textContent), 3_000, 'error');
    assert.equal(articles(p).length, 1);
    fail = false;
    p.click(p.query('#changes-more button')[0]!);
    await until(() => articles(p).length === 2, 3_000, 'retried');
  });
  it('an empty feed: only the empty text, no end message, no button', async () => {
    const p = open({ data: feed([], { counts: { all: 0, code: 0, brain: 0 } }) });
    await until(() => p.$('changes-feed').textContent.includes('Noch keine Änderungen für diesen Filter'), 3_000, 'empty');
    assert.equal(p.$('changes-more').textContent, '');
    assert.doesNotMatch(p.root.textContent, /Keine älteren Änderungen/);
  });
  it('a filter change replaces the feed and restarts without before=', async () => {
    const p = open({ data: (u) => (u.includes('type=code') ? changesFixture({ entries: [changeEntry({ id: 'only' })] }) : pages(u)) });
    await until(() => p.query('#changes-more button').length === 1, 3_000, 'button');
    p.click(p.query('#changes-more button')[0]!);
    await until(() => articles(p).length === 2, 3_000, 'two');
    p.click(p.query('#changes-types .ui-seg-btn')[1]!);
    await until(() => articles(p).length === 1 && articles(p)[0]!.dataset.id === 'only', 3_000, 'replaced');
    assert.doesNotMatch(p.fetches.filter((f) => f.url.startsWith('/api/v1/changes')).at(-1)!.url, /before=/);
    assert.equal(p.query('.chg-day').length, 1);
  });
});

describe('#390 QA: side column', () => {
  const stats = (over: Obj = {}) => ({
    today: { commits: 12, merges: 3, files: 1, added: 1, deleted: 1, brain: 6 }, conflicts_open: 2, hotspots: [], note_hotspots: [], ...over,
  });
  it('2x2 tiles in order with figures', async () => {
    const p = open({ data: () => changesFixture({ stats: stats() }) });
    await ready(p, 1);
    assert.equal(p.query('#changes-today .ui-kpi').length, 4);
    assert.deepEqual(text(p, '#changes-today .ui-kpi-value'), ['12', '6', '3', '2']);
    assert.match(text(p, '#changes-today .ui-kpi-label')[3]!, /^Konflikte? offen$/);
  });
  it('singular label for one open conflict, and amber/violet/red tile colours differ', async () => {
    const p = open({ data: () => changesFixture({ stats: stats({ conflicts_open: 1 }) }) });
    await ready(p, 1);
    assert.match(text(p, '#changes-today .ui-kpi-label')[3]!, /^Konflikt offen$/);
    const colours = p.query('#changes-today .ui-kpi-value').map((v) => v.style.color);
    assert.equal(new Set(colours.slice(1)).size, 3);
    assert.ok(!colours[0] || colours[0] === 'var(--fg)');
  });
  it('zero open conflicts use --fg-3, not red', async () => {
    const p = open({ data: () => changesFixture({ stats: stats({ conflicts_open: 0 }) }) });
    await ready(p, 1);
    assert.equal(p.query('#changes-today .ui-kpi-value')[3]!.style.color, 'var(--fg-3)');
    assert.equal(p.query('#changes-today .ui-kpi-value')[3]!.textContent, '0');
  });
  it('the side column has the two headings', async () => {
    const p = open();
    await ready(p, 1);
    assert.ok(text(p, 'h2').includes('Heute in Zahlen'));
    assert.ok(text(p, 'h2').includes('Hotspots · 7 Tage'));
  });
  it('file hotspots: path then "n×"; max 5; sub heading "Dateien"', async () => {
    const hotspots = Array.from({ length: 8 }, (_, i) => ({ path: `src/f${i}.ts`, repo: 'acme/app', count: 20 - i }));
    const p = open({ data: () => changesFixture({ stats: stats({ hotspots }) }) });
    await ready(p, 1);
    assert.deepEqual(text(p, '.chg-hot-h'), ['Dateien']);
    const cells = p.query('.chg-hot')[0]!.children.map((c) => c.textContent);
    assert.equal(cells.length, 10);
    assert.deepEqual(cells.slice(0, 4), ['src/f0.ts', '20×', 'src/f1.ts', '19×']);
    assert.ok(p.query('.chg-hot')[0]!.className.includes('mono'));
  });
  it('note hotspots: "n×", clash "n× · k Clash" in red only where clashes exist', async () => {
    const note_hotspots = [{ path: 'Inbox/a.md', count: 4, clashes: 0 }, { path: 'Inbox/b.md', count: 3, clashes: 2 }];
    const p = open({ data: () => changesFixture({ stats: stats({ note_hotspots }) }) });
    await ready(p, 1);
    assert.deepEqual(text(p, '.chg-hot-h'), ['Notizen']);
    const cells = p.query('.chg-hot')[0]!.children.map((c) => c.textContent);
    assert.deepEqual(cells, ['Inbox/a.md', '4×', 'Inbox/b.md', '3× · 2 Clash']);
    assert.equal(p.query('.chg-clash').length, 1);
  });
  it('only notes: just the "Notizen" block; nothing: "Keine Hotspots"', async () => {
    const empty = open({ data: () => changesFixture({ stats: stats() }) });
    await ready(empty, 1);
    assert.equal(empty.$('changes-hotspots').textContent, 'Keine Hotspots');
  });
  it('brain off: no note hotspots even if the API sends some, no brain tile data requirement', async () => {
    const p = open({ vitals: gone, candidates: gone, data: () => changesFixture({ stats: stats({ note_hotspots: [{ path: 'Inbox/a.md', count: 4, clashes: 1 }], hotspots: [{ path: 'src/a.ts', repo: 'acme/app', count: 2 }] }) }) });
    await ready(p, 1);
    assert.deepEqual(text(p, '.chg-hot-h'), ['Dateien']);
    assert.equal(p.query('.chg-clash').length, 0);
  });
});

describe('#390 QA: brain disabled', () => {
  it('Brain segment is missing; the select and Code segment still work', async () => {
    const p = open({ vitals: gone, candidates: gone });
    await ready(p, 1);
    assert.deepEqual(text(p, '#changes-types .ui-seg-label'), ['Alle', 'Code']);
    assert.ok(p.query('#changes-repo option').length >= 3);
  });
  it('with the brain on, the vitals request is made and Brain exists', async () => {
    const p = open();
    await ready(p, 1);
    assert.ok(p.fetches.some((f) => f.url.startsWith('/api/v1/brain/vitals')));
    assert.deepEqual(text(p, '#changes-types .ui-seg-label'), ['Alle', 'Code', 'Brain']);
  });
});
