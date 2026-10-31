import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { renderPage } from './helpers.ts';
import { issueDetail } from './helpers/page-fixtures.ts';

// Independent acceptance tests for E3-6 (#385): head card, stage and the fields Jetzt / Session / Subagents.
// The /team body is built here from the documented shape (seats, active, subagents, trace, compact_threshold) with
// a smaller profile than the developer's fixture, and the checks follow the wording of the issue. Frozen clock 12:00:00.

const URL_ = 'http://127.0.0.1/issue?id=acme%2Fapp%231';
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const seat = (role: string, status: string, verdict: string | null = null, duration_ms: number | null = null, model: string | null = null, kind: string | null = null, round: number | null = null): Obj =>
  ({ role, status, verdict, duration_ms, model, kind, round });
const tool = (name: string, arg: string, at: string): Obj => ({ tool: name, message: `${name}: ${arg}`, at: `2026-10-30T${at}.000Z` });
const sub = (type: string, description: string, status: string, started: string, ended: string | null, total: number): Obj => ({
  tool_use_id: `${type}-${started}`, subagent_type: type, description, status, started_at: started, ended_at: ended,
  tokens: { input_tokens: total, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: total },
});
const TRACE = [tool('Read', 'a.ts', '11:59:10'), tool('Grep', 'needle', '11:59:20'), tool('Bash', 'npm test', '11:59:30'), tool('Edit', 'src/x.ts', '11:59:50')];

function team(over: Obj = {}): Obj {
  return {
    seats: [
      seat('analyst', 'done', 'ready', 61_000, 'haiku', 'analysis', 1),
      seat('developer', 'playing', null, 90_000, 'opus', 'implementation', 1),
      seat('reviewer', 'waiting', null, null, null, 'review'),
      seat('you', 'waiting', null, null, null, 'human'),
    ],
    active: {
      role: 'developer', action: 'Edit src/x.ts', recent_tools: TRACE,
      context: { tokens: 84_000, window: 200_000, percent: 42, compacts: 0 }, turn: 5, max_turns: 30, model: 'opus', effort: 'high',
      tokens: { input_tokens: 500_000, output_tokens: 250_000, total_tokens: 750_000 }, cost_usd: 2.5,
    },
    subagents: { running: [], finished: [] },
    blocks: [],
    handoffs: [],
    trace: TRACE,
    compact_threshold: 80,
    ...over,
  };
}
const IDLE = { active: null, subagents: { running: [], finished: [] } };
const page = (t?: Obj, detail: Obj = issueDetail()) => renderPage(AGENT_HTML, { detail, ...(t ? { team: t } : {}) }, { url: URL_ });
type Page = ReturnType<typeof page>;
const seatOf = (p: Page, role: string) => p.query('#stage-seats .stage-seat').find((s) => s.getAttribute('data-role') === role)!;
const text = (p: Page, id: string) => p.$(id).textContent ?? '';
const headDetail = (over: Obj = {}) => issueDetail({
  profile: 'feature', rounds: { current: 1, max: 3 }, issue_url: 'https://github.com/acme/app/issues/1',
  issue: { ...issueDetail().issue, labels: [], branch_name: null }, ...over,
});

