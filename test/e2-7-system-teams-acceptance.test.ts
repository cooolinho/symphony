import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { TEAMS_CSS, TEAMS_JS } from '../src/http/overview-teams.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { FakeElement, domContext, run, scriptContext } from './helpers/fake-dom.ts';

// Independent acceptance tests for E2-7 (#382): System cards and "Teams live" as in the mockup.
// Derived from the issue text (acceptance criteria and the example texts), not from the implementation.

const GB = 1073741824;
const SKY = '#38bdf8';
const VIOLET = '#a78bfa';
const GREEN = '#34d399';
const AMBER = '#fbbf24';
const RED = '#f87171';
const GREY = '#cbd5e1';

// ---------------------------------------------------------------------------------------------- system cards

const START = '// ------------------------------------------------------------------ system cards';
const END = '// ------------------------------------------------------------------ polling';
const sysCtx = () => {
  const from = DASHBOARD_HTML.indexOf(START);
  const to = DASHBOARD_HTML.indexOf(END);
  assert.ok(from > 0 && to > from);
  return domContext(BASE_JS, DASHBOARD_HTML.slice(from, to));
};
const sys = sysCtx();

interface Over {
  cpu?: number | null;
  memUsed?: number;
  memTotal?: number;
  load?: [number, number, number] | null;
  disks?: Array<{ name: string; used: number; total: number; device: number | null }>;
  cores?: number | null;
  gpu?: unknown;
  usage?: unknown;
}

function system(o: Over = {}) {
  const cpu = o.cpu === undefined ? 34 : o.cpu;
  const sample = (at: string, c: number | null) => ({
    at, cpu_percent: c,
    memory: { used_bytes: o.memUsed ?? 12.4 * GB, total_bytes: o.memTotal ?? 31.3 * GB },
    load: o.load === undefined ? { one: 1.52, five: 1.98, fifteen: 1.75 } : o.load && { one: o.load[0], five: o.load[1], fifteen: o.load[2] },
    disks: (o.disks ?? [{ name: 'state', used: 168 * GB, total: 465 * GB, device: 1 }]).map((d) => ({
      name: d.name, path: '/' + d.name, used_bytes: d.used, total_bytes: d.total, device: d.device,
    })),
    gpu: o.gpu ?? null,
  });
  const history = [sample('2026-10-30T09:50:00Z', 20), sample('2026-10-30T09:55:00Z', 25), sample('2026-10-30T10:00:00Z', cpu)];
  return {
    current: history.at(-1), history, gpu: o.gpu ?? null, cpu_count: o.cores === undefined ? 8 : o.cores,
    host: { hostname: 'box', container: null, uptime_seconds: 3600 },
    usage: o.usage === undefined ? { workspaces_bytes: 41 * GB, transcripts_bytes: 9 * GB, at: null } : o.usage,
  };
}

function state(running = 3, max = 4, queued = 2, api: unknown = { remaining: 4000, limit: 5000, reset_at: null, observed_at: null }) {
  return {
    counts: { running, forced: 0, queued },
    health: { max_concurrent_agents: max, last_tick_at: new Date(Date.now() - 4000).toISOString(), tracker_api: api },
  };
}

function build(sysData: unknown, st: unknown): FakeElement[] {
  sys.fixture = { sysData, st };
  return Array.from(run(sys, 'systemCards(fixture.sysData, fixture.st, { slots: [10, 20], github: [5, 6] })'));
}
const lab = (c: FakeElement) => c.byClass('syscard-label')[0]!.textContent;
const val = (c: FakeElement) => c.byClass('mono')[0]!.textContent;
const unit = (c: FakeElement) => c.byClass('syscard-unit')[0]?.textContent;
const sub = (c: FakeElement) => c.byClass('syscard-sub')[0]?.textContent;
const dotColor = (c: FakeElement) => c.byClass('syscard-dot')[0]!.style.background;
const barFill = (c: FakeElement) => c.byClass('ui-bar-fill')[0]?.style.background;
const spark = (c: FakeElement) => c.find((e) => e.tagName === 'svg' && e.classList.contains('ui-spark'))[0];
const card = (cards: FakeElement[], name: string) => cards.find((c) => lab(c) === name)!;

