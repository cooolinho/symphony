/**
 * Made-up history for scripts/demo.ts, so that Changes, Brain and Statistik have content too: finished runs of the
 * last two weeks (repository log), code commits and merges (change log), and a small knowledge vault with agent
 * commits, a human promotion and today's brain accesses. Everything is relative to "now" and the same on every start.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { HistoryLog } from '../src/history/history.ts';

const REPO = 'acme/app';
const HOUR = 3_600_000;
const MODELS = { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' } as const;
type Model = keyof typeof MODELS;

/** Deterministic pseudo-random numbers (mulberry32), so every demo start looks the same. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface PastIssue {
  number: number;
  title: string;
  /** Hours before now when the first run started. */
  startedHoursAgo: number;
  stages: Array<[role: string, model: Model, effort: string | null]>;
  files: Array<[file: string, added: number, deleted: number]>;
  merged: boolean;
}

/** Issues that went through the pipeline before the demo starts. */
const PAST: PastIssue[] = [
  {
    number: 3, title: 'Add CSV export for invoices', startedHoursAgo: 300, merged: true,
    stages: [['issue-analyst', 'sonnet', null], ['developer', 'sonnet', 'medium'], ['test-engineer', 'sonnet', null], ['reviewer', 'opus', 'high']],
    files: [['app/Exports/InvoiceExport.php', 84, 0], ['app/Filament/Resources/InvoiceResource.php', 22, 3], ['tests/Feature/InvoiceExportTest.php', 61, 0]],
  },
  {
    number: 4, title: 'Upgrade to Filament 5', startedHoursAgo: 250, merged: true,
    stages: [['issue-analyst', 'sonnet', null], ['architect', 'fable', 'high'], ['developer', 'opus', 'high'], ['test-engineer', 'sonnet', null], ['reviewer', 'opus', 'high'], ['developer', 'opus', 'high'], ['reviewer', 'opus', 'high']],
    files: [['composer.json', 4, 4], ['composer.lock', 412, 389], ['app/Providers/Filament/AdminPanelProvider.php', 18, 11], ['app/Filament/Resources/CustomerResource.php', 37, 29]],
  },
  {
    number: 5, title: 'Fix rounding in tax totals', startedHoursAgo: 190, merged: true,
    stages: [['issue-analyst', 'haiku', null], ['developer', 'sonnet', 'medium'], ['test-engineer', 'sonnet', null], ['reviewer', 'opus', 'high']],
    files: [['app/Support/Money.php', 9, 4], ['tests/Unit/MoneyTest.php', 27, 0]],
  },
  {
    number: 6, title: 'Rate limiter for the public API', startedHoursAgo: 140, merged: true,
    stages: [['issue-analyst', 'sonnet', null], ['architect', 'fable', 'high'], ['developer', 'opus', 'high'], ['test-engineer', 'sonnet', null], ['reviewer', 'opus', 'high'], ['security-auditor', 'opus', 'high']],
    files: [['app/Http/Middleware/ThrottleApi.php', 46, 0], ['routes/api.php', 6, 2], ['config/api.php', 14, 0], ['tests/Feature/ApiThrottleTest.php', 58, 0]],
  },
  {
    number: 8, title: 'Deployment guide for the Docker setup', startedHoursAgo: 96, merged: true,
    stages: [['issue-analyst', 'haiku', null], ['docs', 'haiku', null], ['reviewer', 'sonnet', null]],
    files: [['docs/deployment.md', 118, 12], ['README.md', 9, 2]],
  },
  {
    number: 9, title: 'Ledger with double-entry bookings', startedHoursAgo: 52, merged: false,
    stages: [['issue-analyst', 'sonnet', null], ['architect', 'fable', 'high'], ['developer', 'opus', 'high'], ['test-engineer', 'sonnet', null], ['reviewer', 'opus', 'high'], ['security-auditor', 'opus', 'high']],
    files: [['app/Models/LedgerEntry.php', 52, 0], ['database/migrations/2026_10_29_000000_create_ledger_entries_table.php', 38, 0], ['app/Services/Ledger.php', 97, 0], ['tests/Feature/LedgerTest.php', 88, 0]],
  },
  {
    number: 10, title: 'Show overdue tasks on the dashboard', startedHoursAgo: 7, merged: true,
    stages: [['issue-analyst', 'haiku', null], ['developer', 'sonnet', 'medium'], ['test-engineer', 'sonnet', null], ['reviewer', 'opus', 'high']],
    files: [['app/Filament/Widgets/OverdueTasks.php', 41, 0], ['tests/Feature/OverdueTasksWidgetTest.php', 33, 0]],
  },
];

