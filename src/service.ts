import path from 'node:path';
import { ClaudeAgentRunner } from './agent/claude.ts';
import { PricingStore } from './costs/pricing.ts';
import { HistoryLog } from './history/history.ts';
import { killAllAgentProcessGroups } from './agent/spawn.ts';
import { startHttpServer, type HttpServerHandle } from './http/server.ts';
import { Logger, type LogLevel } from './log.ts';
import { hasRequiredFields, hasRequiredLabels, isActiveState, sortForDispatch } from './orchestrator/eligibility.ts';
import { Orchestrator } from './orchestrator/orchestrator.ts';
import { getTrackerFactory } from './tracker/registry.ts';
import type { Issue } from './tracker/types.ts';
import type { LoadedEnvFile } from './util/env.ts';
import { errorCode, errorMessage } from './util/errors.ts';
import { truncate } from './util/text.ts';
import { WorkflowStore } from './workflow/store.ts';
import { issueTemplateValue, renderPrompt } from './workflow/template.ts';
import { validateDispatch } from './workflow/validate.ts';

export interface ServiceOptions {
  workflowPath: string;
  /** CLI --port; overrides server.port from WORKFLOW.md. */
  port: number | null;
  logDir: string;
  logFile: string | null;
  logLevel: LogLevel;
  /** Process environment merged with the env file (if any). */
  env: NodeJS.ProcessEnv;
  envFile: LoadedEnvFile | null;
}

/** Names only, never values: which variables came from the env file and which the shell overrode. */
function logEnvFile(logger: Logger, envFile: LoadedEnvFile | null): void {
  if (envFile === null) return;
  logger.info('loaded env file', { file: envFile.file, variables: envFile.applied.join(',') });
  if (envFile.shadowed.length > 0) {
    logger.warn('env file values ignored because the shell environment already sets them', {
      file: envFile.file,
      variables: envFile.shadowed.join(','),
    });
  }
}

