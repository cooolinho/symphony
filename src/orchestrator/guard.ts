import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { AgentToolSpec, AllowedTransition, Issue, ToolResult } from '../tracker/types.ts';
import { SerialQueue } from '../util/async.ts';
import { errorMessage } from '../util/errors.ts';
import { tail } from '../util/text.ts';
import type { HookResult } from '../workspace/hooks.ts';
import { describeFailure, type HookIssue, type Workspace, type WorkspaceManager } from '../workspace/manager.ts';
import { normalizeStateName, type EntryCheck, type ServiceConfig } from '../workflow/config.ts';
import { checkSummary } from '../workflow/results.ts';
import { roleName, type RoleConfig } from '../workflow/roles.ts';
import { isTerminalState } from './eligibility.ts';
import { subIssueLimit } from './work-packages.ts';

/** Tool error categories the guard returns instead of running a status-changing tool. */
export type GuardDenial = 'transition_denied' | 'check_failed' | 'check_timeout' | 'check_error';

export type GuardDecision =
  /** `check`: the entry check that cleared the move (this call's run or a cached pass); absent when none applied. */
  | { allow: true; note: string | null; check?: CheckRecord }
  | {
      allow: false;
      category: GuardDenial;
      message: string;
      /** For `check_failed`: the check's output (cut to {@link CHECK_OUTPUT_LIMIT}) and its record. */
      failed?: { output: string; check: CheckRecord };
    };

/**
 * Decides whether the session may move its issue to `target`; `tool` (default `set_status`) is the tool the agent
 * called, named in the denial messages. Never throws.
 */
export type TransitionGuard = (target: string, tool?: string) => Promise<GuardDecision>;

/** The adapter tool that moves an issue to a column the agent names. */
const STATUS_TOOL = 'set_status';

/** Check output passed back to the agent on a failed check. */
export const CHECK_OUTPUT_LIMIT = 6_000;
/** The end of the output kept for a passed or skipped check (gate run), from the `host load at end` / `steps:` lines on. */
export const CHECK_PASSED_OUTPUT_LIMIT = 400;
export const CHECK_PASSED_NOTE = 'Checks passed — end your turn now.';
/** Exit code of a check that does not apply here (e.g. no such script in the repository): it passes, as `skipped`. */
export const CHECK_SKIPPED_EXIT = 78;
/** A named check posts `pending` only once it has run this long, so instant skips leave no status. */
const PENDING_STATUS_DELAY_MS = 5000;
/** Upper bound for each git call that builds the cache key; on timeout the cache is skipped. */
const GIT_TIMEOUT_MS = 5000;

/** Passing check results of one claim, keyed by `<HEAD sha>:<check hash>`; see {@link cacheKey}. */
export type CheckCache = Map<string, CheckRecord>;

/** Result of one entry check, reported to the orchestrator (`last_check`, history line `checks_finished`). */
export interface CheckRecord {
  target: string;
  /** The check's name (`checks.on_enter` list entries); null for a plain script, or for the summary of several. */
  name: string | null;
  role: string;
  /** Workspace commit the check ran on; null outside git or when unknown. */
  sha: string | null;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  ok: boolean;
  /** `passed`, `skipped` (exit {@link CHECK_SKIPPED_EXIT}), or the denial category the agent received. */
  result: 'passed' | 'skipped' | Exclude<GuardDenial, 'transition_denied'>;
  finishedAt: Date;
  /** Steps and host load the script printed (`steps:` block, `host load at end` line); absent without them. */
  steps?: CheckStep[];
  load?: CheckLoad;
  /** The kept end of the output of a passed or skipped check; reused for a cached result. */
  output?: string;
}

/** One line of the `steps:` block of `checks/laravel.sh`. */
export interface CheckStep {
  name: string;
  duration_s: number;
  result: string;
}

/** The `host load at end` line of `checks/laravel.sh`; a value is null where the script printed `unknown`. */
export interface CheckLoad {
  '1m': number | null;
  '5m': number | null;
  '15m': number | null;
  cpus: number | null;
}

const STEP_LINE = /^\s+(.+?)\s{2,}(?:(\d+)m )?(\d+)s\s{2,}(\S.*?)\s*$/;
const LOAD_LINE = /^host load at end \(1\/5\/15 min\): (.+?), (\S+) CPUs\s*$/m;

