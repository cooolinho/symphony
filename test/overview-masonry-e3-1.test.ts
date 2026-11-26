import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { MASONRY_CSS, MASONRY_GAP_PX, MASONRY_MIN_COL_PX, MASONRY_WIDE_MIN_VIEWPORT_PX } from '../src/http/ui/masonry.ts';
import { TOKENS_CSS } from '../src/http/ui/tokens.ts';
import type { FakeElement } from './helpers/fake-dom.ts';
import { renderPage } from './helpers.ts';
import { dashboardState } from './helpers/page-fixtures.ts';

// E3-1 (#622): independent tests for the overview as a masonry grid. Derived from the acceptance criteria of the issue.
const settle = () => new Promise((r) => setImmediate(r));

// A recording ResizeObserver, installed by a script in front of the page's own scripts. It reports through
// `document.__ro` because the document is the one object of the vm that the test can reach.
const RO_RECORDER = `<script>
document.__ro = { instances: [] };
globalThis.ResizeObserver = class {
  constructor(cb) { this.cb = cb; this.targets = new Set(); document.__ro.instances.push(this); }
  observe(t) { this.targets.add(t); }
  unobserve(t) { this.targets.delete(t); }
  disconnect() { this.targets.clear(); }
};
</script>`;
const NO_RO = `<script>globalThis.ResizeObserver = undefined;</script>`;

interface Recorder { instances: Array<{ targets: Set<FakeElement> }> }
const withScript = (script: string) => DASHBOARD_HTML.replace(/<body[^>]*>/, (m) => m + script);
const recorder = (page: ReturnType<typeof renderPage>) => (page.document as unknown as { __ro: Recorder }).__ro;
// The page has other observers (charts); the masonry one is the one that observes cards of the container.
const masonryObservers = (page: ReturnType<typeof renderPage>) => recorder(page).instances.filter((o) => [...o.targets].some((t) => t.parentElement?.id === 'ov-masonry'));
const observedIds = (page: ReturnType<typeof renderPage>) => {
  const found = masonryObservers(page);
  assert.equal(found.length, 1, 'exactly one ResizeObserver for the cards');
  return [...found[0]!.targets].map((t) => t.id).sort();
};

const CARDS = ['teams-section', 'running-section', 'budget', 'alerts', 'system-panel', 'stats', 'tool-activity', 'brain-panel', 'brain-access', 'activity-section'];
const CORE = ['teams-section', 'budget', 'system-panel', 'stats', 'tool-activity', 'brain-panel', 'brain-access', 'activity-section'];

