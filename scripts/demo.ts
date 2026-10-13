/**
 * Visual QA for the dashboard without a real board: seeds a fake tracker with issues in every status
 * (running, retrying, continuation, paused, queued, blocked column, dependency-blocked) and serves the
 * real pages on http://127.0.0.1:4000. No GitHub access, no Claude sessions - the agent runner is faked.
 *
 *   node scripts/demo.ts [port]
 */
import fs from 'node:fs';
import path from 'node:path';
import { Logger } from '../src/log.ts';
import type { Issue } from '../src/tracker/types.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { startHttpServer } from '../src/http/server.ts';
import { FakeRunner, FakeTracker, StaticWorkflow, baseFront, makeIssue, makeWorkflow, tempDir } from '../test/helpers.ts';

const port = Number(process.argv[2] ?? 4000);
const root = tempDir('symphony-demo-');

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
  },
  roles: {
    developer: { states: ['Ready', 'In progress'], may_move_to: ['In progress', 'Agent review', 'Blocked'] },
    reviewer: { states: ['Agent review'], read_only: true, may_move_to: ['In review', 'In progress', 'Blocked'] },
    auditor: { commands: ['refactoring'], states: ['Ready', 'In progress'], read_only: true, may_move_to: ['In progress', 'In review', 'Blocked'] },
  },
  agent: { max_concurrent_agents: 3, max_continuations: 0, max_retry_backoff_ms: 60_000 },
  polling: { interval_ms: 5_000 },
});

const issue = (id: string, state: string, title: string, overrides: Partial<Issue> = {}) =>
  makeIssue({
    state,
    title,
    identifier: `acme/app#${id}`,
    url: `https://github.com/acme/app/issues/${id}`,
    native_ref: { repository: 'acme/app', number: Number(id) || 0, dispatch_note: null },
    ...overrides,
    id,
  });

const tracker = new FakeTracker([
  issue('11', 'In progress', 'Implement CSV import for recurring tasks'),
  issue('12', 'Agent review', 'Fix timezone drift in due dates', { id: '12', priority: 1 }),
  issue('13', 'Ready', 'Refactor the notification fan-out', { id: '13', description: '/refactoring app/Notifications', priority: 2 }),
  issue('14', 'Ready', 'Add bulk archive action to the task table', { id: '14', priority: 3 }),
  issue('15', 'In progress', 'Flaky payment webhook retries', { id: '15', priority: 1, labels: ['bug', 'model: sonnet'] }),
  issue('16', 'Ready', 'Migrate legacy exports to the new pipeline', { id: '16', priority: 1 }),
  issue('20', 'Blocked', 'Needs a decision on the pricing model'),
  issue('21', 'Ready', 'Build invoices on top of the new ledger', {
    id: '21',
    dispatchable: false,
    blocked_by: [{ id: 'b1', identifier: 'acme/app#9', state: 'OPEN' }],
    native_ref: { repository: 'acme/app', number: 21, dispatch_note: 'blocked by acme/app#9' },
  }),
]);
tracker.issueRepository = () => 'acme/app';
tracker.statusOptions = async () => ['Backlog', 'Ready', 'In progress', 'Agent review', 'Blocked', 'In review', 'Done'];

// 11, 12 and 13 keep their sessions open (running); 15 fails each turn (retry queue);
// 16 ends its turn cleanly while staying active (continuation -> paused with max_continuations 0).
const runner = new FakeRunner(async (turn, params) => {
  const id = params.issue.id;
  if (id === '15') return { ok: false, turnId: String(turn), code: 'turn_failed', message: 'php artisan test exited with code 1 (3 failed)' };
  if (id === '16') return { ok: true, turnId: String(turn), resultText: 'done for now' };
  await new Promise(() => undefined);
  return { ok: true, turnId: String(turn), resultText: 'unreachable' };
});

const logger = Logger.create();
const orchestrator = new Orchestrator({
  workflow: new StaticWorkflow(makeWorkflow(front)),
  runner,
  logger,
  env: {},
  logDir: null,
  createAdapter: () => tracker,
});

await orchestrator.start();
const server = await startHttpServer({ host: '127.0.0.1', port, orchestrator, logger });
console.log(`Demo dashboard: ${server.url}`);
