import type { ChangeStore } from './store.ts';
import {
  CHANGES_PAGE_DEFAULT,
  CHANGES_PAGE_LIMIT,
  type ChangeCounts,
  type ChangeEntry,
  type ChangeNoteHotspot,
  type ChangeStats,
  type ChangesPage,
  type ChangesQuery,
} from './types.ts';

const HOTSPOT_DAYS = 7;
const HOTSPOT_LIMIT = 10;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** State of a clash by id; null when unknown. */
export type ClashStatus = (id: string) => 'open' | 'resolved' | null;

/** The calendar day (`YYYY-MM-DD`) of a timestamp in a time zone. */
export function dayKey(ms: number, timeZone: string): string {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, format);
  }
  return format.format(ms);
}

export function changeCounts(entries: readonly ChangeEntry[]): ChangeCounts {
  const code = entries.filter((entry) => entry.type === 'code').length;
  return { all: entries.length, code, brain: entries.length - code };
}

/**
 * Today (the calendar day of `now` in `timeZone`): commits and merges by status; files (distinct repo + path) and lines of
 * the commits only, as merges repeat them; brain writes (no conflicts) separately. Hotspots: the files of the commits of the last 7 days by number of commits.
 */
export function changeStats(entries: readonly ChangeEntry[], now: Date, timeZone: string, clashStatus: ClashStatus = () => null): ChangeStats {
  const today = dayKey(now.getTime(), timeZone);
  const since = now.getTime() - HOTSPOT_DAYS * 24 * 3600 * 1000;
  const result: ChangeStats = { today: { commits: 0, merges: 0, files: 0, added: 0, deleted: 0, brain: 0 }, hotspots: [], conflicts_open: 0, note_hotspots: [] };
  const notes = new Map<string, ChangeNoteHotspot>();
  const todayFiles = new Set<string>();
  const counts = new Map<string, { path: string; repo: string; count: number }>();
  for (const entry of entries) {
    const at = Date.parse(entry.at);
    if (entry.type === 'brain') {
      if (dayKey(at, timeZone) === today && entry.status !== 'conflict') result.today.brain++;
      if (entry.status === 'conflict' && entry.clash_id && clashStatus(entry.clash_id) === 'open') result.conflicts_open++;
      if (at >= since) {
        for (const path of new Set(entry.files.map((file) => file.path))) {
          const note = notes.get(path) ?? { path, count: 0, clashes: 0 };
          if (entry.status === 'conflict') note.clashes++;
          else note.count++;
          notes.set(path, note);
        }
      }
      continue;
    }
    if (dayKey(at, timeZone) === today) {
      if (entry.status === 'merged') result.today.merges++;
      else if (entry.status === 'committed') {
        result.today.commits++;
        for (const file of entry.files) {
          todayFiles.add(`${entry.repo}\u0000${file.path}`);
          result.today.added += file.added ?? 0;
          result.today.deleted += file.deleted ?? 0;
        }
      }
    }
    if (entry.status === 'committed' && at >= since) {
      for (const path of new Set(entry.files.map((file) => file.path))) {
        const key = `${entry.repo}\u0000${path}`;
        const hot = counts.get(key) ?? { path, repo: entry.repo, count: 0 };
        hot.count++;
        counts.set(key, hot);
      }
    }
  }
  result.today.files = todayFiles.size;
  result.hotspots = [...counts.values()]
    .sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path))
    .slice(0, HOTSPOT_LIMIT);
  result.note_hotspots = [...notes.values()]
    .sort((a, b) => b.count + b.clashes - (a.count + a.clashes) || a.path.localeCompare(b.path))
    .slice(0, HOTSPOT_LIMIT);
  return result;
}

/** One page of the feed with its counts (all matches of repo and issue, whatever the type) and, on the first page, the stats. */
export function buildChangesPage(store: Pick<ChangeStore, 'list' | 'matching'>, query: ChangesQuery, now: Date, timeZone: string, clashStatus: ClashStatus = () => null): ChangesPage {
  const limit = Math.min(CHANGES_PAGE_LIMIT - 1, Math.max(1, Math.floor(query.limit ?? CHANGES_PAGE_DEFAULT)));
  const rows = store.list({ ...query, limit: limit + 1 });
  const entries = rows
    .slice(0, limit)
    .map((entry) => (entry.status === 'conflict' && entry.clash_id ? { ...entry, clash_status: clashStatus(entry.clash_id) } : entry));
  const base = store.matching({ repo: query.repo, issue: query.issue });
  return {
    entries,
    next_before: rows.length > limit ? entries[entries.length - 1]!.id : null,
    counts: changeCounts(base),
    stats: query.before === undefined ? changeStats(base, now, timeZone, clashStatus) : null,
  };
}