describe('E2-7 System panel: head and grid', () => {
  it('panel head shows host, container and process uptime right-aligned in 12.5 px --fg-3', () => {
    assert.match(DASHBOARD_HTML, /\.sys-host \{[^}]*margin-left: auto;[^}]*font-size: 12\.5px;[^}]*color: var\(--fg-3\);/);
    const ctx = sysCtx();
    const node = new FakeElement('span');
    ctx.$ = () => node;
    ctx.sd = { ...system(), host: { hostname: 'devbox', container: 'symphony-1', uptime_seconds: 5 * 60 } };
    run(ctx, 'systemData = sd; renderSystemHost()');
    assert.match(node.textContent, /^Host devbox · Container symphony-1 · seit .+/);
    ctx.sd = { ...system(), host: { hostname: 'devbox', container: null, uptime_seconds: 5 * 60 } };
    run(ctx, 'systemData = sd; renderSystemHost()');
    assert.match(node.textContent, /^Host devbox · Container — · seit .+/);
    assert.ok(!/null|undefined|NaN/.test(node.textContent), node.textContent);
  });

  it('grid is repeat(auto-fit, minmax(190px, 1fr)) with a 12px gap; .gi card padding 14px 14px 10px', () => {
    assert.match(DASHBOARD_HTML, /\.syscards \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(190px, 1fr\)\);[^}]*gap: 12px;/);
    assert.match(DASHBOARD_HTML, /\.syscard \{[^}]*padding: 14px 14px 10px;/);
  });

  it('card typography: label 13 px --fg-2, value mono 26 px/500 --fg-strong, unit mono 13 px --fg-3, text 12 px --fg-3', () => {
    assert.match(DASHBOARD_HTML, /\.syscard-label \{[^}]*font-size: 13px;[^}]*color: var\(--fg-2\)/);
    assert.match(DASHBOARD_HTML, /\.syscard-value \.mono \{[^}]*font: 500 26px var\(--mono\);[^}]*color: var\(--fg-strong\)/);
    assert.match(DASHBOARD_HTML, /\.syscard-unit \{[^}]*font: 13px var\(--mono\);[^}]*color: var\(--fg-3\)/);
    assert.match(DASHBOARD_HTML, /\.syscard-sub \{[^}]*font-size: 12px;[^}]*color: var\(--fg-3\)/);
  });

  it('the cards are .gi and appear in the order CPU, RAM, Disk · State, Load, Agent-Slots, GitHub API', () => {
    const cards = build(system(), state());
    assert.deepEqual(cards.map(lab), ['CPU', 'RAM', 'Disk · State', 'Load', 'Agent-Slots', 'GitHub API']);
    for (const c of cards) assert.ok(c.classList.contains('gi'));
  });

  it('a second volume on another device adds "Disk · Workspaces"; the same device does not', () => {
    const two = build(system({ disks: [
      { name: 'state', used: 168 * GB, total: 465 * GB, device: 1 }, { name: 'workspace', used: 100 * GB, total: 931 * GB, device: 2 },
    ] }), state());
    assert.equal(two.length, 7);
    assert.deepEqual(two.map(lab), ['CPU', 'RAM', 'Disk · State', 'Disk · Workspaces', 'Load', 'Agent-Slots', 'GitHub API']);
    const same = build(system({ disks: [
      { name: 'state', used: 168 * GB, total: 465 * GB, device: 1 }, { name: 'workspace', used: 168 * GB, total: 465 * GB, device: 1 },
    ] }), state());
    assert.equal(same.length, 6);
  });

  it('GPU card only when gpu is not null', () => {
    assert.ok(!build(system({ gpu: null }), state()).some((c) => lab(c) === 'GPU'));
    const gpu = { utilization_percent: 55, memory_used_mib: 1000, memory_total_mib: 8000, temperature_c: 60 };
    const cards = build(system({ gpu }), state());
    assert.equal(cards.length, 7);
    assert.equal(lab(cards.at(-1)!), 'GPU');
    assert.equal(val(cards.at(-1)!), '55');
  });
});

