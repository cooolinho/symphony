import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { TASKS_HTML } from '../src/http/tasks-page.ts';
import { renderPage, until } from './helpers.ts';
import { dashboardState, issueRow } from './helpers/page-fixtures.ts';

// E4-6 (#388), independent acceptance tests derived from the issue text. Clock of renderPage: 2026-10-30T12:00:00Z.

const RESET = '2026-10-30T14:30:00.000Z';
const ETA = '2026-10-30T13:15:00.000Z';
const hm = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const text = (n: { textContent: string }) => n.textContent.replace(/\s+/g, ' ').trim();
const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();

interface W { used: number; limit?: number | null; eta?: string | null; burn?: number; byRole?: Record<string, number>; reset?: string | null }
function win(name: string, o: W) {
  return {
    window: name,
    used_tokens: o.used,
    burn_rate_per_min: o.burn ?? 0,
    resets_at: o.reset === undefined ? RESET : o.reset,
    forecast: o.limit === null ? null : { limit_tokens: o.limit ?? 1_000_000, limit_source: 'sdk', eta: o.eta ?? null },
    alert: false,
    by_role: o.byRole ?? {},
  };
}
const report = (five: W, seven: W = { used: 100_000, limit: 1_000_000 }) => ({
  five_hour: win('five_hour', five),
  seven_day: win('seven_day', seven),
  generated_at: '2026-10-30T12:00:00.000Z',
});

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
  await new Promise((r) => setTimeout(r, 40));
  return page;
}
const panel = (page: Awaited<ReturnType<typeof overview>>) => page.$('budget');
const windows = (page: Awaited<ReturnType<typeof overview>>) => panel(page).querySelectorAll('.ui-bar').slice(0, 2);

describe('E4-6 acceptance: panel frame', () => {
  it('has the .g section with id budget, label, history link and the mockup CSS', async () => {
    const page = await overview(report({ used: 400_000 }));
    const p = panel(page);
    assert.equal(p.tagName.toLowerCase(), 'section');
    assert.ok(p.classList.contains('g'));
    const lbl = p.querySelectorAll('.lbl')[0]!;
    assert.equal(text(lbl), 'Context-Budget · heute');
    const link = p.querySelectorAll('a').find((a) => a.getAttribute('href') === '/stats');
    assert.ok(link, 'link to /stats');
    assert.equal(text(link), 'Verlauf →');
    const css = norm(DASHBOARD_HTML);
    assert.ok(css.includes('flex:11340px'), 'flex: 1 1 340px');
    assert.ok(css.includes('flex-direction:column;gap:14px'));
    assert.ok(css.includes('border-top:1pxsolidrgba(255,255,255,.08)'));
    assert.ok(css.includes('grid-template-columns:84pxminmax(0,1fr)44px52px'));
    assert.ok(css.includes('padding:10px12px'));
    assert.ok(css.includes('rgba(251,191,36,.35)'));
    assert.ok(css.includes('font-weight:500'));
    assert.ok(css.includes('22px'));
  });

  it('sits in the same flex row as the alerts panel', async () => {
    const page = await overview(report({ used: 400_000 }));
    const row = panel(page).parentElement!;
    assert.ok(row.contains ? row.contains(page.$('alerts')) : row === page.$('alerts').parentElement);
  });

  it('shows two windows with name and percent', async () => {
    const page = await overview(report({ used: 250_000, limit: 1_000_000 }, { used: 500_000, limit: 1_000_000 }));
    const t = text(panel(page));
    assert.match(t, /25 %/);
    assert.match(t, /50 %/);
    assert.equal(windows(page).length, 2);
    assert.equal(windows(page)[0]!.getAttribute('aria-valuenow'), '25');
    assert.equal(windows(page)[1]!.getAttribute('aria-valuenow'), '50');
  });
});

describe('E4-6 acceptance: window colours', () => {
  const colourOf = async (five: number, seven: number) => {
    const page = await overview(report({ used: five }, { used: seven }));
    const fills = windows(page).map((b) => b.querySelectorAll('.ui-bar-fill')[0]!.style.background);
    const pcts = panel(page).querySelectorAll('.mono').filter((n) => /^\d+ %$/.test(text(n)) && n.style.color);
    return { fills, pcts: pcts.map((n) => n.style.color) };
  };
  it('5h amber, week sky below 85 %', async () => {
    const c = await colourOf(840_000, 840_000);
    assert.deepEqual(c.fills, ['#fbbf24', '#7dd3fc']);
    assert.deepEqual(c.pcts.slice(0, 2), ['#fbbf24', '#7dd3fc']);
  });
  it('red from exactly 85 %', async () => {
    const c = await colourOf(850_000, 850_000);
    assert.equal(c.fills[0], c.fills[1]);
    assert.notEqual(c.fills[0], '#fbbf24');
    assert.notEqual(c.fills[0], '#7dd3fc');
    assert.equal(c.pcts[0], c.pcts[1]);
    assert.notEqual(c.pcts[0], '#fbbf24');
  });
});

