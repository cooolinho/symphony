import fs from 'node:fs';
import path from 'node:path';
import type { AgentRunner } from '../agent/types.ts';
import type { HistoryEntry } from '../history/history.ts';
import type { Logger } from '../log.ts';
import { filesOutside } from '../orchestrator/changed-files.ts';
import { blockedBucketColumns } from '../orchestrator/pipeline.ts';
import { statusUpdatedAt } from '../orchestrator/recovery.ts';
import { buildStageHistory, docsBaseHead, type PersistedResult } from '../orchestrator/stage-history.ts';
import { DEFAULT_OPT_OUT_LABEL } from '../tracker/github-project/settings.ts';
import type { Issue, TrackerAdapter } from '../tracker/types.ts';
import { errorMessage } from '../util/errors.ts';
import { normalizeStateName, type ServiceConfig } from '../workflow/config.ts';
import type { RoleConfig } from '../workflow/roles.ts';
import { workspaceKey } from '../workspace/manager.ts';
import { act } from './act.ts';
import { classifyBlock } from './case.ts';
import { baseState, githubBaseReader, type BaseReader } from './base.ts';
import { decide, openForRecheck, planRecheck, type BaseState, type Decision, type Diagnosis, type PriorDiagnosis } from './decide.ts';
import { diagnose, readPrompt, renderWatchdogPrompt } from './diagnose.ts';
import {
  changedSince,
  commentEvidence,
  gitState,
  githubStatus,
  historyExcerpt,
  logExcerpt,
  modelHeld,
  readOrchestratorState,
  readRepositoryHistory,
  stateExcerpt,
  transcriptExcerpts,
} from './evidence.ts';
import { HEARTBEAT_INTERVAL_MS, writeHeartbeat } from './heartbeat.ts';
import { blockEntries, watchdogEntries, type WatchdogEntry } from './marker.ts';

/** Columns used when the workflow names no shared escape column (no roles section). */
const FALLBACK_BLOCKED = ['Blocked'];

export interface PollerDeps {
  config: () => ServiceConfig;
  adapter: TrackerAdapter;
  runner: AgentRunner;
  logger: Logger;
  env: NodeJS.ProcessEnv;
  secretNames: string[];
  /** Symphony's state directory (repository logs, transcripts), read-only. */
  logDir: string;
  /** The watchdog's own directory: events.jsonl, transcripts, scratch cwd. */
  stateDir: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Head of a repository's base branch for re-checks; default: the GitHub tracker's GraphQL client (none = no re-checks). */
  readBase?: BaseReader | null;
}

/** One line of `events.jsonl`: what the watchdog saw and did with one blocked issue. */
export interface WatchdogEvent {
  at: string;
  issue: string;
  blocked_at: string | null;
  /** The watchdog mode the decision was made in. */
  mode: string;
  block: string;
  from: string | null;
  cause: string | null;
  confidence: string | null;
  recommended: string | null;
  /** The diagnosis says the target column can fix the cause (`fixable_in_target`); null without a diagnosis. */
  fixable: boolean | null;
  decision: Decision['action'] | 'error';
  reason: string;
  action: string | null;
  moved: string | null;
  cost_usd: number | null;
  prompt_hash: string | null;
  errors: string[];
  /** 0 for the first diagnosis of the block, 1.. for a re-check after the base branch moved. */
  recheck: number;
  /** Head of the base branch at the diagnosis, and what its checks said; null when unknown. */
  base_sha: string | null;
  base_checks: BaseState['checks'] | null;
}

const EVENTS_FILE = 'events.jsonl';

/** Key of one block in one mode. A block without `blocked_at` is remembered only within the run (see `loadDecided`). */
function blockKey(issue: string, blockedAt: string | null, mode: string): string {
  return `${issue}@${blockedAt ?? 'unknown'}#${mode}`;
}

/** Whether an event settles its block: a decision (not a wait or a failed session) that was carried out. */
function decided(event: Pick<WatchdogEvent, 'decision' | 'action' | 'mode'>): boolean {
  return (event.decision === 'resume' || event.decision === 'escalate' || event.decision === 'skip') && (event.action !== null || event.mode === 'observe');
}

