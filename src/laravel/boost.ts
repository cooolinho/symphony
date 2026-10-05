import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SessionExtensions, StdioServer } from '../agent/types.ts';
import type { Logger } from '../log.ts';
import { errorMessage } from '../util/errors.ts';
import { tail, truncate } from '../util/text.ts';
import { runProcess } from '../workspace/hooks.ts';
import { detectLaravelApps, type LaravelApp } from './detect.ts';
import type { LaravelConfig } from './integration.ts';

const execFileAsync = promisify(execFile);

/** Bump when the generation steps change, so existing workspaces regenerate once. */
const STEP_VERSION = 1;
const STATE_FILE = 'laravel-boost.json';
const EXCLUDE_BEGIN = '# >>> symphony laravel-boost (generated files, kept out of commits)';
const EXCLUDE_END = '# <<< symphony laravel-boost';
const GUIDELINES_PATTERN = /<laravel-boost-guidelines>[\s\S]*?<\/laravel-boost-guidelines>/;
/** Larger guideline blocks go to a file the prompt points to. */
const INLINE_GUIDELINES_LIMIT = 48_000;
const LOG_OUTPUT_LIMIT = 2_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/**
 * Boost tools that run without asking: they read the application, its logs and its database
 * (database-query enforces read-only), or query Laravel's documentation service (search-docs).
 * Tools added by later Boost versions are not listed on purpose: they fall through to the
 * permission mode, which denies by default.
 */
const BOOST_READ_TOOLS: readonly string[] = [
  'application-info',
  'browser-logs',
  'database-connections',
  'database-query',
  'database-schema',
  'get-absolute-url',
  'last-error',
  'read-log-entries',
  'search-docs',
];

export interface PrepareBoostParams {
  /** The repository checkout the agent works in. */
  workspacePath: string;
  config: LaravelConfig;
  /** Base environment for composer and php, already stripped of tracker secrets. */
  env: NodeJS.ProcessEnv;
  logger: Logger;
  signal: AbortSignal;
}

/** What Symphony remembers per app between attempts, inside the git directory. */
interface AppState {
  fingerprint: string;
  lockHash: string;
  /** Repository-relative files excluded via info/exclude. */
  excluded: string[];
  /** Guideline file (repository-relative) the block came from, and the block. */
  guidelinesFile: string | null;
  guidelines: string | null;
}

interface State {
  apps: Record<string, AppState>;
}

interface Git {
  top: string;
  gitDir: string;
  run(args: string[]): Promise<string>;
}

/** One `git status --porcelain=v1 -z` entry: XY code by path. */
type StatusMap = Map<string, string>;

interface PreparedApp {
  app: LaravelApp;
  guidelinesFile: string | null;
  guidelines: string | null;
  /** The guideline file is the root CLAUDE.md with the block, which Claude Code loads by itself. */
  guidelinesLoaded: boolean;
  selfManaged: boolean;
  /** Repository-relative files Symphony generated and keeps out of commits. */
  excluded: string[];
}

/**
 * Prepares Laravel Boost for every Laravel app in the workspace that requires laravel/boost:
 * installs Composer dependencies, generates Boost's guidelines and skills for Claude Code, keeps
 * the generated files out of commits, and returns the MCP servers and prompt context for the
 * session. Never throws: problems are logged and the session runs without (that part of) Boost.
 */
export async function prepareLaravelBoost(params: PrepareBoostParams): Promise<SessionExtensions | null> {
  const { config, logger } = params;
  if (config.boost === 'off') return null;
  try {
    const apps = await detectLaravelApps(params.workspacePath);
    for (const app of apps.filter((candidate) => !candidate.boost)) {
      logger.info('Laravel app without Laravel Boost; add it with "npm run repo-init" (Laravel Boost)', { app: appLabel(app) });
    }
    const boostApps = apps.filter((app) => app.boost);
    if (boostApps.length === 0) return null;

    const git = await openGit(params.workspacePath, params.env);
    if (git === null) {
      logger.warn('Laravel Boost skipped: the workspace is not a git checkout, so generated files cannot be kept out of commits');
      return null;
    }
    const state = await readState(git);
    const prepared: PreparedApp[] = [];
    for (const app of boostApps) {
      if (params.signal.aborted) break;
      const result = await prepareApp(app, git, state, params);
      if (result !== null) prepared.push(result);
    }
    // Even after an abort: whatever Boost wrote must stay out of commits.
    await writeState(git, state);
    await writeExclude(git, Object.values(state.apps).flatMap((entry) => entry.excluded));
    if (prepared.length === 0 || params.signal.aborted) return null;
    return await buildExtensions(prepared, git, params);
  } catch (error) {
    logger.warn('Laravel Boost preparation failed; the session runs without Boost', { error: errorMessage(error) });
    return null;
  }
}

