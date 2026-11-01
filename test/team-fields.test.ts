import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_HTML } from '../src/http/issue-page.ts';
import { renderPage } from './helpers.ts';
import { issueDetail, teamView } from './helpers/page-fixtures.ts';

// E3-6 (#385): the fields "Jetzt", "Session" and "Subagents" below the stage. The frozen clock is 12:00:00.

const AGENT_URL = 'http://127.0.0.1/issue?id=acme%2Fapp%231';
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const NO_SESSION = { active: null, subagents: { running: [], finished: [] } };
const fields = (team: Obj, extra: Obj = {}) => renderPage(AGENT_HTML, { detail: issueDetail(), team, ...extra }, { url: AGENT_URL });
const txt = (page: ReturnType<typeof fields>, id: string) => page.$(id).textContent ?? '';
const rule = (selector: string): string => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = AGENT_HTML.match(new RegExp(`\\n\\s*${esc} \\{([^}]*)\\}`));
  assert.ok(m, `rule ${selector}`);
  return m[1]!.replace(/\s+/g, ' ');
};

describe('E3-6 field "Jetzt"', () => {
  it('is titled with the role, shows "vor <s> s" and a role-coloured border', () => {
    const page = fields(teamView());
    assert.equal(page.$('stage-now-meta').textContent, 'Jetzt · Developer');
    assert.equal(page.$('stage-now-ago').textContent, 'vor 10 s');
    assert.equal(page.$('stage-now').style.borderColor, 'rgba(52,211,153,.35)');
    assert.ok(page.$('stage-now').className.includes('gi'));
    assert.match(rule('#stage-now'), /flex: 2 1 380px/);
    assert.match(rule('.field-ago'), /12px var\(--mono\)/);
  });

  it('shows the action as "<Tool> <Argument>" with the argument in the light role colour', () => {
    const page = fields(teamView());
    const action = page.query('#stage-now-body .stage-action')[0]!;
    assert.equal(action.textContent, 'Edit src/http/ui/tokens.ts');
    assert.equal(action.querySelector('.tool')!.textContent, 'Edit');
    const arg = action.querySelector('.arg')!;
    assert.equal(arg.textContent, 'src/http/ui/tokens.ts');
    assert.equal(arg.style.color, '#d1fae5');
    const css = rule('.stage-action');
    assert.ok(css.includes('19px/1.35 var(--mono)') && css.includes('overflow-wrap: anywhere'), css);
    assert.match(rule('.stage-desc'), /font-size: 13px; color: var\(--fg-2\)/);
  });

  it('describes the newest tool result of the live session from its transcript', () => {
    const session = { run: 'r1', attempt: null, role: 'developer', state: 'In progress', model: 'opus', effort: null, started_at: '2026-10-30T11:59:00.000Z', finished_at: null, outcome: null, transcript: '/t/r1.jsonl' };
    const entries = [
      { type: 'model_call', offset: 1, at: '2026-10-30T11:59:40.000Z', message_id: 'm1', model: 'opus', usage: null, cost_usd: null, blocks: [{ type: 'tool_use', id: 'tu1', name: 'Edit', input: '{"file_path":"src/http/ui/tokens.ts"}' }] },
      { type: 'tool_result', offset: 2, at: '2026-10-30T11:59:45.000Z', tool_use_id: 'tu1', is_error: false, text: '+212 Zeilen' },
    ];
    const tx = new Map([['r1', { offset: 3, entries, available: true, reason: null, done: false }]]);
    const page = renderPage(AGENT_HTML, { detail: issueDetail({ sessions: [session] }), team: teamView(), tx, dirty: true }, { url: AGENT_URL });
    assert.equal(page.query('#stage-now-body .stage-desc')[0]!.textContent, '+212 Zeilen');
  });

  it('traces the last four tool calls with arrows and tints only the newest in the role colour', () => {
    const page = fields(teamView());
    const chips = page.query('#stage-now-body .stage-trace .ui-chip');
    assert.deepEqual(chips.map((c) => c.textContent), ['Grep', 'Bash', 'Write', 'Edit']);
    assert.ok(chips.every((c) => c.className.includes('mono')));
    assert.equal(page.query('#stage-now-body .stage-arrow').length, 3);
    assert.match(rule('.stage-arrow'), /color: #5b6678/);
    const last = chips.at(-1)!;
    assert.equal(last.style.color, '#d1fae5');
    assert.equal(last.style.borderColor, 'rgba(52,211,153,.6)');
    assert.equal(last.style.background, 'rgba(52,211,153,.16)');
    for (const c of chips.slice(0, -1)) assert.equal(c.style.background ?? '', '');
    assert.equal(last.getAttribute('title'), 'Edit: src/http/ui/tokens.ts');
  });

  it('says "Keine Session aktiv" without a session and shows the last trace without highlight', () => {
    const page = fields(teamView(NO_SESSION));
    assert.equal(page.$('stage-now-meta').textContent, 'Jetzt');
    assert.equal(page.$('stage-now-ago').textContent, '');
    assert.ok(txt(page, 'stage-now-body').includes('Keine Session aktiv'));
    const chips = page.query('#stage-now-body .stage-trace .ui-chip');
    assert.deepEqual(chips.map((c) => c.textContent), ['Grep', 'Bash', 'Write', 'Edit']);
    for (const c of chips) assert.equal(c.style.background ?? '', '');
    assert.equal(page.query('#stage-now-body .stage-action').length, 0);
  });
});

describe('E3-6 field "Session"', () => {
  it('shows "<used>k / <window>k · <n> %", the gradient bar with the Auto-Compact mark and the hint', () => {
    const page = fields(teamView());
    const ctx = page.query('#stage-session-body .stage-ctx')[0]!;
    assert.equal(ctx.textContent, 'Context84k / 200k · 42 %');
    assert.ok(!ctx.querySelector('.mono')!.className.includes('hot'));
    const bar = page.query('#stage-session-body .ui-bar')[0]!;
    assert.ok(bar.className.includes('ui-bar-h8'));
    assert.equal(bar.getAttribute('aria-valuenow'), '42');
    const mark = page.query('#stage-session-body .ui-bar-mark')[0]!;
    assert.equal(mark.style.left, '80%');
    assert.equal(mark.getAttribute('title'), 'Auto-Compact');
    assert.equal(page.query('#stage-session-body .stage-hint')[0]!.textContent, 'rote Marke: Auto-Compact ab ca. 80 %');
    assert.match(rule('.stage-session .ui-bar-fill'), /linear-gradient\(90deg, #34d399, #fbbf24\)/);
    assert.match(rule('.stage-hint'), /font-size: 11\.5px/);
    assert.match(rule('#stage-session'), /flex: 1 1 260px/);
  });

  it('puts the mark where budget.compact_threshold says', () => {
    const page = fields(teamView({ compact_threshold: 70 }));
    assert.equal(page.query('#stage-session-body .ui-bar-mark')[0]!.style.left, '70%');
    assert.equal(page.query('#stage-session-body .stage-hint')[0]!.textContent, 'rote Marke: Auto-Compact ab ca. 70 %');
  });

  it('turns the value amber from 70 %', () => {
    const team = teamView();
    team.active.context = { tokens: 150000, window: 200000, percent: 75, compacts: 0 };
    const value = fields(team).query('#stage-session-body .stage-ctx .mono')[0]!;
    assert.equal(value.textContent, '150k / 200k · 75 %');
    assert.ok(value.className.includes('hot'));
  });

  it('shows "—" and an empty bar for an unknown window', () => {
    const team = teamView();
    team.active.context = { tokens: 84000, window: null, percent: null, compacts: 0 };
    const page = fields(team);
    assert.equal(page.query('#stage-session-body .stage-ctx .mono')[0]!.textContent, '—');
    assert.equal(page.query('#stage-session-body .ui-bar-fill')[0]!.style.width, '0%');
  });

  it('lists turn of max, duration, model with effort and tokens with cost in a mono grid', () => {
    const detail = issueDetail();
    detail.running.started_at = '2026-10-30T11:47:20.000Z';
    const page = renderPage(AGENT_HTML, { detail, team: teamView() }, { url: AGENT_URL });
    const rows = page.query('#stage-session-body .stage-kv dt').map((dt, i) => [dt.textContent, page.query('#stage-session-body .stage-kv dd')[i]!.textContent]);
    assert.deepEqual(rows, [['Turn', '23 / 50'], ['Dauer', '12m 40s'], ['Modell', 'opus · effort high'], ['Tokens', '1.1M · $1.40']]);
    assert.match(rule('.stage-kv'), /grid-template-columns: auto 1fr;.*font: 13px var\(--mono\)/);
    const bare = teamView();
    bare.active.max_turns = null;
    bare.active.effort = null;
    const plain = fields(bare).query('#stage-session-body .stage-kv dd').map((dd) => dd.textContent);
    assert.deepEqual(plain.slice(0, 1).concat(plain.slice(2, 3)), ['23', 'opus']);
  });

  it('says "Keine Session aktiv" without a session', () => {
    const page = fields(teamView(NO_SESSION));
    assert.ok(txt(page, 'stage-session-body').includes('Keine Session aktiv'));
    assert.equal(page.query('#stage-session-body .ui-bar').length, 0);
  });
});

describe('E3-6 field "Subagents"', () => {
  it('heads "<n> laufen · <m> fertig" and shows two-letter avatars, the running one with a pulse ring', () => {
    const page = fields(teamView());
    assert.equal(page.$('stage-subs-meta').textContent, '1 laufen · 1 fertig');
    const run = page.query('#stage-subs-body .stage-subagent.is-running')[0]!;
    const done = page.query('#stage-subs-body .stage-subagent.is-done')[0]!;
    assert.equal(run.querySelector('.sub-av')!.textContent, 'EX');
    assert.ok(run.querySelector('.sub-av .ring'));
    assert.equal(run.querySelector('.sub-av')!.getAttribute('aria-label'), 'Explore · läuft');
    assert.equal(done.querySelector('.sub-av')!.textContent, 'PL');
    assert.equal(done.querySelector('.sub-av .ring'), null);
    assert.match(rule('.sub-av'), /width: 30px; height: 30px; border-radius: 50%/);
    assert.match(rule('#stage-subs'), /flex: 1 1 300px/);
  });

  it('derives the short name from the type: initials of two words, else the first two letters', () => {
    const team = teamView();
    team.subagents.running[0].subagent_type = 'test-runner';
    team.subagents.finished[0].subagent_type = 'general-purpose';
    const avatars = fields(team).query('#stage-subs-body .sub-av').map((a) => a.textContent);
    assert.deepEqual(avatars, ['TR', 'GP']);
  });

  it('shows name, one-line task and "<Dauer> · <k>k" in green while running, "fertig · <k>k" when done', () => {
    const page = fields(teamView());
    const run = page.query('#stage-subs-body .stage-subagent.is-running')[0]!;
    const done = page.query('#stage-subs-body .stage-subagent.is-done')[0]!;
    assert.equal(run.querySelector('.sub-name')!.textContent, 'Explore');
    assert.equal(run.querySelector('.sub-task')!.textContent, 'Find callers');
    assert.equal(run.querySelector('.sub-right')!.textContent, '2m 0s · 12k');
    assert.equal(done.querySelector('.sub-right')!.textContent, 'fertig · 30k');
    assert.match(rule('.stage-subagent.is-running .sub-right'), /#6ee7b7/);
    assert.match(rule('.sub-task'), /font-size: 12px; color: var\(--fg-3\); white-space: nowrap; overflow: hidden; text-overflow: ellipsis/);
    assert.match(rule('.sub-name'), /font-size: 13px; font-weight: 500/);
  });

  it('keeps the running row (and its ring) across polls while its numbers update', () => {
    const page = fields(teamView());
    const ring = page.query('#stage-subs-body .sub-av .ring')[0];
    const next = teamView();
    next.subagents.running[0].tokens.total_tokens = 15000;
    page.render({ detail: issueDetail(), team: next });
    assert.equal(page.query('#stage-subs-body .sub-av .ring')[0], ring);
    assert.equal(page.query('#stage-subs-body .stage-subagent.is-running .sub-right')[0]!.textContent, '2m 0s · 15k');
  });

  it('says "Keine Subagents in dieser Session" without subagents and "Keine Session aktiv" without a session', () => {
    assert.equal(txt(fields(teamView({ subagents: { running: [], finished: [] } })), 'stage-subs-body'), 'Keine Subagents in dieser Session');
    assert.equal(txt(fields(teamView(NO_SESSION)), 'stage-subs-body'), 'Keine Session aktiv');
  });
});