/** Reads the `steps:` block and the `host load at end` line from a check's output; both are optional. */
export function parseCheckSteps(output: string): { steps?: CheckStep[]; load?: CheckLoad } {
  const result: { steps?: CheckStep[]; load?: CheckLoad } = {};
  const lines = output.split('\n');
  const at = lines.findIndex((line) => line.trim() === 'steps:' && !line.startsWith(' '));
  if (at >= 0) {
    const steps: CheckStep[] = [];
    for (const line of lines.slice(at + 1)) {
      const match = STEP_LINE.exec(line);
      if (match === null) break;
      steps.push({ name: match[1] as string, duration_s: Number(match[2] ?? 0) * 60 + Number(match[3]), result: match[4] as string });
    }
    if (steps.length > 0) result.steps = steps;
  }
  const load = LOAD_LINE.exec(output);
  if (load !== null) {
    const num = (text: string | undefined): number | null => (text !== undefined && /^\d+(\.\d+)?$/.test(text) ? Number(text) : null);
    const [one, five, fifteen] = (load[1] as string).split(/\s+/);
    result.load = { '1m': num(one), '5m': num(five), '15m': num(fifteen), cpus: num(load[2]) };
  }
  return result;
}

/** The end of a passed check's output: from the `host load at end` / `steps:` lines on, at most the limit; else the plain end. */
export function passedOutput(output: string): string {
  const text = output.trim();
  const starts = [/^host load at end /m, /^steps:\s*$/m].map((pattern) => pattern.exec(text)?.index ?? -1).filter((index) => index >= 0);
  return tail(starts.length === 0 ? text : text.slice(Math.min(...starts)), CHECK_PASSED_OUTPUT_LIMIT);
}

/** A check's state in a {@link GateRun}: not started yet, running, or its {@link CheckRecord} result. */
export type GateCheckStatus = 'pending' | 'running' | CheckRecord['result'];

/** One check of a column's entry gate, for the issue detail. */
export interface GateCheck {
  name: string | null;
  status: GateCheckStatus;
  /** When it started; null while pending and for a cached result. */
  startedAt: Date | null;
  /** Null while pending; for a cached result the duration of the original run. */
  durationMs: number | null;
  timeoutMs: number;
  /** The result was reused from an earlier run on the same commit. */
  cached: boolean;
  exitCode: number | null;
  /** The end of the output as the agent receives it; for a passed or skipped check only its short end (`passed` limit). */
  output: string | null;
}

/** The entry gate of one move: every check of the column with its state. Reported on each change. */
export interface GateRun {
  target: string;
  role: string;
  sha: string | null;
  startedAt: Date;
  /** Null while the gate runs. */
  finishedAt: Date | null;
  checks: GateCheck[];
}

/** A named check's state for the tracker (a GitHub commit status `symphony/<name>`). */
export interface CheckStatusReport {
  name: string;
  sha: string;
  state: 'pending' | 'success' | 'failure' | 'error';
  description: string;
}

export interface GuardParams {
  /** The run's role; null = the implicit `default` role. */
  role: RoleConfig | null;
  config: Pick<ServiceConfig, 'tracker' | 'roles' | 'checks'>;
  /** Where entry checks run; null = none at hand, so a move that needs a check is a `check_error`. */
  workspace: Workspace | null;
  /** Current issue facts for the check environment. */
  issue: () => HookIssue;
  manager: Pick<WorkspaceManager, 'runScript'>;
  /** The worker's signal: aborting it kills a running check's process group. */
  signal: AbortSignal;
  /** Passing results to reuse; omitted = no caching. Lives as long as the claim, in memory only. */
  cache?: CheckCache;
  /** Extra check variables from a workspace integration, when one is available. */
  checkEnv?: () => Promise<Record<string, string>>;
  onEvent?: (event: string, message: string, detail: Record<string, unknown>) => void;
  /** Workspace commit for check events; null when unknown. */
  headSha?: () => Promise<string | null>;
  /** Runs a check; the worker uses it to switch to the RunningChecks phase for the check's duration. */
  whileChecking?: <T>(run: () => Promise<T>) => Promise<T>;
  onCheckFinished?: (check: CheckRecord) => void;
  /** Called with a copy of the gate's state on each change (checks pending, running, finished). */
  onGateUpdate?: (gate: GateRun) => void;
  onDenied?: (target: string, message: string) => void;
  /** Reports named checks with a known commit (`checks.report_status`); a failure is logged, never decides. */
  reportStatus?: (report: CheckStatusReport) => Promise<void>;
  /** Delay before a named check reports `pending`; default {@link PENDING_STATUS_DELAY_MS}. */
  pendingDelayMs?: number;
}