describe('E2-7 System panel: values, units and texts', () => {
  const cards = build(system({ cpu: 34 }), state(3, 4, 2));

  it('CPU: "34" + "%" and "8 Kerne · 3 Agents aktiv"', () => {
    const c = card(cards, 'CPU');
    assert.equal(val(c), '34');
    assert.equal(unit(c), '%');
    assert.equal(sub(c), '8 Kerne · 3 Agents aktiv');
  });

  it('RAM: used GB with one decimal, unit "/ 31.3 GB", text "<n> % belegt"', () => {
    const c = card(cards, 'RAM');
    assert.equal(val(c), '12.4');
    assert.equal(unit(c), '/ 31.3 GB');
    assert.equal(sub(c), '40 % belegt');
  });

  it('Disk · State: whole GB, unit "/ 465 GB", text "Workspaces 41 GB · Transkripte 9 GB"', () => {
    const c = card(cards, 'Disk · State');
    assert.equal(val(c), '168');
    assert.equal(unit(c), '/ 465 GB');
    assert.equal(sub(c), 'Workspaces 41 GB · Transkripte 9 GB');
  });

  it('Disk · Workspaces text is "<n> % belegt"', () => {
    const c = card(build(system({ disks: [
      { name: 'state', used: 10 * GB, total: 100 * GB, device: 1 }, { name: 'workspace', used: 180 * GB, total: 500 * GB, device: 2 },
    ] }), state()), 'Disk · Workspaces');
    assert.equal(unit(c), '/ 500 GB');
    assert.equal(sub(c), '36 % belegt');
  });

  it('Load: 1-min value, unit "1 min", text "5 min 1.98 · 15 min 1.75"', () => {
    const c = card(cards, 'Load');
    assert.equal(val(c), '1.52');
    assert.equal(unit(c), '1 min');
    assert.equal(sub(c), '5 min 1.98 · 15 min 1.75');
  });

  it('Agent-Slots: running, unit "/ 4", text "1 frei · 2 in der Queue"', () => {
    const c = card(cards, 'Agent-Slots');
    assert.equal(val(c), '3');
    assert.equal(unit(c), '/ 4');
    assert.equal(sub(c), '1 frei · 2 in der Queue');
  });

  it('GitHub API: remaining, unit "/ 5.000", text "Poll vor 4 s · ok"', () => {
    const c = card(cards, 'GitHub API');
    assert.equal(val(c), '4.000');
    assert.equal(unit(c), '/ 5.000');
    assert.match(sub(c)!, /^Poll vor [345] ?s · ok$/);
  });

  it('every card with data has an ampel dot, a 5 px bar and a sparkline', () => {
    for (const c of cards) {
      assert.equal(c.byClass('syscard-dot').length, 1, lab(c));
      assert.equal(c.byClass('ui-bar').length, 1, lab(c));
      assert.ok(c.byClass('ui-bar')[0]!.classList.contains('ui-bar-h5'), lab(c));
      assert.ok(spark(c), lab(c));
    }
  });

  it('the CPU sparkline has one point per history sample (1 h)', () => {
    const poly = spark(card(cards, 'CPU'))!.find((e) => e.tagName === 'polyline')[0]!;
    assert.equal(poly.getAttribute('points')!.trim().split(/\s+/).length, 3);
  });
});