describe('E3-1 container and cards', () => {
  const page = renderPage(DASHBOARD_HTML, dashboardState());
  const box = page.$('ov-masonry');
  const kids = [...box.children];

  it('the core reading order of the issue holds, #alerts follows the budget, #running-section follows Teams live', () => {
    const ids = kids.map((c) => c.id);
    assert.deepEqual(ids.filter((id) => CORE.includes(id)), CORE);
    assert.equal(ids.indexOf('alerts'), ids.indexOf('budget') + 1);
    assert.equal(ids.indexOf('running-section'), ids.indexOf('teams-section') + 1);
    assert.deepEqual(ids, CARDS);
  });

  it('there is exactly one masonry container and the cards are not nested in another wrapper', () => {
    assert.equal(page.query('.masonry').length, 1);
    for (const id of CARDS) assert.equal(page.$(id).parentElement, box, id);
  });

  it('page head, repositories and the dispatch gate stay above the container, outside of it', () => {
    for (const id of ['repositories', 'dispatch-gate']) {
      const el = page.document.getElementById(id) as FakeElement | null;
      if (el) assert.ok(!box.contains(el), id);
    }
  });

  it('every card is a section whose aria-labelledby names a heading that exists once and sits inside the card', () => {
    for (const card of kids) {
      assert.equal(card.tagName, 'section', card.id);
      const ref = card.getAttribute('aria-labelledby');
      assert.ok(ref, `${card.id} has aria-labelledby`);
      assert.equal(page.query(`#${ref}`).length, 1, `${ref} is unique`);
      const label = page.$(ref!);
      assert.ok(/^h[1-6]$/.test(label.tagName), `${card.id} label is a heading`);
      assert.ok(label.textContent.trim().length > 0, `${card.id} label is not empty`);
      assert.ok(card.contains(label), card.id);
    }
  });

  it('nothing but Teams live and Agent-Aktivität is wide; no other card forces a column count or a span', () => {
    assert.deepEqual(kids.filter((c) => c.classList.contains('wide')).map((c) => c.id), ['teams-section', 'tool-activity']);
    const spans = [...DASHBOARD_HTML.matchAll(/grid-column:\s*span\s*\d/g)];
    assert.equal(spans.length, 1, 'only the .wide rule of the masonry CSS spans columns');
  });

  it('#stats is the section "Kennzahlen · seit Start" and its tiles render inside it', () => {
    const stats = page.$('stats');
    assert.equal(stats.tagName, 'section');
    assert.equal(page.$(stats.getAttribute('aria-labelledby')!).textContent.trim(), 'Kennzahlen · seit Start');
    const tiles = stats.querySelectorAll('.stat');
    assert.ok(tiles.length >= 4, 'tiles inside the section');
    assert.ok(tiles.some((t) => /Running/.test(t.textContent)));
  });

  it('the Agent activity card (the former .lower) has an id and keeps its feed', () => {
    const card = page.$('activity-section');
    assert.ok(card.contains(page.$('feed')));
    assert.equal(page.$('activity-title').textContent, 'Agent activity');
  });

  it('the budget card keeps its title text and its link to /stats', () => {
    const budget = page.$('budget');
    assert.equal(page.$('budget-title').textContent.trim(), 'Context-Budget · heute');
    assert.ok(budget.querySelectorAll('a').some((a) => a.getAttribute('href') === '/stats'));
  });
});

describe('E3-1 old wrappers are gone', () => {
  it('neither markup, CSS nor script of the overview mention .ov-row, .brain-row, .lower or #brain-row', () => {
    assert.doesNotMatch(DASHBOARD_HTML, /ov-row|brain-row|\.lower\b|class="lower"|class="[^"]*\blower\b/);
  });

  it('no source file under src/http styles or scripts them either', () => {
    const dir = path.join(import.meta.dirname, '..', 'src', 'http');
    const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));
    const hits = files.filter((f) => /\.ov-row|\.brain-row|brain-row|\.lower \{|class="lower"/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    assert.deepEqual(hits, []);
  });

  it('the DOM has none of the old classes or ids', () => {
    const page = renderPage(DASHBOARD_HTML, dashboardState());
    assert.deepEqual(page.query('.ov-row, .brain-row, .lower, #brain-row'), []);
  });
});

