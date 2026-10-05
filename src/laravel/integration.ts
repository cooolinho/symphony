import type { WorkspaceIntegration } from '../integrations/types.ts';
import { errorMessage } from '../util/errors.ts';
import { resolveConfigPath } from '../util/paths.ts';
import { Reader } from '../workflow/reader.ts';
import { prepareLaravelBoost, probeLaravelTools } from './boost.ts';
import { detectLaravelApps } from './detect.ts';

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
  prepare: (config, ctx) =>
    prepareLaravelBoost({ workspacePath: ctx.workspacePath, config, env: ctx.env, logger: ctx.logger, signal: ctx.signal }),

  async describe(config, env, workspacePath) {
    if (workspacePath !== null) {
      // Laravel apps in an issue's existing workspace (a new workspace is only cloned when the issue runs).
      const apps = await detectLaravelApps(workspacePath);
      return apps.map((app) => `Laravel app ${app.dir === '' ? '(repository root)' : `${app.dir}/`}: ${app.boost ? 'Laravel Boost' : 'no laravel/boost in composer.json'}`);
    }
    if (config.boost === 'off') return ['Laravel Boost:   off'];
    const tools = await probeLaravelTools(config, env);
    const describe = (command: string, version: string | null) => `${command} (${version ?? 'not found'})`;
    const lines = [`Laravel Boost:   auto, for Laravel apps that require laravel/boost; ${describe(config.php, tools.php)}, ${describe(config.composer, tools.composer)}`];
    if (tools.php === null) lines.push('                 ↳ php does not run: Laravel workspaces start without Boost');
    return lines;
  },
};
