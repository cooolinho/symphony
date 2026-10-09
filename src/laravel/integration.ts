import type { WorkspaceIntegration } from '../integrations/types.ts';
import { errorMessage } from '../util/errors.ts';
import { resolveConfigPath } from '../util/paths.ts';
import { Reader } from '../workflow/reader.ts';
import type { IntegrationReport, IntegrationStatus, SessionExtensions } from '../agent/types.ts';
import { prepareLaravelBoost, probeLaravelTools, type AppBoostStatus } from './boost.ts';
import { detectLaravelApps, type LaravelApp } from './detect.ts';
import { formatVersions, readLaravelFacts, versionFields, type LaravelFacts } from './facts.ts';

export type BoostMode = 'auto' | 'off';

/** Laravel workspaces (the `laravel` section): Laravel Boost for detected Laravel apps. */
export interface LaravelConfig {
  /** auto: use Boost for Laravel apps that require laravel/boost; off: never. */
  boost: BoostMode;
  /** PHP command: a bare name is looked up on PATH, a value with a slash or `~` is a resolved path. */
  php: string;
  /** Composer command, resolved like `php`. */
  composer: string;
  /** Run `composer install` when vendor/ is missing or composer.lock changed since the last install. */
  installDependencies: boolean;
  /** Limit for each php or composer step. */
  timeoutMs: number;
  /** Environment for Symphony's composer and artisan steps and the Boost MCP server; not the agent's shell. */
  env: Record<string, string>;
  /** Variables added to the agent's own environment in Boost sessions. */
  agentEnv: Record<string, string>;
  /** Allow Boost's `tinker` tool (runs arbitrary PHP); denied by default. */
  allowTinker: boolean;
  /** Boost tools removed from the session (and from the pre-approved list). */
  denyTools: string[];
}

const BOOST_MODES: readonly BoostMode[] = ['auto', 'off'];
/** Boost only registers its commands in the local environment (or with debug on); a fresh clone has no .env. */
const LARAVEL_DEFAULT_ENV: Readonly<Record<string, string>> = { APP_ENV: 'local' };
const LARAVEL_DEFAULT_DENY_TOOLS: readonly string[] = ['record-rule'];

export const laravelIntegration: WorkspaceIntegration<LaravelConfig> = {
  id: 'laravel',
  configKey: 'laravel',

  resolveConfig(laravelRaw, ctx) {
    const reader = new Reader();
    const command = (key: 'php' | 'composer'): string => {
      const value = reader.string(laravelRaw, key, `laravel.${key}`)?.trim() || key;
      // Bare names stay PATH lookups; only path-like values are resolved against the workflow directory.
      if (!value.includes('/') && !value.startsWith('~')) return value;
      try {
        return resolveConfigPath(value, ctx.workflowDir, ctx.env, `laravel.${key}`);
      } catch (error) {
        reader.errors.push(errorMessage(error));
        return key;
      }
    };
    const config: LaravelConfig = {
      boost: reader.oneOf(laravelRaw, 'boost', 'laravel.boost', BOOST_MODES, 'auto'),
      php: command('php'),
      composer: command('composer'),
      installDependencies: reader.bool(laravelRaw, 'install_dependencies', 'laravel.install_dependencies', true),
      timeoutMs: reader.int(laravelRaw, 'timeout_ms', 'laravel.timeout_ms', ctx.hookTimeoutMs, 1),
      env: { ...LARAVEL_DEFAULT_ENV, ...reader.stringMap(laravelRaw, 'env', 'laravel.env') },
      agentEnv: reader.stringMap(laravelRaw, 'agent_env', 'laravel.agent_env'),
      allowTinker: reader.bool(laravelRaw, 'allow_tinker', 'laravel.allow_tinker', false),
      denyTools: reader.stringList(laravelRaw, 'deny_tools', 'laravel.deny_tools')?.map((tool) => tool.trim()).filter((tool) => tool !== '') ?? [
        ...LARAVEL_DEFAULT_DENY_TOOLS,
      ],
    };
    return { config, errors: reader.errors, warnings: reader.warnings };
  },

  // Laravel Boost for detected Laravel apps; problems only log warnings.
  async prepare(config, ctx) {
    const { extensions, apps } = await prepareLaravelBoost({
      workspacePath: ctx.workspacePath,
      config,
      env: ctx.env,
      logger: ctx.logger,
      signal: ctx.signal,
    });
    if (apps.length === 0) return extensions;
    const facts = await Promise.all(apps.map((entry) => readLaravelFacts(entry.app.path)));
    ctx.logger.info('integration_prepared', { integration: 'laravel', apps: apps.map((entry, i) => describePrepared(entry, facts[i] as LaravelFacts)).join('; ') });
    const result: SessionExtensions = extensions ?? { mcpServers: {}, contextSections: [], additionalDirectories: [], env: {} };
    // Boost off is the user's choice, not a failure worth a prompt note.
    if (config.boost !== 'off') result.contextSections.push(...apps.flatMap(unavailableNote));
    result.historyFields = historyFields(apps, facts);
    result.reports = [boostReport(config, apps, facts)];
    return result;
  },

  async describe(config, env, workspacePath) {
    if (workspacePath !== null) {
      // Laravel apps in an issue's existing workspace (a new workspace is only cloned when the issue runs).
      const apps = await detectLaravelApps(workspacePath);
      return Promise.all(
        apps.map(async (app) => {
          const versions = formatVersions(await readLaravelFacts(app.path)) ?? 'versions unknown (no composer.lock)';
          return `Laravel app ${displayDir(app)}: ${versions} (${app.boost ? 'requires laravel/boost' : 'no laravel/boost in composer.json'})`;
        }),
      );
    }
    if (config.boost === 'off') return ['Laravel Boost:   off'];
    const tools = await probeLaravelTools(config, env);
    const describe = (command: string, version: string | null) => `${command} (${version ?? 'not found'})`;
    const lines = [`Laravel Boost:   auto, for Laravel apps that require laravel/boost; ${describe(config.php, tools.php)}, ${describe(config.composer, tools.composer)}`];
    if (tools.php === null) lines.push('                 ↳ php does not run: Laravel workspaces start without Boost');
    return lines;
  },
};

