import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { BRAIN_ACCESS_JS } from '../src/http/brain-access.ts';
import { BRAIN_HTML } from '../src/http/brain-page.ts';
import { BRAIN_JS, BRAIN_PANELS_HTML } from '../src/http/overview-brain.ts';
import { renderPage } from './helpers.ts';
import { parseHtml } from './helpers/fake-dom.ts';

// E5-1 (#619): the section "Zugriffe" on the Brain page, shared with the overview card.

type Obj = Record<string, any>;

const vitals = {
  notes_by_status: { candidate: 0, approved: 1, deprecated: 0, none: 0 }, notes: { total: 1 }, links: { total: 1, per_note: 1 },
  orphans: 0, broken_links: 0, candidates: 0, writes_today: 1, reads_today: { total: 1, by_folder: [] },
  clashes: { week: { total: 0, resolved: 0 } }, commits: { total: 1 }, clash_window_min: 10, path: '/srv/brain', last_commit: null,
  obsidian_url: null, folders: [],
};

/** 50 rows: 30 today (developer, reviewer, none) and 20 yesterday, newest first. */
function entries(): Obj[] {
  const rows: Obj[] = [];
  for (let i = 0; i < 50; i++) {
    const today = i < 30;
    const role = i % 3 === 0 ? 'developer' : i % 3 === 1 ? 'reviewer' : null;
    const at = today ? `2026-10-30T10:${String(59 - i).padStart(2, '0')}:00Z` : `2026-10-29T10:${String(59 - (i - 30)).padStart(2, '0')}:00Z`;
    rows.push({ at, role, issue: role ? 'acme/app#7' : null, op: 'read', path_or_query: `Lessons/note-${i}.md`, purpose: `Grund ${i} wort${i}`, result: 'ok' });
  }
  delete rows[2]!.purpose;
  rows[5]!.result = 'rejected';
  return rows;
}

function fetcher(opts: { access?: unknown; vitals?: unknown } = {}) {
  return (url: string): unknown => {
    if (url.includes('/brain/vitals')) return opts.vitals ?? vitals;
    if (url.includes('/brain/candidates')) return { candidates: [] };
    if (url.includes('/brain/clashes')) return { clashes: [] };
    if (url.includes('/brain/access')) return opts.access ?? { access: entries() };
    return {};
  };
}

const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
async function open(opts: Parameters<typeof fetcher>[0] = {}) {
  const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher(opts) });
  await settle();
  return p;
}
const rows = (p: ReturnType<typeof renderPage>) => p.query('#zugriffe-list li.row');
const chip = (p: ReturnType<typeof renderPage>, label: string) => p.query('#zugriffe-roles button').find((b) => b.textContent === label)!;
const count = (p: ReturnType<typeof renderPage>) => p.query('#zugriffe-count')[0]!.textContent;

