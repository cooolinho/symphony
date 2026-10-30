import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { ICONS_JS } from '../src/http/icons.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { COMPONENTS_CSS, COMPONENTS_JS } from '../src/http/ui/components.ts';
import { CHIP_TONES } from '../src/http/ui/palette.ts';
import { TOKENS_CSS } from '../src/http/ui/tokens.ts';
import { FakeElement, createDocument, domContext, run } from './helpers/fake-dom.ts';

const ctx = domContext(BASE_JS);
const make = (code: string): FakeElement => run(ctx, code);
const first = (root: FakeElement, cls: string): FakeElement | undefined => root.byClass(cls)[0];
const has = (e: FakeElement, ...cls: string[]): boolean => cls.every((c) => e.classList.contains(c));

/** Rule bodies of COMPONENTS_CSS whose selector list contains exactly the given selector (whitespace normalised). */
function rule(selector: string): string {
  const src = COMPONENTS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.split(',').some((s) => s.trim().replace(/\s+/g, ' ') === selector)) out.push(m[2]!.replace(/\s+/g, ' '));
  }
  assert.ok(out.length, `rule ${selector}`);
  return out.join(';');
}

describe('fake DOM helper', () => {
  it('joins text, clears children, returns null for missing attributes and fires listeners', () => {
    const doc = createDocument();
    const a = doc.createElement('div');
    a.append('x', doc.createElement('b'));
    a.children[0]!.textContent = 'y';
    assert.equal(a.textContent, 'xy');
    a.textContent = 'z';
    assert.equal(a.children.length, 0);
    assert.equal(a.getAttribute('nope'), null);
    let clicks = 0;
    const keys: string[] = [];
    a.addEventListener('click', () => clicks++);
    a.addEventListener('keydown', (e) => keys.push((e as { key: string }).key));
    a.click();
    a.dispatch('keydown', { key: 'End' });
    assert.equal(clicks, 1);
    assert.deepEqual(keys, ['End']);
    a.focus();
    assert.equal(FakeElement.active, a);
    a.tabIndex = 0;
    assert.equal(a.getAttribute('tabindex'), '0');
    assert.throws(() => { a.innerHTML = '<b>'; });
    assert.throws(() => { a.outerHTML = '<b>'; });
    assert.throws(() => a.insertAdjacentHTML());
  });
});

describe('UI components wiring', () => {
  it('are part of BASE_JS, TOKENS_CSS and every page', () => {
    assert.ok(BASE_JS.includes(ICONS_JS));
    assert.ok(BASE_JS.includes(COMPONENTS_JS));
    assert.ok(BASE_JS.indexOf(ICONS_JS) < BASE_JS.indexOf(COMPONENTS_JS));
    assert.ok(TOKENS_CSS.includes(COMPONENTS_CSS));
    for (const html of [DASHBOARD_HTML, AGENT_HTML, LOGS_HTML]) {
      assert.ok(html.includes('function kpi('));
      assert.ok(html.includes('function icon('));
      assert.ok(html.includes('.ui-bar-forecast'));
    }
    for (const fn of ['card', 'kpi', 'bar', 'stackedBar', 'chip', 'filterChip', 'filterGroup', 'button', 'segmented', 'tabs',
      'sparkline', 'ring', 'avatar', 'eq', 'icon']) assert.equal(run(ctx, `typeof ${fn}`), 'function', fn);
    for (const old of ['statTile', 'progressBar', 'ringGauge']) assert.equal(run(ctx, `typeof ${old}`), 'undefined', old);
  });
});

describe('card', () => {
  it('renders title, meta and body', () => {
    const c = make('card({ title: "Runs", meta: "last 24h", body: document.createElement("p") })');
    assert.equal(c.tagName, 'article');
    assert.ok(has(c, 'ui-card', 'g'));
    assert.equal(first(c, 'ui-card-title')!.tagName, 'h3');
    assert.equal(first(c, 'ui-card-title')!.textContent, 'Runs');
    assert.equal(first(c, 'ui-card-meta')!.textContent, 'last 24h');
    assert.equal(first(c, 'ui-card-body')!.children[0]!.tagName, 'p');
  });
  it('omits head and body when empty', () => {
    assert.equal(make('card({ body: "x" })').byClass('ui-card-head').length, 0);
    assert.equal(make('card({ title: "t" })').byClass('ui-card-body').length, 0);
  });
});

