/**
 * Visual QA for the dashboard without a real board: seeds a fake tracker so that every section has entries
 * (Running; Up next with a continuation, a column limit, a model hold and a busy slot; Waiting with a backoff and
 * a model hold; Paused; Blocked with a blocked column, a dependency and a missing label) and serves the real pages
 * on http://127.0.0.1:4000. No GitHub access, no Claude sessions - the agent runner is faked. The queue changes
 * over the first seconds (fails, holds, pauses) and then settles. The system cards show this machine's metrics (sampled
 * every 2 s) and a made-up GitHub API budget. Changes, Brain and Statistik show the made-up history of scripts/demo-seed.ts
 * (runs of two weeks, commits and merges, a knowledge vault). docs/preview.gif is recorded from this demo.
 *
 *   node scripts/demo.ts [port]
 */
import fs from 'node:fs';
import path from 'node:path';
import { limitScopeOf } from '../src/agent/rate-limit.ts';
import { prepareBrain } from '../src/brain/vault.ts';
import { PricingStore } from '../src/costs/pricing.ts';
import { HistoryLog } from '../src/history/history.ts';
import { Logger } from '../src/log.ts';
import type { Issue } from '../src/tracker/types.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { startHttpServer } from '../src/http/server.ts';
import { SystemCollector } from '../src/system/metrics.ts';
import { FakeRunner, FakeTracker, StaticWorkflow, baseFront, makeIssue, makeWorkflow, tempDir } from '../test/helpers.ts';
import { seedBrain, seedChanges, seedHistory } from './demo-seed.ts';

const port = Number(process.argv[2] ?? 4000);
const root = tempDir('symphony-demo-');
const logDir = path.join(root, 'state');
const vault = path.join(root, 'brain');

// The auditor's /refactoring command must exist as a plugin skill to pass startup validation.
const plugin = path.join(root, 'plugin');
fs.mkdirSync(path.join(plugin, 'skills', 'refactoring'), { recursive: true });
fs.writeFileSync(path.join(plugin, 'skills', 'refactoring', 'SKILL.md'), '# demo refactoring skill\n');

const front = baseFront(root, {
  claude: { plugins: [plugin] },
  tracker: {
    kind: 'github_project',
    provider: { owner: 'acme', project_number: 1, token: 'demo-token' },
    active_states: ['Ready', 'In progress', 'Agent review'],
    terminal_states: ['Done'],
    required_labels: ['symphony'],
  },
  roles: {
    developer: { states: ['Ready', 'In progress'], may_move_to: ['In progress', 'Agent review', 'Blocked'] },
    reviewer: { states: ['Agent review'], read_only: true, may_move_to: ['In review', 'In progress', 'Blocked'] },
    auditor: { commands: ['refactoring'], states: ['Ready', 'In progress'], read_only: true, may_move_to: ['In progress', 'In review', 'Blocked'] },
  },
  agent: {
    max_concurrent_agents: 4,
    max_concurrent_agents_by_state: { 'agent review': 1 },
    max_turns: 1,
    max_continuations: 1,
    max_retry_backoff_ms: 60_000,
  },
  polling: { interval_ms: 5_000 },
  // The vault must not lie inside workspace.root.
  workspace: { root: path.join(root, 'workspaces') },
  brain: { enabled: true, path: vault, obsidian_url: 'https://brain.example.lan' },
});

const issue = (id: string, state: string, title: string, overrides: Partial<Issue> = {}) =>
  makeIssue({
    state,
    title,
    identifier: `acme/app#${id}`,
    url: `https://github.com/acme/app/issues/${id}`,
    native_ref: { repository: 'acme/app', number: Number(id) || 0, dispatch_note: null },
    ...overrides,
    labels: ['symphony', ...(overrides.labels ?? [])],
    id,
  });