describe('E4-6 acceptance: forecast hatch and text', () => {
  it('with forecast: hatch from actual up to the limit, burn per hour in k', async () => {
    const page = await overview(report({ used: 600_000, limit: 1_000_000, eta: ETA, burn: 1500 }));
    const bar = windows(page)[0]!;
    const hatch = bar.querySelectorAll('.ui-bar-forecast');
    assert.equal(hatch.length, 1);
    const left = parseFloat(String(hatch[0]!.style.left));
    const width = parseFloat(String(hatch[0]!.style.width));
    assert.equal(left, 60);
    assert.equal(left + width, 100);
    assert.equal(width, 40);
    assert.ok(panel(page).textContent.includes(`Burn 90k Tokens/h · Limit ca. ${hm(ETA)} · Reset ${hm(RESET)}`));
  });

  it('hatch is coloured per window', async () => {
    const page = await overview(report({ used: 300_000, eta: ETA, burn: 100 }, { used: 300_000, eta: '2026-11-02T10:00:00.000Z', burn: 100 }));
    const h = windows(page).map((b) => b.querySelectorAll('.ui-bar-forecast')[0]!.style.getPropertyValue('--hatch'));
    assert.equal(h[0], 'rgba(251,191,36,.45)');
    assert.equal(h[1], 'rgba(125,211,252,.45)');
    assert.ok(norm(DASHBOARD_HTML).includes('repeating-linear-gradient(135deg,var(--hatch'));
    assert.ok(norm(DASHBOARD_HTML).includes('04px,transparent4px8px'));
  });

  it('without forecast (eta null) before the reset: no hatch, "reicht bei aktuellem Tempo"', async () => {
    const page = await overview(report({ used: 100_000, burn: 500, eta: null }));
    assert.equal(panel(page).querySelectorAll('.ui-bar-forecast').length, 0);
    const t = text(panel(page));
    assert.match(t, /Reset \S+ \d\d:\d\d · reicht bei aktuellem Tempo/);
    assert.ok(!t.includes('Limit ca.'));
  });

  it('without burn rate: only "Reset HH:MM"', async () => {
    const page = await overview(report({ used: 100_000, burn: 0, eta: null }));
    assert.ok(panel(page).textContent.includes(`Reset ${hm(RESET)}`));
    assert.ok(!panel(page).textContent.includes('reicht bei aktuellem Tempo') || panel(page).querySelectorAll('.ui-bar-forecast').length === 0);
    assert.equal(panel(page).querySelectorAll('.ui-bar-forecast').length, 0);
    assert.ok(!/Burn/.test(text(panel(page)).split('Woche')[0]!), 'no Burn text in 5h window');
  });

  it('text is 12.5px and --fg-3', async () => {
    const css = norm(DASHBOARD_HTML);
    assert.ok(css.includes('font-size:12.5px;color:var(--fg-3)'));
  });
});

describe('E4-6 acceptance: no data', () => {
  for (const [name, b] of [
    ['all zero', () => report({ used: 0 }, { used: 0 })],
    ['fetch error', () => new Error('down')],
  ] as const) {
    it(`${name}: panel still there with 0 % bars, empty text, no hatch`, async () => {
      const page = await overview(b());
      assert.equal(panel(page).hidden, false);
      const bars = windows(page);
      assert.equal(bars.length, 2);
      for (const bar of bars) assert.equal(bar.getAttribute('aria-valuenow'), '0');
      const t = text(panel(page));
      assert.equal((t.match(/Noch kein Verbrauch heute/g) ?? []).length, 2);
      assert.equal((t.match(/(?<![0-9])0 %/g) ?? []).length, 2);
      assert.equal(panel(page).querySelectorAll('.ui-bar-forecast').length, 0);
      assert.ok(!t.includes('Tokens je Rolle'));
    });
  }
});

describe('E4-6 acceptance: tokens per role', () => {
  it('sorted descending, compact tokens, no zero roles, bars 6px in role colour', async () => {
    const page = await overview(report({
      used: 500_000,
      byRole: { tester: 0, reviewer: 640_000, developer: 1_200_000, analyst: 160_000 },
    }));
    const p = panel(page);
    assert.ok(text(p).includes('Tokens je Rolle'));
    const t = text(p);
    const iDev = t.search(/developer/i);
    const iRev = t.search(/reviewer/i);
    const iAna = t.search(/analyst/i);
    assert.ok(iDev >= 0 && iDev < iRev && iRev < iAna, `order in: ${t}`);
    assert.ok(!/tester/i.test(t));
    assert.ok(t.includes('1.2M'));
    assert.ok(t.includes('640k'));
    assert.ok(t.includes('160k'));
    // shares of the total 2.0M: 60 / 32 / 8
    assert.ok(/60 %/.test(t) && /32 %/.test(t) && /8 %/.test(t));
    const roleBars = p.querySelectorAll('.ui-bar').slice(2);
    assert.equal(roleBars.length, 3);
    for (const b of roleBars) assert.ok(b.classList.contains('ui-bar-h6'));
    assert.deepEqual(roleBars.map((b) => b.getAttribute('aria-valuenow')), ['60', '32', '8']);
    const fills = roleBars.map((b) => b.querySelectorAll('.ui-bar-fill')[0]!.style.background);
    assert.equal(new Set(fills).size, 3, 'each role has its own colour');
  });

  it('no roles section when no role has consumption', async () => {
    const page = await overview(report({ used: 500_000, byRole: { developer: 0 } }));
    assert.ok(!text(panel(page)).includes('Tokens je Rolle'));
  });
});

