import assert from 'node:assert/strict';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';

// Independent check of the E2-3 integration after merging the Alerts panel (#425) and the system cards (#424):
// both blocks must coexist in the overview page without clashes.

const script = (): string => {
  const scripts = [...DASHBOARD_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  assert.ok(scripts.length > 0);
  return scripts.join('\n');
};

describe('E2-3 Teams next to Alerts on the overview', () => {
  it('has no merge conflict markers in the page', () => {
    assert.doesNotMatch(DASHBOARD_HTML, /^(<<<<<<<|>>>>>>>)/m);
  });

  it('the combined page script compiles', () => {
    assert.doesNotThrow(() => new vm.Script(script()));
  });

  it('declares each top-level function only once (no clash between Teams, Alerts and Pipeline blocks)', () => {
    const names = [...script().matchAll(/^function\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]!);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    assert.deepEqual(dupes, []);
  });

  it('keeps the Teams section, the Running section and the Alerts panel on the page', () => {
    assert.match(DASHBOARD_HTML, /id="teams-section"/);
    assert.match(DASHBOARD_HTML, /id="teams"/);
    assert.match(DASHBOARD_HTML, /id="teams-count"/);
    assert.ok(DASHBOARD_HTML.indexOf('id="teams-section"') < DASHBOARD_HTML.indexOf('id="running-section"') || !DASHBOARD_HTML.includes('id="running-section"'));
    assert.match(DASHBOARD_HTML, /class="team-row|\.team-row/);
    assert.match(DASHBOARD_HTML, /alert/i);
  });

  it('every id the Teams block reads exists in the page markup', () => {
    for (const id of ['teams', 'teams-count']) {
      assert.match(DASHBOARD_HTML, new RegExp(`id="${id}"`));
    }
  });

  it('keeps the SSE wiring, the 1 s Teams ticker and the budget poll together in the start block', () => {
    const s = script();
    assert.match(s, /live\(load, pollEvery\(load, 2000\)\)/);
    assert.match(s, /setInterval\(\(\) => \{\s*tickTeams\(Date\.now\(\)\);[^}]*\}, 1000\)/);
    assert.match(s, /setInterval\(loadBudget, 30000\)/);
  });
});