describe('chip', () => {
  it('tints from one colour: light text, border c at .4, ground c at .1, dot in front', () => {
    const c = make('chip("LIVE", { tone: "green", dot: "#34d399" })');
    assert.equal(c.tagName, 'span');
    assert.ok(has(c, 'ui-chip'));
    assert.equal(c.style.color, '#6ee7b7');
    assert.equal(c.style.borderColor, 'rgba(52,211,153,.4)');
    assert.equal(c.style.background, 'rgba(52,211,153,.1)');
    assert.ok(has(c.children[0]!, 'ui-dot'));
    assert.equal(c.children[0]!.style.background, '#34d399');
    assert.equal(c.textContent, 'LIVE');
  });
  it('takes a hex tone, dot: true uses the tone colour, mono adds the class, nonsense is ignored', () => {
    const h = make('chip("x", { tone: "#fbbf24", dot: true })');
    assert.equal(h.style.color, '#fbbf24');
    assert.equal(h.style.borderColor, 'rgba(251,191,36,.4)');
    assert.equal(h.children[0]!.style.background, '#fbbf24');
    assert.ok(has(make('chip("x", { mono: true })'), 'ui-chip', 'mono'));
    const bad = make('chip("x", { tone: "<img>", dot: "red" })');
    assert.equal(bad.style.color, undefined);
    assert.equal(bad.byClass('ui-dot').length, 0);
    const plain = make('chip("x")');
    assert.equal(plain.style.background, undefined);
    assert.equal(plain.children.length, 1);
  });
  it('CSS: padding 3×10, radius 999, 12 px, nowrap, border .12 and ground .05, 8 px dot', () => {
    const css = rule('.ui-chip');
    for (const v of ['padding: 3px 10px', 'border-radius: 999px', 'font-size: 12px', 'white-space: nowrap',
      'background: rgba(255, 255, 255, .05)', 'border: 1px solid rgba(255, 255, 255, .12)']) assert.ok(css.includes(v), v);
    assert.match(rule('.ui-dot'), /width: 8px; height: 8px/);
  });
});

