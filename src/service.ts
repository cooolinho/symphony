import fs from 'node:fs';
import path from 'node:path';
import { ClaudeAgentRunner } from './agent/claude.ts';
import { chooseEffort, chooseModel } from './agent/model.ts';
import { PricingStore } from './costs/pricing.ts';
import { HistoryLog } from './history/history.ts';
import { killAllAgentProcessGroups } from './agent/spawn.ts';
import { isLoopbackHost, startHttpServer, type HttpServerHandle } from './http/server.ts';
import { defaultIntegrations } from './integrations/registry.ts';
import type { WorkspaceIntegration } from './integrations/types.ts';
import { Logger, type LogLevel } from './log.ts';
import { hasRequiredFields, hasRequiredLabels, isActiveState, sortForDispatch, waitingForSubIssues } from './orchestrator/eligibility.ts';
import { Orchestrator } from './orchestrator/orchestrator.ts';
import { getTrackerFactory } from './tracker/registry.ts';
import type { Issue, TrackerAdapter } from './tracker/types.ts';
import type { LoadedEnvFile } from './util/env.ts';
import { errorCode, errorMessage } from './util/errors.ts';
import { truncate } from './util/text.ts';
import { commandSkills, resolveIssueCommand } from './workflow/command.ts';
import { roleFor, roleName } from './workflow/roles.ts';
import { WorkflowStore } from './workflow/store.ts';
import { issueTemplateValue, renderPrompt } from './workflow/template.ts';
import { unknownBoardColumns, validateDispatch } from './workflow/validate.ts';
import { workspaceKey } from './workspace/manager.ts';

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
/** Dry-run line naming the role, model and effort a candidate would run on (`default` when none is configured). */
export function roleModelLine(role: string, model: string | null, effort: string | null = null): string {
  return `role ${role}, model ${model ?? 'default'}, effort ${effort ?? 'default'}`;
}

