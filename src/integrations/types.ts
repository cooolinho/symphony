import type { SessionExtensions } from '../agent/types.ts';
import type { Logger } from '../log.ts';

export interface IntegrationConfigContext {
  workflowDir: string;
  env: NodeJS.ProcessEnv;
  hookTimeoutMs: number;
}

export interface IntegrationPrepareContext {
  workspacePath: string;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  signal: AbortSignal;
}

/** Project-type support plugged into the generic core (Laravel first); the core never imports a concrete one. */
export interface WorkspaceIntegration<C = unknown> {
  readonly id: string;
  /** Front matter section this integration owns. */
  readonly configKey: string;
  /**
   * Plugin subagents named with this prefix (`laravel-`) belong to the integration: sessions get them only when
   * `prepare` reports the prefix in `agentPrefixes`, i.e. the workspace is of the integration's project type.
   */
  readonly agentPrefix?: string;
  resolveConfig(raw: Record<string, unknown>, ctx: IntegrationConfigContext): { config: C; errors: string[]; warnings: string[] };
  /** Must never throw: failures are logged and yield null. */
  prepare(config: C, ctx: IntegrationPrepareContext): Promise<SessionExtensions | null>;
  checkEnv?(config: C, workspacePath: string): Promise<Record<string, string>>;
  /** Dry-run lines: service-wide with a null workspace, otherwise about that existing workspace. */
  describe?(config: C, env: NodeJS.ProcessEnv, workspacePath: string | null): Promise<string[]>;
}