describe('Brain page: section Zugriffe', () => {
  it('is the last section of #brain-main, labelled, with a counter and one access request', async () => {
    const p = await open();
    const section = p.query('#zugriffe')[0]!;
    assert.equal(section.tagName.toLowerCase(), 'section');
    assert.equal(section.getAttribute('aria-labelledby'), 'zugriffe-title');
    assert.equal(p.query('#zugriffe-title')[0]!.textContent, 'Zugriffe');
    assert.equal(count(p), '50 von 50');
    const sections = p.query('#brain-main section');
    assert.equal(sections[sections.length - 1]!.getAttribute('id'), 'zugriffe');
    assert.equal(p.fetches.filter((f) => f.url === '/api/v1/brain/access?limit=50').length, 1);
  });

  it('renders 50 rows grouped by day with time, role with issue, operation, note, folder and purpose', async () => {
    const p = await open();
    assert.equal(rows(p).length, 50);
    const days = p.query('#zugriffe-list .brain-day').map((d) => d.textContent);
    assert.equal(days.length, 2);
    assert.ok(String(days[0]).startsWith('Heute · '));
    assert.ok(String(days[1]).startsWith('Gestern · '));
    const first = rows(p)[0]!;
    assert.match(first.querySelector('.brain-time')!.textContent, /^\d\d:\d\d:\d\d$/);
    assert.match(first.querySelector('.brain-role')!.textContent, /Developer #7/);
    assert.equal(first.querySelector('.brain-op')!.textContent, 'READ');
    assert.equal(first.querySelector('.brain-name')!.textContent, 'note-0.md');
    assert.equal(first.querySelector('.brain-folder')!.textContent, 'Lessons/');
    assert.equal(first.querySelector('.brain-purpose')!.textContent, 'Grund 0 wort0');
    assert.equal(rows(p)[2]!.querySelector('.brain-purpose')!.textContent, 'Zweck fehlt');
    assert.equal(rows(p)[5]!.querySelector('.brain-op')!.textContent, 'ABGEWIESEN');
  });

  it('filters by role without a request', async () => {
    const p = await open();
    const before = p.fetches.length;
    chip(p, 'Reviewer').click();
    const shown = rows(p);
    assert.equal(shown.length, 17);
    assert.ok(shown.every((r) => r.querySelector('.brain-role')!.textContent.includes('Reviewer')));
    assert.equal(count(p), '17 von 50');
    assert.equal(chip(p, 'Reviewer').getAttribute('aria-pressed'), 'true');
    assert.equal(p.fetches.length, before);
  });

  it('searches path and purpose without a request, and says so when nothing matches', async () => {
    const p = await open();
    const before = p.fetches.length;
    const input = p.query('#zugriffe-q')[0]!;
    input.value = 'WORT12';
    input.dispatch('input');
    assert.equal(rows(p).length, 1);
    assert.equal(rows(p)[0]!.querySelector('.brain-name')!.textContent, 'note-12.md');
    assert.equal(count(p), '1 von 50');
    input.value = 'gibt-es-nicht';
    input.dispatch('input');
    assert.equal(rows(p).length, 0);
    assert.ok(p.query('#zugriffe-list .brain-empty').some((e) => e.textContent === 'Keine Zugriffe für diesen Filter'));
    assert.equal(p.fetches.length, before);
  });

  it('keeps filter and search on the 15 s poll', async () => {
    const p = await open();
    chip(p, 'Reviewer').click();
    const poll = p.intervals.find((i) => i.ms === 15000);
    assert.ok(poll, 'poll registered');
    await poll!.fn();
    await settle();
    assert.equal(rows(p).length, 17);
    assert.equal(chip(p, 'Reviewer').getAttribute('aria-pressed'), 'true');
    assert.equal(p.fetches.filter((f) => f.url.includes('/brain/access')).length, 2);
  });

  it('shows the empty state, and survives a failing access request', async () => {
    const empty = await open({ access: { access: [] } });
    assert.equal(rows(empty).length, 0);
    assert.equal(count(empty), '0 von 0');
    assert.ok(empty.query('#zugriffe-list .brain-empty').some((e) => e.textContent === 'Noch keine Brain-Zugriffe heute'));
    const failing = await open({ access: { __status: 500 } });
    assert.equal(failing.query('#brain-main')[0]!.hidden, false);
    assert.equal(failing.query('#brain-error')[0]!.hidden, true);
    assert.ok(failing.query('#zugriffe-list .brain-empty').length > 0);
  });

  it('stays off with the Brain: #brain-off shown, section hidden with #brain-main, no access request', async () => {
    const p = await open({ vitals: { __status: 404 } });
    assert.equal(p.query('#brain-off')[0]!.hidden, false);
    assert.equal(p.query('#brain-main')[0]!.hidden, true);
    assert.ok(p.fetches.every((f) => !f.url.includes('/brain/access')));
  });
});

describe('shared access logic', () => {
  it('lives once in the shared module, used by the overview and the Brain page', () => {
    const count = (s: string) => s.split('function brainAccessView(').length - 1;
    assert.equal(count(BRAIN_JS), 1);
    assert.equal(count(BRAIN_HTML), 1);
    assert.ok(!readFileSync(new URL('../src/http/brain-page.ts', import.meta.url), 'utf8').includes('function brainRow'));
    assert.doesNotMatch(BRAIN_ACCESS_JS, /innerHTML|insertAdjacentHTML|outerHTML/);
  });

  it('keeps the overview card markup', () => {
    const root = parseHtml(BRAIN_PANELS_HTML);
    assert.ok(root.querySelector('#brain-roles'));
    assert.equal(root.querySelector('#brain-q')!.getAttribute('placeholder'), 'Notiz oder Zweck suchen');
    assert.ok(root.querySelector('#brain-access-list'));
  });
});
