import assert from 'node:assert/strict';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { ALERTS_JS } from '../src/http/alerts.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { BRAIN_CSS, BRAIN_JS, BRAIN_PANELS_HTML } from '../src/http/overview-brain.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { createFakeDocument, parseHtml, run, type FakeElement } from './helpers/fake-dom.ts';

// E2-9 (#384): independent tests derived from the acceptance criteria (mockup values, markup, filters, 404).
const NOW = Date.parse('2026-10-31T12:00:00Z');
const vitals = {
  notes_by_status: { approved: 1000, candidate: 284, deprecated: 0, none: 0 },
  links: 31, orphans: 5, broken_links: 0, candidates: 4, writes_today: 12, reads_today: 1234567,
  obsidian_url: null as string | null,
  last_commit: { sha: 'abc', at: new Date(NOW - 2 * 3600_000).toISOString(), author: 'x' } as { sha: string; at: string; author: string } | null,
};
type Row = Record<string, unknown>;
const mk = (over: Row = {}): Row => ({ at: '2026-10-31T11:00:00Z', role: 'developer', issue: 'acme/app#331', op: 'read', path_or_query: 'Notes/a.md', purpose: 'Grund', result: 'ok', ...over });

type Answer = { ok: boolean; status: number; body?: unknown } | Error;
function setup(data: { vitals?: unknown; access?: Row[]; clashes?: unknown } = {}, override?: (url: string) => Answer | undefined) {
  const root = parseHtml(BRAIN_PANELS_HTML);
  const fetch = async (url: string) => {
    const o = override?.(url);
    if (o instanceof Error) throw o;
    if (o) return { ok: o.ok, status: o.status, json: async () => o.body ?? {} };
    const body = url.startsWith('/api/v1/brain/vitals') ? (data.vitals ?? vitals)
      : url.startsWith('/api/v1/brain/clashes') ? (data.clashes ?? { clashes: [] })
        : { access: data.access ?? [mk()], next_before: null };
    return { ok: true, status: 200, json: async () => body };
  };
  const ctx = vm.createContext({ document: createFakeDocument(root), fetch, setTimeout: (fn: () => void) => (fn(), 1), clearTimeout: () => {} });
  for (const src of [BASE_JS, ALERTS_JS, BRAIN_JS]) vm.runInContext(src, ctx);
  run(ctx, `Date.now = () => ${NOW}`);
  const $ = (id: string) => root.querySelector(`#${id}`) as FakeElement;
  return { ctx, $, root };
}
const list = (s: ReturnType<typeof setup>) => s.$('brain-access-list');
const chipEls = (s: ReturnType<typeof setup>) => s.$('brain-roles').querySelectorAll('button');
const dot = (b: FakeElement) => String(b.querySelector('.ui-dot')?.style.background ?? '');

/** Declarations of the CSS rule whose selector list contains `sel`, whitespace-normalised. */
function rule(css: string, sel: string): string {
  const flat = css.replace(/\s+/g, ' ');
  const out: string[] = [];
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.split(',').map((x) => x.trim()).includes(sel)) out.push(m[2]!.trim());
  }
  assert.ok(out.length, `no CSS rule for ${sel}`);
  return out.join(' ');
}
const hasDecl = (decls: string, d: string) => assert.ok(decls.replace(/\s+/g, ' ').replace(/ ?, ?/g, ',').includes(d.replace(/ ?, ?/g, ',')), `"${d}" missing in "${decls}"`);

