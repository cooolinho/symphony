/**
 * The acceptance criteria of an issue live as checkboxes in its body. This module reads them, appends the ones the
 * analysis adds and ticks them off after a review. Pure text functions: the `report_result` tool does the writing.
 * See docs/results.md#acceptance-criteria.
 */

export const CRITERIA_BLOCK_START = '<!-- symphony:criteria:start -->';
export const CRITERIA_BLOCK_END = '<!-- symphony:criteria:end -->';
const BLOCK_HEADING = '### Ergänzte Akzeptanzkriterien (Symphony)';
/** Separates a criterion's text from the note Symphony writes behind it. */
export const CRITERION_ANCHOR = '<!-- symphony:ac -->';

export const DEFAULT_CRITERIA_HEADINGS: readonly string[] = ['Acceptance criteria', 'Akzeptanzkriterien'];

/** GitHub refuses longer issue bodies. */
export const ISSUE_BODY_LIMIT = 65_536;
const NOTE_TEXT_MAX = 120;

export const CRITERION_STATUSES = ['met', 'unmet', 'manual'] as const;
export type CriterionStatus = (typeof CRITERION_STATUSES)[number];

export interface Criterion {
  text: string;
  checked: boolean;
  /** 0-based line of the body. */
  line: number;
  /** `symphony` = in the block Symphony appended. */
  source: 'body' | 'symphony';
}

export interface CriterionVerdict {
  criterion: string;
  status: CriterionStatus;
  evidence?: string | undefined;
  reason?: string | undefined;
}

const textOf = (rest: string) => (rest.split(CRITERION_ANCHOR)[0] as string).trim();

/** What two spellings of one criterion (or refactoring goal) have in common. */
export const criterionKey = (value: string) => textOf(value).replace(/\s+/g, ' ').toLowerCase();

