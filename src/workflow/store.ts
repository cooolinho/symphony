import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../log.ts';
import { trackerDefaults } from '../tracker/registry.ts';
import { SymphonyError, errorCode, errorMessage } from '../util/errors.ts';
import { resolveConfig, type ServiceConfig } from './config.ts';
import { loadWorkflowFile, type WorkflowDefinition } from './loader.ts';
import { compilePrompt, DEFAULT_CONTINUATION_PROMPT, DEFAULT_PROMPT, type PromptTemplate } from './template.ts';

/** One successfully loaded version of WORKFLOW.md. Template errors live inside the templates. */
export interface EffectiveWorkflow {
  definition: WorkflowDefinition;
  config: ServiceConfig;
  prompt: PromptTemplate;
  continuationPrompt: PromptTemplate;
  version: number;
  contentHash: string;
  loadedAt: Date;
}

export interface WorkflowLoadError {
  code: string;
  message: string;
  at: Date;
}

const RELOAD_DEBOUNCE_MS = 200;

function hash(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

/**
 * Holds the last known good workflow, watches the file, and re-applies changes without restart.
 * A failed reload keeps the previous version and records the error (which blocks new dispatches).
 */
export class WorkflowStore {
  readonly path: string;
  #env: NodeJS.ProcessEnv;
  #logger: Logger;
  #current: EffectiveWorkflow;
  #lastError: WorkflowLoadError | null = null;
  #failedHash: string | null = null;
  #watcher: fs.FSWatcher | null = null;
  #debounce: NodeJS.Timeout | null = null;
  #listeners = new Set<(workflow: EffectiveWorkflow) => void>();

  private constructor(filePath: string, env: NodeJS.ProcessEnv, logger: Logger, initial: EffectiveWorkflow) {
    this.path = filePath;
    this.#env = env;
    this.#logger = logger;
    this.#current = initial;
  }

  /** Loads the workflow once; throws (startup failure) if it cannot be read, parsed or resolved. */
  static async open(filePath: string, options: { env: NodeJS.ProcessEnv; logger: Logger }): Promise<WorkflowStore> {
    const absolute = path.resolve(filePath);
    const { workflow } = await build(absolute, options.env, 1);
    const store = new WorkflowStore(absolute, options.env, options.logger, workflow);
    store.#logWarnings(workflow);
    return store;
  }

  get current(): EffectiveWorkflow {
    return this.#current;
  }

  get lastError(): WorkflowLoadError | null {
    return this.#lastError;
  }

  onReload(listener: (workflow: EffectiveWorkflow) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Re-reads the file; applies it if its content changed. Never throws. */
  async reload(reason: string): Promise<void> {
    let source: string;
    try {
      source = await fs.promises.readFile(this.path, 'utf8');
    } catch (error) {
      this.#fail(new SymphonyError('missing_workflow_file', `cannot read ${this.path}: ${errorMessage(error)}`), null, reason);
      return;
    }
    const contentHash = hash(source);
    if (contentHash === this.#current.contentHash) {
      if (this.#lastError !== null) {
        this.#logger.info('workflow file restored to the running version', { path: this.path });
        this.#lastError = null;
        this.#failedHash = null;
      }
      return;
    }
    if (contentHash === this.#failedHash) return;

    try {
      const { workflow } = await build(this.path, this.#env, this.#current.version + 1);
      this.#current = workflow;
      this.#lastError = null;
      this.#failedHash = null;
      this.#logger.info('workflow reloaded', { path: this.path, version: workflow.version, reason });
      this.#logWarnings(workflow);
      for (const listener of this.#listeners) listener(workflow);
    } catch (error) {
      this.#fail(error, contentHash, reason);
    }
  }

  /** Defensive per-tick check in case a filesystem event was missed. */
  refreshIfChanged(): Promise<void> {
    return this.reload('poll');
  }

  watch(): void {
    if (this.#watcher !== null) return;
    const base = path.basename(this.path);
    try {
      this.#watcher = fs.watch(path.dirname(this.path), (_event, filename) => {
        if (filename !== null && filename.toString() !== base) return;
        if (this.#debounce !== null) clearTimeout(this.#debounce);
        this.#debounce = setTimeout(() => {
          this.#debounce = null;
          void this.reload('watch');
        }, RELOAD_DEBOUNCE_MS);
      });
      this.#watcher.on('error', (error) => {
        this.#logger.warn('workflow file watch failed; relying on the per-tick check', { error: error.message });
        this.#watcher?.close();
        this.#watcher = null;
      });
    } catch (error) {
      this.#logger.warn('cannot watch the workflow file; relying on the per-tick check', { error: errorMessage(error) });
    }
  }

  close(): void {
    if (this.#debounce !== null) clearTimeout(this.#debounce);
    this.#watcher?.close();
    this.#watcher = null;
  }

  #fail(error: unknown, contentHash: string | null, reason: string): void {
    const code = errorCode(error, 'workflow_parse_error');
    const message = errorMessage(error);
    const repeated = this.#lastError?.message === message;
    this.#lastError = { code, message, at: new Date() };
    this.#failedHash = contentHash;
    if (!repeated) {
      this.#logger.error('workflow reload failed; keeping the last good version and pausing new dispatches', {
        path: this.path,
        code,
        error: message,
        running_version: this.#current.version,
        reason,
      });
    }
  }

  #logWarnings(workflow: EffectiveWorkflow): void {
    for (const warning of workflow.config.warnings) this.#logger.warn('workflow config warning', { warning });
    if (workflow.prompt.parseError !== null) {
      this.#logger.error('prompt template does not parse; run attempts will fail until it is fixed', {
        error: workflow.prompt.parseError,
      });
    }
    if (workflow.continuationPrompt.parseError !== null) {
      this.#logger.error('agent.continuation_prompt does not parse; continuation turns will fail', {
        error: workflow.continuationPrompt.parseError,
      });
    }
  }
}

async function build(filePath: string, env: NodeJS.ProcessEnv, version: number): Promise<{ workflow: EffectiveWorkflow }> {
  const { definition, source } = await loadWorkflowFile(filePath);
  const config = resolveConfig(definition.config, { workflowPath: filePath, env, trackerDefaults });
  return {
    workflow: {
      definition,
      config,
      prompt: compilePrompt(definition.promptTemplate === '' ? DEFAULT_PROMPT : definition.promptTemplate),
      continuationPrompt: compilePrompt(config.agent.continuationPrompt ?? DEFAULT_CONTINUATION_PROMPT),
      version,
      contentHash: hash(source),
      loadedAt: new Date(),
    },
  };
}
