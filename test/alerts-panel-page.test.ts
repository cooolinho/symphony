import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { renderPage } from './helpers.ts';
import { dashboardState } from './helpers/page-fixtures.ts';

// E2-4a (#354): the "Hinweise" panel, tested through the whole overview page (fake DOM, frozen clock 2026-10-30T12:00:00Z).
const T = (hm: string) => `2026-10-30T${hm}:00Z`;
const settle = () => new Promise((resolve) => setImmediate(resolve));

const budgetReport = (over: Record<string, unknown> = {}) => ({
  generated_at: T('11:55'),
  five_hour: { alert: true, resets_at: T('13:00'), forecast: { eta: T('12:30'), limit_tokens: 100 } },
  seven_day: { alert: false, resets_at: null, forecast: null },
  ...over,
});
const hold = { model: 'opus', source: 'limit', since: T('11:30'), until: T('14:00'), text: 'weekly limit', issue_identifier: 'acme/app#3' };
const withHealth = (over: Record<string, unknown>) => ({ health: { ...dashboardState().health, ...over } });

/** Page with a budget answer (or a failing budget fetch); the state is rendered once the budget has arrived. */
async function open(state: Record<string, unknown>, budget: unknown) {
  const page = renderPage(DASHBOARD_HTML, undefined, {
    fetch: (url) => {
      if (url.startsWith('/api/v1/budget')) {
        if (budget instanceof Error) throw budget;
        return budget;
      }
      return dashboardState();
    },
  });
  await settle();
  page.render(dashboardState(state));
  await settle();
  return page;
}
const items = (page: Awaited<ReturnType<typeof open>>) => page.$('alerts-list').children;

