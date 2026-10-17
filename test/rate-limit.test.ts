import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isWholeLimitMessage, limitScopeOf, modelFamilyOf, parseLimitMessage, type LimitWindow } from '../src/agent/rate-limit.ts';

const BERLIN = (reset: string) => `You've hit your session limit · resets ${reset} (Europe/Berlin)`;

interface Row {
  name: string;
  text: string;
  now: string;
  expected: string | null;
  zone?: string;
}

const rows: Row[] = [
  { name: 'evening time today', text: BERLIN('7:30pm'), now: '2026-10-05T15:20:31Z', expected: '2026-10-05T17:30:00Z' },
  { name: 'morning time, still today', text: BERLIN('7:10am'), now: '2026-10-05T02:29:23Z', expected: '2026-10-05T05:10:00Z' },
  { name: 'morning time, next day', text: BERLIN('7:10am'), now: '2026-10-05T15:20:31Z', expected: '2026-10-06T05:10:00Z' },
  { name: '12am is midnight', text: BERLIN('12am'), now: '2026-10-05T15:20:31Z', expected: '2026-10-05T22:00:00Z' },
  { name: '12pm is noon', text: BERLIN('12pm'), now: '2026-10-05T03:00:00Z', expected: '2026-10-05T10:00:00Z' },
  { name: '12:30pm', text: BERLIN('12:30pm'), now: '2026-10-05T03:00:00Z', expected: '2026-10-05T10:30:00Z' },
  { name: '24-hour time', text: BERLIN('19:30'), now: '2026-10-05T15:20:31Z', expected: '2026-10-05T17:30:00Z' },
  { name: 'bare number is invalid', text: BERLIN('7'), now: '2026-10-05T15:20:31Z', expected: null },
  { name: 'hour 13 with pm is invalid', text: BERLIN('13pm'), now: '2026-10-05T15:20:31Z', expected: null },
  { name: 'weekday form is not supported', text: BERLIN('Mon 3am'), now: '2026-10-05T15:20:31Z', expected: null },
  { name: 'no time at all', text: 'You\'ve hit your session limit', now: '2026-10-05T15:20:31Z', expected: null },
  { name: 'fall back: first occurrence', text: BERLIN('2:30am'), now: '2026-10-24T22:30:00Z', expected: '2026-10-25T00:30:00Z' },
  { name: 'fall back: later occurrence is next after now', text: BERLIN('2:30am'), now: '2026-10-25T00:45:00Z', expected: '2026-10-25T01:30:00Z' },
  { name: 'fall back: both passed, next day', text: BERLIN('2:30am'), now: '2026-10-25T01:45:00Z', expected: '2026-10-26T01:30:00Z' },
  { name: 'spring forward: gap resolves after the gap', text: BERLIN('2:30am'), now: '2026-03-28T23:00:00Z', expected: '2026-03-29T01:30:00Z' },
  { name: 'date with comma', text: BERLIN('Oct 9, 3pm'), now: '2026-10-05T10:00:00Z', expected: '2026-10-09T13:00:00Z' },
  { name: 'date rolls into next year', text: BERLIN('Jan 2, 9am'), now: '2026-12-30T10:00:00Z', expected: '2027-01-02T08:00:00Z' },
  { name: 'full month name, ordinal and "at"', text: BERLIN('October 9th at 3pm'), now: '2026-10-05T10:00:00Z', expected: '2026-10-09T13:00:00Z' },
  { name: 'unknown month', text: BERLIN('Foo 9, 3pm'), now: '2026-10-05T10:00:00Z', expected: null },
  { name: 'Feb 29 waits for the leap year', text: BERLIN('Feb 29, 9am'), now: '2026-10-05T10:00:00Z', expected: '2028-02-29T08:00:00Z' },
  { name: 'default zone UTC', text: "You've hit your session limit · resets 7:30pm", now: '2026-10-05T15:20:31Z', expected: '2026-10-05T19:30:00Z', zone: 'UTC' },
  { name: 'default zone New York', text: "You've hit your session limit · resets 7:30pm", now: '2026-10-05T15:20:31Z', expected: '2026-10-05T23:30:00Z', zone: 'America/New_York' },
  { name: 'explicit zone wins over default', text: "You've hit your session limit · resets 7:30pm (UTC)", now: '2026-10-05T15:20:31Z', expected: '2026-10-05T19:30:00Z', zone: 'America/New_York' },
  { name: 'unknown zone', text: "You've hit your session limit · resets 7:30pm (Mars/Olympus)", now: '2026-10-05T15:20:31Z', expected: null },
  { name: 'typographic apostrophe', text: 'You’ve hit your session limit · resets 7:30pm (UTC)', now: '2026-10-05T15:20:31Z', expected: '2026-10-05T19:30:00Z' },
];

describe('parseLimitMessage resetsAt', () => {
  for (const row of rows) {
    it(row.name, () => {
      const parsed = parseLimitMessage(row.text, new Date(row.now), row.zone ? { defaultZone: row.zone } : undefined);
      assert.ok(parsed);
      assert.equal(parsed.resetsAt?.toISOString() ?? null, row.expected === null ? null : new Date(row.expected).toISOString());
    });
  }
});

