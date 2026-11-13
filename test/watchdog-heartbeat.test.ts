import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ALERTS_JS } from '../src/http/alerts.ts';
import { HEAD_JS } from '../src/http/overview-head.ts';
import { BASE_JS } from '../src/http/styles.ts';
import { Logger } from '../src/log.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import type { TrackerAdapter } from '../src/tracker/types.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { HEARTBEAT_FILE, HEARTBEAT_STALE_MS, readWatchdogStatus, writeHeartbeat, type Heartbeat } from '../src/watchdog/heartbeat.ts';
import { WatchdogPoller } from '../src/watchdog/poller.ts';
import { FakeElement, scriptContext, run } from './helpers/fake-dom.ts';

const NOW = new Date('2026-11-13T12:00:00Z');
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-heartbeat-'));
const beat = (over: Partial<Heartbeat> = {}): Heartbeat => ({
  pid: 1,
  mode: 'observe',
  model: 'fable',
  started_at: '2026-11-13T10:00:00.000Z',
  updated_at: new Date(NOW.getTime() - 10_000).toISOString(),
  last_tick_at: '2026-11-13T11:59:30.000Z',
  stopped_at: null,
  ...over,
});

describe('watchdog heartbeat', () => {
  it('is null without a state directory or without a heartbeat (watchdog not used)', () => {
    assert.equal(readWatchdogStatus(null, NOW), null);
    assert.equal(readWatchdogStatus(tempDir(), NOW), null);
  });

  it('runs while the heartbeat is fresh, stops when stale or stopped', () => {
    const dir = tempDir();
    assert.equal(writeHeartbeat(dir, beat()), true);
    assert.deepEqual(readWatchdogStatus(dir, NOW), {
      running: true,
      mode: 'observe',
      started_at: '2026-11-13T10:00:00.000Z',
      updated_at: beat().updated_at,
      last_tick_at: '2026-11-13T11:59:30.000Z',
      stopped_at: null,
    });
    writeHeartbeat(dir, beat({ updated_at: new Date(NOW.getTime() - HEARTBEAT_STALE_MS - 1).toISOString() }));
    assert.equal(readWatchdogStatus(dir, NOW)?.running, false);
    writeHeartbeat(dir, beat({ stopped_at: NOW.toISOString() }));
    assert.equal(readWatchdogStatus(dir, NOW)?.running, false);
  });

  it('reports a broken heartbeat as not running', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, HEARTBEAT_FILE), '{not json');
    assert.equal(readWatchdogStatus(dir, NOW)?.running, false);
  });

  it('the poller writes it on start and marks it stopped on stop', async () => {
    const dir = tempDir();
    const config = resolveConfig({ tracker: { kind: 'github_project' }, watchdog: { mode: 'act', interval_ms: 60_000 } }, { workflowPath: path.join(dir, 'WORKFLOW.md'), env: {}, trackerDefaults });
    const adapter = { kind: 'fake', fetchIssuesByStates: async () => [], fetchIssuesByIds: async () => [], agentToolSpecs: () => [] } satisfies TrackerAdapter;
    const poller = new WatchdogPoller({
      config: () => config,
      adapter,
      runner: { startSession: async () => assert.fail('no session expected') },
      logger: Logger.silent(),
      env: {},
      secretNames: [],
      logDir: path.join(dir, 'state'),
      stateDir: path.join(dir, 'watchdog'),
    });
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const running = readWatchdogStatus(path.join(dir, 'watchdog'), new Date());
    assert.equal(running?.running, true);
    assert.equal(running?.mode, 'act');
    assert.notEqual(running?.last_tick_at, null);
    await poller.stop();
    const stopped = readWatchdogStatus(path.join(dir, 'watchdog'), new Date());
    assert.equal(stopped?.running, false);
    assert.notEqual(stopped?.stopped_at, null);
  });

  it('watchdog.state_dir resolves against the workflow directory', () => {
    const resolve = (watchdog: unknown) => resolveConfig({ tracker: { kind: 'github_project' }, watchdog }, { workflowPath: '/srv/wf/WORKFLOW.md', env: {}, trackerDefaults }).watchdog;
    assert.equal(resolve({}).stateDir, null);
    assert.equal(resolve({ state_dir: '' }).stateDir, null);
    assert.equal(resolve({ state_dir: 'wd' }).stateDir, '/srv/wf/wd');
  });
});

describe('dashboard watchdog chip', () => {
  const ctx = scriptContext(BASE_JS, ALERTS_JS, HEAD_JS);
  const chips = (health: unknown): FakeElement[] => {
    ctx.__s = { health };
    return Array.from(run(ctx, 'headChips(__s)'));
  };

  it('shows no chip when the watchdog is not set up', () => {
    assert.deepEqual(chips({ watchdog: null }).map((c) => c.textContent), ['Tracker ok', 'Workflow gültig']);
    assert.deepEqual(chips({}).map((c) => c.textContent), ['Tracker ok', 'Workflow gültig']);
  });

  it('shows "Watchdog läuft" in green next to the other chips, with the mode as tooltip', () => {
    const list = chips({ watchdog: { running: true, mode: 'act', last_tick_at: '2026-11-13T11:59:30.000Z' } });
    assert.deepEqual(list.map((c) => c.textContent), ['Tracker ok', 'Workflow gültig', 'Watchdog läuft']);
    assert.equal(list[2]!.style.color, list[0]!.style.color);
    assert.equal(list[2]!.querySelectorAll('.ui-dot').length, 1);
    assert.match(list[2]!.title, /Modus act/);
  });

  it('shows "Watchdog gestoppt" in red when the heartbeat is stale or the watchdog stopped', () => {
    const stale = chips({ watchdog: { running: false, mode: 'act', updated_at: '2026-11-13T11:00:00.000Z', stopped_at: null } });
    assert.equal(stale[2]!.textContent, 'Watchdog gestoppt');
    assert.notEqual(stale[2]!.style.color, stale[0]!.style.color);
    assert.match(stale[2]!.title, /letztes Lebenszeichen 2026-11-13T11:00:00/);
    const stopped = chips({ watchdog: { running: false, stopped_at: '2026-11-13T11:30:00.000Z' } });
    assert.match(stopped[2]!.title, /beendet/);
  });
});