/** Versions of the configured php and composer, or null when they do not run (dry run). */
export async function probeLaravelTools(config: LaravelConfig, env: NodeJS.ProcessEnv): Promise<{ php: string | null; composer: string | null }> {
  const probe = async (command: string, args: string[], marker: RegExp) => {
    const result = await runProcess(command, args, { cwd: process.cwd(), env: { ...env, ...config.env }, timeoutMs: 10_000 });
    // Composer may print notices around its version line.
    const line = result.output.split('\n').map((candidate) => candidate.trim()).find((candidate) => marker.test(candidate));
    return result.ok && line !== undefined ? truncate(line, 80) : null;
  };
  const [php, composer] = await Promise.all([
    probe(config.php, ['-r', 'echo "PHP " . PHP_VERSION;'], /^PHP \d/),
    probe(config.composer, ['--version', '--no-ansi'], /^Composer (version )?\d/),
  ]);
  return { php, composer };
}

async function prepareApp(app: LaravelApp, git: Git, state: State, params: PrepareBoostParams): Promise<PreparedApp | null> {
  const { config, logger } = params;
  const log = logger.child({ laravel_app: appLabel(app) });
  const relative = (name: string) => repoPath(git, path.join(app.path, name));
  const previous = state.apps[app.dir];
  const lockHash = await hashFile(path.join(app.path, 'composer.lock'));

  const vendorReady = await exists(path.join(app.path, 'vendor', 'autoload.php'));
  // A lock file that changed since Symphony last installed means vendor/ is stale.
  const lockChanged = previous !== undefined && previous.lockHash !== lockHash;
  if (!vendorReady || lockChanged) {
    if (!config.installDependencies) {
      if (!vendorReady) {
        log.warn('Laravel Boost skipped: vendor/ is missing and laravel.install_dependencies is off');
        return null;
      }
    } else {
      log.info('installing Composer dependencies', { reason: vendorReady ? 'composer.lock changed' : 'vendor/ missing' });
      const install = await runStep(config.composer, ['install', '--no-interaction', '--no-progress'], app, params);
      if (!install.ok) {
        log.warn('Laravel Boost skipped: composer install failed', install.detail);
        return null;
      }
    }
  }
  if (!(await exists(path.join(app.path, 'vendor', 'laravel', 'boost')))) {
    log.warn('Laravel Boost skipped: laravel/boost is required but not installed in vendor/');
    return null;
  }

  const selfManaged = await isTracked(git, relative('boost.json'));
  if (selfManaged) {
    // The repository commits its Boost files: use them as they are.
    const found = await readGuidelines(app, git);
    state.apps[app.dir] = { fingerprint: 'self-managed', lockHash, excluded: [], ...found };
    log.info('Laravel Boost files are committed in the repository; using them as they are');
    return { app, ...found, guidelinesLoaded: await loadedByClaude(app, found.guidelinesFile, found.guidelines), selfManaged, excluded: [] };
  }

  const fingerprint = await computeFingerprint(app, lockHash, config.php);
  if (previous !== undefined && previous.fingerprint === fingerprint && (await allExist(git, previous.excluded))) {
    log.debug('Laravel Boost files are up to date');
    return {
      app,
      guidelinesFile: previous.guidelinesFile,
      guidelines: previous.guidelines,
      guidelinesLoaded: await loadedByClaude(app, previous.guidelinesFile, previous.guidelines),
      selfManaged,
      excluded: previous.excluded,
    };
  }

  const { ok, ...generated } = await generate(app, git, params, previous?.excluded ?? []);
  if (!ok) {
    // Whatever it wrote stays excluded; the empty fingerprint retries on the next attempt.
    state.apps[app.dir] = { fingerprint: '', lockHash, ...generated };
    return null;
  }
  state.apps[app.dir] = { fingerprint, lockHash, ...generated };
  log.info('Laravel Boost guidelines and skills generated', { excluded_files: generated.excluded.length });
  return {
    app,
    guidelinesFile: generated.guidelinesFile,
    guidelines: generated.guidelines,
    guidelinesLoaded: await loadedByClaude(app, generated.guidelinesFile, generated.guidelines),
    selfManaged,
    excluded: generated.excluded,
  };
}

