// E1-8: Zustand nach dem Merge von develop – eine Budget-Quelle, Sticky-Verträglichkeit, LIVE/OFFLINE-Texte.
// Unabhängig aus den Abnahmekriterien abgeleitet; prüft das ausgelieferte HTML/CSS/JS.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { BRAIN_HTML } from '../src/http/brain-page.ts';
import { CHANGES_HTML } from '../src/http/changes-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { LAYOUT_CSS, LAYOUT_JS } from '../src/http/ui/layout.ts';
import { TOKENS_CSS } from '../src/http/ui/tokens.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { TASKS_HTML } from '../src/http/tasks-page.ts';

const PAGES = { DASHBOARD_HTML, AGENT_HTML, CHANGES_HTML, TASKS_HTML, BRAIN_HTML, LOGS_HTML };

describe('E1-8 nach dem Merge', () => {
  it('Wurzel: overflow hidden bleibt, clip nur als Verfeinerung per @supports', () => {
    const root = /\.shell-root\s*\{([^}]*)\}/.exec(LAYOUT_CSS)?.[1] ?? '';
    assert.match(root, /position:\s*relative/);
    assert.match(root, /min-height:\s*100vh/);
    assert.match(root, /overflow:\s*hidden/);
    assert.match(root, /font-size:\s*14px/);
    assert.match(root, /line-height:\s*1\.5/);
    assert.match(TOKENS_CSS, /--bg:\s*#070b16/);
    assert.match(LAYOUT_CSS, /@supports\s*\(overflow:\s*clip\)\s*\{\s*\.shell-root\s*\{\s*overflow:\s*clip/);
  });

  it('der 5-h-Chip hat genau einen Budget-Abruf in der Hülle, keine Seite ruft /api/v1/budget zusätzlich ab', () => {
    assert.equal(LAYOUT_JS.match(/fetch\('\/api\/v1\/budget'/g)?.length, 1);
    for (const [name, html] of Object.entries(PAGES)) {
      const own = html.replace(LAYOUT_JS, '');
      assert.doesNotMatch(own, /fetch\(['"`]\/api\/v1\/budget/, `${name} lädt das Budget selbst`);
    }
  });

  it('die Hülle zeigt nur „LIVE“ oder „OFFLINE“ und steht auf jeder Seite im Kopf', () => {
    assert.match(LAYOUT_JS, /LIVE/);
    assert.match(LAYOUT_JS, /OFFLINE/);
    for (const [name, html] of Object.entries(PAGES)) {
      const head = html.slice(0, html.indexOf('<main'));
      assert.match(head, /class="live"|class="[^"]*\blive\b/, `${name}: .live-Punkt`);
      assert.match(head, /title="5-h-Fenster"/, `${name}: 5-h-Chip`);
      assert.doesNotMatch(html, /Poll now/, `${name}: alter Poll-Button`);
    }
  });

  it('die Statistik-Seite nutzt die Hülle mit Statistik-Aurora und hebt „Statistik“ hervor', () => {
    const nav = /<nav class="shell-nav" aria-label="Hauptnavigation">(.*?)<\/nav>/s.exec(LOGS_HTML)?.[1] ?? '';
    const links = [...nav.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
    const current = links.filter((l) => l.includes('aria-current="page"'));
    assert.equal(current.length, 1);
    assert.match(current[0]!, /href="\/stats"/);
    assert.ok(links.every((l) => !l.includes('href="/logs"')));
  });
});