describe('E3-6 independent: head card', () => {
  it('breadcrumb sits above the head card and links Übersicht to /', () => {
    const p = page(team(), headDetail());
    const crumb = p.query('nav a[href="/"]')[0]!;
    assert.equal(crumb.textContent, 'Übersicht');
    assert.ok(AGENT_HTML.indexOf('Übersicht') < AGENT_HTML.indexOf('id="hero"'), 'breadcrumb markup before hero');
    assert.ok(text(p, 'crumb-current').startsWith('#1 Issue one'));
  });

  it('the round chip is amber from round 2 only, and absent without round data', () => {
    const chip = (d: Obj) => page(team(), d).query('#head-chips .ui-chip').filter((c) => !c.hidden).find((c) => (c.textContent ?? '').startsWith('Runde'));
    assert.equal(chip(headDetail({ rounds: { current: 1, max: 3 } }))!.textContent, 'Runde 1 von 3');
    assert.ok(!chip(headDetail({ rounds: { current: 1, max: 3 } }))!.style.color, 'round 1 is not amber');
    assert.equal(chip(headDetail({ rounds: { current: 3, max: 3 } }))!.textContent, 'Runde 3 von 3');
    assert.ok(chip(headDetail({ rounds: { current: 3, max: 3 } }))!.style.color, 'round 3 is amber');
    assert.equal(chip(headDetail({ rounds: null })), undefined);
  });

  it('profile chip only with a profile; complexity chip for every size S, M, L, XL and none without the label', () => {
    const chips = (d: Obj) => page(team(), d).query('#head-chips .ui-chip').filter((c) => !c.hidden).map((c) => c.textContent);
    assert.ok(!chips(headDetail({ profile: null })).some((c) => (c ?? '').startsWith('Profil')));
    assert.ok(chips(headDetail()).includes('Profil feature'));
    for (const size of ['S', 'M', 'L', 'XL']) {
      const labelled = headDetail({ issue: { ...issueDetail().issue, labels: [`complexity: ${size.toLowerCase()}`] } });
      assert.ok(chips(labelled).includes(`Komplexität ${size}`), size);
    }
    assert.ok(!chips(headDetail()).some((c) => (c ?? '').startsWith('Komplexität')));
  });

  it('the live dot is green while a session runs and grey otherwise', () => {
    const running = page(team(), headDetail()).query('#state-slot .ui-dot')[0]!;
    assert.equal(running.style.background, '#34d399');
    const idle = page(team(IDLE), headDetail({ status: 'claimed', running: null })).query('#state-slot .ui-dot')[0]!;
    assert.notEqual(idle.style.background, '#34d399');
    assert.ok(!idle.className.includes('live'));
  });

  it('writes the meta line from the parts that exist, with seven characters of HEAD', () => {
    const base = issueDetail();
    const meta = (over: Obj, run_trace: Obj = {}) => page(team(), headDetail({ issue: { ...base.issue, branch_name: 'b/1' }, run_trace: { ...base.run_trace, ...run_trace }, ...over })).$('head-meta').textContent;
    assert.equal(meta({}, { head_sha: '0123456789abcdef' }), 'acme/app · b/1 · HEAD 0123456');
    assert.equal(meta({ pull_request: 12 }, { head_sha: '0123456789abcdef' }), 'acme/app · b/1 · HEAD 0123456 · PR #12');
    assert.equal(meta({ pull_request: 12 }, { head_sha: null }), 'acme/app · b/1 · PR #12');
    assert.equal(meta({}, { head_sha: null }), 'acme/app · b/1');
    assert.ok(!meta({}, { head_sha: null })!.includes('PR'));
    assert.ok(!(meta({ pull_request: 12 }, { head_sha: null }) ?? '').includes('· ·'));
  });

  it('shows the four key figures in order', () => {
    const p = page(team(), headDetail());
    assert.deepEqual(p.query('#head-kpis .lbl').map((l) => l.textContent), ['Laufzeit', 'Tokens', 'Kosten', 'Sessions']);
    assert.equal(p.query('#head-kpis .head-kpi-v').length, 4);
  });

  it('shows the control buttons only with controlAllowed, and clicking Pausieren posts to the pause route', () => {
    const allowed = page(team(), headDetail());
    const pause = allowed.query('#head-actions button').filter((b) => b.textContent === 'Pausieren');
    assert.equal(pause.length, 1);
    allowed.click(pause[0]!);
    const call = allowed.fetches.at(-1)!;
    assert.equal(call.method, 'POST');
    assert.ok(call.url.endsWith('/pause'), call.url);
    const denied = page(team(), headDetail({ controls: { retry: false } }));
    const labels = denied.query('#head-actions button').filter((b) => !b.hidden).map((b) => b.textContent);
    assert.ok(!labels.includes('Pausieren') && !labels.includes('Fortsetzen'), labels.join());
  });

  it('GitHub link opens in a new tab safely', () => {
    const a = page(team(), headDetail()).query('#head-actions a').find((x) => x.textContent === 'GitHub ↗')!;
    assert.equal(a.getAttribute('href'), 'https://github.com/acme/app/issues/1');
    assert.equal(a.getAttribute('target'), '_blank');
    assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  });
});