describe('Hinweise panel on the overview', () => {
  it('is the panel with counter in the head, aria-live on the counter, and replaces the old sections', () => {
    assert.match(DASHBOARD_HTML, /<h2 class="lbl" id="alerts-title">Alerts<\/h2><span class="alerts-badge" id="alerts-count" aria-live="polite" hidden>/);
    assert.doesNotMatch(DASHBOARD_HTML, /Hinweise/);
    assert.doesNotMatch(DASHBOARD_HTML, /id="problems"|id="model-holds"|id="problem-list"|id="model-hold-list"|Needs attention/);
    const page = renderPage(DASHBOARD_HTML, dashboardState());
    assert.equal(page.$('alerts-count').getAttribute('aria-live'), 'polite');
    assert.ok(page.$('alerts-count').classList.contains('alerts-badge'));
    assert.match(page.$('alerts-title').textContent, /^Alerts$/);
    assert.ok(page.$('alerts-title').classList.contains('lbl'));
    assert.equal(page.query('#problems').length + page.query('#model-holds').length, 0);
  });

  it('three sources: three entries, counter 3, newest first, with kind label, relative time, title, text and link', async () => {
    const page = await open(
      { ...withHealth({ last_tracker_error: { at: T('11:00'), message: 'tracker down' } }), model_holds: [hold] },
      budgetReport(),
    );
    const rows = items(page);
    assert.equal(page.$('alerts-count').textContent, '3');
    assert.equal(rows.length, 3);
    // budget 11:55 > hold 11:30 > tracker error 11:00
    assert.match(rows[0]!.textContent, /Limit in Sicht/);
    assert.match(rows[1]!.textContent, /opus/);
    assert.match(rows[2]!.textContent, /Tracker/);
    assert.match(rows[2]!.textContent, /tracker down/);
    assert.deepEqual(rows.map((r) => r.querySelector('a')!.href), ['/stats', '/issue?id=acme%2Fapp%233', '/stats']);
    assert.deepEqual(rows.map((r) => /vor \d+ (min|h)|gerade eben/.exec(r.textContent)?.[0]), ['vor 5 min', 'vor 30 min', 'vor 1 h']);
    assert.deepEqual(rows.map((r) => r.querySelector('.alert-kind')!.textContent), ['Limit-Prognose', 'Model-Hold', 'Fehler']);
  });

  it('needs-human issues link to the issue page, also from the parked list, once per issue', async () => {
    const row = { issue_identifier: 'acme/app#12', title: 'Frage an den Operator', labels: ['needs-human'], updated_at: T('11:50') };
    const page = await open({ blocked: [row], issues: [row] }, budgetReport({ five_hour: null }));
    const rows = items(page);
    assert.equal(rows.length, 1);
    assert.equal(page.$('alerts-count').textContent, '1');
    assert.equal(rows[0]!.querySelector('a')!.href, '/issue?id=acme%2Fapp%2312');
    assert.match(rows[0]!.textContent, /Frage an den Operator/);
    assert.match(rows[0]!.textContent, /vor 10 min/);
  });

  it('shows the German empty state with a green dot and counter 0', async () => {
    const calm = await open({}, budgetReport({ five_hour: null }));
    assert.equal(calm.$('alerts-count').textContent, '0');
    assert.equal(items(calm).length, 1);
    assert.match(items(calm)[0]!.textContent, /Alles ruhig/);
    assert.ok(calm.$('alerts-list').querySelector('.dot.tone-green'));
    assert.equal(calm.query('#alerts-list a').length, 0);
  });

  it('rerendering replaces the entries instead of appending', async () => {
    const page = await open({ model_holds: [hold] }, null);
    assert.equal(items(page).length, 1);
    page.render(dashboardState({ model_holds: [hold, { ...hold, model: 'sonnet', since: T('11:40') }] }));
    assert.equal(items(page).length, 2);
    assert.equal(page.$('alerts-count').textContent, '2');
    page.render(dashboardState({ model_holds: [] }));
    assert.equal(page.$('alerts-count').textContent, '0');
    assert.match(page.$('alerts-list').textContent, /Alles ruhig/);
  });

  it('operator pause of a model is a hint linking to /stats without an issue', async () => {
    const page = await open({ model_holds: [{ model: 'opus', source: 'operator', since: T('11:00'), until: null, text: null, issue_identifier: null }] }, null);
    assert.equal(items(page).length, 1);
    assert.match(items(page)[0]!.textContent, /opus pausiert · vom Operator angehalten/);
    assert.equal(items(page)[0]!.querySelector('a')!.href, '/stats');
  });

  it('collects workflow, dispatch, tracker, pricing and slot problems as attention entries linking to /stats', async () => {
    const page = await open(
      {
        ...withHealth({
          workflow_error: { message: 'wf broken' },
          dispatch_errors: ['WORKFLOW.md: wf broken', 'no token'],
          last_tracker_error: { at: T('11:00'), message: 'tracker down' },
          pricing_error: 'pricing broken',
        }),
        limits: { ...dashboardState().limits, reservation_problem: 'reserve broken', slot_problems: ['slot broken'] },
      },
      null,
    );
    const text = page.$('alerts-list').textContent;
    for (const t of ['wf broken', 'no token', 'tracker down', 'pricing broken', 'reserve broken', 'slot broken']) assert.ok(text.includes(t), t);
    assert.equal((text.match(/wf broken/g) ?? []).length, 1, 'workflow error is not repeated by the dispatch error');
    assert.equal(page.$('alerts-count').textContent, '6');
    for (const r of items(page)) assert.equal(r.querySelector('a')!.href, '/stats');
  });

  it('status chips in the title block follow tracker and workflow errors', async () => {
    const chips = (p: Awaited<ReturnType<typeof open>>) => p.$('ov-chips').textContent;
    assert.match(chips(await open(withHealth({ last_tracker_error: { at: T('11:00'), message: 'x' } }), null)), /Tracker Fehler/);
    assert.match(chips(await open(withHealth({ workflow_error: { message: 'x' } }), null)), /Workflow ungültig/);
    assert.match(chips(await open({ model_holds: [hold] }, budgetReport())), /Tracker ok.*Workflow gültig/);
  });

  it('writes data as text, never as markup', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const page = await open(withHealth({ pricing_error: evil }), null);
    const row = items(page)[0]!;
    assert.ok(row.textContent.includes(evil));
    assert.equal(row.descendants().filter((e) => e.tagName === 'img').length, 0);
  });
});