/** Runs until SIGINT/SIGTERM. Returns the process exit code. */
export async function runService(options: ServiceOptions): Promise<number> {
  const logger = Logger.create({ level: options.logLevel, file: options.logFile });
  const { env } = options;
  logEnvFile(logger, options.envFile);

  let store: WorkflowStore;
  try {
    store = await WorkflowStore.open(options.workflowPath, { env, logger });
  } catch (error) {
    logger.error('startup failed: cannot load the workflow', { code: errorCode(error, 'startup_failed'), error: errorMessage(error) });
    await logger.close();
    return 1;
  }

  const pricing = new PricingStore(path.join(store.current.config.workflowDir, 'model-costs.yml'), logger);
  const history = new HistoryLog(path.join(options.logDir, 'repositories'), pricing, logger);
  const orchestrator = new Orchestrator({
    workflow: store,
    runner: new ClaudeAgentRunner(),
    logger,
    env,
    logDir: options.logDir,
    pricing,
    history,
  });
  process.on('exit', killAllAgentProcessGroups);
  try {
    await orchestrator.start();
  } catch (error) {
    logger.error('startup failed', { code: errorCode(error, 'startup_failed'), error: errorMessage(error) });
    store.close();
    await logger.close();
    return 1;
  }
  store.watch();

  const config = store.current.config;
  let http: HttpServerHandle | null = null;
  const port = options.port ?? config.server.port;
  if (port !== null) {
    try {
      http = await startHttpServer({ host: config.server.host, port, orchestrator, logger, history: { dir: history.dir, pricing } });
      logger.info('dashboard listening', { url: http.url });
    } catch (error) {
      logger.error('dashboard failed to start; continuing without it', { error: errorMessage(error) });
    }
  }
  logger.info('symphony started', {
    workflow: store.path,
    tracker: config.tracker.kind,
    active_states: config.tracker.activeStates.join(','),
    workspace_root: config.workspace.root,
    max_concurrent_agents: config.agent.maxConcurrentAgents,
    permission_mode: config.claude.permissionMode,
    log_dir: options.logDir,
    repository_logs: history.dir,
    model_costs: pricing.path,
  });

  await new Promise<void>((resolve) => {
    let signals = 0;
    const onSignal = (signal: NodeJS.Signals) => {
      signals += 1;
      if (signals > 1) {
        logger.warn('second signal received; exiting immediately', { signal });
        killAllAgentProcessGroups();
        process.exit(130);
      }
      logger.info('shutdown requested; stopping agents (send the signal again to force)', { signal });
      resolve();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });

  await orchestrator.shutdown(store.current.config.hooks.timeoutMs + 30_000);
  await http?.close();
  store.close();
  logger.info('symphony stopped');
  await logger.close();
  return 0;
}

function ineligibleReason(issue: Issue, store: WorkflowStore): string | null {
  const { tracker } = store.current.config;
  if (!hasRequiredFields(issue)) return 'missing required fields';
  if (!isActiveState(issue.state, tracker)) return `state "${issue.state}" is not active`;
  if (!issue.dispatchable) {
    // Display only: adapters may explain their dispatchability decision in native_ref.dispatch_note.
    const note = issue.native_ref?.dispatch_note;
    return typeof note === 'string' && note !== '' ? note : 'not dispatchable';
  }
  if (!hasRequiredLabels(issue, tracker.requiredLabels)) return `missing required labels (${tracker.requiredLabels.join(', ')})`;
  return null;
}

/** Validates the workflow, lists what would be dispatched and previews the first prompt. No agents run. */
export async function dryRun(options: Pick<ServiceOptions, 'workflowPath' | 'env' | 'envFile' | 'logLevel'>): Promise<number> {
  const logger = Logger.create({ level: options.logLevel });
  const out = (line = '') => process.stdout.write(`${line}\n`);
  logEnvFile(logger, options.envFile);
  try {
    const store = await WorkflowStore.open(options.workflowPath, { env: options.env, logger });
    const { config } = store.current;
    out(`Workflow:        ${store.path}`);
    out(`Env file:        ${options.envFile?.file ?? '(none)'}`);
    out(`Tracker:         ${config.tracker.kind ?? '(none)'}`);
    out(`Active states:   ${config.tracker.activeStates.join(', ')}`);
    out(`Terminal states: ${config.tracker.terminalStates.join(', ')}`);
    out(`Workspace root:  ${config.workspace.root}`);
    out(`Concurrency:     ${config.agent.maxConcurrentAgents} agents, ${config.agent.maxTurns} turns per session, poll every ${config.polling.intervalMs / 1000}s`);
    out(`Continuations:   ${config.agent.maxContinuations === null ? 'unlimited' : `${config.agent.maxContinuations} per issue, then pause`}; delete workspace on ${config.tracker.terminalStates.join('/')}: ${config.workspace.cleanupTerminal ? 'yes' : 'no'}`);
    out(`Claude:          model ${config.claude.model ?? '(Claude Code default)'}, permission mode ${config.claude.permissionMode}, on_permission_request ${config.claude.onPermissionRequest}`);
    out();

    const errors = validateDispatch(store.current, null, options.env);
    if (errors.length > 0) {
      out('Dispatch validation failed:');
      for (const error of errors) out(`  - ${error}`);
      return 1;
    }

    const factory = getTrackerFactory(config.tracker.kind);
    if (factory === undefined) return 1;
    const adapter = factory.create({
      provider: config.tracker.provider,
      activeStates: config.tracker.activeStates,
      terminalStates: config.tracker.terminalStates,
      env: options.env,
      logger,
    });
    const issues = sortForDispatch(await adapter.fetchIssuesByStates(config.tracker.activeStates));
    out(`Candidates in active states: ${issues.length}`);
    let first: Issue | null = null;
    for (const issue of issues) {
      const reason = ineligibleReason(issue, store);
      if (reason === null && first === null) first = issue;
      out(`  ${reason === null ? 'dispatch' : 'skip    '}  ${issue.identifier}  [${issue.state}${issue.priority === null ? '' : `, p${issue.priority}`}]  ${truncate(issue.title, 70)}`);
      if (reason !== null) out(`            ↳ ${reason}`);
    }

    if (first !== null) {
      out();
      out(`Prompt preview for ${first.identifier}:`);
      try {
        const prompt = await renderPrompt(store.current.prompt, { issue: issueTemplateValue(first), attempt: null });
        const lines = prompt.split('\n');
        for (const line of lines.slice(0, 30)) out(`  | ${line}`);
        if (lines.length > 30) out(`  | … (${lines.length - 30} more lines)`);
      } catch (error) {
        out(`  prompt failed to render: ${errorMessage(error)}`);
        return 1;
      }
    }
    return 0;
  } catch (error) {
    out(`Dry run failed (${errorCode(error, 'error')}): ${errorMessage(error)}`);
    return 1;
  } finally {
    await logger.close();
  }
}
