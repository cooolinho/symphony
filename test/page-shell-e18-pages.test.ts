// E1-8: Hülle auf allen realen Seiten (nach dem Merge von E1-4: Changes, Tasks, Brain).
// Unabhängig aus den Abnahmekriterien abgeleitet; prüft das ausgelieferte HTML.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { BRAIN_HTML } from '../src/http/brain-page.ts';
import { CHANGES_HTML } from '../src/http/changes-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { TASKS_HTML } from '../src/http/tasks-page.ts';

const PAGES: Array<{ name: string; html: string; current: string | null; colors?: string[] }> = [
  { name: 'Übersicht', html: DASHBOARD_HTML, current: '/', colors: ['#0d9488', '#6d28d9', '#1d4ed8', '#be185d'] },
  { name: 'Team', html: AGENT_HTML, current: null, colors: ['#059669', '#6d28d9', '#0e7490', '#be185d'] },
  { name: 'Changes', html: CHANGES_HTML, current: '/changes', colors: ['#0d9488', '#7c3aed', '#1d4ed8'] },
  { name: 'Tasks', html: TASKS_HTML, current: '/tasks', colors: ['#0d9488', '#6d28d9', '#b45309'] },
  { name: 'Brain', html: BRAIN_HTML, current: '/brain', colors: ['#7c3aed', '#0d9488', '#be185d'] },
  { name: 'Statistik', html: LOGS_HTML, current: '/stats' },
];

const circles = (html: string): string[] => {
  const m = /<div class="aurora" aria-hidden="true">(.*?)<\/div>/s.exec(html);
  assert.ok(m, 'Aurora-Container mit aria-hidden');
  return [...m[1]!.matchAll(/<i style="([^"]*)"><\/i>/g)].map((x) => x[1]!);
};

describe('E1-8 Hülle auf jeder Seite', () => {
  for (const p of PAGES) {
    it(`${p.name}: Aurora mit 3–4 Kreisen in den Spannen der Issue`, () => {
      const list = circles(p.html);
      assert.ok(list.length >= 3 && list.length <= 4, `${list.length} Kreise`);
      for (const s of list) {
        const size = Number(/width:(\d+)px/.exec(s)?.[1]);
        const blur = Number(/blur\((\d+)px\)/.exec(s)?.[1]);
        const op = Number(/opacity:([\d.]+)/.exec(s)?.[1]);
        assert.ok(size >= 480 && size <= 660, `Größe ${size}`);
        assert.ok(blur >= 90 && blur <= 110, `Blur ${blur}`);
        assert.ok(op >= 0.16 && op <= 0.32, `Deckkraft ${op}`);
      }
      if (p.colors) assert.deepEqual(list.map((s) => /background:(#[0-9a-f]{6})/i.exec(s)?.[1]), p.colors);
    });

    it(`${p.name}: fünf Navigationslinks, höchstens ein aria-current, Kopfleiste und Wurzel`, () => {
      const nav = /<nav class="shell-nav" aria-label="Hauptnavigation">(.*?)<\/nav>/s.exec(p.html);
      assert.ok(nav, 'nav Hauptnavigation');
      const hrefs = [...nav[1]!.matchAll(/<a class="nv[^"]*" href="([^"]+)"/g)].map((x) => x[1]);
      assert.deepEqual(hrefs, ['/', '/changes', '/tasks', '/brain', '/stats']);
      const currents = [...nav[1]!.matchAll(/<a [^>]*href="([^"]+)"[^>]*aria-current="page"/g)].map((x) => x[1]);
      assert.deepEqual(currents, p.current ? [p.current] : []);
      assert.match(p.html, /<header class="[^"]*\bg\b[^"]*"/);
      assert.match(p.html, /class="shell-root"/);
    });

    it(`${p.name}: kein .g in .g`, () => {
      // Jedes Element mit Klasse g: bis zu seinem schließenden Tag darf kein weiteres .g folgen.
      const re = /<(header|section|div|article|aside)\b[^>]*class="[^"]*\bg\b[^"]*"[^>]*>/g;
      const body = p.html.slice(p.html.indexOf('<body'), p.html.indexOf('<script'));
      for (const m of body.matchAll(re)) {
        const tag = m[1]!;
        let depth = 1;
        const tokens = /<(\/?)(header|section|div|article|aside)\b[^>]*>/g;
        tokens.lastIndex = m.index! + m[0].length;
        let t: RegExpExecArray | null;
        const start = m.index! + m[0].length;
        let end = body.length;
        while ((t = tokens.exec(body))) {
          if (t[2] !== tag) continue;
          depth += t[1] ? -1 : 1;
          if (depth === 0) { end = t.index; break; }
        }
        const inner = body.slice(start, end);
        assert.doesNotMatch(inner, /<(header|section|div|article|aside)\b[^>]*class="[^"]*\bg\b[^"]*"/, `${p.name}: .g verschachtelt`);
      }
    });
  }

  it('Poll-Button nur auf der Übersicht', () => {
    for (const p of PAGES) {
      const has = /aria-label="[^"]*poll[^"]*"/i.test(p.html.slice(0, p.html.indexOf('<main')));
      assert.equal(has, p.name === 'Übersicht', p.name);
    }
  });
});