describe('E2-7 System panel: colours and traffic light', () => {
  it('card colours on the bar: CPU sky, RAM violet, Disk green, Load amber, Slots green, GitHub grey', () => {
    // all low utilisation so that no card is amber/red because of its load
    const cards = build(system({ cpu: 10, memUsed: 3 * GB, memTotal: 31.3 * GB, load: [0.4, 0.4, 0.4], cores: 8 }), state(1, 4, 0, { remaining: 4900, limit: 5000, reset_at: null, observed_at: null }));
    assert.equal(barFill(card(cards, 'CPU')), SKY);
    assert.equal(barFill(card(cards, 'RAM')), VIOLET);
    assert.equal(barFill(card(cards, 'Disk · State')), GREEN);
    assert.equal(barFill(card(cards, 'Load')), AMBER);
    assert.equal(barFill(card(cards, 'Agent-Slots')), GREEN);
    assert.equal(barFill(card(cards, 'GitHub API')), GREY);
    const stroke = (name: string) => spark(card(cards, name))!.find((e) => e.tagName === 'polyline')[0]!.getAttribute('stroke');
    assert.equal(stroke('CPU'), SKY);
    assert.equal(stroke('RAM'), VIOLET);
    assert.equal(stroke('Load'), AMBER);
  });

  it('CPU at 34 / 82 / 97 %: dot and bar green-ish card colour, amber, red', () => {
    const at = (cpu: number) => card(build(system({ cpu }), state()), 'CPU');
    const low = at(34);
    assert.equal(barFill(low), SKY);
    assert.equal(dotColor(low), GREEN);
    const mid = at(82);
    assert.equal(barFill(mid), AMBER);
    assert.equal(dotColor(mid), AMBER);
    const high = at(97);
    assert.equal(barFill(high), RED);
    assert.equal(dotColor(high), RED);
    // thresholds are inclusive: 80 is amber, 95 is red; 79 / 94 are not
    assert.equal(dotColor(at(79)), GREEN);
    assert.equal(dotColor(at(80)), AMBER);
    assert.equal(dotColor(at(94)), AMBER);
    assert.equal(dotColor(at(95)), RED);
  });

  it('RAM and Disk change colour on the same thresholds', () => {
    const ram = (p: number) => card(build(system({ memUsed: p, memTotal: 100 }), state()), 'RAM');
    assert.equal(dotColor(ram(34)), GREEN);
    assert.equal(barFill(ram(82)), AMBER);
    assert.equal(barFill(ram(97)), RED);
    const disk = (p: number) => card(build(system({ disks: [{ name: 'state', used: p * GB, total: 100 * GB, device: 1 }] }), state()), 'Disk · State');
    assert.equal(barFill(disk(34)), GREEN);
    assert.equal(barFill(disk(82)), AMBER);
    assert.equal(barFill(disk(97)), RED);
  });

  it('Load percent is load 1 min / cores', () => {
    const load = (one: number, cores: number) => card(build(system({ load: [one, 0, 0], cores }), state()), 'Load');
    assert.equal(dotColor(load(3.4, 10)), GREEN); // 34 %
    assert.equal(dotColor(load(3.3, 4)), AMBER); // 82.5 %
    assert.equal(barFill(load(3.3, 4)), AMBER);
    assert.equal(dotColor(load(3.9, 4)), RED); // 97.5 %
    assert.equal(barFill(load(3.9, 4)), RED);
    assert.equal(dotColor(load(3.9, 8)), GREEN); // 48.75 %: same load, more cores
  });
});

describe('E2-7 System panel: missing values', () => {
  const emptyCard = (c: FakeElement) => {
    assert.equal(val(c), '—', lab(c));
    assert.equal(c.byClass('ui-bar').length, 0, lab(c) + ' bar');
    assert.equal(spark(c), undefined, lab(c) + ' sparkline');
    assert.equal(c.byClass('syscard-sub').length, 0, lab(c) + ' text');
    assert.ok(!/Fehler|error|null|undefined|NaN/i.test(c.textContent), c.textContent);
  };

  it('a null CPU sample gives "—" without bar, sparkline or error text, other cards stay', () => {
    const cards = build(system({ cpu: null }), state());
    const cpu = card(cards, 'CPU');
    // the history still has two CPU values, but the current sample is missing: only the value matters for "—"
    assert.equal(val(cpu), '—');
    assert.equal(cpu.byClass('ui-bar').length, 0);
    assert.equal(val(card(cards, 'RAM')), '12.4');
  });

  it('an unreachable /api/v1/system (null) leaves all host cards on "—" and does not throw', () => {
    const cards = build(null, state());
    assert.deepEqual(cards.map(lab).slice(0, 4), ['CPU', 'RAM', 'Disk · State', 'Load']);
    for (const name of ['CPU', 'RAM', 'Disk · State', 'Load']) emptyCard(card(cards, name));
    assert.equal(cards.length, 6, 'no GPU card');
  });

  it('missing state / tracker budget leaves slots and GitHub API on "—"', () => {
    const cards = build(system(), null);
    emptyCard(card(cards, 'Agent-Slots'));
    emptyCard(card(cards, 'GitHub API'));
    const noApi = build(system(), state(1, 4, 0, null));
    emptyCard(card(noApi, 'GitHub API'));
    assert.equal(val(card(noApi, 'Agent-Slots')), '1');
  });

  it('null memory, load and disks give "—" per card', () => {
    const s = system({ load: null });
    (s.current as any).memory = null;
    (s.current as any).disks = [{ name: 'state', path: '/x', used_bytes: null, total_bytes: null, device: null }];
    const cards = build(s, state());
    emptyCard(card(cards, 'RAM'));
    emptyCard(card(cards, 'Load'));
    emptyCard(card(cards, 'Disk · State'));
  });
});

