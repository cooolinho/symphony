import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defaultIntegrations } from '../integrations/registry.ts';
import type { WorkspaceIntegration } from '../integrations/types.ts';
import type { Logger } from '../log.ts';
import { trackerDefaults } from '../tracker/registry.ts';
import { errorCode, errorMessage } from '../util/errors.ts';
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

/** What `loadWorkflowFile` read: WORKFLOW.md and the files its prompt includes. */
type LoadedWorkflow = Awaited<ReturnType<typeof loadWorkflowFile>>;

/** Hash over WORKFLOW.md and every file its prompt includes, so a change to an included file is a new version too. */
function fingerprint({ source, definition }: LoadedWorkflow): string {
  const hash = createHash('sha256').update(source);
  for (const name of Object.keys(definition.partials).sort()) hash.update(`\0${name}\0${definition.partials[name]}`);
  return hash.digest('hex');
}

/**
 * Holds the last known good workflow, watches the file, and re-applies changes without restart.
 * A failed reload keeps the previous version and records the error (which blocks new dispatches).
 */
export class WorkflowStore {
  readonly path: string;
  #env: NodeJS.ProcessEnv;
  #integrations: readonly WorkspaceIntegration[];
  #logger: Logger;
  #current: EffectiveWorkflow;
  #lastError: WorkflowLoadError | null = null;
  #failedHash: string | null = null;
  #watching = false;
  /** One watcher per directory holding WORKFLOW.md or a file its prompt includes. */
  #watchers = new Map<string, fs.FSWatcher>();
  /** The file names worth a reload, per watched directory. */
  #watchedNames = new Map<string, Set<string>>();
  #debounce: NodeJS.Timeout | null = null;
  #listeners = new Set<(workflow: EffectiveWorkflow) => void>();

  private constructor(
    filePath: string,
    env: NodeJS.ProcessEnv,
    integrations: readonly WorkspaceIntegration[],
    logger: Logger,
    initial: EffectiveWorkflow,
  ) {
    this.path = filePath;
    this.#env = env;
    this.#integrations = integrations;
    this.#logger = logger;
    this.#current = initial;
  }

  /** Loads the workflow once; throws (startup failure) if it cannot be read, parsed or resolved. */
  static async open(
    filePath: string,
    options: { env: NodeJS.ProcessEnv; logger: Logger; integrations?: readonly WorkspaceIntegration[] },
  ): Promise<WorkflowStore> {
    const absolute = path.resolve(filePath);
    const integrations = options.integrations ?? defaultIntegrations();
    const workflow = build(await loadWorkflowFile(absolute), absolute, options.env, integrations, 1);
    const store = new WorkflowStore(absolute, options.env, integrations, options.logger, workflow);
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

  /** Re-reads the file and the files its prompt includes; applies them if their content changed. Never throws. */
  async reload(reason: string): Promise<void> {
    let loaded: LoadedWorkflow;
    try {
      loaded = await loadWorkflowFile(this.path);
    } catch (error) {
      this.#fail(error, null, reason);
      return;
    }
    const contentHash = fingerprint(loaded);
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
      const workflow = build(loaded, this.path, this.#env, this.#integrations, this.#current.version + 1);
      this.#current = workflow;
      this.#watchFiles();
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

  /** Watches WORKFLOW.md and the files its prompt includes (e.g. roles/*.md); a change triggers a reload. */
  watch(): void {
    if (this.#watching) return;
    this.#watching = true;
    this.#watchFiles();
  }

  close(): void {
    if (this.#debounce !== null) clearTimeout(this.#debounce);
    this.#watching = false;
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
  }

  /** Brings the directory watchers in line with the files of the current version. */
  #watchFiles(): void {
    if (!this.#watching) return;
    const dir = path.dirname(this.path);
    const files = [this.path, ...Object.keys(this.#current.definition.partials).map((name) => path.resolve(dir, name))];
    this.#watchedNames = new Map();
    for (const file of files) {
      const names = this.#watchedNames.get(path.dirname(file)) ?? new Set<string>();
      names.add(path.basename(file));
      this.#watchedNames.set(path.dirname(file), names);
    }
    for (const [watched, watcher] of this.#watchers) {
      if (this.#watchedNames.has(watched)) continue;
      watcher.close();
      this.#watchers.delete(watched);
    }
    for (const watched of this.#watchedNames.keys()) if (!this.#watchers.has(watched)) this.#watchDirectory(watched);
  }

  #watchDirectory(dir: string): void {
    try {
      const watcher = fs.watch(dir, (_event, filename) => {
        if (filename !== null && this.#watchedNames.get(dir)?.has(filename.toString()) !== true) return;
        if (this.#debounce !== null) clearTimeout(this.#debounce);
        this.#debounce = setTimeout(() => {
          this.#debounce = null;
          void this.reload('watch');
        }, RELOAD_DEBOUNCE_MS);
      });
      watcher.on('error', (error) => {
        this.#logger.warn('workflow file watch failed; relying on the per-tick check', { error: error.message, dir });
        watcher.close();
        this.#watchers.delete(dir);
      });
      this.#watchers.set(dir, watcher);
    } catch (error) {
      this.#logger.warn('cannot watch the workflow file; relying on the per-tick check', { error: errorMessage(error), dir });
    }
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

function build(
  loaded: LoadedWorkflow,
  filePath: string,
  env: NodeJS.ProcessEnv,
  integrations: readonly WorkspaceIntegration[],
  version: number,
): EffectiveWorkflow {
  const { definition } = loaded;
  const config = resolveConfig(definition.config, { workflowPath: filePath, env, trackerDefaults, integrations });
  return {
    definition,
    config,
    prompt: compilePrompt(definition.promptTemplate === '' ? DEFAULT_PROMPT : definition.promptTemplate, definition.partials),
    continuationPrompt: compilePrompt(config.agent.continuationPrompt ?? DEFAULT_CONTINUATION_PROMPT),
    version,
    contentHash: fingerprint(loaded),
    loadedAt: new Date(),
  };
}