describe('E3-6 independent: stage', () => {
  it('shows only the roles of the profile plus "Du" in the grid and sizes the grid to the seat count', () => {
    const p = page(team());
    assert.deepEqual(p.query('#stage-seats .stage-seat').map((s) => s.getAttribute('data-role')), ['analyst', 'developer', 'reviewer', 'you']);
    assert.equal(p.$('stage-seats').style.getPropertyValue('--seats'), '4');
    assert.match(AGENT_HTML, /repeat\(var\(--seats, 8\), minmax\(0, 1fr\)\)/);
  });

  it('draws the badge per state: green check for done, red cross for returned, none for waiting, skipped and playing', () => {
    const t = team({
      seats: [seat('analyst', 'done', 'ready', 1000, 'haiku'), seat('developer', 'returned', 'failed', 2000, 'opus', null, 2), seat('tester', 'skipped'), seat('reviewer', 'waiting'), seat('you', 'waiting')],
      active: null,
    });
    const p = page(t);
    const badge = (role: string) => seatOf(p, role).querySelector('.ui-av-badge');
    assert.ok(badge('analyst'));
    assert.ok(!badge('analyst')!.className.includes('is-x'));
    assert.ok(badge('developer')!.className.includes('is-x'));
    assert.equal(badge('tester'), null);
    assert.equal(badge('reviewer'), null);
    assert.equal(seatOf(p, 'developer').querySelector('.stage-sub')!.textContent, 'R2 failed · wartet auf R3');
    assert.equal(seatOf(p, 'analyst').querySelector('.stage-sub')!.textContent, 'ready · 1s · haiku');
    assert.equal(seatOf(p, 'tester').querySelector('.stage-sub')!.textContent, 'übersprungen');
    assert.equal(seatOf(p, 'reviewer').querySelector('.stage-sub')!.textContent, 'wartet');
  });

  it('"Du" reads "In review · Merge" before the merge and "Done" after it', () => {
    assert.equal(seatOf(page(team()), 'you').querySelector('.stage-sub')!.textContent, 'In review · Merge');
    const merged = team({ seats: [...team().seats.slice(0, 3), seat('you', 'done')] });
    assert.equal(seatOf(page(merged), 'you').querySelector('.stage-sub')!.textContent, 'Done');
  });

  it('an active seat exists only for a running session: no ring, equalizer or spotlight otherwise', () => {
    const idle = page(team(IDLE));
    assert.equal(idle.query('#stage .ui-ring').length, 0);
    assert.equal(idle.query('#stage .eq').length, 0);
    assert.equal(idle.query('#stage .ring').length, 0);
    assert.notEqual(idle.$('stage-spot').hidden, false);
    const running = page(team());
    assert.equal(running.query('#stage-seats .ui-ring').length, 1);
    assert.equal(running.query('#stage-seats .eq').length, 1);
    assert.equal(running.$('stage-spot').hidden, false);
    assert.equal(running.$('stage-spot').getAttribute('aria-hidden'), 'true');
  });

  it('labels the ring for assistive technology and turns amber exactly from 70 percent', () => {
    const at = (percent: number) => {
      const t = team();
      t.active.context.percent = percent;
      return page(t).query('#stage-seats .ui-ring')[0]!;
    };
    assert.equal(at(42).getAttribute('role'), 'img');
    assert.equal(at(42).getAttribute('aria-label'), 'Developer spielt, Context 42 Prozent');
    assert.ok(!at(69).querySelector('.ui-ring-pct')!.className.includes('hot'));
    assert.ok(at(70).querySelector('.ui-ring-pct')!.className.includes('hot'));
    assert.equal(at(70).getAttribute('aria-label'), 'Developer spielt, Context 70 Prozent');
  });

  it('the active seat reads "spielt · Runde <n> · <Dauer>" and the spotlight uses the role colour', () => {
    const p = page(team(), headDetail({ rounds: { current: 2, max: 3 } }));
    assert.equal(seatOf(p, 'developer').querySelector('.stage-sub')!.textContent, 'spielt · Runde 2 · 1m 0s');
    assert.ok(String(p.$('stage-spot').style.background).includes('rgba(52,211,153,.22)'));
  });

  it('the spotlight follows the active column: the first seat of four sits at 12.5 percent', () => {
    const t = team({ seats: [seat('developer', 'playing', null, 5000, 'opus'), seat('reviewer', 'waiting'), seat('you', 'waiting')] });
    t.active.role = 'developer';
    const left = String(page(t).$('stage-spot').style.left);
    assert.ok(left.includes('calc(') && left.includes('- 160px'), left);
    const third = String(page(team({ seats: [seat('analyst', 'done'), seat('reviewer', 'done'), seat('developer', 'playing'), seat('you', 'waiting')] })).$('stage-spot').style.left);
    assert.notEqual(third, left, 'a different column gives a different offset');
  });

  it('the edge runs through the finished seats up to the active one and is grey afterwards', () => {
    const bg = String(page(team()).$('stage-floor').style.background);
    assert.ok(bg.includes('#38bdf8') && bg.includes('#34d399'), bg);
    assert.ok(bg.includes('rgba(255,255,255,.14)'), bg);
    assert.ok(bg.indexOf('#38bdf8') < bg.indexOf('#34d399') && bg.indexOf('#34d399') < bg.indexOf('rgba(255,255,255,.14)'), bg);
  });

  it('when the first seat is active the edge has no finished colour before it', () => {
    const t = team({ seats: [seat('analyst', 'playing', null, 1000), seat('developer', 'waiting'), seat('you', 'waiting')] });
    t.active.role = 'analyst';
    const bg = String(page(t).$('stage-floor').style.background);
    assert.ok(!bg.includes('#34d399'), 'nothing of the developer colour');
  });

  it('shows head, title and legend of the stage', () => {
    const p = page(team());
    assert.equal(text(p, 'stage-title'), 'Bühne · das Team von #1');
    const labels = p.query('.stage-legend li').map((l) => l.textContent);
    assert.deepEqual(labels, ['spielt', 'fertig', 'Rückgabe', 'wartet']);
  });

  it('puts the 390 px layout into two rows: the 900 px query sets four columns and drops edge and spotlight', () => {
    const m = AGENT_HTML.match(/@media \(max-width: 900px\) \{([\s\S]*?)\n {2}\}/);
    assert.ok(m);
    assert.match(m[1]!, /repeat\(4, minmax\(0, 1fr\)\)/);
    assert.match(m[1]!, /\.floor/);
    assert.match(m[1]!, /display: none/);
  });

  it('keeps seat nodes and the pulse across a poll with the same data', () => {
    const p = page(team());
    const pulse = p.query('#stage-seats .ring')[0];
    const first = p.query('#stage-seats .stage-seat')[0];
    p.render({ detail: issueDetail(), team: team() });
    assert.equal(p.query('#stage-seats .ring')[0], pulse);
    assert.equal(p.query('#stage-seats .stage-seat')[0], first);
  });

  it('inserts server text only as text', () => {
    const t = team();
    t.seats[0].verdict = '<b>x</b>';
    t.seats[0].model = '<i>m</i>';
    const p = page(t);
    assert.equal(p.query('#stage b').length, 0);
    assert.equal(p.query('#stage-seats i').filter((e) => (e.textContent ?? '') !== '').length, 0, 'no injected <i> element');
    const sub = seatOf(p, 'analyst').querySelector('.stage-sub')!.textContent ?? '';
    assert.ok(sub.includes('<b>x</b>') && sub.includes('<i>m</i>'), sub);
  });
});

