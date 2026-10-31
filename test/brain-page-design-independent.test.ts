import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BRAIN_HTML } from '../src/http/brain-page.ts';
import type { FakeElement } from './helpers/fake-dom.ts';
import { renderPage, until } from './helpers.ts';
import { dashboardState } from './helpers/page-fixtures.ts';

// E7-8 (#391), independent tests derived from the issue text: the Brain page after the mockup, in a fake DOM.
// The frozen clock of renderPage is 2026-10-30T12:00:00Z.

type Obj = Record<string, any>;
type Page = ReturnType<typeof renderPage>;

const NOW = Date.parse('2026-10-30T12:00:00Z');
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const pad = (n: number) => String(n).padStart(2, '0');
const hm = (at: string) => `${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}`;

function vitals(over: Obj = {}): Obj {
  return {
    notes_by_status: { candidate: 2, approved: 6, deprecated: 2, none: 0 },
    notes: { total: 10, candidate: 2, approved: 6, deprecated: 2, none: 0 },
    links: { total: 23, per_note: 2.3 }, orphans: 1, broken_links: 3, candidates: 2, writes_today: 4,
    reads_today: { total: 9, by_folder: [{ folder: 'Repos', reads: 6, pct: 67 }, { folder: 'Lessons', reads: 3, pct: 33 }] },
    clashes: { week: { total: 3, resolved: 1 } }, commits: { total: 1234 }, clash_window_min: 10, path: '/srv/brain',
    last_commit: { sha: 'abcdef0123456789', at: '2026-10-30T11:00:00Z', author: 'human' }, obsidian_url: null,
    folders: [
      { path: 'Inbox', notes_by_status: { candidate: 2, approved: 0, deprecated: 0, none: 0 }, total: 2 },
      { path: 'Decisions', notes_by_status: { candidate: 0, approved: 7, deprecated: 0, none: 0 }, total: 7 },
      { path: 'Lessons', notes_by_status: { candidate: 0, approved: 5, deprecated: 0, none: 0 }, total: 5 },
      { path: 'Repos', notes_by_status: { candidate: 0, approved: 1, deprecated: 1, none: 0 }, total: 2 },
      { path: 'Repos/acme-app', notes_by_status: { candidate: 0, approved: 1, deprecated: 1, none: 0 }, total: 2 },
    ],
    ...over,
  };
}
const cand = (name: string, over: Obj = {}): Obj => ({
  path: `Inbox/${name}.md`, title: `Titel ${name}`, type: 'lesson', repo: 'acme/app', issue: '7', role: 'developer',
  created: iso(2 * DAY), target: 'Lessons/', preview: `Text ${name}`, ...over,
});
const node = (p: string, over: Obj = {}): Obj => ({ path: p, title: p.split('/').pop()!.replace(/\.md$/, ''), status: 'approved', type: 'note', missing: false, depth: 1, ...over });
const ROOT = 'Repos/acme-app/index.md';
const edge = (from: string, to: string, broken = false): Obj => ({ from, to, broken });
function graphBody(nodes: Obj[], edges: Obj[]): Obj {
  return { root: ROOT, depth: 2, truncated: false, nodes: [node(ROOT, { depth: 0, type: 'index' }), ...nodes], edges };
}
const SMALL_GRAPH = graphBody(
  [node('Decisions/d.md'), node('Lessons/l.md'), node('Agents/a.md'), node('Issues/acme-app/1.md'), node('Inbox/i.md', { status: 'candidate' })],
  [edge(ROOT, 'Decisions/d.md'), edge(ROOT, 'Lessons/l.md'), edge(ROOT, 'Agents/a.md'), edge(ROOT, 'Issues/acme-app/1.md'), edge(ROOT, 'Inbox/i.md')],
);
const clash = (id: string, over: Obj = {}): Obj => ({
  id, path: 'Lessons/x.md', runs: ['run-a', 'run-b'], roles: ['architect', 'developer'], issues: ['acme/app#7', 'acme/app#9'],
  at: ['2026-10-30T10:00:00Z', '2026-10-30T10:01:00Z'], reason: 'hash_mismatch', status: 'open',
  base: { content: 'a\nb\nc', hash: 'h0' }, attempted: { content: 'a\nb\nc' }, current: { content: 'a\nx\nc', hash: 'h1' }, ...over,
});