/** Columns the role may move to, or null when unrestricted (no `roles`, or no `may_move_to`). */
function allowedTargets(params: GuardParams): string[] | null {
  if (params.config.roles === null || params.role === null || params.role.mayMoveTo === null) return null;
  return params.role.mayMoveTo.filter((column) => !isTerminalState(column, params.config.tracker));
}

function describeAllowed(params: GuardParams, allowed: string[] | null): string {
  if (allowed === null) {
    const terminal = params.config.tracker.terminalStates.map((s) => `"${s}"`).join(', ');
    return `any column except the terminal ones (${terminal})`;
  }
  return allowed.length === 0 ? 'none' : allowed.map((s) => `"${s}"`).join(', ');
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

/** HEAD of a clean working tree; null (never cached) when it is dirty or git fails. */
async function cleanHead(cwd: string): Promise<string | null> {
  try {
    const [head, status] = await Promise.all([git(cwd, ['rev-parse', 'HEAD']), git(cwd, ['status', '--porcelain'])]);
    const sha = head.trim();
    return sha === '' || status.trim() !== '' ? null : sha;
  } catch {
    return null;
  }
}

/** `<HEAD sha>:<check hash>`: a pass is reused only for the same commit and the same check. */
function cacheKey(sha: string, check: EntryCheck): string {
  const identity = check.name === null ? check.command : `${check.name}\u0000${check.command}`;
  return `${sha}:${createHash('sha256').update(identity).digest('hex')}`;
}

/** How a check is named in messages: `"In review"`, or `"ci" for "In review"`. */
function checkLabel(target: string, check: Pick<EntryCheck, 'name'>): string {
  return check.name === null ? `"${target}"` : `"${check.name}" for "${target}"`;
}

function seconds(ms: number): string {
  const total = Math.round(ms / 1000);
  return total >= 60 ? `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s` : `${total}s`;
}

/** The status a finished named check reports; null for a skipped one (no status at all). */
function finalStatus(record: CheckRecord): Pick<CheckStatusReport, 'state' | 'description'> | null {
  const took = seconds(record.durationMs);
  switch (record.result) {
    case 'passed':
      return { state: 'success', description: `passed in ${took}` };
    case 'skipped':
      return null;
    case 'check_failed':
      return { state: 'failure', description: `failed (exit ${record.exitCode}) in ${took}, details on Symphony` };
    case 'check_timeout':
      return { state: 'error', description: `timed out after ${took}` };
    default:
      return { state: 'error', description: `could not run properly (exit ${record.exitCode ?? 'none'})` };
  }
}

/** A broken check environment: `set_status` moves the issue to Blocked; other tools (`report_result`) end the turn. */
function checkError(label: string, why: string, tool: string, output = ''): GuardDecision {
  const next = tool === STATUS_TOOL ? 'move the issue to Blocked' : `end your turn without calling ${tool} again`;
  const shown = output === '' ? '' : `\n\nThe end of its output:\n\n${output}\n\n`;
  return {
    allow: false,
    category: 'check_error',
    message:
      `The entry check for ${label} could not run properly (${why}).${shown === '' ? ' ' : shown}This is not a problem with your change: ` +
      `do not change code; describe the problem${shown === '' ? '' : ' (quote the output)'} in an issue comment and ${next}.`,
  };
}

/** A check that ran into `checks.timeout_ms`: a runtime limit, so the issue stays in its column instead of Blocked. */
function checkTimeout(label: string, durationMs: number, tool: string): GuardDecision {
  return {
    allow: false,
    category: 'check_timeout',
    message:
      `The entry check for ${label} timed out after ${Math.round(durationMs / 1000)}s (checks.timeout_ms), so the issue ` +
      'was not moved. This is a runtime limit, not a problem with your change: do not change code and do not move the ' +
      `issue to Blocked. Call ${tool} again once; if it times out again, post a short issue comment and end your turn ` +
      'without changing the status. Symphony picks the issue up again later.',
  };
}

function checkOutput(result: HookResult, limit: number = CHECK_OUTPUT_LIMIT): string {
  return tail(result.output.trim(), limit);
}

/** Header of one failed check in the combined output of several (`== ci: failed (exit 1, 6m12s) ==`). */
const SECTION_HEADER = /^== .+ ==$/m;

/**
 * Shortens check output to `limit` characters, keeping the end of the output (where the failure is). Output of
 * several failed checks keeps every section: each keeps its header and an equal share of the end of its own output.
 */
export function fitCheckOutput(output: string, limit: number): string {
  const starts = [...output.matchAll(new RegExp(SECTION_HEADER.source, 'gm'))].map((match) => match.index ?? 0);
  if (starts.length < 2 || starts[0] !== 0) return tail(output, limit);
  const sections = starts.map((start, index) => output.slice(start, starts[index + 1] ?? output.length).trim());
  const share = Math.floor((limit - 2 * (sections.length - 1)) / sections.length);
  return sections
    .map((section) => {
      const newline = section.indexOf('\n');
      const header = newline === -1 ? section : section.slice(0, newline);
      const body = newline === -1 ? '' : section.slice(newline + 1);
      return body === '' ? header : `${header}\n${tail(body, Math.max(0, share - header.length - 1))}`;
    })
    .join('\n\n');
}

/** The end of a broken check's output, so the agent can name the problem in its comment. */
const ERROR_OUTPUT_LIMIT = 1500;

function failedMessage(label: string, output: string, tool: string): string {
  return `The entry check for ${label} failed, so the issue was not moved.\n\n${output === '' ? '(no output)' : output}\n\nFix the problems and call ${tool} again.`;
}

function decide(label: string, result: HookResult, tool: string): GuardDecision {
  if (result.ok && result.exitCode === 0) return { allow: true, note: CHECK_PASSED_NOTE };
  if (result.timedOut) return checkTimeout(label, result.durationMs, tool);
  const clean = !result.timedOut && result.error === null && result.signal === null;
  if (clean && result.exitCode === CHECK_SKIPPED_EXIT) return { allow: true, note: CHECK_PASSED_NOTE };
  if (clean && result.exitCode === 1) return { allow: false, category: 'check_failed', message: failedMessage(label, checkOutput(result), tool) };
  return checkError(label, describeFailure({ ...result, output: '' }), tool, checkOutput(result, ERROR_OUTPUT_LIMIT));
}

/** The `checks.on_enter` checks a move of `role` to `target` runs; empty when none does (none set, or `run_checks: false`). */
export function entryChecksFor(target: string, role: RoleConfig | null, config: Pick<ServiceConfig, 'checks'>): readonly EntryCheck[] {
  if (role?.runChecks === false) return [];
  return config.checks.onEnter.get(normalizeStateName(target)) ?? [];
}

/** One record for several checks of a column: the first failure decides, durations add up. */
function summarize(target: string, records: readonly CheckRecord[]): CheckRecord {
  const failed = records.find((record) => !record.ok);
  const last = records[records.length - 1] as CheckRecord;
  return {
    target,
    name: null,
    role: last.role,
    sha: last.sha,
    exitCode: failed?.exitCode ?? 0,
    timedOut: records.some((record) => record.timedOut),
    durationMs: records.reduce((sum, record) => sum + record.durationMs, 0),
    ok: failed === undefined,
    result: failed?.result ?? (records.every((record) => record.result === 'skipped') ? 'skipped' : 'passed'),
    finishedAt: last.finishedAt,
  };
}

/**
 * The transition guard for one session (docs/configuration.md#checks): denies terminal targets and targets outside
 * the role's `may_move_to`, then runs the target's `checks.on_enter` script. Runs one decision at a time.
 */
export function createGuard(params: GuardParams): TransitionGuard {
  const queue = new SerialQueue();
  const emit = params.onEvent ?? (() => undefined);
  const role = roleName(params.role);
  const publish = (gate: GateRun): void => params.onGateUpdate?.({ ...gate, checks: gate.checks.map((c) => ({ ...c })) });

  const evaluate = async (target: string, tool: string): Promise<GuardDecision> => {
    const allowed = allowedTargets(params);
    const key = normalizeStateName(target);
    const terminal = isTerminalState(target, params.config.tracker);
    if (terminal || (allowed !== null && !allowed.some((column) => normalizeStateName(column) === key))) {
      const why = terminal ? `"${target}" is a terminal column; only a human moves issues there` : `role ${role} may not move issues to "${target}"`;
      const message = `${why}. Allowed targets: ${describeAllowed(params, allowed)}.`;
      emit('transition_denied', `${tool} to ${target} denied`, { target, role });
      params.onDenied?.(target, message);
      return { allow: false, category: 'transition_denied', message };
    }

    const checks = params.config.checks.onEnter.get(key) ?? [];
    if (checks.length === 0) return { allow: true, note: null };
    if (params.role?.runChecks === false) {
      emit('checks_skipped', `entry check for ${target} skipped (roles.${role}.run_checks is false)`, { target, role });
      return { allow: true, note: null };
    }

    const workspace = params.workspace;
    if (workspace === null) return checkError(`"${target}"`, 'there is no workspace to run it in', tool);

    const clean = params.cache !== undefined ? await cleanHead(workspace.path) : null;
    // Everything cached: no RunningChecks phase, as before for a single script.
    const cachedAll = clean !== null ? checks.map((check) => params.cache?.get(cacheKey(clean, check))) : [];
    if (clean !== null && cachedAll.every((record) => record !== undefined)) {
      for (const [index, check] of checks.entries()) {
        emit('checks_cached', `entry check for ${checkLabel(target, check).replaceAll('"', '')} reused (${clean})`, { target, role, sha: clean, name: check.name });
        await report(check, cachedAll[index] as CheckRecord);
      }
      const records = cachedAll as CheckRecord[];
      const now = new Date();
      publish({
        target,
        role,
        sha: clean,
        startedAt: now,
        finishedAt: now,
        checks: checks.map((check, index) => {
          const cached = records[index] as CheckRecord;
          return { name: check.name, status: cached.result, startedAt: null, durationMs: cached.durationMs, timeoutMs: check.timeoutMs, cached: true, exitCode: cached.exitCode, output: cached.output ?? null };
        }),
      });
      return { allow: true, note: `cached result for ${clean}`, check: records.length === 1 ? (records[0] as CheckRecord) : summarize(target, records) };
    }

    const whileChecking = params.whileChecking ?? ((run) => run());
    return whileChecking(async () => {
      const sha = clean ?? (params.headSha !== undefined ? await params.headSha() : null);
      const extra = params.checkEnv !== undefined ? await params.checkEnv() : {};
      const gate: GateRun = {
        target,
        role,
        sha,
        startedAt: new Date(),
        finishedAt: null,
        checks: checks.map((check) => ({ name: check.name, status: 'pending', startedAt: null, durationMs: null, timeoutMs: check.timeoutMs, cached: false, exitCode: null, output: null })),
      };
      publish(gate);
      try {
        return await runGate(gate, checks, workspace, sha, clean, extra, tool);
      } finally {
        // An exception while a check runs leaves it `running`: it did not finish properly.
        for (const entry of gate.checks) if (entry.status === 'running') entry.status = 'check_error';
        gate.finishedAt ??= new Date();
        publish(gate);
      }
    });
  };

  const runGate = async (
    gate: GateRun,
    checks: readonly EntryCheck[],
    workspace: Workspace,
    sha: string | null,
    clean: string | null,
    extra: Record<string, string>,
    tool: string,
  ): Promise<GuardDecision> => {
    const target = gate.target;
    {
      const records: CheckRecord[] = [];
      const failures: Array<{ index: number; check: EntryCheck; record: CheckRecord; result: HookResult }> = [];
      for (const [index, check] of checks.entries()) {
        const entry = gate.checks[index] as GateCheck;
        const label = checkLabel(target, check);
        const reused = clean !== null ? params.cache?.get(cacheKey(clean, check)) : undefined;
        if (reused !== undefined) {
          emit('checks_cached', `entry check for ${label.replaceAll('"', '')} reused (${clean})`, { target, role, sha: clean, name: check.name });
          entry.status = reused.result;
          entry.cached = true;
          entry.durationMs = reused.durationMs;
          entry.exitCode = reused.exitCode;
          if (reused.output !== undefined) entry.output = reused.output;
          publish(gate);
          await report(check, reused);
          records.push(reused);
          continue;
        }
        emit('checks_started', `entry check for ${label.replaceAll('"', '')} started`, { target, role, sha, name: check.name });
        entry.status = 'running';
        entry.startedAt = new Date();
        publish(gate);
        const pending = pendingStatus(check, sha);
        const result = await params.manager.runScript(check.name === null ? `check:${target}` : `check:${target}:${check.name}`, check.command, workspace, params.issue(), {
          signal: params.signal,
          timeoutMs: check.timeoutMs,
          env: { ...extra, SYMPHONY_ROLE: role, SYMPHONY_TARGET_STATE: target, ...(check.name !== null ? { SYMPHONY_CHECK_NAME: check.name } : {}) },
        });
        await pending.settle();
        const decision = decide(label, result, tool);
        const skipped = decision.allow && result.exitCode === CHECK_SKIPPED_EXIT;
        const record: CheckRecord = {
          target,
          name: check.name,
          role,
          sha,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          ok: decision.allow,
          result: skipped ? 'skipped' : decision.allow ? 'passed' : (decision.category as CheckRecord['result']),
          finishedAt: new Date(),
        };
        if (record.ok) {
          const kept = passedOutput(result.output);
          if (kept !== '') {
            record.output = kept;
            entry.output = kept;
          }
        }
        Object.assign(record, parseCheckSteps(result.output));
        entry.status = record.result;
        entry.durationMs = record.durationMs;
        entry.exitCode = record.exitCode;
        if (record.result === 'check_failed') entry.output = checkOutput(result);
        else if (record.result === 'check_timeout') {
          const tail = checkOutput(result);
          if (tail !== '') entry.output = tail;
        } else if (record.result === 'check_error') entry.output = checkOutput(result, ERROR_OUTPUT_LIMIT);
        publish(gate);
        emit('checks_finished', `entry check for ${label.replaceAll('"', '')} ${record.result}`, {
          target,
          role,
          sha,
          name: check.name,
          ok: record.ok,
          exit_code: record.exitCode,
          timed_out: record.timedOut,
          duration_ms: record.durationMs,
          steps: record.steps,
          load: record.load,
        });
        params.onCheckFinished?.(record);
        await report(check, record, pending.posted());
        records.push(record);
        if (decision.allow) {
          if (clean !== null) params.cache?.set(cacheKey(clean, check), record);
          continue;
        }
        if (decision.category !== 'check_failed') return decision;
        failures.push({ index, check, record, result });
      }
      const summary = records.length === 1 ? (records[0] as CheckRecord) : summarize(target, records);
      gate.finishedAt = new Date();
      if (failures.length === 0) {
        publish(gate);
        return { allow: true, note: CHECK_PASSED_NOTE, check: summary };
      }
      // Every failure in one answer: a send-back round costs far more than running the remaining checks.
      const share = Math.floor(CHECK_OUTPUT_LIMIT / failures.length);
      if (failures.length > 1 || checks.length > 1) for (const { index, result } of failures) (gate.checks[index] as GateCheck).output = checkOutput(result, share);
      publish(gate);
      const output =
        failures.length === 1 && checks.length === 1
          ? checkOutput((failures[0] as (typeof failures)[number]).result)
          : failures
              .map(({ check, record, result }) => {
                const body = checkOutput(result, share);
                return `== ${check.name ?? 'check'}: failed (exit ${record.exitCode}, ${seconds(record.durationMs)}) ==\n${body === '' ? '(no output)' : body}`;
              })
              .join('\n\n');
      const label = failures.length === 1 ? checkLabel(target, (failures[0] as (typeof failures)[number]).check) : `"${target}" (${failures.map((f) => f.check.name ?? 'check').join(', ')})`;
      return { allow: false, category: 'check_failed', message: failedMessage(label, output, tool), failed: { output, check: summary } };
    }
  };

  /** Starts the delayed `pending` status of a named check; `settle` cancels it or waits until it is posted. */
  function pendingStatus(check: EntryCheck, sha: string | null): { settle(): Promise<void>; posted(): boolean } {
    if (params.reportStatus === undefined || check.name === null || sha === null) return { settle: async () => undefined, posted: () => false };
    const reportStatus = params.reportStatus;
    const name = check.name;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sent: Promise<void> | null = null;
    timer = setTimeout(() => {
      timer = null;
      sent = deliver(reportStatus, { name, sha, state: 'pending', description: 'running in Symphony' });
    }, params.pendingDelayMs ?? PENDING_STATUS_DELAY_MS);
    return {
      settle: async () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        await sent;
      },
      posted: () => sent !== null,
    };
  }

  /** The final status of a named check (a cached pass reports success again: idempotent, repairs a lost post). */
  async function report(check: EntryCheck, record: CheckRecord, pendingPosted = false): Promise<void> {
    if (params.reportStatus === undefined || check.name === null || record.sha === null) return;
    const status = finalStatus(record);
    if (status === null) {
      // A skipped check leaves no status, unless its pending one went out already.
      if (pendingPosted) await deliver(params.reportStatus, { name: check.name, sha: record.sha, state: 'success', description: 'not configured for this repository' });
      return;
    }
    await deliver(params.reportStatus, { name: check.name, sha: record.sha, ...status });
  }

  async function deliver(reportStatus: NonNullable<GuardParams['reportStatus']>, report: CheckStatusReport): Promise<void> {
    try {
      await reportStatus(report);
    } catch (error) {
      emit('check_status_failed', `status symphony/${report.name} (${report.state}) could not be reported: ${errorMessage(error)}`, { name: report.name, sha: report.sha, state: report.state });
    }
  }

  return (target, tool = STATUS_TOOL) =>
    queue.run(async () => {
      try {
        return await evaluate(target, tool);
      } catch (error) {
        return checkError(`"${target}"`, errorMessage(error), tool);
      }
    });
}