function displayDir(app: LaravelApp): string {
  return app.dir === '' ? '(repository root)' : `${app.dir}/`;
}

/** `laravel/ [laravel/framework=v13.1.0 laravel/boost=v2.0.1] boost=ready` for the integration_prepared line. */
function describePrepared(entry: AppBoostStatus, facts: LaravelFacts): string {
  const versions = Object.entries(versionFields(facts)).map(([name, version]) => `${name}=${version}`);
  const reason = entry.reason === null ? '' : ` (${entry.reason})`;
  return `${displayDir(entry.app)} [${versions.join(' ')}] boost=${entry.status}${reason}`;
}

/** The prompt line for an app whose Boost is unavailable: the agent falls back to the shell. */
function unavailableNote(entry: AppBoostStatus): string[] {
  if (entry.status !== 'failed' && entry.status !== 'skipped') return [];
  return [`Laravel Boost is unavailable for \`${displayDir(entry.app)}\` (${entry.reason ?? entry.status}); use artisan and composer in the shell.`];
}

/** Laravel Boost for the dashboard: per app its status, versions, guidelines, skills and MCP server. */
function boostReport(config: LaravelConfig, apps: AppBoostStatus[], facts: LaravelFacts[]): IntegrationReport {
  const parts = apps.map((entry, i) => ({
    name: displayDir(entry.app),
    status: entry.status,
    reason: entry.reason,
    versions: formatVersions(facts[i] as LaravelFacts),
    guidelines: entry.setup?.guidelines ?? null,
    skills: entry.setup?.skills ?? [],
    mcpServer: entry.setup?.server ?? null,
    tools: entry.setup?.tools ?? [],
    warnings: entry.setup?.warnings ?? [],
  }));
  let status: IntegrationStatus = 'absent';
  if (config.boost === 'off') status = 'off';
  else if (apps.some((entry) => entry.status === 'ready')) status = 'ready';
  else if (apps.some((entry) => entry.status === 'failed' || entry.status === 'skipped')) status = 'unavailable';
  return {
    id: 'laravel-boost',
    label: 'Laravel Boost',
    status,
    parts,
    mcpServers: parts.flatMap((part) => (part.mcpServer === null ? [] : [part.mcpServer])),
    skills: [...new Set(parts.flatMap((part) => part.skills))].sort(),
  };
}

/** `laravel=laravel/:v13.1.0 boost=ready`; with several apps every entry is prefixed by its directory. */
function historyFields(apps: AppBoostStatus[], facts: LaravelFacts[]): Record<string, string> {
  const label = (app: LaravelApp) => (app.dir === '' ? '.' : `${app.dir}/`);
  const laravel = apps.map((entry, i) => `${label(entry.app)}:${facts[i]?.packages['laravel/framework'] ?? 'unknown'}`);
  const boost = apps.map((entry) => (apps.length === 1 ? entry.status : `${label(entry.app)}:${entry.status}`));
  return { laravel: laravel.join(','), boost: boost.join(',') };
}
