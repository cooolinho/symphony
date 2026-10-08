import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../log.ts';
import { SymphonyError, errorMessage } from '../util/errors.ts';
import { isStrictlyInside } from '../util/paths.ts';
import { tail } from '../util/text.ts';
import type { HooksConfig } from '../workflow/config.ts';
import { acquireLock, type LockResult } from './lock.ts';
import { runShellScript, type HookName, type HookResult } from './hooks.ts';

export interface Workspace {
  path: string;
  key: string;
  createdNow: boolean;
}

/** Issue facts exposed to hooks as SYMPHONY_* environment variables. */
export interface HookIssue {
  id: string;
  identifier: string;
  url?: string | null;
  branch_name?: string | null;
  /** Adapter-provided variables (e.g. SYMPHONY_ISSUE_REPOSITORY). */
  env?: Record<string, string>;
}

export interface WorkspaceSettings {
  root: string;
  hooks: HooksConfig;
  workflowDir: string;
}

const MAX_KEY_STEM = 200;
const LOG_OUTPUT_LIMIT = 2_000;
/** Agent credentials that check scripts (which run repository code) must never see. */
const AGENT_CREDENTIAL_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * Directory name for an issue: characters outside [A-Za-z0-9._-] become `_`. When that (or
 * length capping) changes the identifier, a 64-bit SHA-256 prefix of the original is appended so
 * distinct identifiers never share a workspace.
 */
export function workspaceKey(identifier: string): string {
  const sanitized = identifier.replace(/[^A-Za-z0-9._-]/g, '_');
  const stem = sanitized.slice(0, MAX_KEY_STEM);
  const unsafe = stem === '' || stem === '.' || stem === '..';
  if (stem === identifier && !unsafe) return stem;
  const digest = createHash('sha256').update(identifier).digest('hex').slice(0, 16);
  return `${stem}-${digest}`;
}

export class WorkspaceManager {
  #settings: WorkspaceSettings;
  #env: NodeJS.ProcessEnv;
  #logger: Logger;

  /** `env` is the base environment for hooks, already stripped of tracker secrets. */
  constructor(settings: WorkspaceSettings, env: NodeJS.ProcessEnv, logger: Logger) {
    this.#settings = settings;
    this.#env = env;
    this.#logger = logger;
  }