/**
 * The tools a session of `role` on `issue` may use: tools that create sub-issues only for a role with `max_sub_issues`,
 * and for a role that reports a design only on an issue it may split into work packages (`subIssueLimit`). A role with
 * `result` hands off through `resultTool` (`report_result`, see `createResultTool`) instead of the adapter's tools that
 * move the issue to a column the agent names (`set_status`); it never gets those, with or without `resultTool`.
 */
export function toolsForRole(
  specs: AgentToolSpec[],
  role: RoleConfig | null,
  issue: Pick<Issue, 'labels' | 'native_ref'>,
  resultTool: AgentToolSpec | null = null,
): AgentToolSpec[] {
  const subIssues = subIssueLimit(role, issue) !== null;
  const reportsResult = role?.result != null;
  const allowed = specs.filter((spec) => (subIssues || spec.createsSubIssues !== true) && !(reportsResult && spec.transitionTarget !== undefined));
  return reportsResult && resultTool !== null ? [...allowed, resultTool] : allowed;
}

/** Adds the guard's note to a tool's data; a note of the tool's own (`report_result`) wins. */
function withNote(data: unknown, note: string): unknown {
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) return 'note' in data ? data : { ...data, note };
  return { result: data, note };
}

/**
 * Wraps every spec with `transitionTarget` so a denied transition never reaches the tracker. A call the tool's `precheck`
 * refuses stops before the guard (no entry check runs). An allowed call gets the move in `context.transition`; a call
 * without a target never does, so a tool can rely on it as proof of the guard.
 */
