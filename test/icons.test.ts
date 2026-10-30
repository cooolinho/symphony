import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { BOOST_ICON_URI, ICON_NAMES, ICONS_JS } from '../src/http/icons.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { FakeElement, domContext, run } from './helpers/fake-dom.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ctx = domContext(BASE_JS);
const icon = (name: string, size?: number): FakeElement | null => run(ctx, `icon(${JSON.stringify(name)}${size ? ', ' + size : ''})`);
const shapes = (svg: FakeElement): string[] =>
  svg.children.map((c) => (c.tagName === 'path' ? c.getAttribute('d')! : `circle ${c.getAttribute('cx')},${c.getAttribute('cy')},${c.getAttribute('r')}`));

describe('icons', () => {
  it('knows the navigation, role and symbol icons, the logo and the arrow', () => {
    for (const n of ['home', 'changes', 'tasks', 'brain', 'stats', 'analyst', 'architect', 'developer', 'tester', 'docs', 'reviewer',
      'security', 'human', 'check', 'cross', 'search', 'refresh', 'logo', 'arrow']) assert.ok(ICON_NAMES.includes(n as never), n);
  });

  it('every icon is an aria-hidden line svg 0 0 24 24 in currentColor with round caps', () => {
    for (const name of ICON_NAMES.filter((n) => n !== 'arrow')) {
      const svg = icon(name)!;
      assert.equal(svg.tagName, 'svg', name);
      assert.equal(svg.namespaceURI, SVG_NS, name);
      assert.equal(svg.getAttribute('viewBox'), '0 0 24 24', name);
      assert.equal(svg.getAttribute('fill'), 'none', name);
      assert.equal(svg.getAttribute('stroke'), 'currentColor', name);
      assert.equal(svg.getAttribute('stroke-linecap'), 'round', name);
      assert.equal(svg.getAttribute('aria-hidden'), 'true', name);
      assert.equal(svg.getAttribute('width'), '16', name);
      assert.equal(svg.getAttribute('height'), '16', name);
      const w = Number(svg.getAttribute('stroke-width'));
      const want = { check: 3.2, cross: 3.4, logo: 2.2 }[name as string];
      if (want) assert.equal(w, want, name);
      else assert.ok(w >= 1.8 && w <= 1.9, `${name}: ${w}`);
      assert.ok(svg.children.length > 0, name);
      for (const node of [svg, ...svg.descendants()]) {
        assert.ok(node.tagName === 'svg' || node.tagName === 'path' || node.tagName === 'circle', node.tagName);
        assert.equal(node.namespaceURI, SVG_NS);
        for (const k of node.attributes.keys()) assert.ok(!k.startsWith('sc-'), `${name}: ${k}`);
      }
    }
    assert.equal(icon('home', 26)!.getAttribute('width'), '26');
  });

  it('draws the mockup paths', () => {
    assert.deepEqual(shapes(icon('home')!), ['M3 11l9-7 9 7', 'M5 10v10h14V10']);
    assert.deepEqual(shapes(icon('changes')!), ['circle 6,6,2.5', 'circle 18,18,2.5', 'M6 8.5v4a5 5 0 0 0 5 5h4.5']);
    assert.deepEqual(shapes(icon('stats')!), ['M5 20V11', 'M12 20V4', 'M19 20v-7']);
    assert.equal(shapes(icon('tasks')!).length, 6);
    assert.equal(shapes(icon('brain')!).length, 2);
    assert.deepEqual(shapes(icon('architect')!).slice(0, 3), ['M12 3l-7 18', 'M12 3l7 18', 'M7.5 15h9']);
    assert.match(shapes(icon('architect')!)[3]!, /^circle /);
    assert.equal(shapes(icon('developer')!).length, 3);
    assert.deepEqual(shapes(icon('logo')!), ['M4 10v4', 'M8 7v10', 'M12 4v16', 'M16 8v8', 'M20 11v2']);
  });

  it('an unknown name gives null; the arrow is text', () => {
    assert.equal(icon('nope'), null);
    assert.equal(icon('constructor'), null);
    const a = icon('arrow')!;
    assert.equal(a.tagName, 'span');
    assert.equal(a.textContent, '↗');
    assert.equal(a.getAttribute('aria-hidden'), 'true');
  });

  it('builds with svgEl only and is available on every page; the boost icon stays', () => {
    for (const bad of ['innerHTML', 'insertAdjacentHTML', 'outerHTML', 'sc-camel']) assert.ok(!ICONS_JS.includes(bad), bad);
    for (const html of [DASHBOARD_HTML, AGENT_HTML, LOGS_HTML]) assert.ok(html.includes('function icon('));
    assert.match(BOOST_ICON_URI, /^data:image\/svg\+xml;base64,/);
  });
});