// ---------------------------------------------------------------------------------------------- teams live

type Rec = Record<string, unknown>;
const ROLES = ['analyst', 'architect', 'developer', 'tester', 'reviewer', 'docs', 'security'];
const stage = (id: string, status: string, over: Rec = {}): Rec => ({
  id, label: id, kind: 'agent', columns: [id], status, sessions: [], verdict: null, round: null, ...over,
});
const stages = (): Rec[] => [
  stage('analyst', 'done'), stage('architect', 'done'), stage('developer', 'active'), stage('tester', 'pending'),
  stage('reviewer', 'pending'), stage('docs', 'pending'), stage('security', 'pending'),
  { id: 'human:in review', label: 'In review', kind: 'human', columns: ['In review'], status: 'pending', sessions: [], verdict: null, round: null },
  { id: 'terminal:done', label: 'Done', kind: 'terminal', columns: ['Done'], status: 'pending', sessions: [], verdict: null, round: null },
];
const runInfo = (over: Rec = {}): Rec => ({
  role: 'developer', session_id: 's1', last_event: 'tool_use', last_message: 'Edit: /ws/a/src/http/ui/tokens.ts', workspace: '/ws/a',
  seconds_running: 754, context: { tokens: 71, window: 100, percent: 71, compacts: 0 }, subagents: { running: [], finished: [] }, ...over,
});
const row = (n: number, running: Rec | null, st: Rec[] = stages(), over: Rec = {}): Rec => ({
  issue_id: 'g' + n, issue_identifier: 'acme/app#' + n, title: 'Titel ' + n, repo: 'acme/app', state: 'In progress',
  section: running ? 'running' : 'next', stages: st, running, ...over,
});

function teams() {
  const ctx = scriptContext(BASE_JS, TEAMS_JS);
  const host: FakeElement = run(ctx, 'document.createElement("div")');
  ctx.host = host;
  const render = (st: unknown, now = 1_000_000) => {
    ctx.st = st;
    ctx.now = now;
    return run(ctx, 'renderTeams(host, st, now)');
  };
  return { host, render, ctx };
}

describe('E2-7 Teams live: panel', () => {
  it('head has the title and a right-hand link "Alle Tasks →" to /tasks', () => {
    assert.match(DASHBOARD_HTML, /<h2 id="teams-title">Teams live\b/);
    assert.match(DASHBOARD_HTML, /<a class="teams-all" href="\/tasks">Alle Tasks →<\/a>/);
  });

  it('list has a 10px gap; the row is a wrapping flex link with 14px 16px padding and 12px 18px gap', () => {
    assert.match(TEAMS_CSS, /\.team-list \{[^}]*gap: 10px;/);
    assert.match(TEAMS_CSS, /\.team-row \{[^}]*display: flex;[^}]*flex-wrap: wrap;[^}]*gap: 12px 18px;[^}]*padding: 14px 16px;/);
  });

  it('row is <a class="gi row"> to /issue?id=<id>', () => {
    const { host, render } = teams();
    render({ issues: [row(7, runInfo())] });
    const a = host.byClass('gi')[0]!;
    assert.equal(a.tagName, 'a');
    assert.ok(a.classList.contains('row'));
    assert.equal(a.getAttribute('href'), '/issue?id=' + encodeURIComponent('acme/app#7'));
  });

  it('empty text "Kein Team spielt gerade" in 13 px --fg-2 when nothing runs', () => {
    assert.match(TEAMS_CSS, /\.team-empty \{[^}]*font-size: 13px;[^}]*color: var\(--fg-2\)/);
    const { host, render } = teams();
    render({ issues: [row(1, null), row(2, null)] });
    assert.equal(host.textContent, 'Kein Team spielt gerade');
    assert.equal(host.byClass('team-row').length, 0);
    render({ issues: [] });
    assert.equal(host.textContent, 'Kein Team spielt gerade');
    render({ issues: [row(3, runInfo())] });
    assert.ok(!host.textContent.includes('Kein Team spielt gerade'));
  });
});