/**
 * Runs `boost:install` for Claude Code and reconciles git: new untracked files are excluded,
 * tracked files Boost changed are restored (their guideline block is kept for the prompt), and
 * files the agent had already changed keep their exact content.
 */
async function generate(
  app: LaravelApp,
  git: Git,
  params: PrepareBoostParams,
  previouslyExcluded: string[],
): Promise<{ ok: boolean } & Omit<AppState, 'fingerprint' | 'lockHash'>> {
  const { config, logger } = params;
  const log = logger.child({ laravel_app: appLabel(app) });
  const before = await status(git);
  const backups = new Map<string, Buffer | null>();
  for (const [file, code] of before) {
    if (code === '??' || !isInside(git, app.path, file)) continue;
    backups.set(file, await readOrNull(path.join(git.top, file)));
  }

  await writeBoostConfig(path.join(app.path, 'boost.json'));
  const guidelineName = (await exists(path.join(app.path, 'CLAUDE.md'))) ? 'CLAUDE.md' : 'AGENTS.md';
  const install = await runStep(
    config.php,
    [path.join(app.path, 'artisan'), 'boost:install', '--no-interaction', '--guidelines', '--skills'],
    app,
    params,
  );

  const guidelinesFile = repoPath(git, path.join(app.path, guidelineName));
  const generatedContent = await readOrNull(path.join(git.top, guidelinesFile));
  const guidelines = generatedContent === null ? null : extractGuidelines(generatedContent.toString('utf8'));

  const after = await status(git);
  const excluded = new Set(previouslyExcluded);
  const restore: string[] = [];
  for (const [file, code] of after) {
    if (!isInside(git, app.path, file)) continue;
    if (code === '??') {
      if (!before.has(file)) excluded.add(file);
    } else if (!before.has(file)) {
      restore.push(file);
    }
  }
  if (restore.length > 0) await git.run(['checkout', '--', ...restore]);
  for (const [file, content] of backups) {
    const target = path.join(git.top, file);
    const current = await readOrNull(target);
    if (content === null) {
      if (current !== null) await fs.rm(target, { force: true });
    } else if (current === null || !current.equals(content)) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
  }

  // Files Boost removed again (for example skills of a dropped package) leave the list.
  const present: string[] = [];
  for (const file of [...excluded].sort()) if (await exists(path.join(git.top, file))) present.push(file);
  if (!install.ok) {
    log.warn('Laravel Boost skipped: boost:install failed', install.detail);
    return { ok: false, excluded: present, guidelinesFile, guidelines };
  }
  const boostConfig = await readJsonOrNull(path.join(app.path, 'boost.json'));
  if (boostConfig !== null && boostConfig.sail === true) {
    log.warn('Boost detected Laravel Sail: its guidelines tell the agent to use vendor/bin/sail, but Symphony runs PHP on the host');
  }
  if (guidelines === null) log.warn('boost:install wrote no Laravel Boost guidelines', { file: guidelinesFile });
  return { ok: true, excluded: present, guidelinesFile, guidelines };
}