const tracker = new FakeTracker([
  // Running: 12 holds the only Agent review slot, 13 and 11 start once 16 and 18 free their slots.
  issue('12', 'Agent review', 'Fix timezone drift in due dates', { priority: 1 }),
  issue('13', 'Ready', 'Refactor the notification fan-out', { description: '/refactoring app/Notifications', priority: 2 }),
  issue('11', 'In progress', 'Implement CSV import for recurring tasks', { priority: 3 }),
  // 17 runs on Fable; after 18 hits the Fable limit its continuation waits for the hold (Up next).
  issue('17', 'In progress', 'Generate the yearly tax report', { priority: 1, labels: ['model: fable'] }),
  issue('18', 'Ready', 'Summarise the support backlog', { priority: 1, labels: ['model: fable'] }),
  // 16 continues once, then pauses (max_continuations 1); 15 fails every turn (Waiting, backoff, then Running again).
  issue('16', 'Ready', 'Migrate legacy exports to the new pipeline', { priority: 1 }),
  issue('15', 'In progress', 'Flaky payment webhook retries', { priority: 2, labels: ['bug', 'model: sonnet'] }),
  // Up next: a column limit and a model hold; nothing else takes the slot 15 leaves during its backoff.
  issue('22', 'Agent review', 'Review the rate limiter rewrite', { priority: 2 }),
  issue('19', 'Ready', 'Draft the onboarding e-mails', { priority: 2, labels: ['model: fable'] }),
  // Blocked: a blocked column, a dependency and a missing required label.
  issue('20', 'Blocked', 'Needs a decision on the pricing model'),
  issue('21', 'Ready', 'Build invoices on top of the new ledger', {
    dispatchable: false,
    blocked_by: [{ id: 'b1', identifier: 'acme/app#9', state: 'OPEN' }],
    native_ref: { repository: 'acme/app', number: 21, dispatch_note: 'blocked by acme/app#9' },
  }),
]);
// Without the "symphony" label (tracker.required_labels).
tracker.issues.set('23', { ...issue('23', 'Ready', 'Spike: evaluate a new PDF renderer', { priority: 2 }), labels: ['spike'] });
tracker.issueRepository = () => 'acme/app';
tracker.statusOptions = async () => ['Backlog', 'Ready', 'In progress', 'Agent review', 'Blocked', 'In review', 'Done'];

const FABLE = "You've reached your Fable limit. Switch to another model to continue.";
const hang = () => new Promise<never>(() => undefined);
const runner = new FakeRunner(async (turn, params) => {
  const id = params.issue.id;
  const done = { ok: true as const, turnId: String(turn), resultText: 'done for now' };
  if (id === '15') return { ok: false, turnId: String(turn), code: 'turn_failed', message: 'php artisan test exited with code 1 (3 failed)' };
  if (id === '16') return done;
  if (id === '17') return new Promise((resolve) => setTimeout(() => resolve(done), 3_000));
  if (id === '18') {
    return {
      ok: false,
      turnId: String(turn),
      code: 'session_limit',
      message: `turn ended with a usage limit: ${FABLE}`,
      sessionLimit: { window: null, ...limitScopeOf(null, 'fable'), resetsAt: null, source: null, text: FABLE, overageDisabledReason: null },
    };
  }
  return hang();
});

const logger = Logger.create();
const workflow = new StaticWorkflow(makeWorkflow(front));

// History before the start: the orchestrator loads the change log and the brain access log when it starts.
const now = Date.now();
const pricing = new PricingStore(path.join(import.meta.dirname, '..', 'model-costs.yml'), logger);
const history = new HistoryLog(path.join(logDir, 'repositories'), pricing, logger);
seedHistory(history, now);
seedChanges(logDir, now);
// The vault's init commit dates from the morning, before the seeded agent commits.
process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = new Date(now - 12 * 3_600_000).toISOString();
await prepareBrain(workflow.current.config.brain, ['acme/app'], logger);
delete process.env.GIT_AUTHOR_DATE;
delete process.env.GIT_COMMITTER_DATE;
seedBrain(vault, logDir, now);

const orchestrator = new Orchestrator({
  workflow,
  runner,
  logger,
  env: {},
  logDir,
  pricing,
  history,
  createAdapter: () => tracker,
});

// System cards: host metrics of this machine and a GitHub API budget that shrinks with every poll.
const system = new SystemCollector({ volumes: [{ name: 'state', path: root }], gpu: false, logger, intervalMs: 2_000 });
system.start();
let remaining = 4_812;
tracker.apiBudget = () => ({ remaining: (remaining = Math.max(0, remaining - 3)), limit: 5_000, reset_at: new Date(Date.now() + 40 * 60_000).toISOString(), observed_at: new Date().toISOString() });

await orchestrator.start();
await orchestrator.loadBrainChanges();
await orchestrator.buildBrainIndex();
const server = await startHttpServer({ host: '127.0.0.1', port, orchestrator, logger, history: { dir: history.dir, pricing }, system });
console.log(`Demo dashboard: ${server.url}`);
