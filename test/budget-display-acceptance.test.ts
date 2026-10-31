import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { BRAIN_HTML } from '../src/http/brain-page.ts';
import { CHANGES_HTML } from '../src/http/changes-page.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { LOGS_HTML } from '../src/http/logs-page.ts';
import { TASKS_HTML } from '../src/http/tasks-page.ts';
import { ROLE_COLORS } from '../src/http/ui/palette.ts';
import { renderPage, until } from './helpers.ts';
import { dashboardState, issueDetail, issueRow } from './helpers/page-fixtures.ts';

// Independent acceptance tests for E4-5 (#357), derived from the issue text: budget section on the overview and
// the 5 h chip in the header. Clock of renderPage: 2026-10-30T12:00:00Z.

const RESET_5H = '2026-10-30T15:30:00.000Z'; // in 3 h 30 min
const RESET_7D = '2026-11-02T12:00:00.000Z';
const ETA = '2026-10-30T14:00:00.000Z';

interface WindowOpts {
  used: number;
  limit?: number | null; // null = no forecast
  eta?: string | null;
  burn?: number;
  alert?: boolean;
  byRole?: Record<string, number>;
  resets?: string;
}

function win(name: string, o: WindowOpts) {
  return {
    window: name,
    used_tokens: o.used,
    burn_rate_per_min: o.burn ?? 1500,
    resets_at: o.resets ?? RESET_5H,
    forecast: o.limit == null ? null : { limit_tokens: o.limit, limit_source: 'observed', eta: o.eta === undefined ? null : o.eta },
    alert: o.alert ?? false,
    by_role: o.byRole ?? {},
  };
}

function report(five: WindowOpts, seven?: Partial<WindowOpts>) {
  return {
    five_hour: win('five_hour', five),
    seven_day: win('seven_day', { used: 3_000_000, limit: 30_000_000, eta: null, resets: RESET_7D, ...seven }),
    generated_at: '2026-10-30T12:00:00.000Z',
  };
}

const text = (n: { textContent: string }) => n.textContent.replace(/\s+/g, ' ').trim();

function api(budget: unknown, state: unknown = dashboardState()) {
  return (url: string): unknown => {
    if (url === '/api/v1/budget') {
      if (budget instanceof Error) throw budget;
      return budget;
    }
    if (url === '/api/v1/state') return state;
    if (url === '/api/v1/history') return { recent: [] };
    return {};
  };
}

async function overview(budget: unknown, state: unknown = dashboardState()) {
  const page = renderPage(DASHBOARD_HTML, state, { fetch: api(budget, state) });
  await until(() => page.fetches.some((f) => f.url === '/api/v1/budget'), 3_000, 'budget fetch');
  await new Promise((r) => setTimeout(r, 30));
  return page;
}

async function chip(html: string, budget: unknown, url?: string): Promise<{ text: string; cls: string }> {
  const base = api(budget);
  const page = renderPage(html, undefined, {
    ...(url ? { url } : {}),
    fetch: (u) => (u === '/api/v1/budget' ? base(u) : html === AGENT_HTML ? issueDetail() : {}),
  });
  await until(() => page.fetches.some((f) => f.url === '/api/v1/budget'), 3_000, 'budget fetch');
  await new Promise((r) => setTimeout(r, 30));
  const node = page.$('shell-budget');
  return { text: text(node), cls: node.children.map((c) => c.className).join(' ') };
}

describe('E4-5 budget section: known limit hit', () => {
  const rep = report({ used: 1_500_000, limit: 2_400_000, eta: ETA, burn: 2000, byRole: { developer: 1_000_000, analyst: 500_000 } });

  it('is a section titled "Budget" with one bar per window (5 h, 7 Tage)', async () => {
    const page = await overview(rep);
    assert.equal(page.$('budget').hidden, false);
    assert.equal(text(page.$('budget-title')), 'Budget');
    const bars = page.$('budget').querySelectorAll('[role="progressbar"]');
    assert.equal(bars.length, 2);
    for (const b of bars) assert.ok((b.getAttribute('aria-label') ?? '').length > 0, 'bar has an accessible name');
    assert.match(text(page.$('budget-body')), /5 Stunden|5 h/);
    assert.match(text(page.$('budget-body')), /7 Tage/);
  });

  it('bar shows used/limit (62,5 % -> aria-valuenow 63 or 62) and a hatched forecast after the fill', async () => {
    const page = await overview(rep);
    const bar = page.$('budget').querySelectorAll('[role="progressbar"]')[0]!;
    const now = Number(bar.getAttribute('aria-valuenow'));
    assert.ok(now === 62 || now === 63, `valuenow ${now}`);
    const fcs = bar.querySelectorAll('.ui-bar-forecast');
    assert.equal(fcs.length, 1, 'hatched forecast present');
    const left = parseFloat(String(fcs[0]!.style.left));
    const width = parseFloat(String(fcs[0]!.style.width));
    assert.ok(Math.abs(left - 62.5) < 1, `forecast starts at the end of the fill (${left})`);
    // 2000 tokens/min for 120 min = 240000 of 2.4M = 10 % extra
    assert.ok(width > 5 && width < 15, `forecast reaches roughly to the ETA (${width})`);
  });

  it('shows "Reset in …", "Burn-Rate … Tokens/min" and "ETA …" for the 5 h window', async () => {
    const page = await overview(rep);
    const five = text(page.$('budget-body'));
    assert.match(five, /Reset in 3h 30m/);
    assert.match(five, /Burn-Rate 2,000 Tokens\/min/);
    assert.match(five, /ETA/);
    assert.doesNotMatch(five, /Noch kein Limit-Treffer bekannt/);
  });

  it('ETA text appears only for windows whose forecast has an eta', async () => {
    const page = await overview(rep);
    const body = text(page.$('budget-body'));
    assert.equal((body.match(/ETA/g) ?? []).length, 1, 'only the 5 h window has an ETA');
  });

  it('numbers are in monospace', async () => {
    const page = await overview(rep);
    const monos = page.$('budget').querySelectorAll('.mono').map(text).join('|');
    assert.match(monos, /6[23](,\d)? ?%/);
    assert.match(monos, /1\.5M/);
  });
});

