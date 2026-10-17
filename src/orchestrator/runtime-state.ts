import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../log.ts';
import { errorMessage } from '../util/errors.ts';
import { resolveEnvReference } from '../util/env.ts';
import type { TrackerConfig } from '../workflow/config.ts';

/** No session of `model` starts until `until`: the model hit its own usage limit. */
export interface ModelHold {
  /** Model family (`fable`, `opus`, `sonnet`, `haiku`). */
  model: string;
  /** `limit`: set by a model-scoped usage limit. */
  source: 'limit';
  since: Date;
  until: Date;
  /** The original Claude message. */
  text: string;
  /** The issue whose session hit the limit. */
  issueIdentifier: string | null;
  /** Repository of that issue, for the history log (`owner/name`, or `unknown`). */
  repo: string;
}

/** Scheduling state that survives a restart. */
export interface RuntimeState {
  modelHolds: ModelHold[];
}

interface ModelHoldJson {
  model: string;
  source: 'limit';
  since: string;
  until: string;
  text: string;
  issue_identifier: string | null;
  repo: string;
}

interface RuntimeStateJson {
  version: 1;
  model_holds: ModelHoldJson[];
}

const MAX_NAME_LENGTH = 100;

/**
 * The state file of this instance: `<logDir>/state/<repositories>.json`, named after the configured repositories
 * because several instances can share one log directory. Null without a log directory (state stays in memory).
 */
export function runtimeStateFile(logDir: string | null, tracker: Pick<TrackerConfig, 'kind' | 'provider'>, env: NodeJS.ProcessEnv): string | null {
  if (logDir === null) return null;
  return path.join(logDir, 'state', `${instanceName(tracker, env)}.json`);
}

function instanceName(tracker: Pick<TrackerConfig, 'kind' | 'provider'>, env: NodeJS.ProcessEnv): string {
  const raw = resolveEnvReference(tracker.provider.repositories, env);
  const entries = Array.isArray(raw)
    ? raw.map((entry) => resolveEnvReference(entry, env))
    : typeof raw === 'string'
      ? raw.split(/[\s,]+/)
      : [];
  const repositories = [...new Set(entries.filter((e): e is string => typeof e === 'string' && e.trim() !== '').map((e) => e.trim().toLowerCase()))].sort();
  const base = repositories.length > 0 ? repositories.join('+') : (tracker.kind ?? 'symphony');
  const name = base.replace(/\//g, '_').replace(/[^a-z0-9._+-]/gi, '_');
  if (name.length <= MAX_NAME_LENGTH) return name;
  return `${name.slice(0, MAX_NAME_LENGTH - 13)}-${createHash('sha256').update(base).digest('hex').slice(0, 12)}`;
}

/**
 * Reads and writes the runtime state file (atomic replace). Without a file everything stays in memory. A missing
 * or unreadable file is an empty state; disk errors are logged once and never fail the caller.
 */
export class RuntimeStateStore {
  readonly file: string | null;
  #logger: Logger;
  #failing = false;

  constructor(file: string | null, logger: Logger) {
    this.file = file;
    this.#logger = logger;
  }

  /** The stored state; holds that ended before `now` are dropped. */
  load(now: Date): RuntimeState {
    const empty: RuntimeState = { modelHolds: [] };
    if (this.file === null) return empty;
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#logger.warn('cannot read the runtime state; starting without it', { file: this.file, error: errorMessage(error) });
      }
      return empty;
    }
    let parsed: Partial<RuntimeStateJson>;
    try {
      parsed = JSON.parse(text) as Partial<RuntimeStateJson>;
    } catch (error) {
      this.#logger.warn('ignoring an unreadable runtime state', { file: this.file, error: errorMessage(error) });
      return empty;
    }
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1) {
      this.#logger.warn('ignoring a runtime state of an unknown version', { file: this.file });
      return empty;
    }
    const holds = Array.isArray(parsed.model_holds) ? parsed.model_holds.map(holdOf) : [];
    return { modelHolds: holds.filter((hold): hold is ModelHold => hold !== null && hold.until.getTime() > now.getTime()) };
  }

  save(state: RuntimeState): void {
    if (this.file === null) return;
    const json: RuntimeStateJson = {
      version: 1,
      model_holds: state.modelHolds.map((hold) => ({
        model: hold.model,
        source: hold.source,
        since: hold.since.toISOString(),
        until: hold.until.toISOString(),
        text: hold.text,
        issue_identifier: hold.issueIdentifier,
        repo: hold.repo,
      })),
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(json, null, 2)}\n`);
      fs.renameSync(tmp, this.file);
      this.#failing = false;
    } catch (error) {
      if (!this.#failing) this.#logger.warn('cannot write the runtime state', { file: this.file, error: errorMessage(error) });
      this.#failing = true;
    }
  }
}

function holdOf(value: unknown): ModelHold | null {
  if (value === null || typeof value !== 'object') return null;
  const hold = value as Partial<ModelHoldJson>;
  if (typeof hold.model !== 'string' || hold.model === '' || hold.source !== 'limit') return null;
  const since = new Date(typeof hold.since === 'string' ? hold.since : Number.NaN);
  const until = new Date(typeof hold.until === 'string' ? hold.until : Number.NaN);
  if (!Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime())) return null;
  return {
    model: hold.model,
    source: 'limit',
    since,
    until,
    text: typeof hold.text === 'string' ? hold.text : '',
    issueIdentifier: typeof hold.issue_identifier === 'string' ? hold.issue_identifier : null,
    repo: typeof hold.repo === 'string' ? hold.repo : 'unknown',
  };
}
