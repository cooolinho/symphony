import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { SymphonyError, errorMessage } from './errors.ts';

/** `$NAME`, `${NAME}` or `${NAME:-default}` as the whole value. */
const WHOLE_REFERENCE = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))$/;

interface EnvReference {
  name: string;
  fallback: string | null;
}

function parseReference(value: unknown): EnvReference | null {
  if (typeof value !== 'string') return null;
  const match = WHOLE_REFERENCE.exec(value.trim());
  if (match === null) return null;
  return { name: (match[1] ?? match[3]) as string, fallback: match[2] ?? null };
}

/** Name of the variable when the whole value is a reference (`$NAME`, `${NAME}`, `${NAME:-default}`). */
export function envReferenceName(value: unknown): string | null {
  return parseReference(value)?.name ?? null;
}

/**
 * Resolves a whole-value reference. An unset or empty variable falls back to the `:-` default;
 * without a default (or with an empty one) it resolves to undefined, so the setting counts as
 * omitted. Values that are not references are returned unchanged.
 */
export function resolveEnvReference(value: unknown, env: NodeJS.ProcessEnv): unknown {
  const reference = parseReference(value);
  if (reference === null) return value;
  const resolved = env[reference.name];
  if (resolved !== undefined && resolved !== '') return resolved;
  return reference.fallback === null || reference.fallback === '' ? undefined : reference.fallback;
}

export interface LoadedEnvFile {
  env: NodeJS.ProcessEnv;
  file: string;
  /** Keys taken from the file. */
  applied: string[];
  /** Keys in the file that the process environment already set (the environment wins). */
  shadowed: string[];
}

/**
 * Merges a dotenv file under the process environment: variables already set in the
 * environment keep their value. The process environment itself is not modified.
 */
export function loadEnvFile(filePath: string, base: NodeJS.ProcessEnv): LoadedEnvFile {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new SymphonyError('missing_env_file', `cannot read env file ${filePath}: ${errorMessage(error)}`, { cause: error });
  }
  const parsed = parseEnv(content);
  const env: NodeJS.ProcessEnv = { ...base };
  const applied: string[] = [];
  const shadowed: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (base[key] !== undefined && base[key] !== '') {
      if (base[key] !== value) shadowed.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }
  return { env, file: filePath, applied, shadowed };
}