describe('E2-7 Teams live: row blocks', () => {
  it('block 1: number, title and "<repo> · <column> · Runde <n>"; flex 1 1 260px', () => {
    assert.match(TEAMS_CSS, /flex: 1 1 260px/);
    assert.match(TEAMS_CSS, /\.team-num \{[^}]*font: 13px var\(--mono\);[^}]*color: var\(--fg-label\)/);
    assert.match(TEAMS_CSS, /\.team-title \{[^}]*font-size: 15px;[^}]*font-weight: 600/);
    assert.match(TEAMS_CSS, /\.team-meta \{[^}]*font-size: 12\.5px;[^}]*color: var\(--fg-3\)/);
    const { host, render } = teams();
    const st = stages();
    (st[3] as Rec).round = 2;
    render({ issues: [row(42, runInfo(), st, { state: 'Testing', title: 'Mein Titel' })] });
    assert.equal(host.byClass('team-num')[0]!.textContent, '#42');
    assert.equal(host.byClass('team-title')[0]!.textContent, 'Mein Titel');
    assert.equal(host.byClass('team-meta')[0]!.textContent, 'acme/app · Testing · Runde 2');
  });

  it('block 2: seven 30 px avatars in pipeline order, no human/terminal stages', () => {
    const { host, render } = teams();
    render({ issues: [row(1, runInfo())] });
    const avs = host.byClass('ui-av');
    assert.equal(avs.length, 7);
    for (const a of avs) assert.ok(a.classList.contains('ui-av-30'));
    assert.deepEqual(avs.map((a) => a.getAttribute('aria-label')!.split(' · ')[0]),
      ['Analyst', 'Architect', 'Developer', 'Tester', 'Reviewer', 'Docs', 'Security']);
  });

  it('block 2: the stage order of the profile is kept, not sorted', () => {
    const { host, render } = teams();
    const shuffled = [stage('security', 'done'), stage('docs', 'done'), stage('developer', 'active'), stage('analyst', 'pending')];
    render({ issues: [row(1, runInfo(), shuffled)] });
    assert.deepEqual(host.byClass('ui-av').map((a) => a.getAttribute('aria-label')!.split(' · ')[0]), ['Security', 'Docs', 'Developer', 'Analyst']);
  });

  it('block 2: states done / playing / waiting / returned / skipped, a single pulse ring on the active avatar', () => {
    const { host, render } = teams();
    const st = [
      stage('analyst', 'done'), stage('architect', 'skipped'), stage('developer', 'active'),
      stage('tester', 'done', { verdict: 'changes_requested', sessions: [{}] }), stage('reviewer', 'pending'),
    ];
    render({ issues: [row(1, runInfo(), st)] });
    const states = host.byClass('ui-av').map((a) => /\bis-(done|playing|waiting|returned|skipped)\b/.exec(a.className)?.[1]);
    assert.equal(states[0], 'done');
    assert.equal(states[1], 'skipped');
    assert.equal(states[2], 'playing');
    assert.equal(states[4], 'waiting');
    assert.notEqual(states[3], 'playing');
    assert.equal(host.byClass('ring').length, 1);
    const playing = host.byClass('ui-av')[2]!;
    assert.equal(playing.byClass('ring').length, 1);
  });

  it('block 2: container aria-label "Team: Analyst fertig, Architect fertig, Developer spielt, …"', () => {
    const { host, render } = teams();
    render({ issues: [row(1, runInfo())] });
    const labelled = host.find((e) => (e.getAttribute('aria-label') ?? '').startsWith('Team: '))[0];
    assert.ok(labelled, 'an element with a Team: label');
    assert.equal(labelled!.getAttribute('aria-label'),
      'Team: Analyst fertig, Architect fertig, Developer spielt, Tester wartet, Reviewer wartet, Docs wartet, Security wartet');
  });

  it('block 3: role name and action "Tool · argument", single line with ellipsis', () => {
    assert.match(TEAMS_CSS, /flex: 1 1 250px/);
    assert.match(TEAMS_CSS, /\.team-role \{[^}]*font-size: 13px;[^}]*font-weight: 500/);
    assert.match(TEAMS_CSS, /\.team-action \{[^}]*font: 12\.5px var\(--mono\);[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap/);
    const { host, render } = teams();
    render({ issues: [row(1, runInfo())] });
    assert.equal(host.byClass('team-role')[0]!.textContent, 'Developer');
    assert.equal(host.byClass('team-action')[0]!.textContent, 'Edit · src/http/ui/tokens.ts');
    render({ issues: [row(1, runInfo({ last_message: 'Bash: npm run check', workspace: '/ws/a' }))] });
    assert.equal(host.byClass('team-action')[0]!.textContent, 'Bash · npm run check');
  });

  it('block 3: a very long action is shortened, not wrapped', () => {
    const { host, render } = teams();
    render({ issues: [row(1, runInfo({ last_message: 'Bash: ' + 'x'.repeat(400) }))] });
    const text = host.byClass('team-action')[0]!.textContent;
    assert.ok(text.length < 200, String(text.length));
    assert.ok(text.startsWith('Bash · xxx'));
  });

  it('block 3: Context label (52 px), 6 px bar, percent mono 12 px in a 36 px column', () => {
    assert.match(TEAMS_CSS, /\.team-ctx \{[^}]*grid-template-columns: 52px 1fr 36px/);
    assert.match(TEAMS_CSS, /\.team-ctx-label \{[^}]*font-size: 12px;[^}]*color: var\(--fg-3\)/);
    assert.match(TEAMS_CSS, /\.team-ctx-pct \{[^}]*font: 12px var\(--mono\);[^}]*text-align: right/);
    const { host, render } = teams();
    render({ issues: [row(1, runInfo())] });
    const ctx = host.byClass('team-ctx')[0]!;
    assert.equal(ctx.byClass('team-ctx-label')[0]!.textContent, 'Context');
    assert.ok(ctx.byClass('ui-bar')[0]!.classList.contains('ui-bar-h6'));
    assert.equal(ctx.byClass('team-ctx-pct')[0]!.textContent, '71 %');
  });

  it('block 3: context sky below 70 %, amber from 70 % (71 % amber), "—" and no bar without data', () => {
    const { host, render } = teams();
    const fill = (percent: number | null, context?: unknown) => {
      render({ issues: [row(1, runInfo({ context: context === undefined ? { tokens: 1, window: 2, percent, compacts: 0 } : context }))] });
      return host.byClass('team-ctx')[0]!;
    };
    assert.equal(fill(69).byClass('ui-bar-fill')[0]!.style.background, SKY);
    assert.equal(fill(70).byClass('ui-bar-fill')[0]!.style.background, AMBER);
    assert.equal(fill(71).byClass('ui-bar-fill')[0]!.style.background, AMBER);
    for (const none of [fill(null), fill(null, null), fill(null, { tokens: 0, window: null, percent: null, compacts: 0 })]) {
      assert.equal(none.byClass('ui-bar').length, 0);
      assert.equal(none.byClass('team-ctx-pct')[0]!.textContent, '—');
    }
  });

  it('block 4: run time mono 15 px, min-width 86px, subagent text for 0 / 1 / n', () => {
    assert.match(TEAMS_CSS, /\.team-end \{[^}]*min-width: 86px/);
    assert.match(TEAMS_CSS, /\.team-time \{[^}]*font: 15px var\(--mono\)/);
    assert.match(TEAMS_CSS, /\.team-subs \{[^}]*font-size: 12px/);
    const { host, render } = teams();
    const subs = (n: number) => {
      render({ issues: [row(1, runInfo({ subagents: { running: Array.from({ length: n }, (_, i) => ({ id: i })), finished: [] } }))] });
      return host.byClass('team-subs')[0]!.textContent;
    };
    assert.deepEqual([0, 1, 2, 5].map(subs), ['keine Subagents', '1 Subagent', '2 Subagents', '5 Subagents']);
    assert.match(host.byClass('team-time')[0]!.textContent, /^\d+:\d{2}$/);
  });

  it('the run time keeps counting and the action updates without a rebuild', () => {
    const { host, render, ctx } = teams();
    render({ issues: [row(1, runInfo({ seconds_running: 60 }))] }, 1_000_000);
    const rowNode = host.byClass('team-row')[0]!;
    const before = host.byClass('team-time')[0]!.textContent;
    render({ issues: [row(1, runInfo({ seconds_running: 60, last_message: 'Read: /ws/a/README.md' }))] }, 1_000_000);
    ctx.later = 1_005_000;
    run(ctx, 'tickTeams(later)');
    assert.equal(host.byClass('team-row')[0], rowNode, 'row node is kept');
    assert.notEqual(host.byClass('team-time')[0]!.textContent, before);
    assert.equal(host.byClass('team-action')[0]!.textContent, 'Read · README.md');
  });
});

