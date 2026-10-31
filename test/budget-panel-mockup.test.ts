import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { TASKS_HTML } from '../src/http/tasks-page.ts';
import { ROLE_COLORS } from '../src/http/ui/palette.ts';
import { renderPage, until } from './helpers.ts';
import { dashboardState, issueRow } from './helpers/page-fixtures.ts';

// E4-6 (#388): context budget panel and 5h chip after the mockup. Clock of renderPage: 2026-10-30T12:00:00Z.

const UI_RED = '#f87171';
const RESET = '2026-10-30T14:00:00.000Z';
const ETA = '2026-10-30T13:00:00.000Z';
const hm = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

interface Opts { used?: number; limit?: number | null; eta?: string | null; burn?: number; byRole?: Record<string, number>; alert?: boolean }

function win(o: Opts = {}) {
  return {
    window: 'five_hour',
    used_tokens: o.used ?? 1_500_000,
    burn_rate_per_min: o.burn ?? 2000,
    resets_at: RESET,
    forecast: o.limit === null ? null : { limit_tokens: o.limit ?? 2_000_000, limit_source: 'sdk', eta: o.eta === undefined ? ETA : o.eta },
    alert: o.alert ?? false,
    by_role: o.byRole ?? {},
  };
}
function report(five: Opts = {}, seven: Opts = { used: 18_000_000, limit: 20_000_000, eta: null }) {
  return { five_hour: win(five), seven_day: { ...win(seven), window: 'seven_day' }, generated_at: '2026-10-30T12:00:00.000Z' };
}

async function overview(budget: unknown, state: unknown = dashboardState()) {
  const page = renderPage(DASHBOARD_HTML, state, {
    fetch: (url) => {
      if (url === '/api/v1/budget') { if (budget instanceof Error) throw budget; return budget; }
      if (url === '/api/v1/state') return state;
      if (url === '/api/v1/history') return { recent: [] };
      return {};
    },
  });
  await until(() => page.fetches.some((f) => f.url === '/api/v1/budget'), 3_000, 'budget fetch');
  await new Promise((r) => setTimeout(r, 30));
  return page;
}
const text = (n: { textContent: string }) => n.textContent.replace(/\s+/g, ' ').trim();

describe('E4-6 panel structure', () => {
  it('is a .g section next to the alerts with label, history link and column layout', async () => {
    const page = await overview(report());
    const panel = page.$('budget');
    assert.match(panel.className, /\bg\b/);
    assert.equal(panel.hidden, false);
    assert.equal(panel.parentElement?.className, 'ov-pair');
    assert.equal(page.$('alerts').parentElement?.className, 'ov-pair');
    assert.match(page.$('budget-title').className, /\blbl\b/);
    assert.equal(text(page.$('budget-title')), 'Context-Budget · heute');
    const more = panel.querySelectorAll('a').find((a) => text(a) === 'Verlauf →');
    assert.equal(more?.getAttribute('href'), '/stats');
    assert.ok(DASHBOARD_HTML.includes('flex: 1 1 340px'));
    assert.ok(DASHBOARD_HTML.includes('flex-direction: column; gap: 14px'));
    assert.ok(DASHBOARD_HTML.includes('84px minmax(0, 1fr) 44px 52px'));
  });
});

