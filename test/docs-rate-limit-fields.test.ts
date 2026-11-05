import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Documentation checks for issue #465 (E4-10): `utilization`, `surpassedThreshold` and `unifiedWindows` in
 * docs/agent-claude.md and the Limit-Prognose / question 5 / E4-3 parts of the dashboard-brain concept.
 * The expected numbers are the real payloads from the spike comments by cooolinho on #320 (2026-11-01).
 */

const root = path.join(import.meta.dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

const AGENT = 'docs/agent-claude.md';
const CONCEPT = 'docs/concepts/dashboard-brain/konzept.md';

/** The text from the rate-limit paragraph in "Events and accounting" up to the "### Limit forecast" heading. */
function rateLimitPart(): string {
  const text = read(AGENT);
  const start = text.indexOf('Instances sharing a log directory');
  const end = text.indexOf('### Limit forecast');
  assert.ok(start >= 0, 'rate-limit paragraph not found');
  assert.ok(end > start, '"### Limit forecast" must follow the rate-limit paragraph');
  return text.slice(start, end);
}

function bodyOf(file: string, heading: RegExp): string {
  const lines = read(file).split('\n');
  const start = lines.findIndex((line) => heading.test(line));
  assert.notEqual(start, -1, `${file}: no line matching ${heading}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6} |^\*\*[^*]+\*\*$/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** All top-level JSON objects of the fenced code blocks; `//` comment lines are dropped. */
function payloads(part: string): Record<string, any>[] {
  const result: Record<string, any>[] = [];
  for (const block of part.matchAll(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm)) {
    const code = (block[1] ?? '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    let depth = 0;
    let from = -1;
    for (let i = 0; i < code.length; i++) {
      if (code[i] === '{') {
        if (depth++ === 0) from = i;
      } else if (code[i] === '}' && --depth === 0) {
        const raw = code.slice(from, i + 1);
        try {
          result.push(JSON.parse(raw));
        } catch (error) {
          assert.fail(`code block in ${AGENT} holds an object that is not valid JSON: ${(error as Error).message}\n${raw}`);
        }
      }
    }
  }
  return result;
}

const GERMAN = /\b(und|nicht|der|die|das|ist|werden|wird|Fenster|sondern)\b/;

describe('docs/agent-claude.md: rate-limit event fields (#465)', () => {
  it('the new description sits before "### Limit forecast", which stays after it', () => {
    const text = read(AGENT);
    assert.equal(text.match(/^### Limit forecast$/gm)?.length, 1);
    const part = rateLimitPart();
    for (const field of ['utilization', 'surpassedThreshold', 'unifiedWindows']) assert.ok(part.includes(`\`${field}\``), field);
  });

  it('utilization: share 0 to 1 of the window named by rateLimitType, missing on rejected', () => {
    const part = rateLimitPart();
    const item = part.split('\n').find((line) => line.includes('`utilization`') && /share|fraction|portion/i.test(line)) ?? '';
    assert.ok(item, 'no description line for utilization');
    assert.match(part, /`rateLimitType`/);
    assert.match(item + part, /`0`\s*(to|–|-)\s*`1`|0\s*(to|–|-)\s*1/);
    assert.match(part, /(missing|absent|not (set|present)|no)[^\n]*`rejected`|`rejected`[^\n]*(missing|absent|neither|no |not )/i);
  });

  it('surpassedThreshold: exceeded warning level, same scale, 0.75 for seven_day and 0.9 for five_hour, with allowed_warning', () => {
    const part = rateLimitPart();
    const item = part.split('\n').find((line) => line.includes('`surpassedThreshold`') && /warning/i.test(line)) ?? '';
    assert.ok(item, 'no description line for surpassedThreshold');
    const around = part.slice(part.indexOf(item));
    assert.match(around, /same scale/i);
    assert.match(around, /0\.75/);
    assert.match(around, /0\.9\b/);
    assert.match(around, /`seven_day`/);
    assert.match(around, /`five_hour`/);
    assert.match(around, /`allowed_warning`/);
  });

  it('unifiedWindows: not typed, per window utilization and resetsAt, overage window, values above 1, read defensively', () => {
    const part = rateLimitPart();
    const item = part.split('\n').find((line) => line.includes('`unifiedWindows`') && /not typed|untyped|undocumented/i.test(line)) ?? '';
    assert.ok(item, 'unifiedWindows must be marked as not typed');
    const around = part.slice(part.indexOf(item));
    assert.match(around, /`utilization`/);
    assert.match(around, /`resetsAt`/);
    assert.match(around, /`seven_day_overage_included`/);
    assert.match(around, /above `?1`?|greater than `?1`?|over `?1`?|> ?1/i);
    assert.match(around, /defensive/i);
  });

  it('names the four findings', () => {
    const part = rateLimitPart();
    // 1: rateLimitType is the window that currently binds
    assert.match(part, /bind/i);
    // 2: rejected carries neither utilization nor surpassedThreshold
    assert.match(part, /`rejected`[^\n]*neither[^\n]*`utilization`[^\n]*`surpassedThreshold`/i);
    // 3: unifiedWindows in every event
    assert.match(part, /`unifiedWindows`[^\n]*(every|each) event|(every|each) event[^\n]*`unifiedWindows`/i);
    // 4: fixed blocks, 5-hour steps, Wednesday 09:00 UTC, restart at 0
    assert.match(part, /fixed/i);
    assert.match(part, /five hours|5 hours|5-hour steps|five-hour steps/i);
    assert.match(part, /Wednesday\s+09:00\s+UTC/);
    assert.match(part, /(starts|begins|restarts)[^\n]*`?0`?/i);
  });

  it('shows two abridged real payloads in a code block, with the numbers of the #320 comment', () => {
    const objects = payloads(rateLimitPart());
    assert.ok(objects.length >= 2, `expected two payloads, found ${objects.length}`);
    const warning = objects.find((o) => o.status === 'allowed_warning');
    const rejected = objects.find((o) => o.status === 'rejected');
    assert.ok(warning, 'no allowed_warning payload');
    assert.ok(rejected, 'no rejected payload');

    assert.equal(warning.rateLimitType, 'seven_day');
    assert.equal(warning.utilization, 0.77);
    assert.equal(warning.surpassedThreshold, 0.75);
    assert.equal(warning.resetsAt, 1793782800);
    assert.deepEqual(warning.unifiedWindows?.five_hour, { utilization: 0, resetsAt: 1793497800 });
    assert.deepEqual(warning.unifiedWindows?.seven_day, { utilization: 0.77, resetsAt: 1793782800 });

    assert.equal(rejected.rateLimitType, 'five_hour');
    assert.equal(rejected.resetsAt, 1793537400);
    assert.ok(!('utilization' in rejected), 'rejected must not carry utilization');
    assert.ok(!('surpassedThreshold' in rejected), 'rejected must not carry surpassedThreshold');
    assert.deepEqual(rejected.unifiedWindows?.five_hour, { utilization: 1.01, resetsAt: 1793537400 });
    assert.deepEqual(rejected.unifiedWindows?.seven_day, { utilization: 0.91, resetsAt: 1793782800 });
    const overage = rejected.unifiedWindows?.seven_day_overage_included;
    if (overage !== undefined) assert.deepEqual(overage, { utilization: 0.7, resetsAt: 1793782800 });
  });

  it('the new part is English', () => {
    const prose = rateLimitPart().replace(/^```[\s\S]*?^```$/gm, '');
    assert.doesNotMatch(prose, GERMAN);
  });
});

describe('konzept.md: Limit-Prognose, question 5 and E4-3 (#465)', () => {
  it('Limit-Prognose: utilization per window from unifiedWindows of the latest event, calibration only a fallback', () => {
    const body = bodyOf(CONCEPT, /^\*\*Limit-Prognose\*\*$/);
    assert.match(body, /`unifiedWindows`/);
    assert.match(body, /neuest/);
    assert.match(body, /Fallback/);
    assert.match(body, /Kalibrierung/);
    assert.match(body, /`session_limit`/);
    assert.doesNotMatch(body, /offene Frage 5|falls es sie liefert/);
  });

  it('no reference to an open question 5 is left', () => {
    assert.doesNotMatch(read(CONCEPT), /offene Frage 5/);
  });

  it('question 5 is decided on 2026-11-01 with a reference to the spike comment on #320, no longer open', () => {
    const text = read(CONCEPT);
    const roast = text.slice(text.indexOf('## Roast: offene Fragen'));
    const decided = roast.indexOf('**Entschieden am 2026-11-01**');
    const open = roast.indexOf('**Noch offen**');
    assert.ok(decided >= 0, 'no "Entschieden am 2026-11-01" block');
    assert.ok(open > decided, '"Noch offen" must come after the new decided block');
    const decidedBlock = roast.slice(decided, open);
    const openBlock = roast.slice(open).split(/\n## /)[0] ?? '';
    assert.match(decidedBlock, /^5\. \*\*Liefert das SDK eine Auslastung\?\*\*/m);
    assert.match(decidedBlock, /#320/);
    assert.match(decidedBlock, /#332/);
    assert.doesNotMatch(openBlock, /Liefert das SDK eine Auslastung/);
    assert.doesNotMatch(openBlock, /^5\. /m);
    // the other open questions stay open
    assert.match(openBlock, /^4\. \*\*Was schreibt Symphony automatisch\?\*\*/m);
    assert.match(openBlock, /^7\. \*\*Retention\.\*\*/m);
  });

  it('E4-3 acceptance is noted as fulfilled with #332 and the comment on #320', () => {
    const body = bodyOf(CONCEPT, /^\*\*E4-3 Spike: Auslastung aus dem SDK\*\*$/);
    assert.match(body, /Abnahme: Beispiel-Payloads aus echten Sessions dokumentiert/);
    assert.match(body, /Erfüllt|erfüllt/);
    assert.match(body, /#332/);
    assert.match(body, /#320/);
    assert.match(body, /docs\/agent-claude\.md/);
  });
});
