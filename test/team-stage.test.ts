import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { renderPage, until } from './helpers.ts';
import { issueDetail, teamView } from './helpers/page-fixtures.ts';

// E3-3 (#356): the stage of the team view on the agent page.

const AGENT_URL = 'http://127.0.0.1/issue?id=acme%2Fapp%231';
const stage = (team?: Record<string, unknown>) => renderPage(AGENT_HTML, { detail: issueDetail(), ...(team ? { team } : {}) }, { url: AGENT_URL });
const text = (page: ReturnType<typeof stage>, id: string) => page.$(id).textContent ?? '';
const NO_SESSION = { active: null, subagents: { running: [], finished: [] } };

describe('stage of the team view', () => {
  it('shows one seat per role in API order, "Du" last; hidden without a team', () => {
    const team = teamView();
    const page = stage(team);
    assert.equal(page.$('stage').hidden, false);
    assert.equal(page.$('stage-title').textContent, 'Bühne');
    const seats = page.query('#stage-seats .stage-seat');
    assert.deepEqual(seats.map((s) => s.getAttribute('data-role')), team.seats.map((s: { role: string }) => s.role));
    assert.equal(seats.at(-1)!.querySelector('.stage-name')!.textContent, 'Du');
    assert.equal(renderPage(AGENT_HTML, { detail: issueDetail() }, { url: AGENT_URL }).$('stage').hidden, true);
  });

  it('marks states and puts role, verdict, duration and model into the title', () => {
    const page = stage(teamView());
    const seat = (role: string) => page.query('#stage-seats .stage-seat').find((s) => s.getAttribute('data-role') === role)!;
    assert.ok(seat('analyst').querySelector('.ui-av-badge'));
    assert.equal(seat('analyst').querySelector('.ui-av-badge.is-x'), null);
    assert.ok(seat('tester').querySelector('.ui-av-badge.is-x'));
    assert.ok(seat('reviewer').querySelector('.ui-av.is-waiting'));
    assert.ok(/is-skipped/.test(seat('docs').className));
    const title = seat('analyst').getAttribute('title')!;
    for (const part of ['Analyst', 'ready', '3m 0s', 'sonnet']) assert.ok(title.includes(part), `${part} in ${title}`);
    assert.ok(seat('docs').getAttribute('title')!.includes('—'));
  });

  it('gives the active seat exactly one pulse, equalizer and a 42 % context ring', () => {
    const page = stage(teamView());
    assert.equal(page.query('#stage-seats .is-active').length, 1);
    assert.equal(page.query('#stage-seats .ring').length, 1);
    assert.equal(page.query('#stage-seats .eq').length, 1);
    assert.equal(page.query('#stage .ui-ring').length, 1);
    assert.equal(page.query('#stage .stage-gauge .ui-ring-pct')[0]!.textContent, '42%');
    const none = teamView();
    none.active.context.percent = null;
    assert.equal(stage(none).query('#stage .stage-gauge .ui-ring-pct')[0]!.textContent, '—');
  });

  it('fills Jetzt, Session and Subagents', () => {
    const page = stage(teamView());
    assert.ok(text(page, 'stage-now-body').includes('Edit src/http/ui/tokens.ts'));
    const chips = page.query('#stage-now-body .stage-trace .ui-chip');
    assert.deepEqual(chips.map((c) => c.textContent), ['B: x', 'C: x', 'D: x', 'E: x']);
    assert.equal(page.query('#stage-session-body .ui-bar')[0]!.getAttribute('aria-valuenow'), '42');
    assert.equal(page.query('#stage-session-body .ui-bar-mark').length, 1);
    assert.equal(page.query('#stage-session-body .stage-compact').length, 2);
    const session = text(page, 'stage-session-body');
    for (const part of ['23', 'opus', '1.1M']) assert.ok(session.includes(part), part);
    assert.equal(page.query('#stage-subs-body .stage-subagent.is-running .dot.pulse').length, 1);
    assert.equal(page.query('#stage-subs-body .stage-subagent.is-done').length, 1);
    assert.equal(page.query('#stage-subs-body .stage-subagent.is-done .pulse').length, 0);
    const subs = text(page, 'stage-subs-body');
    for (const part of ['Explore', 'Find callers', 'Plan']) assert.ok(subs.includes(part), part);
  });

  it('animates nothing and says "Keine Session" without an active session', () => {
    const team = teamView(NO_SESSION);
    team.seats[2].status = 'playing';
    const page = stage(team);
    for (const sel of ['.ring', '.eq', '.is-playing', '.is-active', '.ui-ring']) assert.equal(page.query('#stage ' + sel).length, 0, sel);
    for (const id of ['stage-now-body', 'stage-session-body', 'stage-subs-body']) assert.ok(text(page, id).includes('Keine Session'), id);
  });

  it('shows no live session once the run has ended', () => {
    const page = renderPage(AGENT_HTML, { detail: issueDetail(), team: teamView(), ended: true }, { url: AGENT_URL });
    for (const sel of ['.ring', '.eq', '.is-active', '.ui-ring']) assert.equal(page.query('#stage ' + sel).length, 0, sel);
    assert.ok(text(page, 'stage-now-body').includes('Keine Session'));
  });

  it('resets the flex basis of the fields in the wide column layout', () => {
    assert.match(AGENT_HTML, /@media \(min-width: 1280px\) \{[^@]*\.stage-field, \.stage-field\.is-now \{ flex: 0 0 auto/);
  });

  it('puts the seats into two rows and keeps the stage from overflowing', () => {
    const cols = (n: number) => {
      const team = teamView();
      team.seats = team.seats.slice(0, n);
      return stage(team).$('stage-seats').style.getPropertyValue('--stage-cols');
    };
    assert.equal(cols(8), '4');
    assert.equal(cols(5), '3');
    assert.match(AGENT_HTML, /@media \(max-width: 900px\) \{\s*\.stage-seats \{[^}]*repeat\(var\(--stage-cols/);
    assert.match(AGENT_HTML, /\.stage \{[^}]*overflow: hidden/);
  });

  it('loads /team with the poll and survives a failing /team', async () => {
    const handler = (failTeam: boolean) => (url: string): unknown => {
      if (url.includes('/team')) { if (failTeam) throw new Error('boom'); return teamView(); }
      if (url.includes('/timeline')) return { events: [], latest_seq: 0, first_seq: 1 };
      if (url.includes('/transcript')) return { available: false, reason: 'none', entries: [], next_offset: 0, more: false };
      return issueDetail();
    };
    const ok = renderPage(AGENT_HTML, undefined, { url: AGENT_URL, fetch: handler(false) });
    await until(() => ok.fetches.some((f) => f.url === '/api/v1/acme%2Fapp%231/team') && ok.$('stage').hidden === false);
    const bad = renderPage(AGENT_HTML, undefined, { url: AGENT_URL, fetch: handler(true) });
    await until(() => bad.fetches.some((f) => f.url === '/api/v1/acme%2Fapp%231/team') && (bad.$('hero-title').textContent ?? '') === 'Issue one');
    assert.equal(bad.$('stage').hidden, true);
  });

  it('inserts foreign text as text only', () => {
    const team = teamView();
    team.active.action = '<img src=x onerror=alert(1)>';
    const page = stage(team);
    assert.ok(text(page, 'stage-now-body').includes('<img src=x onerror=alert(1)>'));
    assert.equal(page.query('#stage-now-body img').length, 0);
  });
});