describe('button', () => {
  it('is a real button of size 44 by default; 40 / 38 / 36 and the tones add classes', () => {
    const b = make('button("Pause")');
    assert.equal(b.tagName, 'button');
    assert.equal(b.getAttribute('type'), 'button');
    assert.equal(b.className, 'ui-btn');
    assert.equal(b.textContent, 'Pause');
    for (const s of [40, 38, 36]) assert.ok(has(make(`button("x", { size: ${s} })`), 'ui-btn-' + s));
    assert.equal(make('button("x", { size: 12 })').className, 'ui-btn');
    for (const t of ['approve', 'danger', 'obsidian']) assert.ok(has(make(`button("x", { tone: "${t}" })`), 'ui-btn-' + t));
    assert.equal(make('button("x", { tone: "evil" })').className, 'ui-btn');
  });
  it('an icon button needs an aria-label, the icon is aria-hidden', () => {
    assert.throws(() => make('button(null, { icon: icon("refresh") })'), /ariaLabel/);
    assert.throws(() => make('button("", { icon: icon("refresh") })'), /ariaLabel/);
    const b = make('button(null, { icon: icon("refresh"), ariaLabel: "Refresh" })');
    assert.equal(b.getAttribute('aria-label'), 'Refresh');
    assert.ok(has(b, 'is-icon'));
    assert.equal(b.children[0]!.tagName, 'svg');
    assert.equal(b.children[0]!.getAttribute('aria-hidden'), 'true');
  });
  it('href makes a link styled as a button; external links open in a new tab; onClick runs on click', () => {
    const ext = make('button("Open", { href: "https://github.com/x" })');
    assert.equal(ext.tagName, 'a');
    assert.ok(has(ext, 'ui-btn'));
    assert.equal(ext.getAttribute('target'), '_blank');
    assert.equal(ext.getAttribute('rel'), 'noopener noreferrer');
    const local = make('button("Logs", { href: "/logs" })');
    assert.equal(local.getAttribute('href'), '/logs');
    assert.equal(local.getAttribute('target'), null);
    assert.equal(make('button("x", { href: "javascript:alert(1)" })').tagName, 'button');
    ctx.hits = 0;
    make('button("x", { onClick: () => hits++ })').click();
    assert.equal(ctx.hits, 1);
  });
  it('CSS: 44 px high and wide, pill, border .14, ground .06, hover .12 and the three tones', () => {
    const css = rule('.ui-btn');
    for (const v of ['min-height: 44px', 'min-width: 44px', 'border-radius: 999px', 'border: 1px solid rgba(255, 255, 255, .14)',
      'background: rgba(255, 255, 255, .06)']) assert.ok(css.includes(v), v);
    assert.ok(rule('.ui-btn:hover').includes('background: rgba(255, 255, 255, .12)'));
    assert.match(rule('.ui-btn.ui-btn-40'), /min-height: 40px/);
    assert.match(rule('.ui-btn.ui-btn-38'), /min-height: 38px/);
    assert.match(rule('.ui-btn.ui-btn-36'), /min-height: 36px/);
    assert.match(rule('.ui-btn.ui-btn-approve'), /color: var\(--green-100\); border-color: rgba\(52, 211, 153, 0?\.5\)/);
    assert.match(rule('.ui-btn.ui-btn-danger'), /color: var\(--red-200\)/);
    const ob = rule('.ui-btn.ui-btn-obsidian');
    for (const v of [/background: rgba\(167, 139, 250, 0?\.18\)/, /border-color: rgba\(167, 139, 250, 0?\.55\)/, /color: var\(--violet-100\)/]) assert.match(ob, v);
    assert.match(TOKENS_CSS, /--green-100: #d1fae5;/);
    assert.match(TOKENS_CSS, /--red-200: #fecaca;/);
    assert.match(TOKENS_CSS, /--violet-100: #ede9fe;/);
  });
});

describe('filterChip', () => {
  it('is a button with aria-pressed that toggles and reports the new state', () => {
    ctx.seen = [];
    const b = make('filterChip("Developer", { color: "#34d399", pressed: true, onClick: (on, el) => seen.push([on, el]) })');
    assert.equal(b.tagName, 'button');
    assert.equal(b.getAttribute('type'), 'button');
    assert.equal(b.getAttribute('aria-pressed'), 'true');
    assert.ok(has(b.children[0]!, 'ui-dot'));
    assert.equal(first(b, 'ui-fchip-text')!.textContent, 'Developer');
    b.click();
    assert.equal(b.getAttribute('aria-pressed'), 'false');
    assert.equal(ctx.seen[0][0], false);
    assert.equal(ctx.seen[0][1], b);
    const plain = make('filterChip("All")');
    assert.equal(plain.getAttribute('aria-pressed'), 'false');
    assert.equal(plain.byClass('ui-dot').length, 0);
    assert.doesNotThrow(() => plain.click());
  });
  it('a group is role=group with an aria-label', () => {
    const g = make('filterGroup("Filter by role", [filterChip("A"), filterChip("B")])');
    assert.equal(g.getAttribute('role'), 'group');
    assert.equal(g.getAttribute('aria-label'), 'Filter by role');
    assert.equal(g.children.length, 2);
  });
  it('CSS: 36 px high, 12.5 px / 500; pressed is sky .16 / .55 / #e0f2fe', () => {
    const css = rule('.ui-fchip');
    assert.ok(css.includes('min-height: 36px'));
    assert.ok(css.includes('font: 500 12.5px'));
    const on = rule('.ui-fchip[aria-pressed="true"]');
    assert.match(on, /background: rgba\(125, 211, 252, 0?\.16\)/);
    assert.match(on, /border-color: rgba\(125, 211, 252, 0?\.55\)/);
    assert.match(on, /color: var\(--sky-100\)/);
    assert.match(TOKENS_CSS, /--sky-100: #e0f2fe;/);
  });
});

describe('segmented', () => {
  it('marks the active option with aria-pressed, shows counts and switches on click', () => {
    ctx.changes = [];
    const s = make('segmented([{ value: "all", label: "All", count: 12 }, { value: "code", label: "Code" }], "all", (v) => changes.push(v), "Show")');
    assert.ok(has(s, 'ui-seg'));
    assert.equal(s.getAttribute('role'), 'group');
    assert.equal(s.getAttribute('aria-label'), 'Show');
    const [a, b] = s.children;
    for (const x of [a!, b!]) {
      assert.equal(x.tagName, 'button');
      assert.equal(x.getAttribute('type'), 'button');
    }
    assert.equal(a!.getAttribute('aria-pressed'), 'true');
    assert.equal(b!.getAttribute('aria-pressed'), 'false');
    const count = first(a!, 'ui-seg-count')!;
    assert.ok(has(count, 'mono'));
    assert.equal(count.textContent, '12');
    assert.equal(b!.byClass('ui-seg-count').length, 0);
    b!.click();
    assert.equal(a!.getAttribute('aria-pressed'), 'false');
    assert.equal(b!.getAttribute('aria-pressed'), 'true');
    assert.deepEqual([...ctx.changes], ['code']);
  });
  it('CSS: trough .28 with padding and gap 4, buttons 44 px, active white .92 on #0b1220, count mono 12 px at .75', () => {
    const root = rule('.ui-seg');
    for (const v of ['background: rgba(0, 0, 0, .28)', 'padding: 4px', 'gap: 4px']) assert.ok(root.includes(v), v);
    assert.ok(rule('.ui-seg-btn').includes('min-height: 44px'));
    const on = rule('.ui-seg-btn[aria-pressed="true"]');
    assert.ok(on.includes('background: rgba(255, 255, 255, .92)'));
    assert.ok(on.includes('color: var(--ink-text)'));
    assert.match(TOKENS_CSS, /--ink-text: #0b1220;/);
    const c = rule('.ui-seg-count');
    assert.ok(c.includes('font-size: 12px') && c.includes('opacity: .75'));
  });
});

describe('tabs', () => {
  const build = () => {
    ctx.tabChanges = [];
    return make('tabs([{ id: "overview", label: "Overview" }, { id: "sessions", label: "Sessions", count: 3 }, { id: "logs", label: "Logs" }], "overview", (id) => tabChanges.push(id))');
  };
  const state = (t: FakeElement) => t.children.map((x) => `${x.getAttribute('aria-selected')}/${x.getAttribute('tabindex')}`);

  it('is a tablist of tab buttons with aria-selected and a roving tabindex', () => {
    const t = build();
    assert.equal(t.getAttribute('role'), 'tablist');
    for (const x of t.children) {
      assert.equal(x.tagName, 'button');
      assert.equal(x.getAttribute('role'), 'tab');
      assert.equal(x.getAttribute('type'), 'button');
    }
    assert.deepEqual(state(t), ['true/0', 'false/-1', 'false/-1']);
    assert.equal(t.children[1]!.getAttribute('data-id'), 'sessions');
    assert.equal(first(t.children[1]!, 'ui-tab-count')!.textContent, '3');
  });
  it('arrow keys, Home and End move the selection and the focus', () => {
    const t = build();
    const [a, b, c] = t.children;
    t.dispatch('keydown', { key: 'ArrowRight', target: a });
    assert.deepEqual(state(t), ['false/-1', 'true/0', 'false/-1']);
    assert.equal(FakeElement.active, b);
    t.dispatch('keydown', { key: 'ArrowLeft', target: b });
    t.dispatch('keydown', { key: 'ArrowLeft', target: a });
    assert.deepEqual(state(t), ['false/-1', 'false/-1', 'true/0']);
    assert.equal(FakeElement.active, c);
    t.dispatch('keydown', { key: 'ArrowRight', target: c });
    assert.equal(FakeElement.active, a);
    t.dispatch('keydown', { key: 'End', target: a });
    assert.equal(FakeElement.active, c);
    t.dispatch('keydown', { key: 'Home', target: c });
    assert.equal(FakeElement.active, a);
    t.dispatch('keydown', { key: 'Enter', target: a });
    assert.deepEqual([...ctx.tabChanges], ['sessions', 'overview', 'logs', 'overview', 'logs', 'overview']);
  });
  it('a click selects the tab; an unknown active selects the first', () => {
    const t = build();
    t.children[2]!.click();
    assert.deepEqual(state(t), ['false/-1', 'false/-1', 'true/0']);
    assert.deepEqual([...ctx.tabChanges], ['logs']);
    assert.equal(make('tabs([{ id: "a" }, { id: "b" }], "zz")').children[0]!.getAttribute('aria-selected'), 'true');
  });
  it('CSS: active is white on rgba(255,255,255,.12)', () => {
    const on = rule('.ui-tab[aria-selected="true"]');
    assert.ok(on.includes('background: rgba(255, 255, 255, .12)'));
    assert.ok(on.includes('color: var(--fg-strong)'));
    assert.ok(rule('.ui-tab').includes('min-height: 44px'));
  });
});

describe('trafficTone', () => {
  it('is green below 80, amber from 80, red from 95 and null for anything not finite', () => {
    const tone = (v: string) => run(ctx, `trafficTone(${v})`);
    assert.equal(tone('0'), 'green');
    assert.equal(tone('79.9'), 'green');
    assert.equal(tone('80'), 'amber');
    assert.equal(tone('94.9'), 'amber');
    assert.equal(tone('95'), 'red');
    assert.equal(tone('120'), 'red');
    for (const bad of ['null', 'undefined', 'NaN', 'Infinity', '"90"']) assert.equal(tone(bad), null, bad);
  });
  it('UI_TRAFFIC holds the chip tone colours', () => {
    assert.deepEqual({ ...run(ctx, 'UI_TRAFFIC') }, { green: CHIP_TONES.green.c, amber: CHIP_TONES.amber.c, red: CHIP_TONES.red.c });
  });
});

describe('kpi', () => {
  it('renders value (mono), label and sub line in a .gi tile', () => {
    const k = make('kpi(14, "Code commits", { sub: "today", color: "#fbbf24" })');
    assert.ok(has(k, 'ui-kpi', 'gi'));
    const v = first(k, 'ui-kpi-value')!;
    assert.ok(has(v, 'mono'));
    assert.equal(v.textContent, '14');
    assert.equal(v.style.color, '#fbbf24');
    assert.equal(first(k, 'ui-kpi-label')!.textContent, 'Code commits');
    assert.equal(first(k, 'ui-kpi-sub')!.textContent, 'today');
  });
  it('null shows a dash, sizes 26 / 28 add classes, a bad colour is ignored', () => {
    const k = make('kpi(null, "x", { color: "red" })');
    assert.equal(first(k, 'ui-kpi-value')!.textContent, '—');
    assert.equal(first(k, 'ui-kpi-value')!.style.color, undefined);
    assert.equal(k.byClass('ui-kpi-sub').length, 0);
    assert.equal(first(make('kpi(0, "x")'), 'ui-kpi-value')!.textContent, '0');
    assert.ok(has(make('kpi(1, "x", { size: 26 })'), 'ui-kpi-26'));
    assert.ok(has(make('kpi(1, "x", { size: 28 })'), 'ui-kpi-28'));
    assert.equal(make('kpi(1, "x", { size: 99 })').className, 'ui-kpi gi');
  });
  it('CSS: padding 12×14, value mono 24 (26 / 28), label 12.5–13 px --fg-2, sub 12 px --fg-3', () => {
    assert.ok(rule('.ui-kpi').includes('padding: 12px 14px'));
    assert.match(rule('.ui-kpi-value'), /var\(--fs-kpi-24\)[^;]*var\(--mono\)/);
    assert.match(rule('.ui-kpi-26 .ui-kpi-value'), /--fs-kpi-26/);
    assert.match(rule('.ui-kpi-28 .ui-kpi-value'), /--fs-kpi-28/);
    assert.match(rule('.ui-kpi-label'), /font-size: 12\.5px; color: var\(--fg-2\)/);
    assert.match(rule('.ui-kpi-26 .ui-kpi-label'), /font-size: 13px/);
    assert.match(rule('.ui-kpi-sub'), /font-size: 12px; color: var\(--fg-3\)/);
  });
});

describe('bar', () => {
  it('draws fill, hatched forecast from pct and a marker; exposes progressbar ARIA', () => {
    const b = make('bar(62, { height: 10, color: "#34d399", forecastPct: 25, marker: { pct: 80, title: "Auto-compact" } })');
    assert.equal(b.getAttribute('role'), 'progressbar');
    assert.equal(b.getAttribute('aria-valuenow'), '62');
    assert.equal(b.getAttribute('aria-valuemin'), '0');
    assert.equal(b.getAttribute('aria-valuemax'), '100');
    assert.ok(has(b, 'ui-bar', 'ui-bar-h10', 'has-mark'));
    const [fill, fc, mark] = b.children;
    assert.ok(has(fill!, 'ui-bar-fill'));
    assert.equal(fill!.style.width, '62%');
    assert.equal(fill!.style.background, '#34d399');
    assert.ok(has(fc!, 'ui-bar-forecast'));
    assert.equal(fc!.style.left, '62%');
    assert.equal(fc!.style.width, '25%');
    assert.equal(fc!.style.getPropertyValue('--hatch'), 'rgba(52,211,153,.45)');
    assert.ok(has(mark!, 'ui-bar-mark'));
    assert.equal(mark!.style.left, '80%');
    assert.equal(mark!.getAttribute('title'), 'Auto-compact');
  });
  it('has no hatch without a forecast and no marker without one', () => {
    const b = make('bar(40)');
    assert.equal(b.children.length, 1);
    assert.ok(has(b, 'ui-bar-h8'));
    assert.ok(!has(b, 'has-mark'));
    for (const f of ['0', 'null', 'NaN', '-3', '"10"']) assert.equal(make(`bar(40, { forecastPct: ${f} })`).byClass('ui-bar-forecast').length, 0, f);
    assert.equal(make('bar(40, { marker: { title: "x" } })').byClass('ui-bar-mark').length, 0);
  });
  it('limits the forecast to the rest of the bar and clamps values; unknown heights fall back to 8', () => {
    assert.equal(first(make('bar(90, { forecastPct: 30 })'), 'ui-bar-forecast')!.style.width, '10%');
    for (const [v, w] of [['150', '100%'], ['-5', '0%'], ['NaN', '0%']] as const) assert.equal(make(`bar(${v})`).children[0]!.style.width, w, v);
    assert.equal(make('bar(150)').getAttribute('aria-valuenow'), '100');
    for (const h of [5, 6, 8]) assert.ok(has(make(`bar(1, { height: ${h} })`), 'ui-bar-h' + h));
    assert.ok(has(make('bar(1, { height: 7 })'), 'ui-bar-h8'));
    assert.equal(make('bar(1, { color: "red" })').children[0]!.style.background, undefined);
  });
  it('CSS: radius 99, ground .08, hatch 135deg 4 px stripes, 2 px red marker', () => {
    const b = rule('.ui-bar');
    assert.ok(b.includes('border-radius: 99px') && b.includes('background: rgba(255, 255, 255, .08)'));
    assert.match(rule('.ui-bar-forecast'), /repeating-linear-gradient\(135deg, var\(--hatch, rgba\(52, 211, 153, 0?\.45\)\) 0 4px, transparent 4px 8px\)/);
    const m = rule('.ui-bar-mark');
    assert.ok(m.includes('width: 2px') && m.includes('background: var(--red-400)'));
    assert.match(TOKENS_CSS, /--red-400: #f87171;/);
    assert.equal((COMPONENTS_CSS.match(/repeating-linear-gradient/g) ?? []).length, 1);
  });
});

describe('stackedBar', () => {
  it('is an img named after its parts with one coloured segment per non-empty part', () => {
    const s = make('stackedBar([{ value: 371, label: "approved", color: "#34d399" }, { value: 17, label: "candidates", color: "#fbbf24" }, { value: 24, label: "stale", color: "#94a3b8" }, { value: 0, label: "rejected", color: "#f87171" }])');
    assert.ok(has(s, 'ui-stack'));
    assert.equal(s.getAttribute('role'), 'img');
    assert.equal(s.getAttribute('aria-label'), '371 approved, 17 candidates, 24 stale, 0 rejected');
    assert.equal(s.children.length, 3);
    assert.deepEqual(s.children.map((c) => c.style.background), ['#34d399', '#fbbf24', '#94a3b8']);
    const sum = s.children.reduce((a, c) => a + parseFloat(String(c.style.width)), 0);
    assert.ok(Math.abs(sum - 100) < 0.01, String(sum));
  });
  it('an empty list gives no segments', () => {
    const s = make('stackedBar([])');
    assert.equal(s.children.length, 0);
    assert.equal(s.getAttribute('aria-label'), 'no data');
    assert.equal(make('stackedBar()').children.length, 0);
  });
  it('CSS: 10 px high', () => assert.ok(rule('.ui-stack').includes('height: 10px')));
});

describe('component CSS', () => {
  it('only styles ui- classes, has no keyframes, no hex colours and transitions only transform / opacity', () => {
    const selectors = [...COMPONENTS_CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1]!.split(','));
    for (const s of selectors) assert.match(s.trim(), /^\.ui-/, s);
    assert.ok(!COMPONENTS_CSS.includes('@keyframes'));
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(COMPONENTS_CSS));
    for (const m of COMPONENTS_CSS.matchAll(/transition\s*:\s*([^;}]*)/g)) {
      for (const part of m[1]!.split(',')) assert.match(part.trim(), /^(transform|opacity)\b/, part);
    }
  });
});