describe('E4-6 windows', () => {
  it('with forecast: hatch from actual to 100 %, colours and text', async () => {
    const page = await overview(report({ used: 1_500_000, burn: 2000 }));
    const [five, seven] = page.query('.budget-win');
    const bar = five!.querySelectorAll('.ui-bar')[0]!;
    assert.equal(bar.getAttribute('aria-valuenow'), '75');
    assert.ok(bar.classList.contains('ui-bar-h10'));
    const hatch = bar.querySelectorAll('.ui-bar-forecast');
    assert.equal(hatch.length, 1);
    assert.equal(parseFloat(String(hatch[0]!.style.left)), 75);
    assert.equal(parseFloat(String(hatch[0]!.style.width)), 25);
    assert.equal(hatch[0]!.style.getPropertyValue('--hatch'), 'rgba(251,191,36,.45)');
    const pct = five!.querySelectorAll('.budget-win-pct')[0]!;
    assert.equal(text(pct), '75 %');
    assert.equal(pct.style.color, '#fbbf24');
    assert.equal(text(five!.querySelectorAll('.budget-win-text')[0]!), `Burn 120k Tokens/h · Limit ca. ${hm(ETA)} · Reset ${hm(RESET)}`);
    // week at 90 % without ETA: red, no hatch
    assert.equal(seven!.querySelectorAll('.budget-win-pct')[0]!.style.color, UI_RED);
    assert.notEqual(seven!.querySelectorAll('.budget-win-pct')[0]!.style.color, '#7dd3fc');
    assert.equal(seven!.querySelectorAll('.ui-bar-forecast').length, 0);
  });

  it('week window uses sky below 85 %', async () => {
    const page = await overview(report({}, { used: 10_000_000, limit: 20_000_000, eta: null }));
    assert.equal(page.query('.budget-win-pct')[1]!.style.color, '#7dd3fc');
  });

  it('without forecast: no hatch, "reicht bei aktuellem Tempo"; without burn only the reset', async () => {
    const page = await overview(report({ eta: null }, { used: 1_000_000, limit: 20_000_000, eta: null }));
    const five = page.query('.budget-win')[0]!;
    assert.equal(five.querySelectorAll('.ui-bar-forecast').length, 0);
    const t = text(five.querySelectorAll('.budget-win-text')[0]!);
    assert.match(t, /^Reset .+ \d\d:\d\d · reicht bei aktuellem Tempo$/);
    const still = await overview(report({ eta: null, burn: 0 }));
    assert.equal(text(still.query('.budget-win-text')[0]!), `Reset ${hm(RESET)}`);
    assert.equal(still.query('.ui-bar-forecast').length, 0);
  });

  it('unknown limit shows a dash, no hatch and no NaN', async () => {
    const page = await overview(report({ limit: null }));
    const five = page.query('.budget-win')[0]!;
    assert.equal(text(five.querySelectorAll('.budget-win-pct')[0]!), '—');
    assert.equal(five.querySelectorAll('.ui-bar-forecast').length, 0);
    assert.doesNotMatch(text(five), /NaN/);
  });

  it('without data (error or zero usage): bars at 0 %, empty text, no hatch, no roles', async () => {
    for (const b of [new Error('offline'), report({ used: 0, byRole: { developer: 5 } }, { used: 0 })]) {
      const page = await overview(b);
      assert.equal(page.$('budget').hidden, false);
      const wins = page.query('.budget-win');
      assert.equal(wins.length, 2);
      for (const w of wins) {
        assert.equal(w.querySelectorAll('.ui-bar')[0]!.getAttribute('aria-valuenow'), '0');
        assert.equal(text(w.querySelectorAll('.budget-win-pct')[0]!), '0 %');
        assert.equal(text(w.querySelectorAll('.budget-win-text')[0]!), 'Noch kein Verbrauch heute');
      }
      assert.equal(page.query('.ui-bar-forecast').length, 0);
      assert.equal(page.query('.budget-roles').length, 0);
    }
  });
});