describe('E3-1 masonry wiring', () => {
  it('MASONRY_CSS is part of the page styles and comes after the overview CSS, MASONRY_JS is inlined once', () => {
    const at = DASHBOARD_HTML.indexOf(MASONRY_CSS);
    assert.ok(at > 0);
    assert.equal(DASHBOARD_HTML.split(MASONRY_CSS).length - 1, 1);
    assert.ok(at > DASHBOARD_HTML.indexOf('.budget {'), 'the grid rules come after the card rules');
    assert.equal(DASHBOARD_HTML.split('function masonryMount(').length - 1, 1);
  });

  it('the grid rules of the container: auto-fill columns of min(380px, 100%), wide spans two columns from 1220px', () => {
    assert.equal(MASONRY_MIN_COL_PX, 380);
    assert.match(MASONRY_CSS, /repeat\(auto-fill, minmax\(min\(380px, 100%\), 1fr\)\)/);
    assert.match(MASONRY_CSS, new RegExp(`@media \\(min-width: ${MASONRY_WIDE_MIN_VIEWPORT_PX}px\\)[\\s\\S]*\\.masonry > \\.wide \\{ grid-column: span 2; \\}`));
    assert.equal(MASONRY_WIDE_MIN_VIEWPORT_PX, 1220);
  });

  it('mounts after the first render: one observer, masonry-on, every visible card observed, hidden cards not', () => {
    const page = renderPage(withScript(RO_RECORDER), dashboardState());
    assert.ok(page.$('ov-masonry').classList.contains('masonry-on'));
    assert.equal(page.$('brain-panel').hidden, true);
    assert.equal(page.$('brain-access').hidden, true);
    assert.deepEqual(observedIds(page), CARDS.filter((id) => !id.startsWith('brain-')).sort());
  });

  it('does not mount twice: further polls reuse the one observer', () => {
    const page = renderPage(withScript(RO_RECORDER), dashboardState());
    for (let i = 0; i < 3; i++) page.render(dashboardState({ generated_at: new Date(Date.now() + i * 1000).toISOString() }));
    const before = recorder(page).instances.length;
    for (let i = 0; i < 3; i++) page.render(dashboardState());
    assert.equal(recorder(page).instances.length, before);
    assert.equal(masonryObservers(page).length, 1);
  });

  it('a card that becomes visible is observed after the next poll, a card that becomes hidden is released', () => {
    const page = renderPage(withScript(RO_RECORDER), dashboardState());
    page.$('brain-panel').hidden = false;
    page.render(dashboardState());
    assert.ok(observedIds(page).includes('brain-panel'));
    page.$('brain-panel').hidden = true;
    page.$('alerts').hidden = true;
    page.render(dashboardState());
    const ids = observedIds(page);
    assert.ok(!ids.includes('brain-panel'));
    assert.ok(!ids.includes('alerts'));
    assert.ok(ids.includes('budget'));
  });

  it('a card added to the container is picked up after the next poll', () => {
    const page = renderPage(withScript(RO_RECORDER), dashboardState());
    const extra = page.document.createElement('section');
    extra.id = 'late-card';
    page.$('ov-masonry').appendChild(extra);
    page.render(dashboardState());
    assert.ok(observedIds(page).includes('late-card'));
  });

  it('the Brain cards are observed once the Brain answers (visibility change outside of a poll)', async () => {
    const vitals = {
      notes_by_status: { candidate: 1, approved: 2, deprecated: 0, none: 0 }, links: { total: 3, per_note: 1 }, orphans: 0, broken_links: 0,
      candidates: 1, writes_today: 1, reads_today: { total: 2, by_folder: [] }, last_commit: null,
    };
    const fetch = (url: string): unknown => {
      if (url.startsWith('/api/v1/brain/vitals')) return vitals;
      if (url.startsWith('/api/v1/brain/clashes')) return { clashes: [] };
      if (url.startsWith('/api/v1/brain/access')) return { access: [], next_before: null };
      return dashboardState();
    };
    const page = renderPage(withScript(RO_RECORDER), dashboardState(), { fetch });
    await settle();
    await settle();
    assert.equal(page.$('brain-panel').hidden, false);
    assert.equal(page.$('brain-access').hidden, false);
    const ids = observedIds(page);
    assert.ok(ids.includes('brain-panel') && ids.includes('brain-access'), ids.join());
  });

  it('without Brain both Brain cards stay hidden individually and are not observed', async () => {
    const fetch = (url: string): unknown => (url.startsWith('/api/v1/brain/') ? { __status: 404, error: { code: 'brain_disabled' } } : dashboardState());
    const page = renderPage(withScript(RO_RECORDER), dashboardState(), { fetch });
    await settle();
    await settle();
    assert.equal(page.$('brain-panel').hidden, true);
    assert.equal(page.$('brain-access').hidden, true);
    assert.deepEqual(observedIds(page).filter((id) => id.startsWith('brain-')), []);
  });

  it('a failing /state fetch (catch path) still mounts, shows the alert card and does not throw', async () => {
    const fetch = (url: string): unknown => {
      if (url.startsWith('/api/v1/state')) throw new Error('down');
      return { __status: 404, error: { code: 'x' } };
    };
    const page = renderPage(withScript(RO_RECORDER), undefined, { fetch });
    await settle();
    await settle();
    assert.ok(page.$('ov-masonry').classList.contains('masonry-on'));
    assert.ok(observedIds(page).includes('alerts'));
  });

  it('without ResizeObserver the page renders without error and stays a plain grid with all cards in place', () => {
    const page = renderPage(withScript(NO_RO), dashboardState());
    page.render(dashboardState());
    const box = page.$('ov-masonry');
    assert.ok(!box.classList.contains('masonry-on'));
    assert.deepEqual([...box.children].map((c) => c.id), CARDS);
    assert.ok(page.$('stats-tiles') || page.$('stats'));
    assert.ok(page.$('alerts-list').children.length > 0);
  });

  it('the overview still polls /api/v1/state every 2 s', () => {
    const page = renderPage(DASHBOARD_HTML, dashboardState());
    assert.ok(page.intervals.length > 0 || /pollEvery\(load, 2000\)/.test(DASHBOARD_HTML));
    assert.match(DASHBOARD_HTML, /pollEvery\(load, 2000\)/);
  });
});