function priorOfEvent(event: Pick<WatchdogEvent, 'decision' | 'cause' | 'at'> & Partial<Pick<WatchdogEvent, 'recheck' | 'base_sha'>>): PriorDiagnosis {
  return {
    decision: event.decision === 'resume' || event.decision === 'escalate' || event.decision === 'skip' ? event.decision : null,
    cause: event.cause ?? null,
    recheck: typeof event.recheck === 'number' ? event.recheck : 0,
    baseSha: typeof event.base_sha === 'string' ? event.base_sha : null,
    at: new Date(event.at),
  };
}

function priorOfEntry({ marker, comment }: WatchdogEntry): PriorDiagnosis {
  const at = new Date(marker.created_at);
  return { decision: marker.decision, cause: marker.cause, recheck: marker.recheck, baseSha: marker.base_sha, at: Number.isNaN(at.getTime()) ? comment.createdAt : at };
}

/** The diagnosis that counts: the highest re-check number, then the newest. */
export function newestPrior(priors: ReadonlyArray<PriorDiagnosis | null | undefined>): PriorDiagnosis | null {
  let best: PriorDiagnosis | null = null;
  for (const prior of priors) {
    if (prior == null) continue;
    if (best === null || prior.recheck > best.recheck || (prior.recheck === best.recheck && prior.at.getTime() > best.at.getTime())) best = prior;
  }
  return best;
}

/**
 * The newest settled diagnosis of each block decided on in earlier runs, from `events.jsonl` (by `blockKey`); empty
 * when it cannot be read. Re-checks are counted from it, so a restart neither repeats nor forgets one.
 */
export function loadDecided(file: string): Map<string, PriorDiagnosis> {
  const priors = new Map<string, PriorDiagnosis>();
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return priors;
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const event = JSON.parse(line) as Partial<WatchdogEvent>;
      if (typeof event.issue !== 'string' || typeof event.blocked_at !== 'string' || typeof event.mode !== 'string' || typeof event.at !== 'string') continue;
      if (!decided(event as WatchdogEvent)) continue;
      const key = blockKey(event.issue, event.blocked_at, event.mode);
      const prior = newestPrior([priors.get(key), priorOfEvent(event as WatchdogEvent)]);
      if (prior !== null) priors.set(key, prior);
    } catch {
      // A torn last line after a crash.
    }
  }
  return priors;
}

const columnsOf = (roles: readonly RoleConfig[] | null, active: readonly string[], kind: string) =>
  active.filter((state) => roles?.some((role) => role.result === kind && role.states.includes(normalizeStateName(state))) === true);

export class WatchdogPoller {
  #deps: PollerDeps;
  /**
   * The newest settled diagnosis per block (`<issue>@<blocked at>#<mode>`), also in mode observe, where no marker is
   * written. Read back from `events.jsonl` at start, so a restart does not diagnose the same blocks again; the mode is
   * part of the key, so switching from observe to act acts on blocks that were only observed.
   */
  #priors: Map<string, PriorDiagnosis>;
  /** Blocks that are settled for good (no re-check left), by the same key. */
  #handled = new Set<string>();
  #readBase: BaseReader | null;
  /** Base heads read in the current pass (`<repo>@<branch>`), so blocked issues of one repository share one request. */
  #baseCache: Map<string, Promise<BaseState | null>> | null = null;
  /** Blocks to look at again later (a wait decision or a failed session), by the same key. */
  #nextCheck = new Map<string, number>();
  #timer: NodeJS.Timeout | null = null;
  #stopping = false;
  #abort = new AbortController();
  #tick: Promise<void> | null = null;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #heartbeatFailed = false;
  #startedAt: Date;
  #lastTickAt: Date | null = null;

  constructor(deps: PollerDeps) {
    this.#deps = deps;
    this.#startedAt = this.#now();
    this.#priors = loadDecided(path.join(deps.stateDir, EVENTS_FILE));
    this.#readBase = deps.readBase === undefined ? githubBaseReader(deps.adapter) : deps.readBase;
  }

