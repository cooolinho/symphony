import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALERTS_JS } from '../src/http/alerts.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { domContext, run } from './helpers/fake-dom.ts';

// E4-8 (#466): text of the "Limit-Prognose" card per source, independent of the developer's tests.
const ctx = domContext(BASE_JS, ALERTS_JS);
const T = (hm: string) => `2026-10-31T${hm}:00Z`;
const clock = (iso: string) => {
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};
const state = { health: { dispatch_errors: [], last_tick_at: T('10:30'), last_tracker_error: null }, model_holds: [] };
const cards = (windows: Record<string, unknown>): any[] => {
  ctx.__s = state;
  ctx.__b = { generated_at: T('11:00'), five_hour: { alert: false, resets_at: null, forecast: null }, seven_day: { alert: false, resets_at: null, forecast: null }, ...windows };
  ctx.__r = undefined;
  return JSON.parse(JSON.stringify(run(ctx, 'alerts(__s, __b, __r)'))).filter((a: any) => a.kind === 'budget');
};
const win = (extra: Record<string, unknown>) => ({ alert: true, resets_at: T('13:00'), forecast: { eta: T('12:00'), limit_tokens: null, limit_source: 'sdk' }, ...extra });

describe('alert card: SDK source', () => {
  it('five-hour card reads "5-h-Fenster bei 87 % · Limit ca. HH:MM · Reset HH:MM"', () => {
    const [card] = cards({ five_hour: win({ percent_source: 'sdk', percent: 87 }) });
    assert.equal(card.text, `5-h-Fenster bei 87 % · Limit ca. ${clock(T('12:00'))} · Reset ${clock(T('13:00'))}`);
  });

  it('the percent is rounded to whole numbers', () => {
    assert.match(cards({ five_hour: win({ percent_source: 'sdk', percent: 86.6 }) })[0].text, /bei 87 % /);
    assert.match(cards({ five_hour: win({ percent_source: 'sdk', percent: 100.4 }) })[0].text, /bei 100 % /);
  });

  it('seven-day card names the 7-day window', () => {
    const [card] = cards({ seven_day: win({ percent_source: 'sdk', percent: 50 }) });
    assert.match(card.text, /^7-Tage-Fenster bei 50 % · Limit ca\. /);
  });

  it('without a reset the reset part is dropped', () => {
    const [card] = cards({ five_hour: win({ percent_source: 'sdk', percent: 87, resets_at: null }) });
    assert.equal(card.text, `5-h-Fenster bei 87 % · Limit ca. ${clock(T('12:00'))}`);
  });

  it('works with limit_tokens null and does not throw', () => {
    assert.equal(cards({ five_hour: win({ percent_source: 'sdk', percent: 87 }) }).length, 1);
  });
});

describe('alert card: calibrated source', () => {
  it('keeps the old text', () => {
    const [card] = cards({ five_hour: win({ percent_source: 'calibrated', percent: 60, forecast: { eta: T('12:00'), limit_tokens: 1000, limit_source: 'calibrated' } }) });
    assert.equal(card.text, `Beim aktuellen Verbrauch ist das Limit gegen ${clock(T('12:00'))} erreicht, Reset um ${clock(T('13:00'))}.`);
  });

  it('keeps the old text without percent_source (legacy payload) and without reset', () => {
    const [card] = cards({ five_hour: win({ resets_at: null, forecast: { eta: T('12:00'), limit_tokens: 1000 } }) });
    assert.equal(card.text, `Beim aktuellen Verbrauch ist das Limit gegen ${clock(T('12:00'))} erreicht.`);
  });

  it('percent_source none keeps the old text', () => {
    assert.match(cards({ five_hour: win({ percent_source: 'none', percent: null }) })[0].text, /^Beim aktuellen Verbrauch/);
  });
});
