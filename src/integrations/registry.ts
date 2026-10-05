import type { SessionExtensions } from '../agent/types.ts';
import { laravelIntegration } from '../laravel/integration.ts';
import { SymphonyError, errorMessage } from '../util/errors.ts';
import type { IntegrationPrepareContext, WorkspaceIntegration } from './types.ts';

const RESERVED_SERVER = 'tracker';

export function defaultIntegrations(): WorkspaceIntegration[] {
  return [laravelIntegration];
}

/**
 * Runs every integration that has a resolved config (keyed by integration id) and merges the results in list order.
 * Returns null when nothing contributed.
 */
export async function prepareIntegrations(
  list: readonly WorkspaceIntegration[],
  configs: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>,
  ctx: IntegrationPrepareContext,
): Promise<SessionExtensions | null> {
  const merged: SessionExtensions = { mcpServers: {}, contextSections: [], additionalDirectories: [], env: {} };
  let any = false;
  for (const integration of list) {
    const config = configs instanceof Map ? configs.get(integration.id) : (configs as Record<string, unknown>)[integration.id];
    if (config === undefined || config === null) continue;
    let result: SessionExtensions | null;
    try {
      result = await integration.prepare(config, ctx);
    } catch (error) {
      ctx.logger.error('workspace integration failed; skipping', { integration: integration.id, error: errorMessage(error) });
      continue;
    }
    if (!result) continue;
    for (const name of Object.keys(result.mcpServers)) {
      if (name === RESERVED_SERVER) {
        throw new SymphonyError('invalid_session_extensions', `MCP server name "${RESERVED_SERVER}" is reserved (integration ${integration.id})`);
      }
    }
    any = true;
    if (result.historyFields !== undefined) Object.assign((merged.historyFields ??= {}), result.historyFields);
    for (const [name, server] of Object.entries(result.mcpServers)) {
      if (Object.hasOwn(merged.mcpServers, name)) {
        ctx.logger.warn('duplicate MCP server name; skipping the later one', { integration: integration.id, server: name });
        continue;
      }
      merged.mcpServers[name] = server;
    }
    merged.contextSections.push(...result.contextSections);
    for (const dir of result.additionalDirectories) {
      if (!merged.additionalDirectories.includes(dir)) merged.additionalDirectories.push(dir);
    }
    Object.assign(merged.env, result.env);
  }
  return any ? merged : null;
}