/** Runs of the past issues and of the issues the demo works on, in the repository log of the Statistik page. */
export function seedHistory(history: HistoryLog, now: number): void {
  const rnd = random(7);
  const finished = (issue: string, title: string, role: string, model: Model, effort: string | null, at: number, nextRole?: string): number => {
    const seconds = Math.round(240 + rnd() * (role === 'developer' ? 1500 : 600));
    const scale = model === 'haiku' ? 0.4 : role === 'developer' ? 1.6 : 1;
    const startedAt = new Date(at);
    const finishedAt = new Date(at + seconds * 1000);
    const run = `${issue.split('#')[1]}-${role}-${at.toString(36)}`;
    history.runStarted({ repo: REPO, issue, title, state: 'In progress', attempt: null, model: MODELS[model], effort, role, run, at: startedAt });
    history.runFinished({
      repo: REPO, issue, title, run, session: null, attempt: null, outcome: 'handed_off', role, nextRole, state: 'In progress', reason: 'done',
      turns: 1 + Math.floor(rnd() * 3), startedAt, finishedAt, agentSeconds: seconds, contextPeakPercent: Math.round(30 + rnd() * 50), contextCompacts: rnd() > 0.8 ? 1 : 0,
      modelRequested: MODELS[model], effort, claudeEstimateUsd: null,
      usage: {
        [MODELS[model]]: {
          inputTokens: Math.round((8_000 + rnd() * 30_000) * scale),
          outputTokens: Math.round((6_000 + rnd() * 24_000) * scale),
          cacheReadTokens: Math.round((300_000 + rnd() * 1_200_000) * scale),
          cacheWriteTokens: Math.round((40_000 + rnd() * 120_000) * scale),
        },
      },
    });
    return finishedAt.getTime();
  };
  for (const past of PAST) {
    let at = now - past.startedHoursAgo * HOUR;
    past.stages.forEach(([role, model, effort], index) => {
      at = finished(`${REPO}#${past.number}`, past.title, role, model, effort, at, past.stages[index + 1]?.[0]) + (5 + rnd() * 40) * 60_000;
    });
  }
  // Earlier sessions of the issues on the board, within the last few hours (Context-Budget, tokens per role).
  finished(`${REPO}#11`, 'Implement CSV import for recurring tasks', 'issue-analyst', 'sonnet', null, now - 3.5 * HOUR, 'developer');
  finished(`${REPO}#12`, 'Fix timezone drift in due dates', 'developer', 'sonnet', 'medium', now - 2.8 * HOUR, 'test-engineer');
  finished(`${REPO}#12`, 'Fix timezone drift in due dates', 'test-engineer', 'sonnet', null, now - 1.9 * HOUR, 'reviewer');
  finished(`${REPO}#17`, 'Generate the yearly tax report', 'architect', 'fable', 'high', now - 1.5 * HOUR, 'developer');
  finished(`${REPO}#15`, 'Flaky payment webhook retries', 'issue-analyst', 'haiku', null, now - 1.1 * HOUR, 'developer');
}

const DIFFS: Record<string, string> = {
  php: "+    public function handle(Request $request, Closure $next): Response\n+    {\n+        $key = $request->user()?->id ?? $request->ip();\n+        abort_if(RateLimiter::tooManyAttempts($key, 60), 429);",
  test: "+it('exports every invoice of the month', function () {\n+    Invoice::factory()->count(3)->create();\n+    $csv = (new InvoiceExport(now()))->toCsv();\n+    expect(str($csv)->substrCount(\"\\n\"))->toBe(4);",
  md: '+## Deployment\n+\n+The app ships as one image; `docker compose up -d` starts it behind Traefik.',
  other: '-        "filament/filament": "^4.2",\n+        "filament/filament": "^5.0",',
};

