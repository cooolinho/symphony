#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ClaudeAgentRunner } from '../agent/claude.ts';
import { killAllAgentProcessGroups } from '../agent/spawn.ts';
import { isLogLevel, Logger, type LogLevel } from '../log.ts';
import { getTrackerFactory } from '../tracker/registry.ts';
import { loadEnvFile } from '../util/env.ts';
import { errorCode, errorMessage } from '../util/errors.ts';
import { expandHome } from '../util/paths.ts';
import { WorkflowStore } from '../workflow/store.ts';
import { WatchdogPoller } from './poller.ts';

const USAGE = `Usage: symphony-watchdog [path/to/WORKFLOW.md] [options]

Watches the blocked column of the Symphony board, diagnoses every newly blocked issue with a
read-only Claude session (prompt: watchdog.prompt) and, in mode act, comments and moves it back.
See docs/watchdog.md.

Options:
  --env-file <path>   Load variables from this dotenv file (default: .env next to the workflow file).
  --log-dir <dir>     Symphony's state directory to read (default: $SYMPHONY_LOG_DIR, else
                      $XDG_STATE_HOME/symphony or ~/.local/state/symphony).
  --state-dir <dir>   The watchdog's own directory (events.jsonl, transcripts; default:
                      $SYMPHONY_WATCHDOG_STATE_DIR, else ~/.local/state/symphony-watchdog).
  --log-file <path>   Also write the watchdog's log to this file.
  --log-level <lvl>   debug | info | warn | error (default: info).
  --once              Run one pass over the blocked column and exit.
  -h, --help          Show this help.
`;

function fail(message: string, code = 2): never {
  process.stderr.write(`symphony-watchdog: ${message}\n`);
  process.exit(code);
}

function dirFrom(value: string | undefined, fallback: string, base: string): string {
  return value !== undefined && value.trim() !== '' ? path.resolve(base, expandHome(value.trim())) : fallback;
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        'env-file': { type: 'string' },
        'log-dir': { type: 'string' },
        'state-dir': { type: 'string' },
        'log-file': { type: 'string' },
        'log-level': { type: 'string' },
        once: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    fail(`${(error as Error).message}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const logLevel = (values['log-level'] ?? 'info') as LogLevel;
  if (!isLogLevel(logLevel)) fail(`--log-level must be debug, info, warn or error (got ${values['log-level']})`);
  const workflowPath = path.resolve(positionals[0] ?? 'WORKFLOW.md');
  if (!fs.existsSync(workflowPath)) fail(`workflow file not found: ${workflowPath}`, 1);
  const workflowDir = path.dirname(workflowPath);

  const envFilePath = values['env-file'] !== undefined ? path.resolve(values['env-file']) : path.join(workflowDir, '.env');
  let env = process.env;
  if (values['env-file'] !== undefined || fs.existsSync(envFilePath)) {
    try {
      env = loadEnvFile(envFilePath, process.env).env;
    } catch (error) {
      fail(errorMessage(error), 1);
    }
  }
  const stateHome = env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), '.local', 'state');
  const logDir = dirFrom(values['log-dir'] ?? env.SYMPHONY_LOG_DIR, path.join(stateHome, 'symphony'), workflowDir);
  const stateDir = dirFrom(values['state-dir'] ?? env.SYMPHONY_WATCHDOG_STATE_DIR, path.join(stateHome, 'symphony-watchdog'), workflowDir);

  const logger = Logger.create({ level: logLevel, file: values['log-file'] ?? null }).child({ component: 'watchdog' });
  let store: WorkflowStore;
  try {
    store = await WorkflowStore.open(workflowPath, { env, logger });
  } catch (error) {
    logger.error('startup failed: cannot load the workflow', { code: errorCode(error, 'startup_failed'), error: errorMessage(error) });
    await logger.close();
    return 1;
  }
  const config = store.current.config;
  const factory = getTrackerFactory(config.tracker.kind);
  if (factory === undefined) {
    logger.error('startup failed: unsupported tracker', { tracker: config.tracker.kind ?? 'none' });
    await logger.close();
    return 1;
  }
  const adapter = factory.create({
    provider: config.tracker.provider,
    activeStates: config.tracker.activeStates,
    terminalStates: config.tracker.terminalStates,
    env,
    logger,
  });
  const poller = new WatchdogPoller({
    config: () => store.current.config,
    adapter,
    runner: new ClaudeAgentRunner(),
    logger,
    env,
    secretNames: factory.secretEnvironmentNames(config.tracker.provider),
    logDir,
    stateDir,
  });
  process.on('exit', killAllAgentProcessGroups);
  const { watchdog } = config;
  logger.info('watchdog started', {
    mode: watchdog.mode,
    model: watchdog.model,
    effort: watchdog.effort ?? 'default',
    blocked_columns: poller.blockedColumns(config).join(','),
    prompt: watchdog.prompt,
    interval_ms: watchdog.intervalMs,
    max_resumes: watchdog.maxResumes,
    log_dir: logDir,
    state_dir: stateDir,
  });

  if (values.once) {
    await poller.tick();
    store.close();
    await logger.close();
    return 0;
  }
  store.watch();
  poller.start();
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  logger.info('watchdog stopping');
  await poller.stop();
  store.close();
  await logger.close();
  return 0;
}

process.on('unhandledRejection', (reason) => {
  process.stderr.write(`symphony-watchdog: unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`);
  killAllAgentProcessGroups();
  process.exit(1);
});

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`symphony-watchdog: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    killAllAgentProcessGroups();
    process.exit(1);
  },
);
