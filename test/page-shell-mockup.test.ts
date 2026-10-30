// E1-8: page shell after the mockup (aurora, header, title block, breadcrumbs, grid, panel, 5 h chip, poll button).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { BASE_JS } from '../src/http/styles.ts';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { TOKENS_CSS } from '../src/http/ui/tokens.ts';
import {
  AURORA, LAYOUT_CSS, LAYOUT_JS, auroraHtml, breadcrumbs, escapeHtml, page, pageHeader, panel, sectionLink, twoColumns,
  type AuroraCircle,
} from '../src/http/ui/layout.ts';

const PAGES = { dashboard: DASHBOARD_HTML, agent: AGENT_HTML, logs: LOGS_HTML };
const count = (text: string, needle: string): number => text.split(needle).length - 1;
const ruleOf = (css: string, selector: string): string => {
  const at = css.indexOf(`\n  ${selector} {`);
  assert.ok(at >= 0, `${selector} rule`);
  return css.slice(at, css.indexOf('}', at));
};
const navOf = (html: string): string => html.slice(html.indexOf('aria-label="Hauptnavigation"'), html.indexOf('</nav>'));
const shell = (o: Partial<Parameters<typeof page>[0]> = {}): string =>
  page({ title: 't', nav: 'overview', aurora: AURORA.overview, body: '', scripts: '', ...o });

