import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { childEnvironment } from '../agent/env.ts';
import type { AgentRunner } from '../agent/types.ts';
import { brainToolsFor } from '../brain/tools.ts';
import type { Logger } from '../log.ts';
import type { AgentToolSpec, Issue, ToolResult } from '../tracker/types.ts';
import { SymphonyError, errorMessage } from '../util/errors.ts';
import type { ClaudeConfig, ServiceConfig } from '../workflow/config.ts';
import { compilePrompt, renderPrompt } from '../workflow/template.ts';
import { diagnosisSchema, diagnosisShape, type Diagnosis } from './decide.ts';

/** The prompt file as read for one diagnosis. */
export interface WatchdogPrompt {
  source: string;
  /** First 12 hex digits of its sha256, recorded in the watchdog marker. */
  hash: string;
}

export async function readPrompt(file: string): Promise<WatchdogPrompt> {
  let source: string;
  try {
    source = await fs.readFile(file, 'utf8');
  } catch (error) {
    throw new SymphonyError('watchdog_prompt_missing', `cannot read the watchdog prompt ${file}: ${errorMessage(error)}`, { cause: error });
  }
  return { source, hash: createHash('sha256').update(source).digest('hex').slice(0, 12) };
}

export async function renderWatchdogPrompt(prompt: WatchdogPrompt, scope: Record<string, unknown>): Promise<string> {
  return renderPrompt(compilePrompt(prompt.source), scope);
}

/** Tools the diagnosis session may use besides `report_diagnosis` (and the brain's read tools). */
const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'];
const DENIED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill'];
const MARKER_START = /<!--\s*symphony:/i;

const REMINDER =
  'You have not called `report_diagnosis` yet. Call it now with what you found (use `cause: unknown` and ' +
  '`confidence: low` if you could not find the cause), then end your turn.';

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(category: string, message: string): ToolResult {
  return { ok: false, error: { category, message } };
}

/** The `report_diagnosis` tool; `onReport` receives the first valid diagnosis. */
export function diagnosisTool(onReport: (diagnosis: Diagnosis) => void): AgentToolSpec {
  let reported = false;
  return {
    name: 'report_diagnosis',
    description: 'Reports the diagnosis of the blocked issue: cause, evidence, the finished comment and the column to go back to. Call it once, then end your turn.',
    inputSchema: diagnosisShape,
    mutates: false,
    execute: async (args) => {
      if (reported) return fail('already_reported', 'the diagnosis is already recorded; end your turn now');
      const parsed = diagnosisSchema.safeParse(args);
      if (!parsed.success) return fail('invalid_diagnosis', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
      if (MARKER_START.test(parsed.data.comment)) return fail('invalid_diagnosis', 'the comment contains "<!-- symphony:", which is reserved for Symphony; remove it');
      reported = true;
      onReport(parsed.data);
      return ok({ recorded: true, message: 'Diagnosis recorded — end your turn now.' });
    },
  };
}

export interface DiagnoseParams {
  runner: AgentRunner;
  config: ServiceConfig;
  issue: Issue;
  prompt: string;
  /** The issue's workspace when it exists (read-only), else the watchdog's own scratch directory. */
  cwd: string;
  /** Directories the session may read besides `cwd`: Symphony's state directory. */
  readDirs: string[];
  env: NodeJS.ProcessEnv;
  secretNames: string[];
  transcriptPath: string | null;
  logger: Logger;
  signal: AbortSignal;
}

export interface DiagnoseOutcome {
  diagnosis: Diagnosis | null;
  costUsd: number | null;
  /** Why no diagnosis came back; null with a diagnosis. */
  error: string | null;
}

/** The Claude settings of a diagnosis session: the workflow's, narrowed to read-only tools and the watchdog's model. */
export function watchdogClaudeConfig(config: ServiceConfig): ClaudeConfig {
  const { watchdog, claude } = config;
  return {
    ...claude,
    model: watchdog.model,
    fallbackModel: null,
    effort: watchdog.effort,
    maxBudgetUsd: watchdog.maxBudgetUsd,
    // Only the listed tools run; everything else is refused without asking.
    permissionMode: 'dontAsk',
    onPermissionRequest: 'deny',
    allowedTools: ALLOWED_TOOLS,
    disallowedTools: DENIED_TOOLS,
    byModel: new Map(),
    // The workspace's own settings could allow more tools.
    settingSources: [],
    strictMcpConfig: true,
    plugins: [],
    skills: null,
    appendSystemPrompt: null,
    persistSession: false,
  };
}

/** Runs one diagnosis session; never throws for a failed session, only reports it. */
export async function diagnose(params: DiagnoseParams): Promise<DiagnoseOutcome> {
  let diagnosis: Diagnosis | null = null;
  let costUsd: number | null = null;
  const brainTools = brainToolsFor(params.config.brain, 'read', params.logger);
  let session;
  try {
    session = await params.runner.startSession({
      cwd: path.resolve(params.cwd),
      issue: params.issue,
      config: watchdogClaudeConfig(params.config),
      policy: { readOnly: true },
      tools: [diagnosisTool((reported) => (diagnosis = reported))],
      ...(brainTools.length > 0 ? { brainTools } : {}),
      toolContext: () => ({ issue: params.issue, role: 'watchdog' }),
      env: childEnvironment(params.env, params.secretNames),
      logger: params.logger,
      signal: params.signal,
      onEvent: (event) => {
        if (typeof event.costUsd === 'number') costUsd = event.costUsd;
      },
      transcriptPath: params.transcriptPath,
      extensions: { mcpServers: {}, contextSections: [], additionalDirectories: params.readDirs, env: {} },
    });
  } catch (error) {
    return { diagnosis: null, costUsd, error: `session did not start: ${errorMessage(error)}` };
  }
  try {
    for (let turn = 1; turn <= params.config.watchdog.maxTurns && diagnosis === null; turn++) {
      const result = await session.runTurn(turn === 1 ? params.prompt : REMINDER);
      if (!result.ok) return { diagnosis, costUsd, error: diagnosis === null ? `turn failed (${result.code}): ${result.message}` : null };
    }
  } finally {
    await session.stop();
  }
  return { diagnosis, costUsd, error: diagnosis === null ? `no report_diagnosis after ${params.config.watchdog.maxTurns} turn(s)` : null };
}