describe('parseLimitMessage window', () => {
  const now = new Date('2026-10-05T15:20:31Z');
  const cases: Array<[string, LimitWindow | null]> = [
    ["You've hit your session limit", 'five_hour'],
    ["You've hit your weekly limit", 'seven_day'],
    ["You've hit your weekly Opus limit", 'seven_day_opus'],
    ["You've hit your Sonnet weekly limit", 'seven_day_sonnet'],
    ["You've hit your usage limit", null],
    ["You've HIT YOUR Session LIMIT", 'five_hour'],
  ];
  for (const [text, window] of cases) {
    it(`${text} -> ${window}`, () => {
      assert.equal(parseLimitMessage(text, now)?.window, window);
    });
  }

  it('returns null for text that is not a limit message', () => {
    assert.equal(parseLimitMessage('Something else went wrong · resets 7pm', now), null);
    assert.equal(parseLimitMessage('', now), null);
  });
});

describe('parseLimitMessage scope', () => {
  const now = new Date('2026-10-05T15:20:31Z');
  const cases: Array<[string, 'account' | 'model', string | null, LimitWindow | null]> = [
    ["You've reached your Fable limit. Switch to another model to continue.", 'model', 'fable', null],
    ["You've hit your Fable limit", 'model', 'fable', null],
    ["You've hit your weekly Fable limit · resets Oct 9, 3pm (Europe/Berlin)", 'model', 'fable', 'seven_day'],
    ["You've reached your weekly Haiku limit", 'model', 'haiku', 'seven_day'],
    ["You've hit your weekly Opus limit", 'model', 'opus', 'seven_day_opus'],
    ["You've reached your Sonnet limit", 'model', 'sonnet', 'seven_day_sonnet'],
    ["You've hit your session limit", 'account', null, 'five_hour'],
    ["You've reached your session limit", 'account', null, 'five_hour'],
    ["You've hit your weekly limit", 'account', null, 'seven_day'],
    ["You've hit your usage limit", 'account', null, null],
  ];
  for (const [text, scope, model, window] of cases) {
    it(`${text} -> ${scope} ${model ?? ''}`, () => {
      const parsed = parseLimitMessage(text, now);
      assert.equal(parsed?.scope, scope);
      assert.equal(parsed?.model, model);
      assert.equal(parsed?.window, window);
    });
  }

  it('reads the reset of a reached wording', () => {
    const parsed = parseLimitMessage("You've reached your Fable limit · resets 7:30pm (UTC)", now);
    assert.equal(parsed?.resetsAt?.toISOString(), '2026-10-05T19:30:00.000Z');
  });
});

describe('limitScopeOf', () => {
  it('lets the model in the text win over the event window', () => {
    assert.deepEqual(limitScopeOf('seven_day', 'fable'), { scope: 'model', model: 'fable' });
    assert.deepEqual(limitScopeOf('five_hour', 'fable'), { scope: 'model', model: 'fable' });
  });
  it('maps the model windows of the SDK to their family', () => {
    assert.deepEqual(limitScopeOf('seven_day_opus', null), { scope: 'model', model: 'opus' });
    assert.deepEqual(limitScopeOf('seven_day_sonnet', null), { scope: 'model', model: 'sonnet' });
  });
  it('keeps every other window account-wide', () => {
    for (const window of ['five_hour', 'seven_day', 'overage', null]) assert.deepEqual(limitScopeOf(window, null), { scope: 'account', model: null });
  });
});

describe('modelFamilyOf', () => {
  it('maps aliases and model ids to their family', () => {
    assert.equal(modelFamilyOf('fable'), 'fable');
    assert.equal(modelFamilyOf('claude-fable-5-1'), 'fable');
    assert.equal(modelFamilyOf('opus[1m]'), 'opus');
    assert.equal(modelFamilyOf('claude-haiku-4-5-20251001'), 'haiku');
    assert.equal(modelFamilyOf('Sonnet'), 'sonnet');
  });
  it('has no family for the default model and unknown names', () => {
    assert.equal(modelFamilyOf(null), null);
    assert.equal(modelFamilyOf('gpt-4'), null);
    assert.equal(modelFamilyOf('opusx'), null);
  });
});

describe('isWholeLimitMessage', () => {
  it('accepts a text that is only a limit message', () => {
    assert.ok(isWholeLimitMessage("You've reached your Fable limit. Switch to another model to continue."));
    assert.ok(isWholeLimitMessage("  You've hit your session limit · resets 7:30pm (Europe/Berlin)\n"));
    assert.ok(isWholeLimitMessage('You’ve hit your weekly limit'));
  });
  it('rejects answers that only mention a limit', () => {
    assert.ok(!isWholeLimitMessage(''));
    assert.ok(!isWholeLimitMessage('Fixed it. You hit your rate limit earlier, so I added a backoff.'));
    assert.ok(!isWholeLimitMessage("Done.\n\nYou've reached your Fable limit."));
    assert.ok(!isWholeLimitMessage(`You've hit your session limit ${'x'.repeat(400)}`));
  });
});