/** The Boost tools that run without asking and the ones removed from the session. */
export function boostToolPolicy(config: LaravelConfig): { autoApprove: string[]; deny: string[] } {
  const deny = [...new Set([...(config.allowTinker ? [] : ['tinker']), ...config.denyTools])];
  return { autoApprove: BOOST_READ_TOOLS.filter((tool) => !deny.includes(tool)), deny };
}

async function buildExtensions(prepared: PreparedApp[], git: Git, params: PrepareBoostParams): Promise<SessionExtensions> {
  const { config } = params;
  const policy = boostToolPolicy(config);
  const mcpServers: Record<string, StdioServer> = {};
  const contextSections: string[] = [];
  const additionalDirectories: string[] = [];
  for (const entry of prepared) {
    const { app } = entry;
    const name = prepared.length === 1 ? 'laravel-boost' : `laravel-boost-${slug(app.dir)}`;
    mcpServers[name] = {
      command: config.php,
      args: [path.join(app.path, 'artisan'), 'boost:mcp'],
      env: { ...config.env, SYMPHONY_WORKSPACE: params.workspacePath },
      autoApprove: [...policy.autoApprove],
      deny: [...policy.deny],
    };
    if (app.dir !== '') additionalDirectories.push(app.path);
    contextSections.push(await contextSection(entry, name, git, config, policy));
  }
  return { mcpServers, contextSections, additionalDirectories, env: { ...config.agentEnv } };
}

/** Skill names of the app: generated `.claude/skills/<name>/` directories, or the committed ones. */
async function skillNames(entry: PreparedApp, git: Git): Promise<string[]> {
  const skillsDir = repoPath(git, path.join(entry.app.path, '.claude', 'skills'));
  const prefix = skillsDir === '' ? '' : `${skillsDir}/`;
  const files = entry.selfManaged ? (await listFiles(path.join(git.top, skillsDir))).map((file) => prefix + file.split(path.sep).join('/')) : entry.excluded;
  const names = new Set<string>();
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const parts = file.slice(prefix.length).split('/');
    if (parts.length >= 2 && parts[0] !== '') names.add(parts[0] as string);
  }
  return [...names].sort();
}

async function contextSection(
  entry: PreparedApp,
  server: string,
  git: Git,
  config: LaravelConfig,
  policy: { autoApprove: string[]; deny: string[] },
): Promise<string> {
  const { app } = entry;
  const where = app.dir === '' ? 'the repository root' : `\`${app.dir}/\``;
  const list = (tools: string[]) => tools.map((tool) => `\`${tool}\``).join(', ');
  const lines = [
    `# Laravel Boost (${app.dir === '' ? 'repository root' : `${app.dir}/`})`,
    `This workspace contains a Laravel application at ${where} with Laravel Boost.`,
    `- Run Artisan and Composer from that directory: \`${config.php} artisan …\`, \`${config.composer} …\`.`,
    `- The \`${server}\` MCP server (tools \`mcp__${server}__*\`) inspects this application.` +
      (policy.autoApprove.length === 0 ? '' : ` Pre-approved tools: ${list(policy.autoApprove)}.`) +
      (policy.deny.length === 0 ? '' : ` Not available in this session: ${list(policy.deny)}.`) +
      ' Other Boost tools need approval and are denied by default.',
  ];
  if (policy.autoApprove.includes('search-docs')) {
    lines.push('- Use `search-docs` before writing code that depends on Laravel ecosystem APIs or versions.');
  }
  const skills = await skillNames(entry, git);
  if (skills.length > 0) {
    lines.push(`- Boost's skills for this app's packages are available: ${list(skills)}. Use the matching skill when the task touches its area.`);
  }
  if (entry.selfManaged) {
    lines.push('- This repository commits its Boost files. Regenerate them only if the issue asks for it.');
  } else {
    lines.push(
      '- Symphony generated Boost guidelines, skills and boost.json for this workspace; git ignores them locally. ' +
        'Do not edit or commit them. Project guidance belongs in `.ai/guidelines/`, project skills in `.ai/skills/`.',
    );
  }
  if (!policy.deny.includes('record-rule')) {
    lines.push('- If you record project rules with the `record-rule` tool, commit the `.ai/rules` changes with your work.');
  }

  if (entry.guidelines !== null && !entry.guidelinesLoaded) {
    if (entry.guidelines.length <= INLINE_GUIDELINES_LIMIT) {
      lines.push('', `## Laravel Boost guidelines${entry.guidelinesFile !== null ? ` (from ${entry.guidelinesFile})` : ''}`, '', entry.guidelines);
    } else {
      const file = path.join(git.gitDir, 'symphony', `laravel-boost-guidelines-${slug(app.dir)}.md`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, entry.guidelines);
      lines.push(`- Read Laravel Boost's guidelines before you start: ${file}`);
    }
  }
  return lines.join('\n');
}

