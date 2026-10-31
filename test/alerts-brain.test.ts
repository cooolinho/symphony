import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALERTS_JS } from '../src/http/alerts.ts';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { FakeElement, domContext, run } from './helpers/fake-dom.ts';
import { renderPage } from './helpers.ts';
import { dashboardState } from './helpers/page-fixtures.ts';

// E2-4b (#373): brain alerts (open write clashes, candidate backlog) in the alerts panel. Independent of the developer's tests.
const ctx = domContext(BASE_JS, ALERTS_JS);
const T = (hm: string) => `2026-10-30T${hm}:00Z`;
const settle = () => new Promise((resolve) => setImmediate(resolve));

const clash = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  path: 'Wiki/a.md',
  runs: ['acme/app#1', 'acme/app#2'],
  at: [T('10:00'), T('11:00')],
  reason: 'hash mismatch',
  status: 'open',
  ...over,
});
const hold = { model: 'opus', source: 'limit', since: T('11:30'), until: T('14:00'), text: 'weekly limit', issue_identifier: 'acme/app#3' };

const list = (s: unknown, b: unknown, brain?: unknown): any[] => {
  ctx.__s = s;
  ctx.__b = b;
  ctx.__r = brain;
  return JSON.parse(JSON.stringify(run(ctx, 'alerts(__s, __b, __r)')));
};
const render = (l: unknown) => {
  const host = new FakeElement('ul');
  const count = new FakeElement('span');
  ctx.__l = l;
  ctx.__h = host;
  ctx.__c = count;
  run(ctx, 'renderAlerts(__l, __h, __c)');
  return { host, count };
};