describe('E3-6 independent: fields', () => {
  it('Jetzt: shows only as many chips as there are tool calls and arrows between them', () => {
    const one = team();
    one.active.recent_tools = [TRACE[3]];
    one.trace = [TRACE[3]];
    const p = page(one);
    assert.equal(p.query('#stage-now-body .stage-trace .ui-chip').length, 1);
    assert.equal(p.query('#stage-now-body .stage-arrow').length, 0);
    const four = page(team());
    assert.equal(four.query('#stage-now-body .stage-trace .ui-chip').length, 4);
    assert.equal(four.query('#stage-now-body .stage-arrow').length, 3);
    assert.ok(four.query('#stage-now-body .stage-arrow').every((a) => a.textContent === '→'));
  });

  it('Jetzt: caps a longer history at the last four calls, newest tinted', () => {
    const t = team();
    t.active.recent_tools = [tool('Glob', '*', '11:59:00'), ...TRACE];
    t.trace = t.active.recent_tools;
    const chips = page(t).query('#stage-now-body .stage-trace .ui-chip');
    assert.ok(chips.length <= 4, `${chips.length} chips`);
    assert.equal(chips.at(-1)!.textContent, 'Edit');
    assert.ok(chips.at(-1)!.style.background);
    assert.ok(!chips[0]!.style.background);
  });

  it('Jetzt: ages the action with "vor <s> s" and names the role in the title', () => {
    const p = page(team());
    assert.equal(text(p, 'stage-now-meta'), 'Jetzt · Developer');
    assert.equal(text(p, 'stage-now-ago'), 'vor 10 s');
  });

  it('Jetzt: without a session says so and highlights nothing', () => {
    const p = page(team(IDLE));
    assert.ok(text(p, 'stage-now-body').includes('Keine Session aktiv'));
    assert.ok(p.query('#stage-now-body .stage-trace .ui-chip').every((c) => !c.style.background));
  });

  it('Session: reads "<used>k / <window>k · <n> %" with the mark at the configured threshold', () => {
    for (const threshold of [65, 80, 90]) {
      const p = page(team({ compact_threshold: threshold }));
      assert.equal(p.query('#stage-session-body .ui-bar-mark')[0]!.style.left, `${threshold}%`);
      assert.equal(p.query('#stage-session-body .ui-bar-mark')[0]!.getAttribute('title'), 'Auto-Compact');
      assert.equal(p.query('#stage-session-body .stage-hint')[0]!.textContent, `rote Marke: Auto-Compact ab ca. ${threshold} %`);
    }
    const p = page(team());
    assert.equal(p.query('#stage-session-body .stage-ctx .mono')[0]!.textContent, '84k / 200k · 42 %');
  });

  it('Session: defaults the mark to 80 percent when the API sends no threshold', () => {
    const t = team();
    delete t.compact_threshold;
    assert.equal(page(t).query('#stage-session-body .ui-bar-mark')[0]!.style.left, '80%');
  });

  it('Session: amber from 70 percent, "—" and an empty bar for an unknown window', () => {
    const hot = team();
    hot.active.context = { tokens: 140_000, window: 200_000, percent: 70, compacts: 0 };
    assert.ok(page(hot).query('#stage-session-body .stage-ctx .mono')[0]!.className.includes('hot'));
    const cool = team();
    cool.active.context = { tokens: 138_000, window: 200_000, percent: 69, compacts: 0 };
    assert.ok(!page(cool).query('#stage-session-body .stage-ctx .mono')[0]!.className.includes('hot'));
    const unknown = team();
    unknown.active.context = { tokens: 84_000, window: null, percent: null, compacts: 0 };
    const p = page(unknown);
    assert.equal(p.query('#stage-session-body .stage-ctx .mono')[0]!.textContent, '—');
    assert.equal(p.query('#stage-session-body .ui-bar-fill')[0]!.style.width, '0%');
  });

  it('Session: lists turn of max, model with effort and tokens with cost', () => {
    const dd = page(team()).query('#stage-session-body .stage-kv dd').map((d) => d.textContent);
    assert.equal(dd[0], '5 / 30');
    assert.equal(dd[2], 'opus · effort high');
    assert.match(dd[3]!, /^750(\.0)?[kK] · \$2\.50$/);
  });

  it('Subagents: counts running and finished and puts the pulse ring on running rows only', () => {
    const t = team({
      subagents: {
        running: [sub('Explore', 'Look', 'running', '2026-10-30T11:58:00.000Z', null, 5_000), sub('test-runner', 'Run', 'running', '2026-10-30T11:59:00.000Z', null, 1_000)],
        finished: [sub('Plan', 'Draft', 'done', '2026-10-30T11:50:00.000Z', '2026-10-30T11:52:00.000Z', 7_000)],
      },
    });
    const p = page(t);
    assert.equal(text(p, 'stage-subs-meta'), '2 laufen · 1 fertig');
    const avatars = p.query('#stage-subs-body .sub-av');
    assert.deepEqual(avatars.map((a) => a.textContent), ['EX', 'TR', 'PL']);
    assert.deepEqual(avatars.map((a) => a.querySelector('.ring') !== null), [true, true, false]);
  });

  it('Subagents: right column shows duration and tokens while running, "fertig · <k>k" when finished', () => {
    const t = team({
      subagents: {
        running: [sub('Explore', 'Look', 'running', '2026-10-30T11:58:00.000Z', null, 5_000)],
        finished: [sub('Plan', 'Draft', 'done', '2026-10-30T11:50:00.000Z', '2026-10-30T11:52:00.000Z', 7_000)],
      },
    });
    const p = page(t);
    assert.equal(p.query('#stage-subs-body .sub-right')[0]!.textContent, '2m 0s · 5k');
    assert.equal(p.query('#stage-subs-body .sub-right')[1]!.textContent, 'fertig · 7k');
  });

  it('Subagents: empty list says so, and foreign text stays text', () => {
    assert.equal(text(page(team()), 'stage-subs-body'), 'Keine Subagents in dieser Session');
    const t = team({ subagents: { running: [sub('Explore', '<img src=x onerror=alert(1)>', 'running', '2026-10-30T11:58:00.000Z', null, 1000)], finished: [] } });
    const p = page(t);
    assert.equal(p.query('#stage-subs-body img').length, 0);
    assert.ok(text(p, 'stage-subs-body').includes('<img src=x onerror=alert(1)>'));
  });
});