/** Reads the Boost block from a committed guideline file (CLAUDE.md first, as Boost does). */
async function readGuidelines(app: LaravelApp, git: Git): Promise<{ guidelinesFile: string | null; guidelines: string | null }> {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const content = await readOrNull(path.join(app.path, name));
    const guidelines = content === null ? null : extractGuidelines(content.toString('utf8'));
    if (guidelines !== null) return { guidelinesFile: repoPath(git, path.join(app.path, name)), guidelines };
  }
  return { guidelinesFile: null, guidelines: null };
}

/** Claude Code loads the root CLAUDE.md itself; only then does the prompt skip the block. */
async function loadedByClaude(app: LaravelApp, file: string | null, guidelines: string | null): Promise<boolean> {
  if (guidelines === null || app.dir !== '' || file !== 'CLAUDE.md') return false;
  const content = await readOrNull(path.join(app.path, 'CLAUDE.md'));
  return content !== null && content.toString('utf8').includes(guidelines);
}

export function extractGuidelines(content: string): string | null {
  return GUIDELINES_PATTERN.exec(content)?.[0] ?? null;
}

/** Targets Claude Code and keeps the MCP guidance without writing Boost's own .mcp.json. */
async function writeBoostConfig(file: string): Promise<void> {
  const current = (await readJsonOrNull(file)) ?? {};
  const agents = Array.isArray(current.agents) ? current.agents.filter((agent): agent is string => typeof agent === 'string') : [];
  if (!agents.includes('claude_code')) agents.push('claude_code');
  await fs.writeFile(file, `${JSON.stringify({ ...current, agents, guidelines: true, mcp: true }, null, 4)}\n`);
}

async function computeFingerprint(app: LaravelApp, lockHash: string, php: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ step: STEP_VERSION, lockHash, php, boost: await boostVersion(app) }));
  for (const file of await listFiles(path.join(app.path, '.ai'))) {
    hash.update(`\0${file}\0`);
    hash.update((await readOrNull(path.join(app.path, '.ai', file))) ?? '');
  }
  return hash.digest('hex');
}

async function boostVersion(app: LaravelApp): Promise<string | null> {
  const installed = await readJsonOrNull(path.join(app.path, 'vendor', 'composer', 'installed.json'));
  const packages = Array.isArray(installed?.packages) ? installed.packages : Array.isArray(installed) ? installed : [];
  for (const entry of packages as unknown[]) {
    if (typeof entry === 'object' && entry !== null && (entry as { name?: unknown }).name === 'laravel/boost') {
      const version = (entry as { version?: unknown }).version;
      return typeof version === 'string' ? version : null;
    }
  }
  return null;
}

async function runStep(
  command: string,
  args: string[],
  app: LaravelApp,
  params: PrepareBoostParams,
): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
  const result = await runProcess(command, args, {
    cwd: app.path,
    env: { ...params.env, ...params.config.env, SYMPHONY_WORKSPACE: params.workspacePath },
    timeoutMs: params.config.timeoutMs,
    signal: params.signal,
  });
  return {
    ok: result.ok,
    detail: {
      command: [command, ...args].join(' '),
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      error: result.error,
      duration_ms: result.durationMs,
      output: tail(result.output, LOG_OUTPUT_LIMIT),
    },
  };
}