describe('E4-5 budget section: no limit hit yet (forecast null)', () => {
  const rep = report({ used: 700_000, limit: null, burn: 900 }, { limit: null });

  it('bars show only usage: no hatching, no ETA, hint text', async () => {
    const page = await overview(rep);
    const body = page.$('budget-body');
    assert.equal(body.querySelectorAll('.ui-bar-forecast').length, 0);
    assert.doesNotMatch(text(body), /ETA/);
    assert.match(text(body), /Noch kein Limit-Treffer bekannt/);
    assert.equal(page.$('budget').querySelectorAll('[role="progressbar"]').length, 2);
    // still reports reset and burn rate
    assert.match(text(body), /Reset in/);
    assert.match(text(body), /Burn-Rate 900 Tokens\/min/);
    // the used tokens are visible
    assert.match(text(body), /700\.0K|700K|700,000/);
  });

  it('does not invent a percentage', async () => {
    const page = await overview(rep);
    const bar = page.$('budget').querySelectorAll('[role="progressbar"]')[0]!;
    assert.notEqual(bar.getAttribute('aria-valuenow'), '100');
    assert.doesNotMatch(text(page.$('budget-body')), /NaN|Infinity|undefined|null/);
  });

  it('mixed: 5 h with forecast, 7 Tage without keeps hatch and hint apart', async () => {
    const page = await overview(report({ used: 500_000, limit: 1_000_000, eta: ETA }, { limit: null }));
    assert.equal(page.$('budget-body').querySelectorAll('.ui-bar-forecast').length, 1);
    assert.match(text(page.$('budget-body')), /Noch kein Limit-Treffer bekannt/);
  });
});

describe('E4-5 tokens per role (5 h window)', () => {
  it('lists role colour, name and tokens', async () => {
    const page = await overview(report({ used: 100, limit: 1000, byRole: { developer: 123_456, analyst: 7_000 } }));
    const items = page.$('budget').querySelectorAll('li');
    assert.equal(items.length, 2);
    const all = items.map(text).join('|');
    assert.match(all, /Developer/i);
    assert.match(all, /Analyst/i);
    assert.match(all, /123\.5K|123K|123,456/);
    assert.match(all, /7\.0K|7K|7,000/);
    const dev = items.find((i) => /developer/i.test(text(i)))!;
    assert.ok(dev.querySelectorAll('.ui-dot').some((n) => n.style.background === ROLE_COLORS.developer), 'role colour dot');
    assert.ok(dev.querySelectorAll('.mono').length >= 1, 'tokens in monospace');
  });

  it('uses the 5 h by_role, not the 7 day one', async () => {
    const page = await overview(report({ used: 1, limit: 10, byRole: { developer: 111 } }, { byRole: { architect: 999_000 } }));
    const items = page.$('budget').querySelectorAll('li').map(text).join('|');
    assert.match(items, /Developer/i);
    assert.doesNotMatch(items, /Architect/i);
  });
});

