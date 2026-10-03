#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { killAllAgentProcessGroups } from './agent/spawn.ts';
import { isLogLevel, type LogLevel } from './log.ts';
import { dryRun, runService } from './service.ts';
import { loadEnvFile, type LoadedEnvFile } from './util/env.ts';
import { errorMessage } from './util/errors.ts';
import { expandHome } from './util/paths.ts';

const VERSION = '0.1.0';

const USAGE = `Usage: symphony [path/to/WORKFLOW.md] [options]

Polls the configured tracker and runs one Claude Code session per eligible issue,
each in its own workspace. Defaults to ./WORKFLOW.md.

Options:
  --env-file <path>   Load variables from this dotenv file (default: .env next to the
                      workflow file, if present). Variables already set in the shell win.
  --port <n>          Serve the dashboard and JSON API on 127.0.0.1:<n> (0 = any free port).
                      Overrides server.port from WORKFLOW.md.
  --log-dir <dir>     Repository logs, session transcripts and state (default:
                      $SYMPHONY_LOG_DIR, else $XDG_STATE_HOME/symphony or
                      ~/.local/state/symphony).
  --log-file <path>   Also write structured logs to this file.
  --log-level <lvl>   debug | info | warn | error (default: info).
  --dry-run           Validate the workflow, list what would be dispatched, preview the
                      first prompt, and exit without starting agents.
  -h, --help          Show this help.
  -v, --version       Show the version.
`;

function fail(message: string, code = 2): never {
  process.stderr.write(`symphony: ${message}\n`);
  process.exit(code);
}

function defaultLogDir(env: NodeJS.ProcessEnv, workflowDir: string): string {
  if (env.SYMPHONY_LOG_DIR && env.SYMPHONY_LOG_DIR.trim() !== '') return path.resolve(workflowDir, expandHome(env.SYMPHONY_LOG_DIR.trim()));
  const stateHome = env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim() !== '' ? env.XDG_STATE_HOME : path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'symphony');
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        'env-file': { type: 'string' },
        port: { type: 'string' },
        'log-dir': { type: 'string' },
        'log-file': { type: 'string' },
        'log-level': { type: 'string' },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
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
  if (values.version) {
    process.stdout.write(`symphony ${VERSION}\n`);
    return 0;
  }
  if (positionals.length > 1) fail(`expected at most one workflow path, got ${positionals.length}\n\n${USAGE}`);

  let port: number | null = null;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!/^\d+$/.test(values.port) || port > 65_535) fail(`--port must be an integer from 0 to 65535 (got ${values.port})`);
  }
  const logLevel: LogLevel = (values['log-level'] ?? 'info') as LogLevel;
  if (!isLogLevel(logLevel)) fail(`--log-level must be debug, info, warn or error (got ${values['log-level']})`);

  const explicit = positionals[0];
  const workflowPath = path.resolve(explicit ?? 'WORKFLOW.md');
  if (!fs.existsSync(workflowPath)) {
    fail(explicit === undefined ? `no WORKFLOW.md in ${process.cwd()} (pass a path to one)` : `workflow file not found: ${workflowPath}`, 1);
  }

  let envFile: LoadedEnvFile | null = null;
  const envFilePath = values['env-file'] !== undefined ? path.resolve(values['env-file']) : path.join(path.dirname(workflowPath), '.env');
  if (values['env-file'] !== undefined || fs.existsSync(envFilePath)) {
    try {
      envFile = loadEnvFile(envFilePath, process.env);
    } catch (error) {
      fail(errorMessage(error), 1);
    }
  }
  const env = envFile?.env ?? process.env;

  if (values['dry-run']) return dryRun({ workflowPath, env, envFile, logLevel });
  return runService({
    workflowPath,
    port,
    logDir: path.resolve(values['log-dir'] ?? defaultLogDir(env, path.dirname(workflowPath))),
    logFile: values['log-file'] !== undefined ? path.resolve(values['log-file']) : null,
    logLevel,
    env,
    envFile,
  });
}

// Tracker tools are pre-approved on purpose (allowedTools), so the SDK's notice that canUseTool
// is skipped for them is expected; drop just that warning.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const options = rest[0];
  const code =
    typeof options === 'object' && options !== null ? (options as { code?: string }).code : typeof rest[1] === 'string' ? rest[1] : undefined;
  if (code === 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED') return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

process.on('uncaughtException', (error) => {
  process.stderr.write(`symphony: fatal error: ${error.stack ?? error.message}\n`);
  killAllAgentProcessGroups();
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`symphony: unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`);
  killAllAgentProcessGroups();
  process.exit(1);
});

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`symphony: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    killAllAgentProcessGroups();
    process.exit(1);
  },
);