export async function runService(options: ServiceOptions): Promise<number> {
  const logger = Logger.create({ level: options.logLevel, file: options.logFile });
  const { env } = options;
  logEnvFile(logger, options.envFile);
  const integrations = defaultIntegrations();

  let store: WorkflowStore;
  try {
    store = await WorkflowStore.open(options.workflowPath, { env, logger, integrations });
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
    integrations,
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
      const { host, allowRemoteControl } = config.server;
      http = await startHttpServer({ host, port, orchestrator, logger, history: { dir: history.dir, pricing }, allowRemoteControl });
      logger.info('dashboard listening', { url: http.url });
      if (!isLoopbackHost(host)) {
        logger.warn('dashboard listens on a non-loopback address; it has no login of its own, put an authenticating reverse proxy in front', {
          host,
          allow_remote_control: allowRemoteControl,
        });
      }
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

function ineligibleReason(issue: Issue, store: WorkflowStore, adapter: TrackerAdapter): string | null {
  const { tracker, roles } = store.current.config;
  if (!hasRequiredFields(issue)) return 'missing required fields';
  if (!isActiveState(issue.state, tracker)) return `state "${issue.state}" is not active`;
  if (!issue.dispatchable) {
    // Display only: adapters may explain their dispatchability decision in native_ref.dispatch_note.
    const note = issue.native_ref?.dispatch_note;
    return typeof note === 'string' && note !== '' ? note : 'not dispatchable';
  }
  if (!hasRequiredLabels(issue, tracker.requiredLabels)) return `missing required labels (${tracker.requiredLabels.join(', ')})`;
  const waiting = waitingForSubIssues(issue, roleFor(issue, roles), adapter);
  if (waiting.length > 0) return `waiting for sub-issues ${waiting.join(', ')} (roles.<role>.wait_for_sub_issues)`;
  return null;
}

/**
 * Dry-run lines of every integration: service-wide with a null workspace, otherwise about an issue's existing
 * workspace (a new workspace is only cloned when the issue runs). A failing integration contributes nothing.
 */
async function integrationLines(
  integrations: readonly WorkspaceIntegration[],
  configs: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv,
  workspace: string | null,
): Promise<string[]> {
  if (workspace !== null && !fs.existsSync(workspace)) return [];
  const lines: string[] = [];
  for (const integration of integrations) {
    const config = configs[integration.id];
    if (integration.describe === undefined || config === undefined || config === null) continue;
    try {
      lines.push(...(await integration.describe(config, env, workspace)));
    } catch {
      // Display only.
    }
  }
  return lines;
}

/** Validates the workflow, lists what would be dispatched and previews the first prompt. No agents run. */
export async function dryRun(options: Pick<ServiceOptions, 'workflowPath' | 'env' | 'envFile' | 'logLevel'>): Promise<number> {
  const logger = Logger.create({ level: options.logLevel });
  const out = (line = '') => process.stdout.write(`${line}\n`);
  logEnvFile(logger, options.envFile);
  try {
    const integrations = defaultIntegrations();
    const store = await WorkflowStore.open(options.workflowPath, { env: options.env, logger, integrations });
    const { config } = store.current;
    out(`Workflow:        ${store.path}`);
    out(`Env file:        ${options.envFile?.file ?? '(none)'}`);
    out(`Tracker:         ${config.tracker.kind ?? '(none)'}`);
    out(`Active states:   ${config.tracker.activeStates.join(', ')}`);
    out(`Terminal states: ${config.tracker.terminalStates.join(', ')}`);
    out(`Workspace root:  ${config.workspace.root}`);
    out(`Concurrency:     ${config.agent.maxConcurrentAgents} agents, ${config.agent.maxTurns} turns per session, poll every ${config.polling.intervalMs / 1000}s`);
    out(`Session limit:   ${config.agent.maxSessionLimitRetries} retries, then wait for the reset (0 = wait right away)`);
    out(`Continuations:   ${config.agent.maxContinuations === null ? 'unlimited' : `${config.agent.maxContinuations} per issue, then pause`}; delete workspace on ${config.tracker.terminalStates.join('/')}: ${config.workspace.cleanupTerminal ? 'yes' : 'no'}`);
    out(`Claude:          model ${config.claude.model ?? '(Claude Code default)'} (default; a "Model: …" issue label overrides it), effort ${config.claude.effort ?? '(Claude Code default)'} (default; an "Effort: …" issue label overrides it), permission mode ${config.claude.permissionMode}, on_permission_request ${config.claude.onPermissionRequest}`);
    if (config.claude.plugins.length > 0 || config.claude.skills !== null) {
      const skills = config.claude.skills === null ? 'Claude Code default' : config.claude.skills === 'all' ? 'all' : config.claude.skills.join(', ');
      out(`Plugins:         ${config.claude.plugins.join(', ') || '(none)'}; skills: ${skills}`);
    }
    for (const line of await integrationLines(integrations, config.integrations, options.env, null)) out(line);
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
    if (adapter.statusOptions !== undefined) {
      const unknown = unknownBoardColumns(config, await adapter.statusOptions());
      if (unknown.length > 0) {
        out('Board column check failed:');
        for (const error of unknown) out(`  - ${error}`);
        return 1;
      }
      out('Board columns:   all configured columns exist on the board');
      out();
    }
    const skills = commandSkills(config.claude.plugins);
    const issues = sortForDispatch(await adapter.fetchIssuesByStates(config.tracker.activeStates));
    out(`Candidates in active states: ${issues.length}`);
    let first: Issue | null = null;
    for (const issue of issues) {
      const reason = ineligibleReason(issue, store, adapter);
      if (reason === null && first === null) first = issue;
      out(`  ${reason === null ? 'dispatch' : 'skip    '}  ${issue.identifier}  [${issue.state}${issue.priority === null ? '' : `, p${issue.priority}`}]  ${truncate(issue.title, 70)}`);
      if (reason !== null) out(`            ↳ ${reason}`);
      const role = roleFor(issue, config.roles);
      const choice = chooseModel(issue.labels, role?.claude.model ?? config.claude.model);
      const effortChoice = chooseEffort(issue.labels, role?.claude.effort ?? config.claude.effort);
      out(`            ↳ ${roleModelLine(roleName(role), choice.model, effortChoice.effort)}`);
      const command = resolveIssueCommand(issue.description, skills);
      if (command !== null) out(`            ↳ command /${command.name} → ${command.skill}`);
      if (choice.warning !== null) out(`            ↳ model label ignored: ${choice.warning}; using ${choice.model ?? '(Claude Code default)'}`);
      else if (choice.label !== null) out(`            ↳ model ${choice.model} (label "${choice.label}")`);
      if (effortChoice.warning !== null) out(`            ↳ effort label ignored: ${effortChoice.warning}; using ${effortChoice.effort ?? '(Claude Code default)'}`);
      else if (effortChoice.label !== null) out(`            ↳ effort ${effortChoice.effort} (label "${effortChoice.label}")`);
      const workspace = path.join(config.workspace.root, workspaceKey(issue.identifier));
      for (const line of await integrationLines(integrations, config.integrations, options.env, workspace)) out(`            ↳ ${line}`);
    }

    if (first !== null) {
      out();
      out(`Prompt preview for ${first.identifier}:`);
      try {
        const prompt = await renderPrompt(store.current.prompt, {
          issue: issueTemplateValue(first, skills),
          attempt: null,
          role: roleName(roleFor(first, config.roles)),
        });
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