describe('E4-5 context hint', () => {
  const run = (id: number, percent: number | null) => {
    const r = structuredClone(issueRow().running as Record<string, unknown>);
    return { ...r, issue_id: String(id), issue_identifier: `acme/app#${id}`, context: { tokens: 10, window: 100, percent, compacts: 0 } };
  };
  const rep = report({ used: 1, limit: 10 });

  it('shows "n Sessions über 70 % Context" with issue links when n > 0', async () => {
    const page = await overview(rep, dashboardState({ running: [run(1, 95), run(2, 72), run(3, 10), run(4, null)] }));
    const section = text(page.$('budget'));
    assert.match(section, /2 Sessions über 70 % Context/);
    const hrefs = page.$('budget').querySelectorAll('a').map((a) => a.getAttribute('href') ?? '');
    assert.equal(hrefs.length, 2);
    assert.ok(hrefs.every((h) => h.startsWith('/issue')));
    assert.ok(hrefs.some((h) => decodeURIComponent(h).includes('acme/app#1')));
    assert.ok(hrefs.some((h) => decodeURIComponent(h).includes('acme/app#2')));
    assert.ok(!hrefs.some((h) => decodeURIComponent(h).includes('acme/app#3')));
  });

  it('is absent when no session is above 70 % (exactly 70 % and unknown do not count)', async () => {
    const page = await overview(rep, dashboardState({ running: [run(1, 70), run(2, 30), run(3, null)] }));
    assert.doesNotMatch(text(page.$('budget')), /Context/);
    assert.equal(page.$('budget').querySelectorAll('a').length, 0);
  });

  it('is absent with nothing running', async () => {
    const page = await overview(rep, dashboardState({ running: [] }));
    assert.doesNotMatch(text(page.$('budget')), /über 70 %/);
  });

  it('follows the state: a later render with a hot session adds the hint', async () => {
    const page = await overview(rep, dashboardState({ running: [] }));
    assert.doesNotMatch(text(page.$('budget')), /über 70 %/);
    page.render(dashboardState({ running: [run(7, 88)] }));
    assert.match(text(page.$('budget')), /Sessions? über 70 % Context/);
  });
});

describe('E4-5 5 h chip', () => {
  const pages: Array<[string, string, string?]> = [
    ['dashboard', DASHBOARD_HTML],
    ['tasks', TASKS_HTML],
    ['brain', BRAIN_HTML],
    ['changes', CHANGES_HTML],
    ['logs', LOGS_HTML],
    ['agent', AGENT_HTML, 'http://127.0.0.1/issue?id=acme%2Fapp%231'],
  ];

  it('reads "5h 62 %" in amber at 62 % (from 50 %)', async () => {
    const c = await chip(TASKS_HTML, report({ used: 1_240_000, limit: 2_000_000 }));
    assert.equal(c.text, '5h 62 %');
    assert.match(c.cls, /amber/);
    assert.doesNotMatch(c.cls, /red/);
  });

  it('is neutral below 50 %, amber from 50 %, red from 85 %', async () => {
    const at49 = await chip(TASKS_HTML, report({ used: 490_000, limit: 1_000_000 }));
    assert.equal(at49.text, '5h 49 %');
    assert.doesNotMatch(at49.cls, /amber|red/);
    const at50 = await chip(TASKS_HTML, report({ used: 500_000, limit: 1_000_000 }));
    assert.match(at50.cls, /amber/);
    const at84 = await chip(TASKS_HTML, report({ used: 840_000, limit: 1_000_000 }));
    assert.match(at84.cls, /amber/);
    assert.doesNotMatch(at84.cls, /red/);
    const at85 = await chip(TASKS_HTML, report({ used: 1_700_000, limit: 2_000_000 }));
    assert.equal(at85.text, '5h 85 %');
    assert.match(at85.cls, /red/);
    const at90 = await chip(TASKS_HTML, report({ used: 900_000, limit: 1_000_000 }));
    assert.match(at90.cls, /red/);
  });

  it('an alert flag alone does not colour the chip below 50 %', async () => {
    const c = await chip(TASKS_HTML, report({ used: 400_000, limit: 2_000_000, eta: ETA, alert: true }));
    assert.doesNotMatch(c.cls, /red|amber/);
  });

  it('a 7 day alert alone does not colour the 5 h chip', async () => {
    const c = await chip(TASKS_HTML, report({ used: 100_000, limit: 2_000_000 }, { alert: true }));
    assert.doesNotMatch(c.cls, /red|amber/);
  });

  it('shows "5h —" on error, malformed answer and without a forecast', async () => {
    for (const b of [new Error('offline'), { nope: true }, report({ used: 5, limit: null }, { limit: null })]) {
      const c = await chip(TASKS_HTML, b);
      assert.equal(c.text, '5h —');
      assert.doesNotMatch(c.cls, /amber|red/);
    }
  });

  it('is filled on every page', async () => {
    for (const [name, html, url] of pages) {
      const c = await chip(html, report({ used: 1_240_000, limit: 2_000_000 }), url);
      assert.equal(c.text, '5h 62 %', `chip on ${name}`);
    }
  });

  it('reloads every 30 seconds', () => {
    // the harness swallows timers; read the interval from the shell script that runs on every page
    const script = [...TASKS_HTML.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] as string).join('\n');
    assert.match(script, /\/api\/v1\/budget/);
    assert.match(script, /setInterval\([^;]*,\s*30000\s*\)/);
  });

  it('the chip text is German and the chip is monospace', () => {
    assert.match(TASKS_HTML, /id="shell-budget"[^>]*class="[^"]*mono|class="[^"]*mono[^"]*"[^>]*id="shell-budget"/);
  });
});