describe('E4-6 tokens per role', () => {
  it('sorted descending, compact tokens, shares, roles without usage missing', async () => {
    const page = await overview(report({ byRole: { analyst: 640_000, developer: 1_200_000, tester: 0, reviewer: 160_000 } }));
    const names = page.query('.budget-role-name').map(text);
    assert.deepEqual(names, ['Developer', 'Analyst', 'Reviewer']);
    assert.deepEqual(page.query('.budget-role-tok').map(text), ['1.2M', '640k', '160k']);
    assert.deepEqual(page.query('.budget-role-pct').map(text), ['60 %', '32 %', '8 %']);
    const bars = page.query('.budget-role-grid .ui-bar');
    assert.equal(bars.length, 3);
    assert.ok(bars[0]!.classList.contains('ui-bar-h6'));
    assert.equal(bars[0]!.querySelectorAll('.ui-bar-fill')[0]!.style.background, ROLE_COLORS.developer);
    assert.equal(text(page.query('.budget-roles .lbl')[0]!), 'Tokens je Rolle');
  });
});

describe('E4-6 hot context cards', () => {
  const running = (id: string, percent: number | null) => {
    const r = structuredClone(issueRow().running as Record<string, unknown>);
    return { ...r, issue_id: id, issue_identifier: `acme/app#${id}`, role: 'developer', context: { tokens: 144_000, window: 200_000, percent, compacts: 0 } };
  };
  it('none below 70 %', async () => {
    const page = await overview(report(), dashboardState({ running: [running('1', 10), running('2', null)] }));
    assert.equal(page.query('.budget-hot').length, 0);
  });
  it('one card with the full text', async () => {
    const page = await overview(report(), dashboardState({ running: [running('7', 72)] }));
    const cards = page.query('.budget-hot');
    assert.equal(cards.length, 1);
    assert.match(cards[0]!.className, /\bgi\b/);
    assert.equal(cards[0]!.querySelectorAll('.dot.tone-amber').length, 1);
    assert.equal(text(cards[0]!), '#7 Developer bei 72 % Context (144k / 200k) – Auto-Compact naht');
  });
  it('two cards from 70 % on, fullest first', async () => {
    const page = await overview(report(), dashboardState({ running: [running('1', 95), running('2', 70), running('3', 30)] }));
    const cards = page.query('.budget-hot');
    assert.equal(cards.length, 2);
    assert.match(text(cards[0]!), /^#1 .* 95 %/);
    assert.match(text(cards[1]!), /^#2 .* 70 %/);
  });
});

describe('E4-6 5h chip', () => {
  const chip = async (budget: unknown) => {
    const page = renderPage(TASKS_HTML, undefined, { fetch: (u) => { if (u !== '/api/v1/budget') return {}; if (budget instanceof Error) throw budget; return budget; } });
    await until(() => page.fetches.some((f) => f.url === '/api/v1/budget'), 3_000, 'budget fetch');
    await new Promise((r) => setTimeout(r, 20));
    return page;
  };
  it('dash without data', async () => {
    for (const b of [new Error('x'), { nope: 1 }]) {
      const page = await chip(b);
      assert.equal(text(page.$('shell-budget')), '5h —');
      assert.doesNotMatch((page.$('shell-budget').children.map((c) => c.className).join(' ')), /tone-/);
    }
  });
  it('40 % neutral, 62 % amber, 90 % red, alert alone stays neutral', async () => {
    const at = async (used: number, alert = false) => chip(report({ used, alert }));
    const p40 = await at(800_000, true);
    assert.equal(text(p40.$('shell-budget')), '5h 40 %');
    assert.doesNotMatch((p40.$('shell-budget').children.map((c) => c.className).join(' ')), /tone-/);
    const p62 = await at(1_240_000);
    assert.equal(text(p62.$('shell-budget')), '5h 62 %');
    assert.match((p62.$('shell-budget').children.map((c) => c.className).join(' ')), /tone-amber/);
    const p90 = await at(1_800_000);
    assert.match((p90.$('shell-budget').children.map((c) => c.className).join(' ')), /tone-red/);
  });
  it('title with reset time and link to /#budget', async () => {
    const page = await chip(report());
    assert.equal(page.$('shell-budget').getAttribute('title'), `5-h-Fenster · Reset ${hm(RESET)}`);
    assert.equal(page.$('shell-budget').getAttribute('href'), '/#budget');
  });
});