describe('brain alerts: alerts() unit', () => {
  it('threshold boundary: 0, 24 none; 25, 26, 1000 exactly one backlog entry with its own count', () => {
    for (const n of [0, 1, 24]) assert.equal(list({ health: {} }, null, { clashes: [], candidates: n }).length, 0, String(n));
    for (const n of [25, 26, 1000]) {
      const l = list({ health: {} }, null, { clashes: [], candidates: n });
      assert.equal(l.length, 1, String(n));
      assert.equal(l[0].kind, 'brain_backlog');
      assert.equal(l[0].title, `${n} Kandidaten warten auf Review`);
      assert.equal(l[0].href, '/brain#candidates');
    }
  });

  it('the threshold is a client constant of 25', () => {
    assert.equal(run(ctx, 'BRAIN_BACKLOG_THRESHOLD'), 25);
    assert.match(ALERTS_JS, /BRAIN_BACKLOG_THRESHOLD\s*=\s*25/);
  });

  it('invalid candidate counts never produce a backlog entry or garbage text', () => {
    for (const candidates of [undefined, null, 'abc', Number.NaN]) {
      const l = list({ health: {} }, null, { clashes: [], candidates });
      assert.equal(l.filter((a) => a.kind === 'brain_backlog').length, 0, String(candidates));
    }
  });

  it('every open clash becomes its own entry, in input order of equal times, each linking to /brain#clashes', () => {
    const l = list({ health: {} }, null, { clashes: [clash({ id: 'a', path: 'one.md' }), clash({ id: 'b', path: 'two.md' }), clash({ id: 'c', path: 'three.md' })], candidates: 3 });
    assert.equal(l.length, 3);
    assert.ok(l.every((a) => a.kind === 'brain_clash' && a.href === '/brain#clashes'));
    assert.deepEqual(l.map((a) => a.title).sort(), ['one.md', 'three.md', 'two.md']);
  });

  it('clash text names both runs and the reason; a missing earlier run shows a dash, never null/undefined', () => {
    const [a] = list({ health: {} }, null, { clashes: [clash({ runs: [null, 'acme/app#9'], at: [null, T('11:10')] })], candidates: 0 });
    assert.match(a.text, /acme\/app#9/);
    assert.match(a.text, /hash mismatch/);
    assert.match(a.text, /—/);
    assert.doesNotMatch(`${a.title} ${a.text}`, /null|undefined|NaN/);
    assert.equal(a.at, T('11:10'));
  });

  it('time of a clash entry is the rejected write (at[1]), not the earlier one', () => {
    const [a] = list({ health: {} }, null, { clashes: [clash({ at: [T('08:00'), T('09:00')] })], candidates: 0 });
    assert.equal(a.at, T('09:00'));
  });

  it('brain entries sort into the list by time; backlog (no timestamp) comes last', () => {
    const l = list(
      { health: { last_tracker_error: { at: T('09:00'), message: 'boom' } }, model_holds: [hold] },
      null,
      { clashes: [clash({ at: [null, T('11:00')] })], candidates: 40 },
    );
    assert.deepEqual(l.map((a) => a.kind), ['model_hold', 'brain_clash', 'attention', 'brain_backlog']);
  });

  it('brain data does not change the existing kinds (with and without brain)', () => {
    const state = { health: { last_tracker_error: { at: T('09:00'), message: 'boom' } }, model_holds: [hold] };
    const without = list(state, null);
    const withBrain = list(state, null, { clashes: [clash()], candidates: 30 }).filter((a) => !a.kind.startsWith('brain_'));
    assert.deepEqual(withBrain, without);
  });

  it('brain without clashes field or empty object adds nothing and does not throw', () => {
    assert.deepEqual(list({ health: {} }, null, {}), []);
    assert.deepEqual(list({ health: {} }, null, { candidates: 3 }), []);
    assert.deepEqual(list({ health: {} }, null, undefined), []);
  });

  it('both new kinds have a label and a tone class that exist in the CSS', () => {
    const { host } = render(list({ health: {} }, null, { clashes: [clash()], candidates: 25 }));
    const cards = host.children.map((li) => li.querySelector('a')!);
    const clashCard = cards.find((c) => c.classList.contains('kind-brain_clash'))!;
    const backlogCard = cards.find((c) => c.classList.contains('kind-brain_backlog'))!;
    assert.ok(clashCard && backlogCard);
    for (const card of [clashCard, backlogCard]) {
      const tone = ['alert-red', 'alert-amber'].find((t) => card.classList.contains(t));
      assert.ok(tone, 'has a tone class');
      assert.ok(!card.classList.contains('alert-undefined'));
      assert.ok(card.querySelector('.alert-kind')!.textContent.length > 0);
      assert.notEqual(card.querySelector('.alert-kind')!.textContent, 'undefined');
    }
    assert.match(backlogCard.querySelector('.alert-title')!.textContent, /25 Kandidaten warten auf Review/);
  });

  it('counter counts the new kinds together with old ones; "Alles ruhig" only without any entry', () => {
    const state = { health: {}, model_holds: [hold] };
    const mixed = render(list(state, null, { clashes: [clash(), clash({ id: 'c2' })], candidates: 25 }));
    assert.equal(mixed.count.textContent, '4');
    assert.equal(mixed.host.children.length, 4);
    assert.doesNotMatch(mixed.host.textContent, /Alles ruhig/);
    const onlyBacklog = render(list({ health: {} }, null, { clashes: [], candidates: 25 }));
    assert.equal(onlyBacklog.count.textContent, '1');
    assert.doesNotMatch(onlyBacklog.host.textContent, /Alles ruhig/);
    const calm = render(list({ health: {} }, null, { clashes: [], candidates: 24 }));
    assert.equal(calm.count.textContent, '0');
    assert.match(calm.host.textContent, /Alles ruhig/);
  });

  it('brain data is rendered as text, never as markup', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const { host } = render(list({ health: {} }, null, { clashes: [clash({ path: evil, reason: evil })], candidates: 0 }));
    assert.ok(host.textContent.includes(evil));
    assert.equal(host.descendants().filter((e) => e.tagName === 'img').length, 0);
  });
});