/** Code commits and merges of the past issues in the change log (`<logDir>/changes/acme_app.jsonl`). */
export function seedChanges(logDir: string, now: number): void {
  const rnd = random(11);
  const lines: string[] = [];
  for (const past of PAST) {
    const issue = `${REPO}#${past.number}`;
    const branch = `symphony/issue-${past.number}`;
    const pr = { number: 40 + past.number, status: past.merged ? ('success' as const) : ('pending' as const) };
    const end = now - (past.startedHoursAgo - past.stages.length * 0.6) * HOUR;
    const split = Math.max(1, Math.ceil(past.files.length / 2));
    const commits: Array<[role: string, files: PastIssue['files'], title: string]> = [
      ['developer', past.files.slice(0, split), past.title],
      ['test-engineer', past.files.slice(split), `Tests: ${past.title.toLowerCase()}`],
    ];
    commits.forEach(([role, files, title], index) => {
      if (files.length === 0) return;
      const first = files[0]![0];
      const diff = first.endsWith('Test.php') ? DIFFS.test! : first.endsWith('.php') ? DIFFS.php! : first.endsWith('.md') ? DIFFS.md! : DIFFS.other!;
      const sha = Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, '0') + 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
      lines.push(JSON.stringify({
        id: `code:${REPO}:${sha}`, type: 'code', at: new Date(end - (2 - index) * 0.7 * HOUR).toISOString(), repo: REPO, issue, role, title,
        files: files.map(([file, added, deleted]) => ({ path: file, added, deleted, status: deleted === 0 ? 'added' : 'modified' })),
        pr, diff, status: 'committed', branch,
      }));
    });
    if (past.merged) {
      lines.push(JSON.stringify({
        id: `code:${REPO}:merge:${pr.number}`, type: 'code', at: new Date(end).toISOString(), repo: REPO, issue, role: 'symphony', title: `Merge #${pr.number}: ${past.title}`,
        files: past.files.map(([file, added, deleted]) => ({ path: file, added, deleted, status: deleted === 0 ? 'added' : 'modified' })),
        pr, diff: null, status: 'merged', branch,
      }));
    }
  }
  fs.mkdirSync(path.join(logDir, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(logDir, 'changes', 'acme_app.jsonl'), `${lines.join('\n')}\n`);
}

interface SeedNote {
  path: string;
  author: string;
  issue: string;
  hoursAgo: number;
  purpose: string;
  frontmatter: string;
  body: string;
}

const NOTES: SeedNote[] = [
  {
    path: 'Decisions/ledger-double-entry.md', author: 'symphony-architect', issue: `${REPO}#9`, hoursAgo: 9, purpose: 'Record the ledger design for #9',
    frontmatter: 'type: decision\nstatus: candidate\nrepo: acme/app\nsources: [acme/app#9]',
    body: '# Ledger with double-entry bookings\n\nEvery booking writes two `ledger_entries` rows in one transaction; balances are derived, never stored.\nInvoices (#21) build on [[Repos/acme-app/index|the app index]] and this ledger.\n',
  },
  {
    path: 'Inbox/pest-sqlite-in-memory.md', author: 'symphony-reviewer', issue: `${REPO}#5`, hoursAgo: 8, purpose: 'Lesson from the review of #5',
    frontmatter: 'type: lesson\nstatus: candidate\nrepo: acme/app\ntarget: Lessons/\nsources: [acme/app#5]',
    body: '# Money casts need integer cents in tests\n\nThe SQLite test database rounds `decimal` columns; assert on integer cents. See [[Repos/acme-app/index]].\n',
  },
  {
    path: 'Inbox/filament5-table-actions.md', author: 'symphony-test-engineer', issue: `${REPO}#4`, hoursAgo: 6, purpose: 'Lesson from the Filament 5 upgrade',
    frontmatter: 'type: lesson\nstatus: candidate\nrepo: acme/app\ntarget: Lessons/\nsources: [acme/app#4]',
    body: '# Filament 5 moved table actions\n\n`->actions()` became `->recordActions()`; Livewire tests call `callTableAction` with the new name. Related: [[Decisions/ledger-double-entry]].\n',
  },
  {
    path: 'Inbox/webhook-retries-idempotency.md', author: 'symphony-developer', issue: `${REPO}#15`, hoursAgo: 1.5, purpose: 'Note on the flaky webhook retries of #15',
    frontmatter: 'type: lesson\nstatus: candidate\nrepo: acme/app\ntarget: Lessons/\nsources: [acme/app#15]',
    body: '# Payment webhooks arrive twice\n\nThe provider retries after 5 s; store the event id and skip duplicates. See [[Repos/acme-app/index]] and [[Missing/retry-policy]].\n',
  },
];

