import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/agent-page.ts';
import { renderPage } from './helpers.ts';
import { issueDetail, teamView } from './helpers/page-fixtures.ts';

// E3-6 (#385): breadcrumb and head card (Kopfkarte) of the team view.

const AGENT_URL = 'http://127.0.0.1/issue?id=acme%2Fapp%231';
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const full = (over: Obj = {}): Obj =>
  issueDetail({
    profile: 'feature',
    rounds: { current: 2, max: 3 },
    pull_request: null,
    issue: { ...issueDetail().issue, labels: ['type: feature', 'complexity: l'], branch_name: 'symphony/issue-1' },
    run_trace: { ...issueDetail().run_trace, head_sha: 'abc1234def5678' },
    issue_url: 'https://github.com/acme/app/issues/1',
    ...over,
  });
const head = (detail: Obj, extra: Obj = {}) => renderPage(AGENT_HTML, { detail, team: teamView(), ...extra }, { url: AGENT_URL });
const chips = (page: ReturnType<typeof head>) => page.query('#head-chips .ui-chip').filter((c) => !c.hidden).map((c) => c.textContent);
/** The CSS rule body for a selector in the page styles (whitespace normalised). */
const rule = (selector: string): string => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = AGENT_HTML.match(new RegExp(`\\n\\s*${esc} \\{([^}]*)\\}`));
  assert.ok(m, `rule ${selector}`);
  return m[1]!.replace(/\s+/g, ' ');
};

describe('E3-6 head card: breadcrumb', () => {
  it('reads "Übersicht › #<nr> <short title>" with Übersicht linking to /', () => {
    const page = head(full());
    assert.equal(page.$('crumb-current').textContent, '#1 Issue one');
    assert.equal(page.query('nav[aria-label="Brotkrumen"] a[href="/"]')[0]!.textContent, 'Übersicht');
    const long = head(full({ title: 'A very long issue title that goes on and on and on forever' }));
    assert.equal(long.$('crumb-current').textContent, '#1 A very long issue title that goes on an…');
  });
});

describe('E3-6 head card: chips, title, meta', () => {
  it('is a glass section with the mockup padding and wrapping', () => {
    assert.match(AGENT_HTML, /<section class="g head" id="hero"/);
    const css = rule('.head');
    for (const part of ['padding: 20px 22px', 'flex-wrap: wrap', 'gap: 18px 28px', 'justify-content: space-between']) assert.ok(css.includes(part), part);
    assert.match(rule('.head h1'), /600 var\(--fs-h1-team\)/);
    assert.match(rule('.head-meta'), /12\.5px var\(--mono\); color: var\(--fg-3\)/);
  });

  it('shows #nr (mono), the column with a green live dot, round amber from 2, profile and complexity', () => {
    const page = head(full());
    assert.deepEqual(chips(page), ['#1', 'In progress', 'Runde 2 von 3', 'Profil feature', 'Komplexität L']);
    assert.ok(page.$('head-num').className.includes('mono'));
    const dot = page.query('#state-slot .ui-dot')[0]!;
    assert.ok(dot.className.includes('live'));
    assert.equal(dot.style.background, '#34d399');
    const round = page.query('#head-tags .ui-chip')[0]!;
    assert.equal(round.style.color, '#fcd34d', 'amber tone');
    const first = head(full({ rounds: { current: 1, max: 3 } })).query('#head-tags .ui-chip')[0]!;
    assert.equal(first.textContent, 'Runde 1 von 3');
    assert.equal(first.style.color ?? '', '', 'no tone in round 1');
    assert.equal(page.$('hero-title').textContent, 'Issue one');
  });

  it('leaves out chips without data and greys the dot without a live session', () => {
    const page = head(issueDetail({ status: 'claimed', running: null }));
    assert.deepEqual(chips(page), ['#1', 'In progress · Claimed']);
    const dot = page.query('#state-slot .ui-dot')[0]!;
    assert.ok(!dot.className.includes('live'));
    assert.equal(dot.style.background, '#94a3b8');
    const noComplexity = head(full({ issue: { ...issueDetail().issue, labels: ['type: feature'] } }));
    assert.ok(!chips(noComplexity).some((c) => c!.startsWith('Komplexität')));
  });

  it('writes the meta line "repo · branch · HEAD <7> · PR #n" and drops missing parts', () => {
    assert.equal(head(full()).$('head-meta').textContent, 'acme/app · symphony/issue-1 · HEAD abc1234');
    assert.equal(head(full({ pull_request: 7 })).$('head-meta').textContent, 'acme/app · symphony/issue-1 · HEAD abc1234 · PR #7');
    assert.equal(head(issueDetail()).$('head-meta').textContent, 'acme/app');
  });
});

describe('E3-6 head card: key figures and actions', () => {
  it('has four key figures Laufzeit, Tokens, Kosten, Sessions with mono 22 px values', () => {
    const page = head(full());
    assert.deepEqual(page.query('#head-kpis .lbl').map((l) => l.textContent), ['Laufzeit', 'Tokens', 'Kosten', 'Sessions']);
    assert.deepEqual(page.query('#head-kpis .head-kpi-v').map((v) => v.textContent), ['1m 0s', '0', '$0.00', '1']);
    assert.match(rule('.head-kpis'), /grid-template-columns: repeat\(4, minmax\(84px, auto\)\)/);
    assert.match(rule('.head-kpi-v'), /var\(--fs-kpi-22\)\/1\.2 var\(--mono\)/);
  });

  it('offers Pausieren while running and Fortsetzen when paused, through the control routes', () => {
    const running = head(full());
    const pause = running.query('#head-actions button.restart');
    assert.deepEqual(pause.map((b) => [b.textContent, b.getAttribute('data-verb')]), [['Pausieren', 'Pause']]);
    running.click(pause[0]!);
    assert.deepEqual(running.fetches.at(-1), { url: '/api/v1/acme%2Fapp%231/pause', method: 'POST' });
    const paused = head(full({ status: 'paused', running: null, paused: { source: 'operator', paused_at: '2026-10-30T11:50:00Z', continuations: 0 } }));
    const buttons = paused.query('#head-actions button.restart');
    assert.deepEqual(buttons.map((b) => b.textContent), ['Jetzt starten', 'Fortsetzen']);
    paused.click(buttons[1]!);
    assert.equal(paused.fetches.at(-1)!.url, '/api/v1/acme%2Fapp%231/resume');
  });

  it('hides the control buttons without controlAllowed', () => {
    const page = head(full({ controls: { retry: false } }));
    assert.equal(page.query('#head-actions button.restart').length, 0);
    assert.equal(page.query('#head-actions .restart-off').length, 0, 'no disabled note in the head card either');
  });

  it('links "GitHub ↗" to the issue in a new tab with noopener noreferrer, and only for an http(s) URL', () => {
    const link = head(full()).query('#head-actions a')[0]!;
    assert.equal(link.textContent, 'GitHub ↗');
    assert.equal(link.getAttribute('href'), 'https://github.com/acme/app/issues/1');
    assert.equal(link.getAttribute('target'), '_blank');
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(head(full({ issue_url: null })).query('#head-actions a').length, 0);
    assert.equal(head(full({ issue_url: 'javascript:alert(1)' })).query('#head-actions a').length, 0);
  });
});