describe('Brain styles from the mockup (inlined in the overview)', () => {
  const page = DASHBOARD_HTML;
  it('is part of the page CSS', () => {
    assert.ok(page.replace(/\s+/g, ' ').includes(BRAIN_CSS.replace(/\s+/g, ' ').trim().slice(0, 80)));
  });
  it('vitals: 2x2 grid with gap 10px and a mono footer that wraps', () => {
    const grid = rule(BRAIN_CSS, '.brain-tiles');
    hasDecl(grid, 'display: grid');
    hasDecl(grid, 'repeat(2, minmax(0, 1fr))');
    hasDecl(grid, 'gap: 10px');
    const foot = rule(BRAIN_CSS, '.brain-foot');
    hasDecl(foot, 'flex-wrap: wrap');
    hasDecl(foot, 'gap: 6px 14px');
    assert.match(foot, /12px var\(--mono\)/);
    assert.match(foot, /var\(--fg-3/);
  });
  it('access panel: flex column with gap 12px; count in mono 12px', () => {
    const p = rule(BRAIN_CSS, '.brain-access');
    hasDecl(p, 'display: flex');
    hasDecl(p, 'flex-direction: column');
    hasDecl(p, 'gap: 12px');
    assert.match(rule(BRAIN_CSS, '#brain-count'), /12px var\(--mono\)/);
  });
  it('search field: min-height 44, radius 14, trough rgba(0,0,0,.25)', () => {
    const s = rule(BRAIN_CSS, '.brain-search');
    hasDecl(s, 'min-height: 44px');
    hasDecl(s, 'border-radius: 14px');
    hasDecl(s, 'rgba(0,0,0,.25)');
  });
  it('day label is sky #7dd3fc', () => {
    assert.match(rule(BRAIN_CSS, '.brain-day'), /color: #7dd3fc/i);
  });
  it('row grid 64px 104px minmax(0, 1fr), gap 4px 12px, padding 11px 8px, top line', () => {
    const r = rule(BRAIN_CSS, '.brain-acc');
    hasDecl(r, 'grid-template-columns: 64px 104px minmax(0,1fr)');
    hasDecl(r, 'gap: 4px 12px');
    hasDecl(r, 'padding: 11px 8px');
    hasDecl(r, 'border-top: 1px solid rgba(255,255,255,.06)');
  });
  it('typography of the row columns', () => {
    assert.match(rule(BRAIN_CSS, '.brain-time'), /12\.5px var\(--mono\)/);
    assert.match(rule(BRAIN_CSS, '.brain-time'), /var\(--fg-2/);
    assert.match(rule(BRAIN_CSS, '.brain-role'), /font-size: 12\.5px/);
    const op = rule(BRAIN_CSS, '.brain-op');
    assert.match(op, /11\.5px var\(--mono\)/);
    hasDecl(op, 'letter-spacing: .06em');
    const name = rule(BRAIN_CSS, '.brain-name');
    assert.match(name, /font-size: 13\.5px/);
    assert.match(name, /font-weight: 500/);
    hasDecl(name, 'overflow-wrap: anywhere');
    const folder = rule(BRAIN_CSS, '.brain-folder');
    assert.match(folder, /font-size: 12px/);
    assert.match(folder, /var\(--fg-3/);
    const purpose = rule(BRAIN_CSS, '.brain-purpose');
    assert.match(purpose, /font-size: 12\.5px/);
    assert.match(purpose, /font-style: italic/);
    assert.match(purpose, /var\(--fg-2/);
    assert.match(rule(BRAIN_CSS, '.brain-purpose.brain-nopurpose'), /color: #7c879b/i);
  });
  it('the sr class exists in the page styles', () => {
    assert.match(DASHBOARD_HTML, /\.sr\b[^{]*\{[^}]*(clip|position: absolute)/);
  });
});

describe('Brain-Vitals: Kacheln, Button, Fußzeile', () => {
  it('formats with de-DE thousands separators in all four tiles and in the footer', async () => {
    const s = setup({ vitals: { ...vitals, links: 12345, orphans: 1000 } });
    await run(s.ctx, 'loadBrain()');
    assert.deepEqual(s.$('brain-tiles').querySelectorAll('.ui-kpi-value').map((e) => e.textContent), ['1.284', '4', '12.345', '1.000']);
    assert.ok(s.$('brain-foot').textContent.includes('1.234.567 Reads'));
  });
  it('colours: Notizen default (fg-strong), amber, sky, violet #c4b5fd', async () => {
    const s = setup();
    await run(s.ctx, 'loadBrain()');
    const colors = s.$('brain-tiles').querySelectorAll('.ui-kpi-value').map((e) => String(e.style.color || ''));
    assert.equal(colors[0], '');
    assert.match(colors[1]!, /^#f(b|a)[0-9a-f]{4}$/i);
    assert.equal(colors[2]!.toLowerCase(), '#7dd3fc');
    assert.equal(colors[3]!.toLowerCase(), '#c4b5fd');
    assert.match(rule(DASHBOARD_HTML, '.ui-kpi-value'), /var\(--fg-strong\)/);
  });
  it('has four tiles in the tiles container and the head contains title and action host', async () => {
    const s = setup();
    await run(s.ctx, 'loadBrain()');
    assert.equal(s.$('brain-tiles').querySelectorAll('.ui-kpi').length, 4);
    const head = s.$('brain-panel').querySelector('.section-head')!;
    assert.ok(head.querySelector('#brain-title'));
    assert.ok(head.querySelector('#brain-obsidian'));
  });
  it('Obsidian button: 36px link with the exact label, http(s) and obsidian:// accepted, hidden otherwise', async () => {
    for (const url of ['https://notes.example/vault', 'obsidian://open?vault=brain']) {
      const s = setup({ vitals: { ...vitals, obsidian_url: url } });
      await run(s.ctx, 'loadBrain()');
      const a = s.$('brain-panel').querySelector('.section-head a')!;
      assert.ok(a, url);
      assert.equal(a.getAttribute('href'), url);
      assert.equal(a.textContent, 'In Obsidian öffnen ↗');
      assert.ok(a.classList.contains('ui-btn-36'));
    }
    for (const url of [null, '', 'javascript:alert(1)']) {
      const s = setup({ vitals: { ...vitals, obsidian_url: url } });
      await run(s.ctx, 'loadBrain()');
      assert.equal(s.$('brain-panel').querySelectorAll('a').length, 0, String(url));
    }
  });
  it('removes the button again when a later load has no obsidian_url', async () => {
    let url: string | null = 'obsidian://open?vault=b';
    const s = setup({}, (u) => (u.startsWith('/api/v1/brain/vitals') ? { ok: true, status: 200, body: { ...vitals, obsidian_url: url } } : undefined));
    await run(s.ctx, 'loadBrain()');
    assert.equal(s.$('brain-panel').querySelectorAll('a').length, 1);
    url = null;
    await run(s.ctx, 'loadBrain()');
    assert.equal(s.$('brain-panel').querySelectorAll('a').length, 0);
  });
  it('footer text: "<n> Writes heute · <n> Reads · letzter Commit vor <Dauer>" without conflicts', async () => {
    const s = setup();
    await run(s.ctx, 'loadBrain()');
    const foot = s.$('brain-foot').textContent.replace(/\s+/g, ' ');
    assert.ok(foot.includes('12 Writes heute'));
    assert.ok(foot.includes('Reads'));
    assert.ok(!/Konflikt/.test(foot));
    assert.match(foot, /letzter Commit vor 2 h/);
    assert.ok(foot.indexOf('Writes') < foot.indexOf('Reads') && foot.indexOf('Reads') < foot.indexOf('Commit'));
  });
  it('footer shows Konflikt/Konflikte between Reads and Commit, "noch kein Commit" without one', async () => {
    const s = setup({ clashes: { clashes: [{}, {}, {}] }, vitals: { ...vitals, last_commit: null } });
    await run(s.ctx, 'loadBrain()');
    const foot = s.$('brain-foot').textContent.replace(/\s+/g, ' ');
    assert.ok(foot.includes('3 Konflikte'));
    assert.ok(foot.includes('noch kein Commit'));
    assert.ok(foot.indexOf('Reads') < foot.indexOf('Konflikte') && foot.indexOf('Konflikte') < foot.indexOf('noch kein Commit'));
  });
  it('footer has no Konflikte when the clash list is empty or the clash call answers 404/500', async () => {
    for (const bad of [{ ok: false, status: 404 }, { ok: false, status: 500 }, new Error('x')] as Answer[]) {
      const s = setup({}, (u) => (u.startsWith('/api/v1/brain/clashes') ? bad : undefined));
      await run(s.ctx, 'loadBrain()');
      assert.equal(s.$('brain-panel').hidden, false);
      assert.ok(!s.$('brain-foot').textContent.includes('Konflikt'));
    }
  });
});

describe('Brain-Zugriffe: Chips, Suche, Zeilen', () => {
  it('chips: Alle (--fg dot) first, profile roles without Docs with their colour dot, Symphony (#94a3b8) last', async () => {
    const s = setup({ access: [mk({ role: 'developer' }), mk({ role: 'docs' }), mk({ role: null }), mk({ role: 'tester' })] });
    run(s.ctx, `brainSetProfile({ pipeline_config: { roles: [{ name: 'analyst' }, { name: 'developer' }, { name: 'docs' }, { name: 'tester' }] } })`);
    await run(s.ctx, 'loadBrain()');
    const chips = chipEls(s);
    const labels = chips.map((c) => c.textContent);
    assert.equal(labels[0], 'Alle');
    assert.equal(labels.at(-1), 'Symphony');
    assert.ok(!labels.some((l) => /docs/i.test(l)));
    assert.deepEqual(labels.slice(1, 4), ['Analyst', 'Developer', 'Tester']);
    assert.equal(dot(chips[0]!)?.toLowerCase(), '#e8eef9');
    assert.equal(dot(chips[1]!)?.toLowerCase(), '#38bdf8');
    assert.equal(dot(chips[2]!)?.toLowerCase(), '#34d399');
    assert.equal(dot(chips.at(-1)!)?.toLowerCase(), '#94a3b8');
    assert.equal(chips.filter((c) => c.getAttribute('aria-pressed') === 'true').length, 1);
    const group = s.$('brain-roles').querySelector('[role=group]')!;
    assert.equal(group.getAttribute('aria-label'), 'Nach Rolle filtern');
  });
  it('exactly one chip stays pressed after every click, including clicking the pressed chip again', async () => {
    const s = setup({ access: [mk({ role: 'developer' }), mk({ role: 'tester' })] });
    run(s.ctx, `brainSetProfile({ pipeline_config: { roles: [{ name: 'developer' }, { name: 'tester' }] } })`);
    await run(s.ctx, 'loadBrain()');
    const pressedN = () => chipEls(s).filter((c) => c.getAttribute('aria-pressed') === 'true').length;
    for (const label of ['Developer', 'Developer', 'Tester', 'Symphony', 'Alle', 'Alle']) {
      chipEls(s).find((c) => c.textContent === label)!.click();
      assert.equal(pressedN(), 1, label);
      assert.equal(chipEls(s).find((c) => c.textContent === label)!.getAttribute('aria-pressed'), 'true', label);
    }
  });
  it('role filter works on loaded rows; the count shows "<gezeigt> von <geladen>"', async () => {
    const s = setup({ access: [mk({ role: 'developer' }), mk({ role: 'developer' }), mk({ role: 'tester' })] });
    run(s.ctx, `brainSetProfile({ pipeline_config: { roles: [{ name: 'developer' }, { name: 'tester' }] } })`);
    await run(s.ctx, 'loadBrain()');
    assert.equal(s.$('brain-count').textContent, '3 von 3');
    chipEls(s).find((c) => c.textContent === 'Tester')!.click();
    assert.equal(list(s).querySelectorAll('li.row').length, 1);
    assert.equal(s.$('brain-count').textContent, '1 von 3');
  });
  it('role and search combine', async () => {
    const s = setup({ access: [mk({ role: 'developer', path_or_query: 'Notes/alpha.md' }), mk({ role: 'tester', path_or_query: 'Notes/alpha2.md' }), mk({ role: 'developer', path_or_query: 'Notes/beta.md' })] });
    run(s.ctx, `brainSetProfile({ pipeline_config: { roles: [{ name: 'developer' }, { name: 'tester' }] } })`);
    await run(s.ctx, 'brainBind(document.getElementById("brain-q")); loadBrain()');
    chipEls(s).find((c) => c.textContent === 'Developer')!.click();
    s.$('brain-q').value = 'ALPHA';
    s.$('brain-q').dispatch('input');
    assert.equal(list(s).querySelectorAll('li.row').length, 1);
    assert.equal(s.$('brain-count').textContent, '1 von 3');
  });
  it('search matches path substring and purpose, ignores case, trims whitespace', async () => {
    const s = setup({ access: [mk({ path_or_query: 'Lessons/Gradle-Tipps.md', purpose: 'Build' }), mk({ path_or_query: 'x.md', purpose: 'Über Docker' }), mk({ path_or_query: 'y.md', purpose: '' })] });
    await run(s.ctx, 'brainBind(document.getElementById("brain-q")); loadBrain()');
    const q = (v: string) => { s.$('brain-q').value = v; s.$('brain-q').dispatch('input'); return list(s).querySelectorAll('li.row').length; };
    assert.equal(q('gradle'), 1);
    assert.equal(q('TIPPS.MD'), 1);
    assert.equal(q('dock'), 1);
    assert.equal(q('  docker  '), 1);
    assert.equal(q('.md'), 3);
    assert.equal(q(''), 3);
    assert.equal(q('nichts'), 0);
  });
  it('search field markup: label wrapping a 16px icon, .sr text, search input with placeholder', () => {
    const root = parseHtml(BRAIN_PANELS_HTML);
    const label = root.querySelector('label')!;
    assert.ok(label);
    const input = label.querySelector('input')!;
    assert.equal(input.getAttribute('type'), 'search');
    assert.equal(input.getAttribute('placeholder'), 'Notiz oder Zweck suchen');
    assert.equal(label.querySelector('.sr')!.textContent, 'Zugriffe durchsuchen');
    const svg = label.querySelector('svg')!;
    assert.equal(svg.getAttribute('width'), '16');
    assert.equal(svg.getAttribute('height'), '16');
    // label is connected to the input (nesting or for/id)
    assert.ok(label.querySelector('input') || label.getAttribute('for') === input.getAttribute('id'));
  });
  it('the access panel has the title "Brain-Zugriffe" and the count in its head', () => {
    const root = parseHtml(BRAIN_PANELS_HTML);
    const head = root.querySelector('#brain-access .section-head')!;
    assert.equal(head.querySelector('h2')!.textContent, 'Brain-Zugriffe');
    assert.ok(head.querySelector('#brain-count'));
    assert.ok(!root.querySelector('#brain-panel')!.querySelector('input'));
  });
  it('day label "Heute · <Wochentag, d. Monat>" in de-DE and .lbl class', async () => {
    const s = setup({ access: [mk()] });
    await run(s.ctx, 'loadBrain()');
    const lbl = list(s).querySelector('.lbl')!;
    assert.equal(lbl.textContent, 'Heute · ' + new Date(NOW).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }));
    assert.match(lbl.textContent, /^Heute · \p{L}+, \d{1,2}\. \p{L}+$/u);
  });
  it('rows of other days get their own label, newest day first, rows in the matching group', async () => {
    const day = 24 * 3600e3;
    const s = setup({ access: [mk({ at: new Date(NOW - 1000).toISOString() }), mk({ at: new Date(NOW - day).toISOString() }), mk({ at: new Date(NOW - 5 * day).toISOString() })] });
    await run(s.ctx, 'loadBrain()');
    const labels = list(s).querySelectorAll('.lbl').map((e) => e.textContent);
    assert.equal(labels.length, 3);
    assert.ok(labels[0]!.startsWith('Heute · '));
    assert.ok(labels[1]!.startsWith('Gestern · '));
    assert.ok(!/^(Heute|Gestern)/.test(labels[2]!));
    assert.equal(list(s).querySelectorAll('li.row').length, 3);
  });
  it('only yesterday rows: Gestern label is shown (and the empty-today state may appear)', async () => {
    const s = setup({ access: [mk({ at: new Date(NOW - 24 * 3600e3).toISOString() })] });
    await run(s.ctx, 'loadBrain()');
    assert.ok(list(s).querySelectorAll('.lbl').some((e) => e.textContent.startsWith('Gestern · ')));
    assert.equal(list(s).querySelectorAll('li.row').length, 1);
  });
  it('row: three columns time | role+issue+op | note+folder+purpose', async () => {
    const s = setup({ access: [mk({ role: 'developer', issue: 'acme/app#331', op: 'write', path_or_query: 'Lessons/x/y.md', purpose: 'Weil' })] });
    await run(s.ctx, 'loadBrain()');
    const row = list(s).querySelector('li.row')!;
    assert.equal(row.children.length, 3);
    const [time, who, note] = row.children as [FakeElement, FakeElement, FakeElement];
    assert.match(time.textContent, /^\d\d:\d\d:\d\d$/);
    assert.equal(who.querySelector('.brain-role')!.textContent, 'Developer #331');
    assert.equal(String(who.querySelector('.brain-role')!.style.color).toLowerCase(), '#34d399');
    assert.equal(dot(who.querySelector('.brain-role')!)?.toLowerCase(), '#34d399');
    assert.equal(who.querySelector('.brain-op')!.textContent, 'WRITE');
    assert.equal(note.querySelector('.brain-name')!.textContent, 'y.md');
    assert.equal(note.querySelector('.brain-folder')!.textContent, 'Lessons/x/');
    const order = note.children.map((c) => c.className.split(' ')[0]);
    assert.deepEqual(order, ['brain-name', 'brain-folder', 'brain-purpose']);
    assert.equal(note.querySelector('.brain-purpose')!.textContent, 'Weil');
  });
  it('role without issue shows just the role name', async () => {
    const s = setup({ access: [mk({ issue: null })] });
    await run(s.ctx, 'loadBrain()');
    assert.equal(list(s).querySelector('.brain-role')!.textContent, 'Developer');
  });
  it('operation colours: READ sky, WRITE amber, SEARCH violet, ABGEWIESEN red, LIST grey, APPEND amber', async () => {
    const ops = ['read', 'write', 'search', 'list', 'append'].map((op) => mk({ op }));
    const s = setup({ access: [...ops, mk({ op: 'write', result: 'rejected', reason: 'window' })] });
    await run(s.ctx, 'loadBrain()');
    const got = Object.fromEntries(list(s).querySelectorAll('.brain-op').map((o) => [o.textContent, String(o.style.color).toLowerCase()]));
    assert.equal(got.READ, '#7dd3fc');
    assert.equal(got.WRITE, '#fbbf24');
    assert.equal(got.APPEND, '#fbbf24');
    assert.equal(got.SEARCH, '#c4b5fd');
    assert.equal(got.LIST, '#94a3b8');
    assert.match(got.ABGEWIESEN!, /^#(f87171|ef4444|fca5a5|f43f5e)$/);
  });
  it('folder: path folder, "Suche" for search, "Inbox/ · Kandidat", "Issues/<repo>/ · approved"', async () => {
    const s = setup({ access: [
      mk({ path_or_query: 'Notes/deep/a.md' }),
      mk({ op: 'search', path_or_query: 'needle' }),
      mk({ path_or_query: 'Inbox/c.md' }),
      mk({ path_or_query: 'Issues/acme-app/7.md' }),
    ] });
    await run(s.ctx, 'loadBrain()');
    assert.deepEqual(list(s).querySelectorAll('.brain-folder').map((e) => e.textContent), ['Notes/deep/', 'Suche', 'Inbox/ · Kandidat', 'Issues/acme-app/ · approved']);
  });
  it('SEARCH note shows the quoted query', async () => {
    const s = setup({ access: [mk({ op: 'search', path_or_query: 'needle' })] });
    await run(s.ctx, 'loadBrain()');
    assert.ok(list(s).querySelector('.brain-name')!.textContent.startsWith('„needle“'));
  });
  it('missing purpose (empty, whitespace, missing) shows "Zweck fehlt", others keep their text', async () => {
    const s = setup({ access: [mk({ purpose: '' }), mk({ purpose: '  ' }), mk({ purpose: undefined }), mk({ purpose: 'echt' })] });
    await run(s.ctx, 'loadBrain()');
    assert.deepEqual(list(s).querySelectorAll('.brain-purpose').map((e) => e.textContent), ['Zweck fehlt', 'Zweck fehlt', 'Zweck fehlt', 'echt']);
    assert.equal(list(s).querySelectorAll('.brain-nopurpose').length, 3);
  });
  it('empty states: no accesses at all vs. no match for filter or search', async () => {
    const empty = setup({ access: [] });
    await run(empty.ctx, 'loadBrain()');
    assert.ok(list(empty).textContent.includes('Noch keine Brain-Zugriffe heute'));
    assert.ok(!list(empty).textContent.includes('Keine Zugriffe für diesen Filter'));
    assert.equal(list(empty).querySelectorAll('li.row').length, 0);

    const s = setup({ access: [mk({ role: 'developer' })] });
    run(s.ctx, `brainSetProfile({ pipeline_config: { roles: [{ name: 'developer' }, { name: 'tester' }] } })`);
    await run(s.ctx, 'brainBind(document.getElementById("brain-q")); loadBrain()');
    chipEls(s).find((c) => c.textContent === 'Tester')!.click();
    assert.ok(list(s).textContent.includes('Keine Zugriffe für diesen Filter'));
    assert.ok(!list(s).textContent.includes('Noch keine Brain-Zugriffe heute'));
    assert.equal(s.$('brain-count').textContent, '0 von 1');
    chipEls(s).find((c) => c.textContent === 'Alle')!.click();
    s.$('brain-q').value = 'zzzz';
    s.$('brain-q').dispatch('input');
    assert.ok(list(s).textContent.includes('Keine Zugriffe für diesen Filter'));
  });
  it('renders agent texts as text, never as markup', async () => {
    const s = setup({ access: [mk({ path_or_query: 'Notes/<img src=x onerror=1>.md', purpose: '<script>x</script>', issue: 'a/b#<b>1' })] });
    await run(s.ctx, 'loadBrain()');
    assert.equal(list(s).querySelectorAll('img, script, b').length, 0);
    assert.ok(list(s).textContent.includes('<script>x</script>'));
  });
});

describe('ohne Brain: beide Panels fehlen', () => {
  const hidden = (s: ReturnType<typeof setup>) => ['brain-row', 'brain-panel', 'brain-access'].every((id) => s.$(id).hidden);
  it('404 only on vitals hides both panels although access answers', async () => {
    const s = setup({}, (u) => (u.startsWith('/api/v1/brain/vitals') ? { ok: false, status: 404, body: { error: { code: 'brain_disabled' } } } : undefined));
    await run(s.ctx, 'loadBrain()');
    assert.ok(hidden(s));
    assert.equal(list(s).querySelectorAll('li').length, 0);
    assert.equal(list(s).textContent.trim(), '');
    assert.equal(s.$('brain-foot').textContent.trim(), '');
  });
  it('404 on everything shows no error text and nothing rendered', async () => {
    const s = setup({}, () => ({ ok: false, status: 404, body: { error: { code: 'brain_disabled' } } }));
    await run(s.ctx, 'loadBrain()');
    assert.ok(hidden(s));
    assert.equal(s.$('brain-tiles').children.length, 0);
    assert.ok(!/fehler|error|nicht/i.test(s.root.textContent.replace(/Notiz oder Zweck suchen/g, '')));
  });
  it('panels are hidden before the first answer (no empty frame on first paint)', () => {
    const s = setup();
    assert.ok(hidden(s));
  });
  it('panels reappear once the Brain answers after having been disabled', async () => {
    let on = false;
    const s = setup({}, (u) => (!on ? { ok: false, status: 404 } : undefined));
    await run(s.ctx, 'loadBrain()');
    assert.ok(hidden(s));
    on = true;
    await run(s.ctx, 'loadBrain()');
    assert.ok(['brain-row', 'brain-panel', 'brain-access'].every((id) => !s.$(id).hidden));
  });
});