const CHECKBOX = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s+)(.*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;

function isCriteriaHeading(title: string, headings: readonly string[]): boolean {
  const plain = title.replace(/[*_`]/g, '').trim().toLowerCase();
  return headings.some((heading) => {
    const wanted = heading.trim().toLowerCase();
    return wanted !== '' && plain.startsWith(wanted) && !/^\p{L}/u.test(plain.slice(wanted.length));
  });
}

const splitLines = (body: string) => body.split('\n').map((line) => line.replace(/\r$/, ''));
const eolOf = (body: string) => (body.includes('\r\n') ? '\r\n' : '\n');

/** First and last line of Symphony's block; null without a complete one. */
function blockRange(lines: readonly string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.trim() === CRITERIA_BLOCK_START);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line.trim() === CRITERIA_BLOCK_END);
  return end < 0 ? null : { start, end };
}

/**
 * Checkbox lines under a criteria heading (any level, up to the next heading of the same or a higher level) and in
 * Symphony's block. Other task lists, code blocks and HTML comments do not count.
 */
export function parseCriteria(body: string | null, headings: readonly string[] = DEFAULT_CRITERIA_HEADINGS): Criterion[] {
  if (body === null) return [];
  const lines = splitLines(body);
  const block = blockRange(lines);
  const found: Criterion[] = [];
  let section: number | null = null;
  let fence: string | null = null;
  let comment = false;
  for (const [index, line] of lines.entries()) {
    const inBlock = block !== null && index > block.start && index < block.end;
    if (fence !== null) {
      const close = FENCE.exec(line)?.[1];
      if (close !== undefined && close[0] === fence[0] && close.length >= fence.length) fence = null;
      continue;
    }
    if (comment) {
      if (line.includes('-->')) comment = false;
      continue;
    }
    fence = FENCE.exec(line)?.[1] ?? null;
    if (fence !== null) continue;
    if (line.lastIndexOf('<!--') > line.lastIndexOf('-->')) {
      comment = true;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      if (inBlock) continue;
      const level = (heading[1] as string).length;
      if (isCriteriaHeading(heading[2] as string, headings)) section = section === null ? level : Math.min(section, level);
      else if (section !== null && level <= section) section = null;
      continue;
    }
    if (section === null && !inBlock) continue;
    const box = CHECKBOX.exec(line);
    if (box === null) continue;
    const text = textOf(box[4] as string);
    if (text !== '') found.push({ text, checked: box[2] !== ' ', line: index, source: inBlock ? 'symphony' : 'body' });
  }
  return found;
}

/** The criteria without repeated texts, in order of appearance. */
export function uniqueCriteria<T extends { text: string }>(criteria: readonly T[]): T[] {
  const seen = new Set<string>();
  return criteria.filter((criterion) => {
    const key = criterionKey(criterion.text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Agent text as one harmless line: no HTML, no comment that could pose as a marker, no @mention that notifies. */
function plainLine(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/</g, '‹').replace(/>/g, '›').replace(/@(?=\w)/g, '@​').trim();
}

function shorten(value: string): string {
  const line = plainLine(value);
  const cut = line.length > NOTE_TEXT_MAX ? `${line.slice(0, NOTE_TEXT_MAX - 1)}…` : line;
  // A cut through `code` would turn the rest of the note into code.
  return (cut.split('`').length - 1) % 2 === 0 ? cut : cut.replaceAll('`', '');
}

/** An added criterion as stored: `>` survives (it renders as text), comments and mentions do not. */
const criterionLine = (value: string) =>
  value.replace(/\s+/g, ' ').replace(/<!--|-->/g, '').replace(/@(?=\w)/g, '@​').trim();

/**
 * Replaces Symphony's block (or appends it) with the criteria the body does not state itself. A line the old block
 * already had keeps its tick and note; without anything to add the block is removed.
 */
export function upsertAddedBlock(body: string | null, added: readonly string[], headings: readonly string[] = DEFAULT_CRITERIA_HEADINGS): string {
  const original = body ?? '';
  const eol = eolOf(original);
  const lines = splitLines(original);
  const criteria = parseCriteria(original, headings);
  const stated = new Set(criteria.filter((c) => c.source === 'body').map((c) => criterionKey(c.text)));
  const previous = new Map(criteria.filter((c) => c.source === 'symphony').map((c) => [criterionKey(c.text), lines[c.line] as string]));
  const items = uniqueCriteria(added.map((value) => ({ text: criterionLine(value) })))
    .filter((c) => c.text !== '' && !stated.has(criterionKey(c.text)))
    .map((c) => previous.get(criterionKey(c.text)) ?? `- [ ] ${c.text}`);
  const next = items.length === 0 ? [] : [CRITERIA_BLOCK_START, BLOCK_HEADING, '', ...items, CRITERIA_BLOCK_END];
  const block = blockRange(lines);
  if (block !== null) {
    lines.splice(block.start, block.end - block.start + 1, ...next);
    return lines.join(eol);
  }
  if (next.length === 0) return original;
  const head = original.replace(/\s+$/, '');
  return `${head === '' ? '' : `${head}${eol}${eol}`}${next.join(eol)}${eol}`;
}

const NOTE_ICONS: Record<CriterionStatus, string> = { met: '✅', unmet: '❌', manual: '👤' };

function noteFor(verdict: CriterionVerdict, round: number | null, url: string | null): string {
  const label = round === null ? '' : ` R${round}`;
  const detail =
    verdict.status === 'met'
      ? `Beleg: ${shorten(verdict.evidence ?? '')}`
      : verdict.status === 'unmet'
        ? shorten(verdict.reason ?? verdict.evidence ?? 'nicht erfüllt')
        : shorten(verdict.reason ?? '');
  const head = verdict.status === 'manual' ? `${NOTE_ICONS.manual} manuell prüfen${label}` : `${NOTE_ICONS[verdict.status]}${label}`;
  const link = url !== null && /^https:\/\/[^\s()<>]+$/.test(url) ? `[Review](${url})` : null;
  return `<sub>${[head, detail, link].filter((part) => part !== null && part !== '' && part !== 'Beleg: ').join(' · ')}</sub>`;
}

export interface TickedBody {
  body: string;
  /** Criteria whose box is ticked afterwards. */
  ticked: number;
  total: number;
}

/**
 * Writes a review's verdicts into the body: `met` ticks, `unmet` unticks, `manual` leaves the box to the human and
 * only unticks one Symphony had ticked itself. Lines without a verdict stay as they are. Null when the body would
 * pass GitHub's limit even without notes.
 */
export function applyVerdicts(
  body: string,
  verdicts: readonly CriterionVerdict[],
  { round, url, headings = DEFAULT_CRITERIA_HEADINGS }: { round: number | null; url: string | null; headings?: readonly string[] },
): TickedBody | null {
  const byKey = new Map(verdicts.map((verdict) => [criterionKey(verdict.criterion), verdict]));
  const criteria = parseCriteria(body, headings);
  const render = (notes: boolean): TickedBody => {
    const lines = splitLines(body);
    let ticked = 0;
    for (const criterion of criteria) {
      const verdict = byKey.get(criterionKey(criterion.text));
      let checked = criterion.checked;
      if (verdict !== undefined) {
        const line = lines[criterion.line] as string;
        const [, open, , close, rest] = CHECKBOX.exec(line) as unknown as [string, string, string, string, string];
        const tickedBySymphony = rest.includes(`${CRITERION_ANCHOR} <sub>${NOTE_ICONS.met}`);
        checked = verdict.status === 'met' ? true : verdict.status === 'unmet' ? false : checked && !tickedBySymphony;
        const note = notes ? ` ${CRITERION_ANCHOR} ${noteFor(verdict, round, url)}` : '';
        lines[criterion.line] = `${open}${checked ? 'x' : ' '}${close}${textOf(rest)}${note}`;
      }
      if (checked) ticked++;
    }
    return { body: lines.join(eolOf(body)), ticked, total: criteria.length };
  };
  const noted = render(true);
  if (noted.body.length <= ISSUE_BODY_LIMIT) return noted;
  const bare = render(false);
  return bare.body.length <= ISSUE_BODY_LIMIT ? bare : null;
}