describe('E3-1 empty states are one line inside their card', () => {
  const page = renderPage(DASHBOARD_HTML, dashboardState({ issues: [], counts: { ...dashboardState().counts, running: 0 } }));

  it('Running: the empty state is a single paragraph in the running card, not a block of its own', () => {
    const empty = page.$('issues-empty');
    assert.equal(empty.hidden, false);
    assert.equal(empty.tagName, 'p');
    assert.ok(page.$('running-section').contains(empty));
    assert.match(empty.textContent, /No agents running/);
    assert.ok(![...page.$('ov-masonry').children].some((c) => c.id === 'issues-empty'));
  });

  it('Alerts: "Alles ruhig" is one list item in the alerts card', () => {
    const lis = page.$('alerts').querySelectorAll('li');
    assert.equal(lis.length, 1);
    assert.equal(lis[0]!.textContent, 'Alles ruhig');
  });

  it('no empty-state style draws a dashed full-width block any more', () => {
    assert.doesNotMatch(DASHBOARD_HTML, /\.agents-empty \{[^}]*(dashed|border:|padding: 2\d)/);
    assert.doesNotMatch(DASHBOARD_HTML, /class="cursor"/);
  });
});

describe('E3-1 reduced motion', () => {
  it('the reduced-motion media query switches animations and transitions off for everything, equalizer included', () => {
    const css = DASHBOARD_HTML;
    const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{([^}]*)\}/);
    assert.ok(block, 'global reduced-motion rule');
    assert.match(block![1]!, /animation: none !important/);
    assert.match(block![1]!, /transition: none !important/);
    assert.match(TOKENS_CSS, /\.eq i \{[^}]*animation:/);
    assert.ok(css.includes('.eq i {'), 'the equalizer rules are still on the page');
  });

  it('the masonry CSS adds no transition or animation of its own', () => {
    assert.doesNotMatch(MASONRY_CSS, /transition|animation|@keyframes/);
  });
});

describe('E3-1 column count from the CSS (390 / 1440 / 1920 / 2560 px)', () => {
  const edge = (width: number) => {
    const base = Number(TOKENS_CSS.match(/--edge:\s*(\d+)px/)![1]);
    const small = Number(TOKENS_CSS.match(/@media \(max-width: 640px\) \{\s*:root \{ --edge: (\d+)px/)![1]);
    return width <= 640 ? small : base;
  };
  // auto-fill: n tracks of at least min(380, 100%) with a 16 px gap fit into the container width.
  const columns = (viewport: number) => {
    const inner = viewport - 2 * edge(viewport);
    const min = Math.min(MASONRY_MIN_COL_PX, inner);
    return Math.max(1, Math.floor((inner + MASONRY_GAP_PX) / (min + MASONRY_GAP_PX)));
  };

  for (const [width, cols] of [[390, 1], [1440, 3], [1920, 4], [2560, 6]] as const) {
    it(`${width} px gives ${cols} column(s)`, () => assert.equal(columns(width), cols));
  }

  it('the shell has no max-width that would cap the container', () => {
    assert.match(DASHBOARD_HTML, /\.shell-main \{ max-width: none;/);
  });
});

describe('E3-1 screenshots', () => {
  const dir = path.join(import.meta.dirname, '..', 'docs', 'screenshots');
  for (const width of [390, 1440, 1920, 2560]) {
    it(`masonry-e3-1-overview-${width}.png is a PNG of ${width} px width`, () => {
      const buf = fs.readFileSync(path.join(dir, `masonry-e3-1-overview-${width}.png`));
      assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG');
      assert.equal(buf.readUInt32BE(16), width);
      assert.ok(buf.readUInt32BE(20) > 600, 'a full page, not an empty frame');
    });
  }
});