  #now(): Date {
    return this.#deps.now?.() ?? new Date();
  }

  start(): void {
    this.#beat();
    this.#heartbeatTimer = setInterval(() => this.#beat(), HEARTBEAT_INTERVAL_MS);
    this.#heartbeatTimer.unref();
    const loop = () => {
      if (this.#stopping) return;
      this.#tick = this.tick()
        .then(() => {
          this.#lastTickAt = this.#now();
          this.#beat();
        })
        .catch((error: unknown) => this.#deps.logger.error('watchdog tick failed', { error: errorMessage(error) }))
        .finally(() => {
          this.#tick = null;
          if (!this.#stopping) this.#timer = setTimeout(loop, this.#deps.config().watchdog.intervalMs);
        });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    if (this.#heartbeatTimer !== null) clearInterval(this.#heartbeatTimer);
    this.#abort.abort('watchdog shutting down');
    await this.#tick;
    this.#beat(this.#now());
  }

  /** Writes the sign of life the orchestrator shows on the dashboard (`health.watchdog`). */
  #beat(stoppedAt: Date | null = null): void {
    const { watchdog } = this.#deps.config();
    const ok = writeHeartbeat(this.#deps.stateDir, {
      pid: process.pid,
      mode: watchdog.mode,
      model: watchdog.model,
      started_at: this.#startedAt.toISOString(),
      updated_at: this.#now().toISOString(),
      last_tick_at: this.#lastTickAt?.toISOString() ?? null,
      stopped_at: stoppedAt?.toISOString() ?? null,
    });
    if (!ok && !this.#heartbeatFailed) this.#deps.logger.warn('could not write the watchdog heartbeat', { state_dir: this.#deps.stateDir });
    this.#heartbeatFailed = !ok;
  }

  blockedColumns(config: ServiceConfig): string[] {
    const columns = blockedBucketColumns(config.roles, config.tracker.activeStates, config.tracker.terminalStates);
    return columns.length > 0 ? columns : FALLBACK_BLOCKED;
  }

  /** One pass over the blocked column; issues are handled one after the other. */
  async tick(): Promise<void> {
    const config = this.#deps.config();
    const issues = await this.#deps.adapter.fetchIssuesByStates(this.blockedColumns(config));
    this.#baseCache = new Map();
    try {
      for (const issue of issues) {
        if (this.#stopping) return;
        try {
          await this.handle(issue, config);
        } catch (error) {
          this.#deps.logger.error('watchdog could not handle the issue', { issue: issue.identifier, error: errorMessage(error) });
        }
      }
    } finally {
      this.#baseCache = null;
    }
  }

  /** Head of the issue's base branch (`native_ref.base_branch`, else the default branch); null when unknown. */
  #base(issue: Issue, repo: string | null, history: readonly HistoryEntry[]): Promise<BaseState | null> {
    const reader = this.#readBase;
    if (repo === null || reader === null) return Promise.resolve(null);
    const raw = issue.native_ref?.base_branch;
    const branch = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
    const cacheKey = `${repo}@${branch ?? ''}`;
    const cached = this.#baseCache?.get(cacheKey);
    if (cached !== undefined) return cached;
    const read = reader(repo, branch).then(
      (head) => baseState(head, history),
      (error: unknown) => {
        this.#deps.logger.warn('watchdog could not read the base branch', { repo, branch: branch ?? 'default', error: errorMessage(error) });
        return null;
      },
    );
    this.#baseCache?.set(cacheKey, read);
    return read;
  }

  async handle(issue: Issue, config: ServiceConfig): Promise<WatchdogEvent | null> {
    const { adapter, logger } = this.#deps;
    const { watchdog } = config;
    const now = this.#now();
    const blockedAt = statusUpdatedAt(issue);
    const key = blockKey(issue.identifier, blockedAt?.toISOString() ?? null, watchdog.mode);
    if (this.#handled.has(key)) return null;
    if ((this.#nextCheck.get(key) ?? 0) > now.getTime()) return null;
    if (blockedAt !== null && now.getTime() - blockedAt.getTime() < watchdog.settleMs) return null;
    if (adapter.readComments === undefined || adapter.viewerLogin === undefined || adapter.readResults === undefined) {
      throw new Error(`the ${adapter.kind} tracker cannot read comments and results`);
    }

    const [comments, viewer, tracked] = await Promise.all([adapter.readComments(issue), adapter.viewerLogin(), adapter.readResults(issue)]);
    const entries = watchdogEntries(comments, viewer);
    const repo = adapter.issueRepository?.(issue) ?? null;
    const history = readRepositoryHistory(this.#deps.logDir, repo);
    // Diagnosed before (this process, an earlier one, or the marker of the block's comment): settled, unless an
    // environment escalation may be re-checked because the base branch moved.
    const prior = newestPrior([this.#priors.get(key), ...blockEntries(entries, blockedAt?.toISOString() ?? null).map(priorOfEntry)]);
    let base: Promise<BaseState | null> | null = null;
    const readBase = () => (base ??= this.#base(issue, repo, history.entries));
    const plan = await planRecheck({ prior, config: watchdog, now, readBase });
    if (plan.action === 'final') {
      this.#handled.add(key);
      return null;
    }
    if (plan.action === 'later') {
      this.#later(key, now, watchdog.cooldownMs);
      logger.debug('watchdog does not re-check yet', { issue: issue.identifier, reason: plan.reason });
      return null;
    }
    const recheck = plan.recheck;

    const fetchFn = this.#deps.fetch ?? fetch;
    const state = await readOrchestratorState(fetchFn, watchdog.apiUrl);
    if (modelHeld(state, watchdog.model)) {
      this.#later(key, now, watchdog.cooldownMs);
      logger.info('watchdog waits: the orchestrator holds the model', { issue: issue.identifier, model: watchdog.model });
      return null;
    }

    const results: PersistedResult[] = tracked.map(({ result, meta, url }) => ({ result, meta, url }));
    const baseNow = await readBase();
    const { activeStates } = config.tracker;
    const block = classifyBlock({
      results,
      comments,
      viewer,
      history: history.entries,
      issueIdentifier: issue.identifier,
      blockedColumns: this.blockedColumns(config),
      activeStates,
      roles: config.roles,
      blockedAt,
    });

    const workspace = path.join(config.workspace.root, workspaceKey(issue.identifier));
    const workspaceExists = fs.existsSync(workspace);
    const humanComments = comments.filter((comment) => comment.author !== viewer);
    const resumes = entries.filter((entry) => entry.marker.action === 'resume').length;
    const prompt = await readPrompt(watchdog.prompt);
    const scope = {
      mode: watchdog.mode,
      issue: { identifier: issue.identifier, title: issue.title, url: issue.url, labels: issue.labels, state: issue.state, description: issue.description },
      block: {
        kind: block.kind,
        from: block.from,
        role: block.role,
        blockers: block.blockers,
        summary: block.summary,
        check_failed_for: block.checkFailedFor,
        comment_url: block.commentUrl,
        blocked_at: blockedAt?.toISOString() ?? null,
      },
      evidence: {
        history: historyExcerpt(history.lines, history.entries, issue.identifier),
        log: logExcerpt(watchdog.logFile, issue.identifier, blockedAt),
        state: stateExcerpt(state, issue.identifier),
        github_status: await githubStatus(fetchFn, now),
        git: await gitState(workspaceExists ? workspace : null),
        transcripts: transcriptExcerpts(this.#deps.logDir, issue.identifier),
        comments: commentEvidence(comments),
      },
      columns: activeStates,
      attempt: Math.min(resumes + 1, watchdog.maxResumes),
      max_resumes: watchdog.maxResumes,
      recheck: {
        number: recheck,
        max: watchdog.maxRechecks,
        reason: recheck > 0 ? plan.reason : null,
        previous_cause: recheck > 0 ? (prior?.cause ?? null) : null,
        base_branch: baseNow?.branch ?? null,
        base_sha: baseNow?.sha ?? null,
        base_checks: baseNow?.checks ?? null,
      },
      paths: {
        sessions: path.join(this.#deps.logDir, 'sessions', workspaceKey(issue.identifier)),
        repositories: path.join(this.#deps.logDir, 'repositories'),
        log: watchdog.logFile,
        workspace: workspaceExists ? workspace : null,
      },
    };
    const text = await renderWatchdogPrompt(prompt, scope);

    const scratch = path.join(this.#deps.stateDir, 'scratch');
    fs.mkdirSync(scratch, { recursive: true });
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const transcriptPath = path.join(this.#deps.stateDir, 'sessions', workspaceKey(issue.identifier), `${stamp}.jsonl`);
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    logger.info('watchdog diagnoses a blocked issue', {
      issue: issue.identifier,
      block: block.kind,
      from: block.from ?? 'unknown',
      model: watchdog.model,
      recheck: recheck > 0 ? `${recheck}/${watchdog.maxRechecks}: ${plan.reason}` : undefined,
    });
    const outcome = await diagnose({
      runner: this.#deps.runner,
      config,
      issue,
      prompt: text,
      cwd: workspaceExists ? workspace : scratch,
      readDirs: [this.#deps.logDir, ...(watchdog.logFile === null ? [] : [path.dirname(watchdog.logFile)])],
      env: this.#deps.env,
      secretNames: this.#deps.secretNames,
      transcriptPath,
      logger: logger.child({ issue: issue.identifier }),
      signal: this.#abort.signal,
    });

    const common = {
      at: now.toISOString(),
      issue: issue.identifier,
      blocked_at: blockedAt?.toISOString() ?? null,
      mode: watchdog.mode,
      block: block.kind,
      from: block.from,
      cost_usd: outcome.costUsd,
      prompt_hash: prompt.hash,
      recheck,
      base_sha: baseNow?.sha ?? null,
      base_checks: baseNow?.checks ?? null,
    };
    if (outcome.diagnosis === null) {
      // A failed session (usage limit, outage) is no verdict on the issue: try again after the cooldown.
      this.#later(key, now, watchdog.cooldownMs);
      return this.#record({ ...common, cause: null, confidence: null, recommended: null, fixable: null, decision: 'error', reason: outcome.error ?? 'no diagnosis', action: null, moved: null, errors: [] });
    }

    const diagnosis: Diagnosis = outcome.diagnosis;
    const decision = decide({
      diagnosis,
      block,
      entries,
      humanComments,
      config: watchdog,
      activeStates,
      firstColumn: activeStates[0] ?? null,
      docsColumns: columnsOf(config.roles, activeStates, 'docs'),
      reviewColumns: columnsOf(config.roles, activeStates, 'review'),
      blockedByAnalysis: config.roles?.some((role) => role.name === block.role && role.result === 'analysis') === true,
      docsPathRuleBroken: await this.#docsPathRuleBroken(results, workspaceExists ? workspace : null, config),
      manualMerge: issue.labels.some((label) => label.toLowerCase() === DEFAULT_OPT_OUT_LABEL),
      now,
    });
    if (decision.action === 'wait') this.#later(key, now, watchdog.cooldownMs);
    const done = await act({
      adapter,
      issue,
      mode: watchdog.mode,
      diagnosis,
      decision,
      maxResumes: watchdog.maxResumes,
      limitLabel: config.pipeline.limitLabel,
      blockedAt,
      promptHash: prompt.hash,
      recheck,
      maxRechecks: watchdog.maxRechecks,
      base: baseNow,
      now,
    });
    if (decided({ decision: decision.action, action: done.action, mode: watchdog.mode })) {
      const settled = priorOfEvent({ decision: decision.action, cause: diagnosis.cause, at: now.toISOString(), recheck, base_sha: baseNow?.sha ?? null });
      this.#priors.set(key, settled);
      if (!openForRecheck(settled) || recheck >= watchdog.maxRechecks) this.#handled.add(key);
      else this.#later(key, now, watchdog.cooldownMs);
    }
    if (done.action === null && decision.action !== 'wait' && watchdog.mode !== 'observe') this.#later(key, now, watchdog.cooldownMs);
    return this.#record({
      ...common,
      cause: diagnosis.cause,
      confidence: diagnosis.confidence,
      recommended: diagnosis.target_column,
      fixable: diagnosis.fixable_in_target,
      decision: decision.action,
      reason: decision.reason,
      action: done.action,
      moved: done.moved,
      errors: done.errors,
    });
  }

  /** True when files changed since the docs hand-off lie outside `pipeline.docs_paths` (the docs role would block again). */
  async #docsPathRuleBroken(results: readonly PersistedResult[], workspace: string | null, config: ServiceConfig): Promise<boolean> {
    const base = docsBaseHead(buildStageHistory(results));
    if (base === null) return false;
    const files = await changedSince(workspace, base);
    // Unknown counts as broken: better a human than a docs run that blocks again.
    if (files === null) return true;
    return filesOutside(files, config.pipeline.docsPaths).length > 0;
  }

  #later(key: string, now: Date, ms: number): void {
    this.#nextCheck.set(key, now.getTime() + Math.max(ms, 60_000));
  }

  #record(event: WatchdogEvent): WatchdogEvent {
    const level = event.decision === 'error' || event.errors.length > 0 ? 'warn' : 'info';
    this.#deps.logger.log(level, 'watchdog decision', { ...event, errors: event.errors.join('; ') || undefined });
    try {
      fs.mkdirSync(this.#deps.stateDir, { recursive: true });
      fs.appendFileSync(path.join(this.#deps.stateDir, EVENTS_FILE), `${JSON.stringify(event)}\n`);
    } catch (error) {
      this.#deps.logger.warn('could not write the watchdog event log', { error: errorMessage(error) });
    }
    return event;
  }
}
