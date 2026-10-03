import os from 'node:os';
import path from 'node:path';
import { SymphonyError } from './errors.ts';

/** Expands a leading `~` or `~/` to the home directory. */
export function expandHome(value: string, home: string = os.homedir()): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

/**
 * Expands `$NAME` and `${NAME}` references. Only used for values that are local filesystem
 * paths; URIs and shell commands are never rewritten. Unset variables are a config error.
 */
export function expandEnvVars(value: string, env: NodeJS.ProcessEnv, field: string): string {
  return value.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_match, braced, bare) => {
    const name = (braced ?? bare) as string;
    const resolved = env[name];
    if (resolved === undefined || resolved === '') {
      throw new SymphonyError('invalid_config', `${field} references environment variable $${name}, which is not set`);
    }
    return resolved;
  });
}

/** Resolves a config path value: `$VAR` and `~` expansion, then relative-to-base resolution. */
export function resolveConfigPath(value: string, baseDir: string, env: NodeJS.ProcessEnv, field: string): string {
  const expanded = expandHome(expandEnvVars(value, env, field), env.HOME || os.homedir());
  return path.resolve(baseDir, expanded);
}

/** True when `candidate` is strictly inside `root` (both absolute and normalized). */
export function isStrictlyInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === '' || path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