  /** Absolute workspace path for an identifier, guaranteed to be inside the (real) root. */
  async pathFor(identifier: string): Promise<{ root: string; key: string; path: string }> {
    await fs.mkdir(this.#settings.root, { recursive: true });
    const root = await fs.realpath(this.#settings.root);
    const key = workspaceKey(identifier);
    const workspacePath = path.join(root, key);
    if (!isStrictlyInside(root, workspacePath)) {
      throw new SymphonyError('invalid_workspace_path', `workspace path ${workspacePath} escapes the workspace root ${root}`);
    }
    return { root, key, path: workspacePath };
  }

  /** Takes the cross-instance lock `<root>/<key>.lock`, which lives outside the clone. */
  async lock(identifier: string): Promise<LockResult> {
    const target = await this.pathFor(identifier);
    return acquireLock(`${target.path}.lock`);
  }

  /** Creates or reuses the issue workspace; runs after_create only when the directory is new. */
  async ensure(issue: HookIssue): Promise<Workspace> {
    let target: { key: string; path: string };
    try {
      target = await this.pathFor(issue.identifier);
    } catch (error) {
      if (error instanceof SymphonyError) throw error;
      throw new SymphonyError('workspace_error', `cannot prepare workspace root: ${errorMessage(error)}`, { cause: error });
    }

    let createdNow = false;
    try {
      await fs.mkdir(target.path);
      createdNow = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new SymphonyError('workspace_error', `cannot create workspace ${target.path}: ${errorMessage(error)}`, { cause: error });
      }
      const stat = await fs.lstat(target.path);
      if (!stat.isDirectory()) {
        // Policy: never delete or follow something we did not create.
        throw new SymphonyError('workspace_path_conflict', `${target.path} exists but is not a directory`);
      }
      // A successful after_create leaves files and a failed one deletes the directory, so an empty one is
      // the leftover of a crash or of a hook that reported success without doing its job: prepare it again.
      if ((await fs.readdir(target.path)).length === 0) {
        this.#logger.info('workspace is empty; running after_create again', { issue_id: issue.id, issue_identifier: issue.identifier, workspace: target.path });
        createdNow = true;
      }
    }

    const workspace: Workspace = { path: target.path, key: target.key, createdNow };
    if (createdNow) {
      const result = await this.runHook('after_create', workspace, issue);
      if (result !== null && !result.ok) {
        // Remove the half-prepared directory so the next attempt runs after_create again.
        await fs.rm(workspace.path, { recursive: true, force: true }).catch(() => undefined);
        throw new SymphonyError('hook_failed', `after_create hook ${describeFailure(result)}`);
      }
    }
    return workspace;
  }

  /** Runs a configured hook in the workspace. Returns null when the hook is not configured. */
  async runHook(name: HookName, workspace: Workspace, issue: HookIssue): Promise<HookResult | null> {
    const script = this.#script(name);
    if (script === null) return null;
    const log = this.#logger.child({ hook: name, issue_id: issue.id, issue_identifier: issue.identifier });
    log.info('hook started', { workspace: workspace.path });
    const result = await runShellScript(script, {
      cwd: workspace.path,
      env: this.#hookEnv(name, workspace, issue),
      timeoutMs: this.#settings.hooks.timeoutMs,
    });
    if (result.ok) {
      log.info('hook completed', { duration_ms: result.durationMs });
    } else {
      log.warn(result.timedOut ? 'hook timed out' : 'hook failed', {
        exit_code: result.exitCode,
        signal: result.signal,
        duration_ms: result.durationMs,
        error: result.error,
        output: tail(result.output, LOG_OUTPUT_LIMIT),
      });
    }
    return result;
  }

  /**
   * Runs an arbitrary script (an entry check) in the workspace with the hook environment,
   * SYMPHONY_HOOK=<label>, and without agent credentials. `env` is merged on top.
   */
  async runScript(
    label: string,
    script: string,
    workspace: Workspace,
    issue: HookIssue,
    options: { signal?: AbortSignal; timeoutMs: number; env?: Record<string, string> },
  ): Promise<HookResult> {
    const log = this.#logger.child({ hook: label, issue_id: issue.id, issue_identifier: issue.identifier });
    log.info('script started', { workspace: workspace.path });
    const env: NodeJS.ProcessEnv = { ...this.#hookEnv(label, workspace, issue), ...options.env };
    for (const name of AGENT_CREDENTIAL_VARS) delete env[name];
    const result = await runShellScript(script, {
      cwd: workspace.path,
      env,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    if (result.ok) {
      log.info('script completed', { duration_ms: result.durationMs });
    } else {
      log.warn(result.timedOut ? 'script timed out' : 'script failed', {
        exit_code: result.exitCode,
        signal: result.signal,
        duration_ms: result.durationMs,
        error: result.error,
        output: tail(result.output, LOG_OUTPUT_LIMIT),
      });
    }
    return result;
  }

  /** Runs before_remove (failures ignored) and deletes the workspace if it exists. */
  async remove(issue: HookIssue): Promise<boolean> {
    const target = await this.pathFor(issue.identifier);
    await fs.rm(`${target.path}.lock`, { force: true });
    let stat;
    try {
      stat = await fs.lstat(target.path);
    } catch {
      return false;
    }
    if (stat.isDirectory()) {
      await this.runHook('before_remove', { path: target.path, key: target.key, createdNow: false }, issue);
    }
    await fs.rm(target.path, { recursive: true, force: true });
    this.#logger.info('workspace removed', { issue_id: issue.id, issue_identifier: issue.identifier, workspace: target.path });
    return true;
  }

  #script(name: HookName): string | null {
    const hooks = this.#settings.hooks;
    switch (name) {
      case 'after_create':
        return hooks.afterCreate;
      case 'before_run':
        return hooks.beforeRun;
      case 'after_run':
        return hooks.afterRun;
      case 'before_remove':
        return hooks.beforeRemove;
    }
  }

  #hookEnv(name: string, workspace: Workspace, issue: HookIssue): NodeJS.ProcessEnv {
    return {
      ...this.#env,
      ...issue.env,
      SYMPHONY_HOOK: name,
      SYMPHONY_ISSUE_ID: issue.id,
      SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
      SYMPHONY_ISSUE_URL: issue.url ?? '',
      SYMPHONY_ISSUE_BRANCH: issue.branch_name ?? '',
      SYMPHONY_WORKSPACE: workspace.path,
      SYMPHONY_WORKSPACE_KEY: workspace.key,
      SYMPHONY_WORKFLOW_DIR: this.#settings.workflowDir,
    };
  }
}

export function describeFailure(result: HookResult): string {
  if (result.timedOut) return `timed out after ${result.durationMs}ms`;
  if (result.error === 'aborted') return 'was aborted';
  if (result.error !== null) return `could not start: ${result.error}`;
  const why = result.signal !== null ? `was killed by ${result.signal}` : `exited with code ${result.exitCode}`;
  const output = result.output.trim();
  return output === '' ? why : `${why}: ${tail(output, 500)}`;
}