describe('Hinweise panel: budget source', () => {
  it('loads /api/v1/budget and shows a hint only for windows with an alert', async () => {
    const page = renderPage(DASHBOARD_HTML, undefined, { fetch: (url) => (url.startsWith('/api/v1/budget') ? budgetReport({ seven_day: { alert: true, resets_at: T('23:00'), forecast: { eta: T('20:00'), limit_tokens: 5 } } }) : dashboardState()) });
    assert.ok(page.fetches.some((f) => f.url.startsWith('/api/v1/budget')), 'budget is fetched');
    await settle();
    page.render(dashboardState());
    await settle();
    const rows = items(page);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.querySelector('a')!.href === '/stats'));
    assert.match(page.$('alerts-list').textContent, /5-h|5 h|5-Stunden/i);
    assert.match(page.$('alerts-list').textContent, /7/);
  });

  it('shows no budget hint without an alert', async () => {
    const page = await open({}, budgetReport({ five_hour: { alert: false, resets_at: null, forecast: null } }));
    assert.equal(page.$('alerts-count').textContent, '0');
  });

  it('a failing budget fetch only drops the budget hints; the rest of the panel keeps working', async () => {
    const page = await open({ model_holds: [hold] }, new Error('budget down'));
    assert.equal(items(page).length, 1);
    assert.match(items(page)[0]!.textContent, /opus/);
    assert.equal(page.$('alerts-count').textContent, '1');
  });

  it('a budget report without windows does not break the panel', async () => {
    const page = await open({}, {});
    assert.equal(page.$('alerts-count').textContent, '0');
    assert.match(page.$('alerts-list').textContent, /Alles ruhig/);
  });
});

describe('Hinweise panel: state fetch fails', () => {
  it('shows the error in the panel and the Offline header instead of breaking', async () => {
    const page = renderPage(DASHBOARD_HTML, undefined, {
      fetch: (url) => {
        if (url.startsWith('/api/v1/budget')) return budgetReport();
        throw new Error('connection refused');
      },
    });
    await settle();
    assert.match(page.$('alerts-list').textContent, /connection refused/);
    assert.ok(Number(page.$('alerts-count').textContent) >= 1);
    assert.match(page.$('ov-subtitle').textContent, /Orchestrator nicht erreichbar/);
  });
});

