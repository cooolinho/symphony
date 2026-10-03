/** Variables that would make the child think it runs nested inside another Claude Code session. */
const NESTING_MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];

/**
 * Environment for agent and hook processes: the orchestrator's environment minus tracker
 * credentials (declared by the adapter) and Claude Code nesting markers.
 */
export function childEnvironment(env: NodeJS.ProcessEnv, secretNames: Iterable<string>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  for (const name of secretNames) delete result[name];
  for (const name of NESTING_MARKERS) delete result[name];
  return result;
}