class FakeElement {
  className = '';
  textContent = '';
  children: unknown[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, () => unknown> = {};
  classList = {
    contains: (c: string) => this.className.split(' ').includes(c),
    add: (c: string) => { this.className = (this.className + ' ' + c).trim(); },
    remove: (c: string) => { this.className = this.className.split(' ').filter((x) => x !== c).join(' '); },
  };
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  addEventListener(ev: string, fn: () => unknown): void { this.listeners[ev] = fn; }
  replaceChildren(...c: unknown[]): void { this.children = c; this.textContent = c.map((x) => (typeof x === 'string' ? x : (x as FakeElement).textContent)).join(''); }
}

function shellContext(fetchImpl: (url: string, init?: { method?: string }) => Promise<unknown>) {
  const ids = ['shell-live', 'shell-live-dot', 'shell-live-text', 'shell-budget', 'shell-clock', 'shell-poll', 'announce'];
  const nodes = new Map<string, FakeElement>(ids.map((id) => [id, new FakeElement()]));
  const timers: Array<[() => void, number]> = [];
  const fetched: Array<[string, string | undefined]> = [];
  const ctx = vm.createContext({
    document: { getElementById: (id: string) => nodes.get(id) ?? null, createElement: () => new FakeElement() },
    setInterval: (fn: () => void, ms: number) => timers.push([fn, ms]),
    setTimeout: (fn: () => void) => { fn(); },
    fetch: (url: string, init?: { method?: string }) => { fetched.push([url, init?.method]); return fetchImpl(url, init); },
    fmtClock: (iso: string) => iso.slice(11, 19),
  });
  vm.runInContext(LAYOUT_JS, ctx);
  return { ctx, nodes, timers, fetched, node: (id: string) => nodes.get(id) as FakeElement };
}
const reject = (): Promise<unknown> => Promise.reject(new Error('offline'));

describe('E1-8 page shell after the mockup', () => {
  it('root: position, height, overflow, ground colour, text', () => {
    const root = ruleOf(LAYOUT_CSS, '.shell-root');
    for (const d of ['position: relative', 'min-height: 100vh', 'overflow: hidden', 'background: var(--bg)', 'color: var(--fg)', 'font-size: 14px', 'line-height: 1.5']) assert.ok(root.includes(d), d);
    assert.match(TOKENS_CSS, /--bg: #070b16/);
    for (const [name, html] of Object.entries(PAGES)) assert.equal(count(html, '<div class="shell-root">'), 1, name);
  });

  it('aurora: aria-hidden container, circles, dot grid', () => {
    assert.ok(shell().includes('<div class="aurora" aria-hidden="true">'));
    assert.match(ruleOf(LAYOUT_CSS, '.aurora'), /pointer-events: none/);
    assert.match(ruleOf(LAYOUT_CSS, '.aurora > i'), /border-radius: 50%/);
    const grid = ruleOf(LAYOUT_CSS, '.aurora::after');
    assert.ok(grid.includes('radial-gradient(rgba(255, 255, 255, .08) 1px, transparent 1.5px)'));
    assert.ok(grid.includes('background-size: 22px 22px'));
    const html = auroraHtml(AURORA.overview);
    assert.equal(count(html, '<i style='), 4);
    assert.ok(html.includes('width:620px;height:620px;left:-160px;top:-200px;background:#0d9488;opacity:0.32;filter:blur(90px)'));
    assert.ok(html.includes('right:6%;top:1180px;background:#be185d;opacity:0.18;filter:blur(110px)'));
  });

  it('aurora: invalid parameters throw a RangeError', () => {
    const ok = AURORA.overview[0] as AuroraCircle;
    const bad: Array<Partial<AuroraCircle>> = [{ size: 700 }, { size: 400 }, { opacity: 0.5 }, { blur: 50 }, { color: 'red' }, { x: 'middle 3px' }, { y: Number.NaN }, { color: '#000;x' }];
    for (const b of bad) assert.throws(() => auroraHtml([ok, ok, { ...ok, ...b }]), RangeError, JSON.stringify(b));
    assert.throws(() => auroraHtml([ok, ok]), RangeError);
    assert.throws(() => auroraHtml([]), RangeError);
    assert.throws(() => auroraHtml([ok, ok, ok, ok, ok]), RangeError);
    assert.throws(() => shell({ aurora: [] }), RangeError);
  });

  it('aurora per page: presets from the mockup, every page uses at least three circles', () => {
    assert.deepEqual(Object.keys(AURORA).sort(), ['brain', 'changes', 'overview', 'stats', 'tasks', 'team']);
    const colors = {
      overview: ['#0d9488', '#6d28d9', '#1d4ed8', '#be185d'], team: ['#059669', '#6d28d9', '#0e7490', '#be185d'],
      changes: ['#0d9488', '#7c3aed', '#1d4ed8'], tasks: ['#0d9488', '#6d28d9', '#b45309'],
      brain: ['#7c3aed', '#0d9488', '#be185d'], stats: ['#1d4ed8', '#0d9488', '#7c3aed'],
    };
    for (const [key, list] of Object.entries(AURORA)) {
      assert.deepEqual(list.map((c) => c.color), colors[key as keyof typeof colors], key);
      assert.doesNotThrow(() => auroraHtml(list), key);
    }
    assert.deepEqual([AURORA.brain[0]?.size, AURORA.brain[0]?.opacity], [660, 0.32]);
    for (const [name, html] of Object.entries(PAGES)) assert.ok(count(html, '<i style="width:') >= 3, name);
    assert.ok(AGENT_HTML.includes('background:#059669'), 'team preset');
    assert.ok(LOGS_HTML.includes('background:#1d4ed8'), 'stats preset');
  });

  it('container', () => {
    const wrap = ruleOf(LAYOUT_CSS, '.shell-wrap');
    for (const d of ['max-width: 1440px', 'margin: 0 auto', 'padding: 16px 20px 48px', 'display: flex', 'flex-direction: column', 'gap: 18px']) assert.ok(wrap.includes(d), d);
    const html = shell({ crumbs: [{ label: 'A', href: '/' }, { label: 'B' }] });
    assert.ok(html.indexOf('<div class="shell-wrap">') < html.indexOf('<header'));
    assert.ok(html.indexOf('<header') < html.indexOf('class="crumbs"') && html.indexOf('class="crumbs"') < html.indexOf('<main'));
  });

  it('header: glass, logo, wordmark, no sticky', () => {
    const html = shell();
    assert.ok(html.includes('<header class="shell-head g">'));
    const head = ruleOf(LAYOUT_CSS, '.shell-head');
    for (const d of ['border-radius: 22px', 'padding: 8px 10px 8px 14px', 'flex-wrap: wrap', 'gap: 10px 18px']) assert.ok(head.includes(d), d);
    assert.doesNotMatch(head, /sticky/);
    assert.match(html, /<a class="brand" href="\/"[^>]*>\s*<span class="brand-mark" aria-hidden="true"><svg[^>]*>(<path [^>]*\/>){5}<\/svg><\/span>\s*<span class="brand-name">Symphony<\/span>/);
    const mark = ruleOf(LAYOUT_CSS, '.brand-mark');
    for (const d of ['width: 36px', 'height: 36px', 'border-radius: 12px', 'linear-gradient(140deg, #14b8a6, #7c3aed)']) assert.ok(mark.includes(d), d);
    const name = ruleOf(LAYOUT_CSS, '.brand-name');
    assert.ok(name.includes('600 17px'));
  });

  it('navigation: five links with icons, exactly one aria-current, pill rules', () => {
    const keys = ['overview', 'changes', 'tasks', 'brain', 'stats'] as const;
    const hrefs = ['/', '/changes', '/tasks', '/brain', '/stats'];
    for (const [i, key] of keys.entries()) {
      const html = shell({ nav: key });
      const nav = navOf(html);
      assert.deepEqual([...nav.matchAll(/<a class="nv[^"]*" href="([^"]+)"/g)].map((m) => m[1]), hrefs);
      assert.equal(count(nav, 'aria-current="page"'), 1, key);
      assert.ok(nav.includes(`href="${hrefs[i]}" aria-current="page"`), key);
      assert.equal(count(nav, '<svg width="16"'), 5);
      assert.equal(count(nav, 'aria-hidden="true"'), 5);
    }
    assert.equal(count(navOf(shell({ nav: null })), 'aria-current="page"'), 0);
    assert.match(ruleOf(LAYOUT_CSS, '.shell-nav'), /flex: 1 1 520px/);
    const well = ruleOf(LAYOUT_CSS, '.shell-well');
    for (const d of ['rgba(0, 0, 0, .28)', 'border-radius: 999px', 'padding: 4px', 'gap: 4px', 'overflow-x: auto', 'max-width: 100%']) assert.ok(well.includes(d), d);
    assert.match(LAYOUT_CSS, /\.nv\[aria-current="page"\], \.nv\.on \{ background: rgba\(255, 255, 255, \.92\)/);
  });

  it('team view: Übersicht highlighted without aria-current', () => {
    const nav = navOf(AGENT_HTML);
    assert.equal(count(nav, 'aria-current'), 0);
    assert.equal(count(nav, 'class="nv on"'), 1);
    assert.match(nav, /class="nv on" href="\/"/);
    const other = navOf(shell({ nav: 'brain', navHighlight: 'overview' }));
    assert.equal(count(other, 'class="nv on"'), 0);
    assert.equal(count(other, 'aria-current="page"'), 1);
  });

  it('LIVE / OFFLINE', () => {
    assert.match(shell(), /id="shell-live"><span class="dot" id="shell-live-dot"><\/span><span id="shell-live-text">OFFLINE<\/span>/);
    const { ctx, node } = shellContext(reject);
    vm.runInContext('setLive(true)', ctx);
    assert.equal(node('shell-live-text').textContent, 'LIVE');
    assert.equal(node('shell-live').className, 'sh-chip shell-live tone-green');
    assert.equal(node('shell-live-dot').className, 'dot live');
    vm.runInContext('setLive(false)', ctx);
    assert.equal(node('shell-live-text').textContent, 'OFFLINE');
    assert.equal(node('shell-live').className, 'sh-chip shell-live tone-gray');
    assert.equal(node('shell-live-dot').className, 'dot');
  });

  it('5 h chip: no data, amber from 50 %, red from 85 %', async () => {
    assert.match(shell(), /id="shell-budget" title="5-h-Fenster">5h —</);
    const { ctx, node } = shellContext(reject);
    const report = (used: number) => ({ five_hour: { used_tokens: used, forecast: { limit_tokens: 100 } } });
    const chip = (r: unknown): { pct: number | null; tone: string | null } => { ctx.r = r; return JSON.parse(vm.runInContext('JSON.stringify(fiveHourChip(r))', ctx) as string); };
    assert.deepEqual(chip(null), { pct: null, tone: null });
    assert.deepEqual(chip({ five_hour: { used_tokens: 5, forecast: null } }), { pct: null, tone: null });
    assert.deepEqual(chip(report(30)), { pct: 30, tone: null });
    assert.deepEqual(chip(report(50)), { pct: 50, tone: 'amber' });
    assert.deepEqual(chip(report(84)), { pct: 84, tone: 'amber' });
    assert.deepEqual(chip(report(85)), { pct: 85, tone: 'red' });
    vm.runInContext('setBudget(null)', ctx);
    assert.equal(node('shell-budget').textContent, '5h —');
    ctx.r = report(62);
    vm.runInContext('setBudget(r)', ctx);
    assert.equal(node('shell-budget').textContent, '5h 62 %');
    assert.equal((node('shell-budget').children[1] as FakeElement).className, 'budget-pct tone-amber');
    ctx.r = report(90);
    vm.runInContext('setBudget(r)', ctx);
    assert.equal((node('shell-budget').children[1] as FakeElement).className, 'budget-pct tone-red');
    assert.match(ruleOf(LAYOUT_CSS, '.budget-pct.tone-amber'), /var\(--amber\)/);
    assert.match(ruleOf(LAYOUT_CSS, '.budget-pct.tone-red'), /var\(--red\)/);
  });

  it('5 h chip: loads /api/v1/budget, a failure ends at "5h —"', async () => {
    const ok = shellContext(() => Promise.resolve({ ok: true, json: async () => ({ five_hour: { used_tokens: 62, forecast: { limit_tokens: 100 } } }) }));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(ok.fetched[0], ['/api/v1/budget', undefined]);
    assert.equal(ok.node('shell-budget').textContent, '5h 62 %');
    const bad = shellContext(reject);
    await new Promise((r) => setImmediate(r));
    assert.equal(bad.node('shell-budget').textContent, '5h —');
    assert.ok(bad.timers.some((t) => t[1] === 60000));
  });

  it('version and clock', () => {
    assert.match(shell(), /id="shell-version" title="Symphony-Version">v\d+\.\d+\.\d+/);
    const clock = ruleOf(LAYOUT_CSS, '.shell-clock');
    for (const d of ['15px', 'var(--mono)', 'tabular-nums']) assert.ok(clock.includes(d), d);
    const { timers, node } = shellContext(reject);
    assert.match(node('shell-clock').textContent, /^\d\d:\d\d:\d\d$/);
    assert.ok(timers.some((t) => t[1] === 1000));
  });

  it('Jetzt pollen: only when requested, with aria-label; click posts to /api/v1/refresh', async () => {
    assert.ok(!shell().includes('id="shell-poll"'));
    for (const [name, html] of Object.entries(PAGES)) assert.equal(html.includes('id="shell-poll"'), name === 'dashboard', name);
    const html = shell({ pollNow: true });
    assert.match(html, /<button class="btn shell-poll" id="shell-poll" type="button" aria-label="Jetzt pollen"/);
    assert.ok(html.indexOf('id="shell-poll"') > html.indexOf('<header') && html.indexOf('id="shell-poll"') < html.indexOf('</header>'));

    for (const [reply, text] of [[{ ok: true, json: async () => ({}) }, 'Poll eingereiht'], [{ ok: true, json: async () => ({ coalesced: true }) }, 'Poll bereits eingereiht'], [{ ok: false, json: async () => ({}) }, 'Poll fehlgeschlagen']] as const) {
      const t = shellContext((url) => Promise.resolve(url === '/api/v1/refresh' ? reply : { ok: false, json: async () => ({}) }));
      let after = 0;
      vm.runInContext('shellHooks.afterPoll = () => { globalThis.after = (globalThis.after || 0) + 1; }', t.ctx);
      await t.node('shell-poll').listeners.click?.();
      assert.deepEqual(t.fetched.at(-1), ['/api/v1/refresh', 'POST']);
      assert.equal(t.node('announce').textContent, text);
      assert.equal(t.node('shell-poll').classList.contains('is-busy'), false);
      after = (t.ctx as { after?: number }).after ?? 0;
      assert.equal(after, 1);
    }
    const failing = shellContext(reject);
    await failing.node('shell-poll').listeners.click?.();
    assert.equal(failing.node('announce').textContent, 'Poll fehlgeschlagen');
  });

  it('pageHeader', () => {
    const html = pageHeader({ title: 'A<b', subtitle: 'S&t', right: '<span class="chip">x</span>' });
    assert.equal(html, '<div class="page-title"><div><h1>A&lt;b</h1><p class="page-sub">S&amp;t</p></div><div class="page-title-right"><span class="chip">x</span></div></div>');
    const bare = pageHeader({ title: 'T' });
    assert.ok(!bare.includes('page-sub') && !bare.includes('page-title-right'));
    const title = ruleOf(LAYOUT_CSS, '.page-title');
    for (const d of ['flex-wrap: wrap', 'align-items: flex-end', 'padding: 6px 4px 0']) assert.ok(title.includes(d), d);
    const h1 = ruleOf(LAYOUT_CSS, '.page-title h1');
    for (const d of ['font-size: 34px', 'font-weight: 600', 'letter-spacing: -.02em']) assert.ok(h1.includes(d), d);
    const sub = ruleOf(LAYOUT_CSS, '.page-sub');
    assert.ok(sub.includes('15px') && sub.includes('var(--fg-2)'));
    assert.equal(count(DASHBOARD_HTML, '<h1>'), 1);
    assert.equal(count(LOGS_HTML, '<h1>'), 1);
  });

  it('breadcrumbs', () => {
    const html = breadcrumbs([{ label: 'Übersicht', href: '/' }, { label: 'X<y' }]);
    assert.equal(html, '<nav class="crumbs" aria-label="Brotkrumen"><ol><li><a href="/">Übersicht</a></li><li><span class="crumb-current" id="crumb-current">X&lt;y</span></li></ol></nav>');
    assert.ok(!html.includes('aria-current'));
    const crumbs = ruleOf(LAYOUT_CSS, '.crumbs');
    assert.ok(crumbs.includes('13.5px') && crumbs.includes('var(--fg-3)'));
    assert.match(ruleOf(LAYOUT_CSS, '.crumb-current'), /var\(--fg-chip\)/);
    assert.match(LAYOUT_CSS, /\.crumbs li \+ li::before \{ content: "›"/);
    assert.ok(AGENT_HTML.includes('aria-label="Brotkrumen"'));
  });

  it('twoColumns', () => {
    assert.equal(twoColumns('A', 'B'), '<div class="cols"><div class="col-main">A</div><div class="col-side">B</div></div>');
    assert.ok(twoColumns('A', 'B', { sideWidth: 360 }).includes('<div class="col-side" style="flex: 1 1 360px">'));
    for (const w of [0, -1, 1.5]) assert.throws(() => twoColumns('A', 'B', { sideWidth: w }), RangeError);
    const cols = ruleOf(LAYOUT_CSS, '.cols');
    for (const d of ['display: flex', 'flex-wrap: wrap', 'gap: 18px', 'align-items: flex-start']) assert.ok(cols.includes(d), d);
    assert.ok(ruleOf(LAYOUT_CSS, '.col-main').includes('flex: 999 1 640px'));
    assert.ok(ruleOf(LAYOUT_CSS, '.col-side').includes('flex: 1 1 420px'));
    for (const sel of ['.col-main', '.col-side']) for (const d of ['min-width: 0', 'display: flex', 'flex-direction: column', 'gap: 18px']) assert.ok(ruleOf(LAYOUT_CSS, sel).includes(d), sel + d);
  });

  it('panel and sectionLink', () => {
    const html = panel({ title: 'Teams live', right: sectionLink('Alle Tasks', '/tasks'), children: '<p>x</p>' });
    assert.equal(html, '<section class="g shell-panel" aria-labelledby="panel-teams-live"><div class="panel-head"><h2 class="lbl" id="panel-teams-live">Teams live</h2><a class="panel-link" href="/tasks">Alle Tasks →</a></div><p>x</p></section>');
    assert.match(panel({ title: 'T', ariaLabel: 'Eigen', children: '' }), /<section class="g shell-panel" aria-label="Eigen">/);
    assert.match(panel({ title: 'T', id: 'mine', children: '' }), /aria-labelledby="mine"[\s\S]*id="mine"/);
    assert.ok(ruleOf(LAYOUT_CSS, '.shell-panel').includes('padding: 18px'));
    assert.ok(ruleOf(LAYOUT_CSS, '.panel-link').includes('font-size: 13px'));
    assert.equal(escapeHtml('<'), '&lt;');
  });

  it('390 px: only the navigation well scrolls horizontally', () => {
    assert.ok(ruleOf(LAYOUT_CSS, '.shell-well').includes('overflow-x: auto'));
    assert.ok(ruleOf(LAYOUT_CSS, '.shell-well').includes('max-width: 100%'));
    assert.ok(ruleOf(LAYOUT_CSS, '.shell-nav').includes('min-width: 0'));
    assert.ok(ruleOf(LAYOUT_CSS, '.shell-root').includes('overflow: hidden'));
    assert.match(TOKENS_CSS, /body \{[^}]*overflow-x: hidden/);
    assert.match(LAYOUT_CSS, /@media \(max-width: 640px\) \{[^@]*\.shell-nav \{ order: 3; flex-basis: 100%; \}/);
    for (const rule of ['.shell-wrap', '.shell-head', '.shell-nav', '.shell-well']) {
      for (const m of ruleOf(LAYOUT_CSS, rule).matchAll(/(?<![-\w])(?:min-)?width:\s*(\d+)px/g)) assert.ok(Number(m[1]) <= 390, rule);
    }
  });

  it('blur budget: no backdrop-filter in the shell, no .g inside a .g', () => {
    assert.doesNotMatch(LAYOUT_CSS, /backdrop-filter/);
    const html = shell({ pollNow: true, crumbs: [{ label: 'A', href: '/' }, { label: 'B' }], body: twoColumns(panel({ title: 'A', children: '<p>a</p>' }), panel({ title: 'B', children: '<p>b</p>' })) });
    for (const doc of [html, ...Object.values(PAGES)]) {
      const body = doc.slice(doc.indexOf('<body>'), doc.indexOf('<script>')).replace(/<(i|p|a|span|svg|path|circle|button|input|time|br|img)\b[^>]*\/>/g, '');
      const stack: boolean[] = [];
      let depth = 0;
      for (const m of body.matchAll(/<(\/?)([a-z0-9]+)\b([^>]*)>/g)) {
        const tag = m[2] as string;
        if (['input', 'br', 'img', 'path', 'circle', 'meta', 'link', 'hr', 'option'].includes(tag) && !m[1]) continue;
        if (m[1]) { if (stack.pop()) depth--; continue; }
        if (/\/$/.test(m[3] as string)) continue;
        const isG = /\bclass="[^"]*\bg\b[^"]*"/.test(m[3] as string);
        if (isG) { assert.equal(depth, 0, 'nested .g'); depth++; }
        stack.push(isG);
      }
    }
  });
});