describe('Hinweise panel: stable refresh (focus and aria-live survive the 2-s poll)', () => {
  it('an unchanged list keeps the very same entry nodes and does not rewrite the counter', async () => {
    const page = await open({ model_holds: [hold] }, budgetReport());
    const before = [...items(page)];
    assert.equal(before.length, 2);
    const counter = page.$('alerts-count');
    let writes = 0;
    const text = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(counter), 'textContent');
    assert.ok(text?.set, 'textContent setter is observable in the fake DOM');
    {
      Object.defineProperty(counter, 'textContent', { get: () => text.get!.call(counter), set: (v) => { writes++; text.set!.call(counter, v); }, configurable: true });
    }
    page.render(dashboardState({ model_holds: [hold] }));
    const after = [...items(page)];
    assert.equal(after.length, 2);
    assert.ok(after.every((node, i) => node === before[i]), 'entry nodes are reused, a focused link keeps focus');
    assert.equal(writes, 0, 'counter is not rewritten when unchanged');
    assert.equal(counter.textContent, '2');
  });

  it('a changed list updates counter and entries', async () => {
    const page = await open({ model_holds: [hold] }, budgetReport());
    page.render(dashboardState({ model_holds: [] }));
    assert.equal(page.$('alerts-count').textContent, '1');
    assert.equal(items(page).length, 1);
    page.render(dashboardState({ model_holds: [hold, { ...hold, model: 'sonnet', since: T('11:40') }] }));
    assert.equal(page.$('alerts-count').textContent, '3');
    assert.equal(items(page).length, 3);
  });

  it('switching to the empty state and back leaves no stale entries', async () => {
    const page = await open({}, null);
    assert.match(page.$('alerts-list').textContent, /Alles ruhig/);
    page.render(dashboardState({ model_holds: [hold] }));
    assert.equal(items(page).length, 1);
    assert.doesNotMatch(page.$('alerts-list').textContent, /Alles ruhig/);
    page.render(dashboardState());
    assert.equal(items(page).length, 1);
    assert.match(page.$('alerts-list').textContent, /Alles ruhig/);
    assert.equal(page.$('alerts-count').textContent, '0');
  });

  it('budget hint mentions the reset only when the window has resets_at', async () => {
    const withReset = await open({}, budgetReport());
    assert.match(withReset.$('alerts-list').textContent, /Reset/);
    const without = await open({}, budgetReport({ five_hour: { alert: true, resets_at: null, forecast: { eta: T('12:30'), limit_tokens: 100 } } }));
    assert.equal(items(without).length, 1);
    assert.doesNotMatch(without.$('alerts-list').textContent, /Reset/);
    assert.doesNotMatch(without.$('alerts-list').textContent, /undefined|null|NaN|Invalid/);
  });
});

describe('Hinweise panel: brain source', () => {
  const clash = { id: 'c1', path: 'Wiki/a.md', runs: ['acme/app#1', 'acme/app#2'], at: [T('11:00'), T('11:30')], reason: 'stale base', status: 'open' };
  async function openBrain(clashes: unknown, vitals: unknown) {
    const page = renderPage(DASHBOARD_HTML, undefined, {
      fetch: (url) => {
        if (url.startsWith('/api/v1/brain/clashes')) {
          if (clashes instanceof Error) throw clashes;
          return clashes;
        }
        if (url.startsWith('/api/v1/brain/vitals')) return vitals;
        return dashboardState();
      },
    });
    await settle();
    page.render(dashboardState());
    await settle();
    return page;
  }

  it('one open clash and 25 candidates: two new entries, counted, linking to the brain page', async () => {
    const page = await openBrain({ clashes: [clash] }, { candidates: 25 });
    assert.ok(page.fetches.some((f) => f.url === '/api/v1/brain/clashes?status=open'));
    assert.equal(items(page).length, 2);
    assert.equal(page.$('alerts-count').textContent, '2');
    assert.deepEqual(items(page).map((r) => r.querySelector('a')!.href).sort(), ['/brain#candidates', '/brain#clashes']);
    assert.match(page.$('alerts-list').textContent, /Wiki\/a\.md/);
    assert.match(page.$('alerts-list').textContent, /25 Kandidaten warten auf Review/);
    assert.doesNotMatch(page.$('alerts-list').textContent, /Alles ruhig/);
  });

  it('24 candidates and no clash: no brain entry', async () => {
    const page = await openBrain({ clashes: [] }, { candidates: 24 });
    assert.equal(page.$('alerts-count').textContent, '0');
    assert.match(page.$('alerts-list').textContent, /Alles ruhig/);
  });

  it('404 brain_disabled: no brain entries and no error', async () => {
    const page = await openBrain({ __status: 404, error: { code: 'brain_disabled' } }, { __status: 404, error: { code: 'brain_disabled' } });
    assert.equal(page.$('alerts-count').textContent, '0');
    assert.match(page.$('alerts-list').textContent, /Alles ruhig/);
    assert.doesNotMatch(page.$('alerts-list').textContent, /nicht erreichbar|brain/i);
  });

  it('a failing brain fetch is skipped silently', async () => {
    const page = await openBrain(new Error('down'), { candidates: 30 });
    assert.equal(page.$('alerts-count').textContent, '0');
  });
});