describe('E4-6 acceptance: hot context cards', () => {
  const running = (id: string, percent: number | null, tokens = 150_000, window = 200_000) => {
    const r = structuredClone(issueRow().running as Record<string, unknown>);
    return { ...r, issue_id: id, issue_identifier: `acme/app#${id}`, role: 'developer', context: { tokens, window, percent, compacts: 0 } };
  };
  const cards = (page: Awaited<ReturnType<typeof overview>>) => panel(page).querySelectorAll('.gi');

  it('0 sessions over 70 % -> no card', async () => {
    const page = await overview(report({ used: 1 }), dashboardState({ running: [running('1', 69.9), running('2', 12)] }));
    assert.equal(cards(page).length, 0);
  });
  it('1 session -> 1 card with the exact text and amber dot', async () => {
    const page = await overview(report({ used: 1 }), dashboardState({ running: [running('41', 75, 150_000, 200_000), running('2', 10)] }));
    assert.equal(cards(page).length, 1);
    assert.match(text(cards(page)[0]!), /^#41 developer bei 75 % Context \(150k \/ 200k\) – Auto-Compact naht$/i);
    assert.ok(cards(page)[0]!.querySelectorAll('.dot').length >= 1);
  });
  it('2 sessions -> 2 cards, 70 % itself counts', async () => {
    const page = await overview(report({ used: 1 }), dashboardState({ running: [running('5', 70, 140_000), running('6', 91, 182_000), running('7', 50)] }));
    assert.equal(cards(page).length, 2);
    const t = cards(page).map(text).join('|');
    assert.match(t, /#5 .* bei 70 % Context \(140k \/ 200k\)/i);
    assert.match(t, /#6 .* bei 91 % Context \(182k \/ 200k\)/i);
  });
  it('cards also appear without budget data', async () => {
    const page = await overview(new Error('x'), dashboardState({ running: [running('9', 80)] }));
    assert.equal(cards(page).length, 1);
  });
});

describe('E4-6 acceptance: 5h chip', () => {
  const chipPage = async (budget: unknown) => {
    const page = renderPage(TASKS_HTML, undefined, { fetch: (u) => { if (u !== '/api/v1/budget') return {}; if (budget instanceof Error) throw budget; return budget; } });
    await until(() => page.fetches.some((f) => f.url === '/api/v1/budget'), 3_000, 'budget fetch');
    await new Promise((r) => setTimeout(r, 30));
    return page;
  };
  const chipAt = async (pct: number) => chipPage(report({ used: pct * 10_000 }));
  const toneOf = (page: Awaited<ReturnType<typeof chipPage>>) => (page.$('shell-budget').children.map((c) => c.className).join(' '));

  it('— without data (error and malformed)', async () => {
    for (const b of [new Error('x'), {}, { five_hour: null }]) {
      const page = await chipPage(b);
      assert.equal(text(page.$('shell-budget')), '5h —');
    }
  });
  it('40 % neutral', async () => {
    const page = await chipAt(40);
    assert.equal(text(page.$('shell-budget')), '5h 40 %');
    assert.doesNotMatch(toneOf(page), /amber|red/);
  });
  it('62 % amber', async () => {
    const page = await chipAt(62);
    assert.equal(text(page.$('shell-budget')), '5h 62 %');
    assert.match(toneOf(page), /amber/);
  });
  it('90 % red', async () => {
    const page = await chipAt(90);
    assert.equal(text(page.$('shell-budget')), '5h 90 %');
    assert.match(toneOf(page), /red/);
  });
  it('thresholds: 49 neutral, 50 amber, 84 amber, 85 red', async () => {
    assert.doesNotMatch(toneOf(await chipAt(49)), /amber|red/);
    assert.match(toneOf(await chipAt(50)), /amber/);
    assert.match(toneOf(await chipAt(84)), /amber/);
    assert.match(toneOf(await chipAt(85)), /red/);
  });
  it('title with reset time, href to the overview anchor', async () => {
    const page = await chipAt(40);
    assert.equal(page.$('shell-budget').getAttribute('title'), `5-h-Fenster · Reset ${hm(RESET)}`);
    assert.equal(page.$('shell-budget').getAttribute('href'), '/#budget');
  });
  it('chip colours exist in the shell CSS (amber, red, neutral --fg-chip)', async () => {
    const css = norm(TASKS_HTML);
    assert.match(css, /\.shell-budget\{color:var\(--fg-chip\)/);
  });
  it('chip is present on the overview page too and updates with the report', async () => {
    const page = await overview(report({ used: 620_000 }));
    assert.equal(text(page.$('shell-budget')), '5h 62 %');
  });
});