/** Git commands are quick and not abortable, so reconciling after an aborted php step always completes. */
async function openGit(cwd: string, env: NodeJS.ProcessEnv): Promise<Git | null> {
  const runIn = async (dir: string, args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, { cwd: dir, env, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' });
    return stdout;
  };
  let top: string;
  let gitDir: string;
  try {
    top = (await runIn(cwd, ['rev-parse', '--show-toplevel'])).trim();
    gitDir = path.resolve(cwd, (await runIn(cwd, ['rev-parse', '--git-dir'])).trim());
  } catch {
    return null;
  }
  // git reports the real path; keep the workspace's own spelling when it is the top level (symlinked roots).
  const root = (await fs.realpath(top)) === (await fs.realpath(cwd)) ? cwd : top;
  return { top: root, gitDir, run: (args) => runIn(root, args) };
}

async function status(git: Git): Promise<StatusMap> {
  const output = await git.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = output.split('\0');
  const map: StatusMap = new Map();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] as string;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    map.set(entry.slice(3), code);
    // Renames and copies carry the source path as the next entry.
    if (/[RC]/.test(code)) index++;
  }
  return map;
}

async function isTracked(git: Git, file: string): Promise<boolean> {
  try {
    await git.run(['ls-files', '--error-unmatch', '--', file]);
    return true;
  } catch {
    return false;
  }
}

async function readState(git: Git): Promise<State> {
  const parsed = await readJsonOrNull(path.join(git.gitDir, 'symphony', STATE_FILE));
  return parsed !== null && typeof parsed.apps === 'object' && parsed.apps !== null ? (parsed as unknown as State) : { apps: {} };
}

async function writeState(git: Git, state: State): Promise<void> {
  const file = path.join(git.gitDir, 'symphony', STATE_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** Rewrites Symphony's block in the repository's info/exclude with exact, anchored paths. */
async function writeExclude(git: Git, files: string[]): Promise<void> {
  const file = path.resolve(git.top, (await git.run(['rev-parse', '--git-path', 'info/exclude'])).trim());
  const current = (await readOrNull(file))?.toString('utf8') ?? '';
  const start = current.indexOf(EXCLUDE_BEGIN);
  const end = current.indexOf(EXCLUDE_END);
  let kept = current;
  if (start !== -1 && end > start) kept = current.slice(0, start) + current.slice(end + EXCLUDE_END.length).replace(/^\n/, '');
  kept = kept.replace(/\n*$/, kept.trim() === '' ? '' : '\n');
  const unique = [...new Set(files)].sort();
  const block = unique.length === 0 ? '' : `${EXCLUDE_BEGIN}\n${unique.map((entry) => `/${escapeGlob(entry)}`).join('\n')}\n${EXCLUDE_END}\n`;
  const next = kept + block;
  if (next === current) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, next);
}

function escapeGlob(file: string): string {
  return file.replace(/[\\*?[\]!#]/g, (char) => `\\${char}`).replace(/ $/, '\\ ');
}

async function allExist(git: Git, files: string[]): Promise<boolean> {
  for (const file of files) if (!(await exists(path.join(git.top, file)))) return false;
  return true;
}

/** Files below `dir`, relative and sorted; empty when it does not exist. */
async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
      .sort();
  } catch {
    return [];
  }
}

function repoPath(git: Git, absolute: string): string {
  return path.relative(git.top, absolute).split(path.sep).join('/');
}

function isInside(git: Git, appPath: string, file: string): boolean {
  const relative = repoPath(git, appPath);
  return relative === '' || file === relative || file.startsWith(`${relative}/`);
}

async function hashFile(file: string): Promise<string> {
  const content = await readOrNull(file);
  return content === null ? '' : createHash('sha256').update(content).digest('hex');
}

async function readOrNull(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

async function readJsonOrNull(file: string): Promise<Record<string, unknown> | null> {
  const content = await readOrNull(file);
  if (content === null) return null;
  try {
    const parsed: unknown = JSON.parse(content.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function appLabel(app: LaravelApp): string {
  return app.dir === '' ? '.' : app.dir;
}

function slug(dir: string): string {
  return dir === '' ? 'root' : dir.replace(/[^A-Za-z0-9_-]/g, '-');
}