describe('brain alerts: overview page', () => {
  type Answer = unknown;
  async function open(clashes: Answer, vitals: Answer, state: Record<string, unknown> = {}) {
    const page = renderPage(DASHBOARD_HTML, undefined, {
      fetch: (url) => {
        if (url.startsWith('/api/v1/brain/clashes')) {
          if (clashes instanceof Error) throw clashes;
          return clashes;
        }
        if (url.startsWith('/api/v1/brain/vitals')) {
          if (vitals instanceof Error) throw vitals;
          return vitals;
        }
        if (url.startsWith('/api/v1/budget')) return { generated_at: T('11:55'), five_hour: null, seven_day: null };
        return dashboardState(state);
      },
    });
    await settle();
    page.render(dashboardState(state));
    await settle();
    return page;
  }
  const rows = (p: Awaited<ReturnType<typeof open>>) => p.$('alerts-list').children;
  const gone = { __status: 404, error: { code: 'brain_disabled' } };

  it('asks exactly the two brain endpoints (open clashes, vitals)', async () => {
    const page = await open({ clashes: [] }, { candidates: 0 });
    const brainUrls = page.fetches.map((f) => f.url).filter((u) => u.includes('/brain/'));
    assert.ok(brainUrls.includes('/api/v1/brain/clashes?status=open'));
    assert.ok(brainUrls.includes('/api/v1/brain/vitals'));
    assert.ok(page.fetches.filter((f) => f.url.includes('/brain/')).every((f) => f.method === 'GET'));
  });

  it('1 open clash + 25 candidates: two entries, counter 2, clash shows path/runs/reason, links as required', async () => {
    const page = await open({ clashes: [clash()] }, { candidates: 25 });
    assert.equal(rows(page).length, 2);
    assert.equal(page.$('alerts-count').textContent, '2');
    const clashRow = rows(page).find((r) => r.querySelector('a')!.href === '/brain#clashes')!;
    assert.match(clashRow.textContent, /Wiki\/a\.md/);
    assert.match(clashRow.textContent, /acme\/app#1/);
    assert.match(clashRow.textContent, /acme\/app#2/);
    assert.match(clashRow.textContent, /hash mismatch/);
    const backlogRow = rows(page).find((r) => r.querySelector('a')!.href === '/brain#candidates')!;
    assert.match(backlogRow.textContent, /25 Kandidaten warten auf Review/);
  });

  it('24 candidates: no backlog entry', async () => {
    const page = await open({ clashes: [] }, { candidates: 24 });
    assert.equal(page.$('alerts-count').textContent, '0');
    assert.doesNotMatch(page.$('alerts-list').textContent, /Kandidaten/);
    assert.match(page.$('alerts-list').textContent, /Alles ruhig/);
  });

  it('404 brain_disabled on both endpoints: no brain entries, no error text, other alerts intact', async () => {
    const page = await open(gone, gone, { model_holds: [hold] });
    assert.equal(rows(page).length, 1);
    assert.match(rows(page)[0]!.textContent, /opus/);
    assert.equal(page.$('alerts-count').textContent, '1');
    const text = page.$('alerts-list').textContent + page.$('ov-subtitle').textContent;
    assert.doesNotMatch(text, /nicht erreichbar|brain_disabled|404|Fehler/);
    assert.equal(page.query('.kind-brain_clash').length + page.query('.kind-brain_backlog').length, 0);
  });

  it('404 on clashes alone (vitals fine) or vitals alone is skipped silently', async () => {
    const a = await open(gone, { candidates: 30 });
    assert.equal(a.$('alerts-count').textContent, '0');
    assert.doesNotMatch(a.$('alerts-list').textContent, /nicht erreichbar/);
    const b = await open({ clashes: [clash()] }, gone);
    assert.equal(b.$('alerts-count').textContent, '0');
    assert.doesNotMatch(b.$('alerts-list').textContent, /nicht erreichbar/);
  });

  it('network errors on the brain endpoints do not produce the offline state or an error entry', async () => {
    const page = await open(new Error('down'), new Error('down'));
    assert.equal(page.$('alerts-count').textContent, '0');
    assert.match(page.$('alerts-list').textContent, /Alles ruhig/);
    assert.doesNotMatch(page.$('ov-subtitle').textContent, /nicht erreichbar/);
  });

  it('garbage answers (no clashes array, non-numeric candidates) do not break the panel', async () => {
    const page = await open({}, { candidates: 'many' });
    assert.equal(page.$('alerts-count').textContent, '0');
    assert.match(page.$('alerts-list').textContent, /Alles ruhig/);
    assert.doesNotMatch(page.$('alerts-list').textContent, /undefined|NaN/);
  });

  it('brain answers arriving after the state was rendered update the panel without a new state', async () => {
    const page = renderPage(DASHBOARD_HTML, undefined, {
      fetch: (url) => {
        if (url.startsWith('/api/v1/brain/clashes')) return { clashes: [clash()] };
        if (url.startsWith('/api/v1/brain/vitals')) return { candidates: 25 };
        if (url.startsWith('/api/v1/budget')) return { five_hour: null, seven_day: null };
        return dashboardState();
      },
    });
    page.render(dashboardState());
    await settle();
    await settle();
    // no further page.render(): the late brain answer must have re-rendered the list itself
    assert.equal(page.$('alerts-count').textContent, '2');
  });

  it('later state polls keep the brain entries (not dropped on re-render)', async () => {
    const page = await open({ clashes: [clash()] }, { candidates: 25 });
    page.render(dashboardState());
    assert.equal(page.$('alerts-count').textContent, '2');
    page.render(dashboardState({ model_holds: [hold] }));
    assert.equal(page.$('alerts-count').textContent, '3');
  });

  it('header status chips are not driven by the brain entries', async () => {
    const page = await open({ clashes: [clash()] }, { candidates: 99 });
    assert.match(page.$('ov-chips').textContent, /Tracker ok.*Workflow gültig/);
  });

  it('the brain entries are links (anchors) with the brain hrefs', async () => {
    const page = await open({ clashes: [clash()] }, { candidates: 25 });
    assert.deepEqual(page.query('#alerts-list a').map((a) => a.href).sort(), ['/brain#candidates', '/brain#clashes']);
  });
});