function git(vault: string, args: string[], at: number, author?: string): void {
  const date = new Date(at).toISOString();
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const identity = author === undefined ? [] : ['-c', `user.name=${author}`, '-c', `user.email=${author}@local`];
  execFileSync('git', [...identity, '-C', vault, ...args], { env, stdio: 'ignore' });
}

/**
 * Notes and commits in the vault that `prepareBrain` created: candidates by agents (one with a broken link), the
 * decision promoted by a human, and today's reads and writes in the access log (`<logDir>/brain/access.jsonl`).
 */
export function seedBrain(vault: string, logDir: string, now: number): void {
  const access: object[] = [];
  const line = (at: number, role: string, issue: string, op: string, target: string, purpose: string) =>
    access.push({ at: new Date(at).toISOString(), run: `${issue.split('#')[1]}-${role}`, issue, role, op, path_or_query: target, purpose, result: 'ok' });
  for (const note of NOTES) {
    const at = now - note.hoursAgo * HOUR;
    const file = path.join(vault, note.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const day = new Date(at).toISOString().slice(0, 10);
    fs.writeFileSync(file, `---\n${note.frontmatter}\nissue: ${note.issue}\nrole: ${note.author.slice('symphony-'.length)}\ncreated: ${day}\nupdated: ${day}\n---\n${note.body}`);
    git(vault, ['add', note.path], at);
    git(vault, ['commit', '-q', '-m', `${note.issue} ${note.issue.split('#')[1]}-run: ${note.purpose}`, '-m', note.path], at, note.author);
    const role = note.author.slice('symphony-'.length);
    line(at - 4 * 60_000, role, note.issue, 'read', 'Repos/acme-app/index.md', `Read the repository index before working on ${note.issue}`);
    line(at - 3 * 60_000, role, note.issue, 'search', 'ledger OR filament OR webhook', `Find earlier notes for ${note.issue}`);
    line(at, role, note.issue, 'write', note.path, note.purpose);
  }
  // A human promoted the ledger decision on the Brain page.
  const decision = path.join(vault, 'Decisions/ledger-double-entry.md');
  fs.writeFileSync(decision, fs.readFileSync(decision, 'utf8').replace('status: candidate', 'status: approved'));
  git(vault, ['commit', '-q', '-am', 'approve: Decisions/ledger-double-entry.md'], now - 7 * HOUR, 'human');
  for (const [hoursAgo, role, issue, target] of [
    [0.9, 'developer', `${REPO}#11`, 'Decisions/ledger-double-entry.md'],
    [0.6, 'reviewer', `${REPO}#12`, 'Inbox/pest-sqlite-in-memory.md'],
    [0.3, 'developer', `${REPO}#17`, 'Decisions/ledger-double-entry.md'],
    [0.1, 'test-engineer', `${REPO}#16`, 'Inbox/filament5-table-actions.md'],
  ] as const) {
    line(now - hoursAgo * HOUR, role, issue, 'read', target, `Check earlier knowledge for ${issue}`);
  }
  fs.mkdirSync(path.join(logDir, 'brain'), { recursive: true });
  fs.writeFileSync(path.join(logDir, 'brain', 'access.jsonl'), `${access.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
}