describe('E2-7 Teams live: equalizer and pulse ring only while the session runs', () => {
  it('a running session has the equalizer in the role colour and exactly one ring', () => {
    const { host, render } = teams();
    render({ issues: [row(1, runInfo())] });
    const eqs = host.byClass('team-actline')[0]!.byClass('eq');
    assert.equal(eqs.length, 1);
    assert.match(String(eqs[0]!.style.color), /#34d399/i);
    assert.equal(host.byClass('ring').length, 1);
  });

  it('the equalizer follows the role colour', () => {
    const { host, render } = teams();
    render({ issues: [row(1, runInfo({ role: 'tester' }), [stage('developer', 'done'), stage('tester', 'active')])] });
    assert.match(String(host.byClass('team-actline')[0]!.byClass('eq')[0]!.style.color), /#fbbf24/i);
    assert.equal(host.byClass('team-role')[0]!.textContent, 'Tester');
  });

  it('without a session (waiting for the session, paused) there is no equalizer and no ring', () => {
    const { host, render } = teams();
    render({ issues: [row(1, runInfo({ session_id: null, last_event: null, last_message: '' }))] });
    assert.equal(host.byClass('team-row').length, 1);
    assert.equal(host.byClass('eq').length, 0);
    assert.equal(host.byClass('ring').length, 0);
    assert.ok(host.byClass('ui-av').every((a) => !a.classList.contains('is-playing')));
  });

  it('an issue that is no longer running gets no row, equalizer or ring', () => {
    const { host, render } = teams();
    render({ issues: [row(1, runInfo())] });
    render({ issues: [row(1, null, stages().map((s) => (s.id === 'developer' ? { ...s, status: 'done' } : s)), { section: 'review' })] });
    assert.equal(host.byClass('team-row').length, 0);
    assert.equal(host.byClass('eq').length, 0);
    assert.equal(host.byClass('ring').length, 0);
    assert.equal(host.textContent, 'Kein Team spielt gerade');
  });

  it('only the running issues of a mixed state appear, one row each', () => {
    const { host, render } = teams();
    render({ issues: [row(1, runInfo()), row(2, null), row(3, runInfo({ role: 'analyst' }), [stage('analyst', 'active')]), row(4, null)] });
    assert.equal(host.byClass('team-row').length, 2);
    assert.equal(host.byClass('ring').length, 2);
    assert.equal(host.byClass('team-actline').flatMap((l) => l.byClass('eq')).length, 2);
  });
});

describe('E2-7 Teams live: render time', () => {
  it('renders 20 running issues in under 50 ms (best of 3, fresh content each time)', () => {
    const { host, render } = teams();
    const issues = (tag: string) => Array.from({ length: 20 }, (_, i) => row(i, runInfo({ last_message: `Edit: /ws/a/${tag}/${i}.ts` }), stages(), { title: `Titel ${tag} ${i}` }));
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const state = { issues: issues('r' + k) };
      const t0 = performance.now();
      const n = render(state);
      best = Math.min(best, performance.now() - t0);
      assert.equal(n, 20);
    }
    assert.equal(host.byClass('team-row').length, 20);
    assert.ok(best < 50, `render took ${best.toFixed(1)} ms`);
  });
});

// ---------------------------------------------------------------------------------------------- server data

describe('E2-7 /api/v1/system carries host info', () => {
  it('the snapshot has host {hostname, container, uptime_seconds} for the head line', async () => {
    const { SystemCollector } = await import('../src/system/metrics.ts');
    const logger = { warn() {}, info() {}, error() {}, debug() {} } as never;
    const c = new SystemCollector({ volumes: [], gpu: false, logger, hostname: 'h', container: 'symphony', uptime: () => 90 });
    const snap = c.snapshot();
    assert.deepEqual(snap.host, { hostname: 'h', container: 'symphony', uptime_seconds: 90 });
    assert.equal(snap.gpu, null);
  });
});