export function guardTools(specs: AgentToolSpec[], guard: TransitionGuard): AgentToolSpec[] {
  return specs.map((spec) => {
    const transitionTarget = spec.transitionTarget;
    if (transitionTarget === undefined) return spec;
    return {
      ...spec,
      execute: async (args, { transition: _unchecked, ...context }): Promise<ToolResult> => {
        const target = await transitionTarget(args);
        if (target === null) return spec.execute(args, context);
        const refused = await spec.precheck?.(args, context);
        if (refused !== undefined && refused !== null) return refused;
        let decision = await guard(target, spec.name);
        let moved = target;
        let checkFailed: AllowedTransition['checkFailed'];
        if (!decision.allow && decision.failed !== undefined) {
          // The entry check failed for a tool that has another column for this case (`on_check_failed`): the same
          // guard decides about that column, so `may_move_to` and its own entry check still apply.
          const fallback = spec.checkFailedTarget?.(args) ?? null;
          if (fallback !== null && normalizeStateName(fallback) !== normalizeStateName(target)) {
            const failed = decision.failed;
            decision = await guard(fallback, spec.name);
            moved = fallback;
            checkFailed = { target, output: failed.output, check: checkSummary(failed.check) };
          }
        }
        if (!decision.allow) return { ok: false, error: { category: decision.category, message: decision.message } };
        const check = decision.check !== undefined ? checkSummary(decision.check) : null;
        const result = await spec.execute(args, { ...context, transition: { target: moved, check, ...(checkFailed !== undefined ? { checkFailed } : {}) } });
        return result.ok && decision.note !== null ? { ok: true, data: withNote(result.data, decision.note) } : result;
      },
    };
  });
}