function fetcher(opts: Obj = {}): (url: string, init: { method: string; body?: unknown }) => unknown {
  return (url, init) => {
    if (init.method === 'POST') return typeof opts.post === 'function' ? opts.post(url) : { path: 'Lessons/a.md', previous_path: 'Inbox/a.md', hash: 'h', sha: 's' };
    const body = (key: string, fallback: unknown) => (typeof opts[key] === 'function' ? opts[key](url) : opts[key] ?? fallback);
    if (url.includes('/state')) return opts.state ?? dashboardState({ controls: { retry: true } });
    if (url.includes('/brain/vitals')) return body('vitals', vitals());
    if (url.includes('/brain/candidates')) return body('candidates', { candidates: [cand('a'), cand('b')] });
    if (url.includes('/brain/graph')) return body('graph', SMALL_GRAPH);
    if (url.includes('/brain/clashes')) return body('clashes', { clashes: [] });
    return {};
  };
}
const OFF = { retry: false };

async function open(opts: Obj = {}): Promise<Page> {
  const p = renderPage(BRAIN_HTML, undefined, { fetch: fetcher(opts) });
  await until(() => p.query('[aria-label="Vitalwerte"] .ui-kpi').length > 0);
  await settle();
  return p;
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
const text = (n: { textContent: string }) => n.textContent.replace(/\s+/g, ' ').trim();
const btn = (scope: { query?: unknown } & Obj, label: string): FakeElement | undefined =>
  (scope.querySelectorAll('button, a') as FakeElement[]).find((b) => text(b) === label);
const candidateCards = (p: Page): FakeElement[] => p.query('#candidates article.gi');
const sectionOf = (p: Page, heading: RegExp): FakeElement => {
  const section = p.query('section').find((s) => s.querySelectorAll('.lbl').some((l) => heading.test(text(l))));
  assert.ok(section, `section ${heading}`);
  return section;
};
const hex = (v: unknown) => String(v ?? '').toLowerCase().replace(/\s+/g, '');
const css = (re: RegExp) => assert.match(BRAIN_HTML.replace(/\s+/g, ''), re);

describe('Brain page: title block (E7-8)', () => {
  it('h1 "Brain" and the subtitle with vault path in <code> and the commit count in de-DE', async () => {
    const p = await open();
    assert.equal(text(p.query('h1')[0]!), 'Brain');
    const sub = p.query('.page-sub')[0] ?? p.$('brain-sub');
    assert.equal(text(sub), 'Das gemeinsame Gedächtnis der Agents · Vault /srv/brain · 1.234 Commits');
    assert.deepEqual(sub.querySelectorAll('code').map(text), ['/srv/brain']);
  });

  it('shows the Obsidian button as a link on obsidian_url, and hides it without configuration', async () => {
    const p = await open({ vitals: vitals({ obsidian_url: 'obsidian://open?vault=brain' }) });
    const link = p.query('a').find((a) => text(a) === 'In Obsidian öffnen ↗');
    assert.ok(link);
    assert.equal(link.getAttribute('href'), 'obsidian://open?vault=brain');
    const none = await open();
    assert.equal(none.query('a').filter((a) => text(a).startsWith('In Obsidian öffnen')).length, 0);
  });

  it('draws the button in the Obsidian tone rgba(167,139,250,.18) / .55 / #ede9fe', () => {
    css(/rgba\(167,139,250,0?\.18\)/);
    css(/rgba\(167,139,250,0?\.55\)/);
    css(/#ede9fe/i);
  });
});

describe('Brain page: vitals (E7-8)', () => {
  it('is a section.g with aria-label "Vitalwerte" on a 160 px auto-fit grid with 12 px gap', async () => {
    const p = await open();
    const section = p.query('section.g').find((s) => s.getAttribute('aria-label') === 'Vitalwerte');
    assert.ok(section);
    css(/repeat\(auto-fit,minmax\(160px,1fr\)\)/);
    css(/gap:12px/);
  });

  it('shows the notes card with label, mono total, the stacked bar with its aria-label and a legend', async () => {
    const p = await open();
    const section = p.query('[aria-label="Vitalwerte"]')[0]!;
    const bar = section.querySelectorAll('[role="img"]')[0]!;
    assert.equal(bar.getAttribute('aria-label'), '6 approved, 2 Kandidaten, 2 veraltet');
    const colors = bar.descendants().map((part) => hex(part.style.background));
    assert.deepEqual(colors, ['#34d399', '#fbbf24', '#64748b']);
    const card = section.children.find((c) => c.contains(bar))!;
    const t = text(card);
    assert.match(t, /^Notizen/);
    assert.ok(t.includes('10'), 'total');
    for (const legend of ['6 approved', '2 Kandidaten', '2 veraltet']) assert.ok(t.includes(legend), legend);
    css(/grid-column:span2/);
    css(/26px/);
    css(/\.ui-stack\{[^}]*height:10px/);
  });

  it('shows the four tiles with their notes', async () => {
    const p = await open();
    const tiles = p.query('[aria-label="Vitalwerte"] .ui-kpi').map(text);
    const find = (label: string) => tiles.find((t) => t.includes(label));
    assert.match(find('Links')!, /23/);
    assert.match(find('Links')!, /2,3 je Notiz/);
    assert.match(find('Waisen')!, /1/);
    assert.match(find('Waisen')!, /ohne ein- und ausgehende Links/);
    assert.match(find('Kaputte Links')!, /3/);
    assert.match(find('Kaputte Links')!, /Ziel fehlt/);
    assert.match(find('Writes / Reads heute')!, /4 \/ 9/);
    assert.match(find('Writes / Reads heute')!, /67 % der Reads aus Repos\//);
  });

  it('colours the tiles: sky, violet, red', async () => {
    const p = await open();
    const color = (label: string) => {
      const kpi = p.query('[aria-label="Vitalwerte"] .ui-kpi').find((k) => k.querySelector('.ui-kpi-label') && text(k.querySelector('.ui-kpi-label')!) === label)!;
      return hex((kpi.querySelector('.ui-kpi-value') as FakeElement).style.color);
    };
    assert.equal(color('Links'), '#38bdf8');
    assert.equal(color('Waisen'), '#a78bfa');
    assert.equal(color('Kaputte Links'), '#f87171');
  });

  it('formats the numbers in de-DE (links per note with one decimal, thousands separator)', async () => {
    const p = await open({ vitals: vitals({ links: { total: 12345, per_note: 12.5 } }) });
    const t = p.query('[aria-label="Vitalwerte"] .ui-kpi').map(text).find((x) => x.includes('Links'))!;
    assert.match(t, /12\.345/);
    assert.match(t, /12,5 je Notiz/);
  });
});

describe('Brain page: candidate review (E7-8)', () => {
  it('has the head, the explanation and one card per candidate with title, target path and excerpt', async () => {
    const p = await open();
    const section = p.query('#candidates')[0]!;
    assert.ok(text(section).includes('Kandidaten-Review'));
    assert.ok(text(section).includes('2 offen von 2'));
    assert.ok(text(section).includes('Neue Notizen der Agents. Erst nach dem Befördern bevorzugen Agents sie beim Lesen.'));
    css(/flex:9991620px/);
    const cs = candidateCards(p);
    assert.equal(cs.length, 2);
    assert.ok(cs[0]!.getAttribute('class')!.split(' ').includes('gi'));
    assert.ok(text(cs[0]!).includes('Titel a'));
    assert.ok(text(cs[0]!).includes('Inbox/ → Lessons/'));
    assert.ok(text(cs[0]!).includes('Text a'));
  });

  it('names the types in German (Lesson, Repo-Wissen, Entscheidung, Agent-Notiz, Sonstiges)', async () => {
    const types: Array<[string | null, string]> = [['lesson', 'Lesson'], ['index', 'Repo-Wissen'], ['decision', 'Entscheidung'], ['agent', 'Agent-Notiz'], ['note', 'Sonstiges'], [null, 'Sonstiges']];
    const p = await open({ candidates: { candidates: types.map(([type], i) => cand(`t${i}`, { type, created: iso(i * HOUR + 3 * DAY) })) } });
    const cs = candidateCards(p);
    assert.equal(cs.length, types.length);
    types.forEach(([, name], i) => {
      const c = cs.find((x) => text(x).includes(`Titel t${i}`))!;
      const chips = c.querySelectorAll('.ui-chip').map(text);
      assert.ok(chips.includes(name), `${name} in ${chips.join('|')}`);
    });
  });

  it('shows the age as "vor 4 min", "vor 1 h" and "vor 2 Tagen"', async () => {
    const p = await open({ candidates: { candidates: [cand('m', { created: iso(4 * MIN) }), cand('h', { created: iso(HOUR + 5 * MIN) }), cand('d', { created: iso(2 * DAY + HOUR) })] } });
    const of = (n: string) => text(candidateCards(p).find((c) => text(c).includes(`Titel ${n}`))!);
    assert.ok(of('m').includes('vor 4 min'));
    assert.ok(of('h').includes('vor 1 h'));
    assert.ok(of('d').includes('vor 2 Tagen'));
  });

  it('shows the role with its name, the issue number and the target from the type folder or the target', async () => {
    const p = await open({ candidates: { candidates: [cand('x', { role: 'tester', issue: '42', target: 'Decisions/', type: 'decision' })] } });
    const c = text(candidateCards(p)[0]!);
    assert.match(c, /Tester/);
    assert.match(c, /#42/);
    assert.ok(c.includes('Inbox/ → Decisions/'));
  });

  it('cuts the excerpt to the first 200 characters', async () => {
    const preview = 'a'.repeat(150) + 'b'.repeat(150);
    const p = await open({ candidates: { candidates: [cand('x', { preview })] } });
    const c = text(candidateCards(p)[0]!);
    assert.ok(c.includes('a'.repeat(150) + 'b'.repeat(50)));
    assert.ok(!c.includes('b'.repeat(51)));
  });

  it('sorts the oldest candidate first', async () => {
    const p = await open({ candidates: { candidates: [cand('neu', { created: iso(MIN) }), cand('alt', { created: iso(5 * DAY) }), cand('mitte', { created: iso(HOUR) })] } });
    const titles = candidateCards(p).map((c) => (/Titel (neu|alt|mitte)/.exec(text(c)) ?? [])[1]);
    assert.deepEqual(titles, ['alt', 'mitte', 'neu']);
  });

  it('offers Befördern and Verwerfen (40 px) only with control actions, and the Obsidian edit button only with an URL', async () => {
    const allowed = await open();
    const first = candidateCards(allowed)[0]!;
    assert.ok(btn(first, 'Befördern'));
    assert.ok(btn(first, 'Verwerfen'));
    assert.ok(btn(first, 'Befördern')!.classList.contains('ui-btn-40'));
    assert.ok(btn(first, 'Verwerfen')!.classList.contains('ui-btn-danger'));
    assert.equal(btn(first, 'In Obsidian bearbeiten ↗'), undefined, 'no Obsidian URL');

    const withUrl = await open({ vitals: vitals({ obsidian_url: 'https://brain.lan' }) });
    assert.ok(btn(candidateCards(withUrl)[0]!, 'In Obsidian bearbeiten ↗'));

    const off = await open({ state: dashboardState({ controls: OFF }), vitals: vitals({ obsidian_url: 'https://brain.lan' }) });
    for (const c of candidateCards(off)) {
      for (const label of ['Befördern', 'Verwerfen', 'In Obsidian bearbeiten ↗', 'Rückgängig']) assert.equal(btn(c, label), undefined, label);
    }
    assert.equal(candidateCards(off).length, 2, 'the candidates are still listed');
  });

  it('promotes: POST, chip "Befördert · approved", "Rückgängig" (36 px), counter counts down', async () => {
    let list = [cand('a', { created: iso(3 * DAY) }), cand('b', { created: iso(DAY) })];
    const p = await open({ candidates: () => ({ candidates: list }), post: () => { list = list.filter((c) => c.path !== 'Inbox/a.md'); return { path: 'Lessons/a.md', previous_path: 'Inbox/a.md', hash: 'h', sha: 's' }; } });
    btn(candidateCards(p)[0]!, 'Befördern')!.click();
    await until(() => candidateCards(p).some((c) => text(c).includes('Befördert · approved')));
    await settle();
    const posts = p.fetches.filter((f) => f.method === 'POST');
    assert.equal(posts.length, 1);
    assert.ok(posts[0]!.url.includes('approve'), posts[0]!.url);
    assert.ok(posts[0]!.url.includes(encodeURIComponent('Inbox/a.md')));
    const decided = candidateCards(p).find((c) => text(c).includes('Titel a'))!;
    assert.ok(text(decided).includes('Befördert · approved'));
    assert.ok(btn(decided, 'Rückgängig')!.classList.contains('ui-btn-36'));
    assert.equal(btn(decided, 'Befördern'), undefined);
    assert.ok(text(p.query('#candidates')[0]!).includes('1 offen von 2'));
  });

  it('discards after the confirmation: chip "Verworfen · deprecated"; "Rückgängig" calls the API and restores the card', async () => {
    let list = [cand('a')];
    const p = await open({
      candidates: () => ({ candidates: list }),
      post: (url: string) => {
        if (url.includes('reject')) { list = []; return { path: 'Inbox/a.md', hash: 'h', sha: 's' }; }
        list = [cand('a')];
        return { path: 'Inbox/a.md', hash: 'h', sha: 'r' };
      },
    });
    btn(candidateCards(p)[0]!, 'Verwerfen')!.click();
    await until(() => text(p.query('#candidates')[0]!).includes('Verworfen · deprecated'));
    await settle();
    assert.equal(p.confirms.length, 1, 'asks before discarding');
    assert.ok(text(p.query('#candidates')[0]!).includes('0 offen von 1'));
    const posts = () => p.fetches.filter((f) => f.method === 'POST');
    assert.ok(posts()[0]!.url.includes('reject'));
    btn(candidateCards(p)[0]!, 'Rückgängig')!.click();
    await until(() => posts().length === 2);
    await settle();
    assert.ok(/revert/.test(posts()[1]!.url), posts()[1]!.url);
    const t = text(p.query('#candidates')[0]!);
    assert.ok(!t.includes('Verworfen · deprecated'));
    assert.ok(t.includes('1 offen von 1'));
    assert.ok(btn(candidateCards(p)[0]!, 'Befördern'));
  });

  it('shows the empty state without candidates', async () => {
    const p = await open({ candidates: { candidates: [] } });
    assert.ok(text(p.query('#candidates')[0]!).includes('Keine Kandidaten offen – alles gesichtet'));
    assert.equal(candidateCards(p).length, 0);
    assert.ok(text(p.query('#candidates')[0]!).includes('0 offen von 0'));
  });
});

describe('Brain page: graph (E7-8)', () => {
  const svgOf = (p: Page) => p.query('svg').find((s) => s.getAttribute('viewBox') === '0 0 360 220')!;
  const circles = (p: Page) => svgOf(p).querySelectorAll('circle');

  it('draws an svg with the viewBox, role img and the label around the repository index', async () => {
    const p = await open();
    const svg = svgOf(p);
    assert.ok(svg);
    assert.equal(svg.getAttribute('role'), 'img');
    assert.equal(svg.getAttribute('aria-label'), 'Ausschnitt des Notiz-Graphen rund um Repos/acme-app/index');
    const section = sectionOf(p, /^Graph/);
    assert.match(text(section.querySelectorAll('.lbl')[0]!), /^Graph · Ausschnitt acme-app/);
  });

  it('colours the nodes by folder, with the root at radius 13 and the others between 5 and 13, class node', async () => {
    const p = await open();
    const cs = circles(p);
    assert.equal(cs.length, 6);
    for (const c of cs) {
      assert.ok(c.classList.contains('node'));
      const r = Number(c.getAttribute('r'));
      assert.ok(r >= 5 && r <= 13, `r ${r}`);
    }
    assert.equal(cs.filter((c) => Number(c.getAttribute('r')) === 13).length, 1);
    assert.deepEqual(
      cs.map((c) => hex(c.getAttribute('fill'))).sort(),
      ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#94a3b8'].sort(),
    );
  });

  it('sizes the nodes by their number of links', async () => {
    const hubGraph = graphBody(
      [node('Lessons/hub.md'), node('Lessons/leaf.md'), node('Decisions/a.md', { depth: 2 }), node('Decisions/b.md', { depth: 2 }), node('Agents/c.md', { depth: 2 })],
      [edge(ROOT, 'Lessons/hub.md'), edge(ROOT, 'Lessons/leaf.md'), edge('Lessons/hub.md', 'Decisions/a.md'), edge('Lessons/hub.md', 'Decisions/b.md'), edge('Lessons/hub.md', 'Agents/c.md')],
    );
    const p = await open({ graph: hubGraph });
    const radii = circles(p).map((c) => Number(c.getAttribute('r'))).sort((a, b) => a - b);
    assert.equal(radii[radii.length - 1], 13);
    assert.ok(radii[radii.length - 2]! > radii[0]!, `radii ${radii.join(',')}`);
  });

  it('draws edges at .18 white / 1 px and broken links red, 1.5 px, dashed 3 3', async () => {
    const g = graphBody([node('Lessons/l.md'), node('Lessons/gone.md', { missing: true, status: null })], [edge(ROOT, 'Lessons/l.md'), edge(ROOT, 'Lessons/gone.md', true)]);
    const p = await open({ graph: g });
    const lines = svgOf(p).querySelectorAll('line, path').filter((l) => l.getAttribute('stroke'));
    const broken = lines.filter((l) => hex(l.getAttribute('stroke')) === '#f87171');
    const normal = lines.filter((l) => hex(l.getAttribute('stroke')) === 'rgba(255,255,255,.18)' || hex(l.getAttribute('stroke')) === 'rgba(255,255,255,0.18)');
    assert.equal(broken.length, 1);
    assert.equal(normal.length, 1);
    assert.equal(Number(broken[0]!.getAttribute('stroke-width')), 1.5);
    assert.equal(broken[0]!.getAttribute('stroke-dasharray')!.replace(/\s+/g, ' '), '3 3');
    assert.equal(Number(normal[0]!.getAttribute('stroke-width')), 1);
  });

  it('shows at most 24 nodes', async () => {
    const many = Array.from({ length: 40 }, (_, i) => node(`Lessons/n${i}.md`));
    const p = await open({ graph: graphBody(many, many.map((n) => edge(ROOT, n.path))) });
    const n = circles(p).length;
    assert.ok(n > 0 && n <= 24, `${n} nodes`);
  });

  it('groups notes of one folder two links away as "Inbox (3)"', async () => {
    const g = graphBody(
      [node('Lessons/l.md'), node('Decisions/d.md'), node('Inbox/1.md', { depth: 2 }), node('Inbox/2.md', { depth: 2 }), node('Inbox/3.md', { depth: 2 })],
      [edge(ROOT, 'Lessons/l.md'), edge(ROOT, 'Decisions/d.md'), edge('Lessons/l.md', 'Inbox/1.md'), edge('Lessons/l.md', 'Inbox/2.md'), edge('Lessons/l.md', 'Inbox/3.md')],
    );
    const p = await open({ graph: g });
    assert.ok(svgOf(p).textContent.includes('Inbox (3)'), svgOf(p).textContent);
    assert.ok(circles(p).length <= 4, 'root, two neighbours and one group');
  });

  it('labels the centre and at most the four largest neighbours', async () => {
    const many = Array.from({ length: 10 }, (_, i) => node(`Lessons/n${i}.md`));
    const p = await open({ graph: graphBody(many, many.map((n) => edge(ROOT, n.path))) });
    const labels = svgOf(p).querySelectorAll('text');
    assert.ok(labels.length >= 1 && labels.length <= 5, `${labels.length} labels`);
  });

  it('has a legend with the folders and "kaputter Link"', async () => {
    const p = await open();
    const section = sectionOf(p, /^Graph/);
    const t = text(section);
    for (const name of ['Repos', 'Decisions', 'Lessons', 'Inbox', 'Agents', 'Issues', 'kaputter Link']) assert.ok(t.includes(name), name);
  });

  it('offers a select only with two or more repositories', async () => {
    const one = await open();
    const selects = (p: Page) => sectionOf(p, /^Graph/).querySelectorAll('select').filter((s) => !s.hidden);
    assert.equal(selects(one).length, 0);
    const two = await open({ vitals: vitals({ folders: [...vitals().folders, { path: 'Repos/beta', notes_by_status: {}, total: 1 }] }) });
    const select = selects(two)[0]!;
    assert.ok(select);
    assert.deepEqual(select.options.map(text).sort(), ['acme-app', 'beta']);
  });
});

describe('Brain page: structure (E7-8)', () => {
  const ENTRIES: Array<[RegExp, string, string | null]> = [
    [/^README\.md/, 'Regeln für Menschen und Agents', null],
    [/^Inbox\//, 'Kandidaten, warten auf Review', '#fbbf24'],
    [/^Repos\//, 'Wissen je Repository, Einstieg index.md', '#38bdf8'],
    [/^Decisions\//, 'Entscheidungen im ADR-Stil', '#a78bfa'],
    [/^Lessons\//, 'Gelerntes aus Fehlern und Reviews', '#34d399'],
    [/^Issues\//, 'Zusammenfassungen nach dem Merge, von Symphony', '#94a3b8'],
    [/^Agents\//, 'Gedächtnis je Rolle', '#f9a8d4'],
  ];
  const rowOf = (section: FakeElement, desc: string): FakeElement => {
    const others = ENTRIES.map(([, d]) => d).filter((d) => d !== desc);
    const hits = section.descendants().filter((e) => text(e).includes(desc) && !others.some((d) => text(e).includes(d)));
    assert.ok(hits.length > 0, desc);
    return hits.reduce((best, e) => (text(e).length > text(best).length ? e : best));
  };

  it('lists the seven entries with path, description and (for the folders) the count', async () => {
    const p = await open();
    const section = sectionOf(p, /^Struktur$/);
    const counts: Record<string, string> = { 'Inbox/': '2', 'Decisions/': '7', 'Lessons/': '5' };
    for (const [pathRe, desc] of ENTRIES) {
      const row = rowOf(section, desc);
      const t = text(row);
      assert.match(t, pathRe, desc);
      const key = Object.keys(counts).find((k) => t.startsWith(k));
      if (key) assert.ok(new RegExp(`(^|\\D)${counts[key]}(\\D|$)`).test(t.slice(key.length)), `${key} count in "${t}"`);
    }
    assert.equal(ENTRIES.filter(([, d]) => text(section).includes(d)).length, 7);
  });

  it('colours the paths per folder', async () => {
    const p = await open();
    const section = sectionOf(p, /^Struktur$/);
    for (const [pathRe, , color] of ENTRIES) {
      if (color === null) continue;
      const el = section.descendants().find((e) => pathRe.test(text(e)) && text(e).length < 30 && hex(e.style.color) !== '');
      assert.ok(el, String(pathRe));
      assert.equal(hex(el.style.color), color, String(pathRe));
    }
  });

  it('uses the row grid minmax(0,1fr) auto, padding 8px 0 and a .06 top line', () => {
    css(/grid-template-columns:minmax\(0,1fr\)auto/);
    css(/padding:8px0/);
    css(/border-top:1pxsolidrgba\(255,255,255,0?\.06\)/);
  });
});

describe('Brain page: write clashes (E7-8)', () => {
  const panel = (p: Page) => sectionOf(p, /^Write-Clashes$/);

  it('shows the card with path, time and the hash text; the footer shows the week balance', async () => {
    const p = await open({ clashes: { clashes: [clash('c1')] } });
    const t = text(panel(p));
    const [a, b] = ['2026-10-30T10:00:00Z', '2026-10-30T10:01:00Z'];
    assert.ok(t.includes('Lessons/x.md'));
    assert.ok(t.includes(`Architect #7 schrieb um ${hm(a)}, Developer #9 um ${hm(b)} mit altem Hash. Der zweite Schreibvorgang wurde abgewiesen;`), t);
    assert.ok(t.includes('Diese Woche: 3 Clashes, 1 gelöst · Schutzfenster 10 min'), t);
    assert.ok(panel(p).querySelector('article.gi'));
  });

  it('closes the sentence with "<Rolle B> hat die aktuelle Fassung zurückbekommen." (role name only, no issue number)', async () => {
    const p = await open({ clashes: { clashes: [clash('c1')] } });
    assert.ok(text(panel(p)).includes('abgewiesen; Developer hat die aktuelle Fassung zurückbekommen.'), text(panel(p)));
  });

  it('gives the window reason with the protection window in minutes', async () => {
    const p = await open({ clashes: { clashes: [clash('c1', { reason: 'window' })] }, vitals: vitals({ clash_window_min: 5 }) });
    assert.ok(text(panel(p)).includes('innerhalb des Schutzfensters von 5 min.'), text(panel(p)));
    assert.ok(!text(panel(p)).includes('mit altem Hash'));
  });

  it('offers "Fassungen vergleichen" (38 px) and "Als gelöst markieren" only with control actions', async () => {
    const p = await open({ clashes: { clashes: [clash('c1')] } });
    const card = panel(p).querySelector('article.gi')!;
    assert.ok(btn(card, 'Fassungen vergleichen')!.classList.contains('ui-btn-38'));
    assert.ok(btn(card, 'Als gelöst markieren')!.classList.contains('ui-btn-38'));
    const off = await open({ clashes: { clashes: [clash('c1')] }, state: dashboardState({ controls: OFF }) });
    const offCard = panel(off).querySelector('article.gi')!;
    assert.ok(btn(offCard, 'Fassungen vergleichen'), 'comparing needs no control rights');
    assert.equal(btn(offCard, 'Als gelöst markieren'), undefined);
  });

  it('opens the comparison of the rejected and the current version', async () => {
    const p = await open({ clashes: { clashes: [clash('c1', { attempted: { content: 'a\nalt\nc' }, current: { content: 'a\nneu\nc' } })] } });
    const card = panel(p).querySelector('article.gi')!;
    btn(card, 'Fassungen vergleichen')!.click();
    await settle();
    const t = text(card);
    assert.ok(t.includes('alt'));
    assert.ok(t.includes('neu'));
  });

  it('marks a clash as resolved through the API', async () => {
    const p = await open({ clashes: { clashes: [clash('c1')] } });
    btn(panel(p).querySelector('article.gi')!, 'Als gelöst markieren')!.click();
    await until(() => p.fetches.some((f) => f.method === 'POST'));
    const post = p.fetches.find((f) => f.method === 'POST')!;
    assert.ok(post.url.includes('/api/v1/brain/clashes/c1/resolve'), post.url);
  });

  it('draws the red border (.35) of the panel, the title in #fca5a5 and the card border .4', () => {
    css(/rgba\(248,113,113,0?\.35\)/);
    css(/#fca5a5/i);
    css(/rgba\(248,113,113,0?\.4\)/);
  });

  it('without open clashes: "Keine offenen Clashes", no red border, footer still shown', async () => {
    const withClash = await open({ clashes: { clashes: [clash('c1')] } });
    const none = await open({ clashes: { clashes: [] } });
    const t = text(panel(none));
    assert.ok(t.includes('Keine offenen Clashes'));
    assert.ok(t.includes('Diese Woche: 3 Clashes, 1 gelöst · Schutzfenster 10 min'));
    assert.equal(panel(none).querySelectorAll('article.gi').length, 0);
    assert.notEqual(panel(none).getAttribute('class'), panel(withClash).getAttribute('class'), 'the red border is tied to open clashes');
    assert.ok(!panel(none).getAttribute('class')!.includes('has-open'));
  });

  it('does not show resolved clashes as open ones', async () => {
    const p = await open({ clashes: { clashes: [clash('c1', { status: 'resolved' })] } });
    assert.ok(text(panel(p)).includes('Keine offenen Clashes'));
    assert.equal(btn(panel(p), 'Als gelöst markieren'), undefined);
  });
});

describe('Brain page: brain disabled (E7-8)', () => {
  const disabled = (url: string): unknown => (url.includes('/brain/') ? { __status: 404, error: { code: 'brain_disabled' } } : dashboardState({ controls: { retry: true } }));

  it('shows the title block, the notice and the docs link, nothing else', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: (url) => disabled(url) });
    await until(() => !p.$('brain-off').hidden);
    await settle();
    assert.equal(text(p.query('h1')[0]!), 'Brain');
    const notice = p.$('brain-off');
    assert.ok(text(notice).includes('Das Brain ist nicht aktiviert (brain.enabled)'), text(notice));
    assert.deepEqual(notice.querySelectorAll('code').map(text), ['brain.enabled']);
    const link = notice.querySelectorAll('a').find((a) => (a.getAttribute('href') ?? '').endsWith('docs/brain.md'));
    assert.ok(link, 'link to docs/brain.md');
    assert.ok(p.$('brain-main').hidden, 'no vitals, review, graph or clashes');
    assert.equal(p.query('a').filter((a) => text(a).startsWith('In Obsidian')).length, 0);
  });

  it('does not keep requesting the graph (no flood of API errors)', async () => {
    const p = renderPage(BRAIN_HTML, undefined, { fetch: (url) => disabled(url) });
    await until(() => !p.$('brain-off').hidden);
    await settle();
    assert.equal(p.fetches.filter((f) => f.url.includes('/brain/graph')).length, 0);
    assert.ok(p.fetches.length <= 5, `${p.fetches.length} requests`);
  });
});
