import fs from 'node:fs/promises';
import path from 'node:path';
import { isPlainObject } from '../workflow/loader.ts';

/** What a composer.json says about Laravel. */
export interface ComposerFacts {
  /** laravel/framework is a runtime dependency. */
  laravel: boolean;
  /** laravel/boost is a dependency (usually require-dev). */
  boost: boolean;
}

export interface LaravelApp {
  /** Directory relative to the repository root with `/` separators; '' for the root itself. */
  dir: string;
  /** Absolute directory. */
  path: string;
  boost: boolean;
}

const SKIPPED_DIRS = new Set(['vendor', 'node_modules']);

/** Reads laravel/framework from `require` and laravel/boost from `require` or `require-dev`. */
export function classifyComposer(json: unknown): ComposerFacts {
  const section = (key: string): Record<string, unknown> => {
    const value = isPlainObject(json) ? json[key] : undefined;
    return isPlainObject(value) ? value : {};
  };
  const require = section('require');
  const requireDev = section('require-dev');
  return {
    laravel: 'laravel/framework' in require,
    boost: 'laravel/boost' in require || 'laravel/boost' in requireDev,
  };
}

function skippedDir(name: string): boolean {
  return name.startsWith('.') || SKIPPED_DIRS.has(name);
}

/**
 * Directories that may hold a Laravel app, from repository-relative file paths: the root and
 * one level deep, wherever both `artisan` and `composer.json` exist. Root ('') sorts first.
 */
export function candidateAppDirs(paths: Iterable<string>): string[] {
  const files = new Map<string, Set<string>>();
  for (const raw of paths) {
    const parts = raw.split('/').filter((part) => part !== '');
    if (parts.length === 0 || parts.length > 2) continue;
    if (parts.length === 2 && skippedDir(parts[0] as string)) continue;
    const dir = parts.length === 2 ? (parts[0] as string) : '';
    const name = parts[parts.length - 1] as string;
    if (name !== 'artisan' && name !== 'composer.json') continue;
    let names = files.get(dir);
    if (names === undefined) files.set(dir, (names = new Set()));
    names.add(name);
  }
  return [...files]
    .filter(([, names]) => names.has('artisan') && names.has('composer.json'))
    .map(([dir]) => dir)
    .sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Laravel apps in a checkout: the root and its direct subdirectories (vendor, node_modules and dot-dirs skipped). */
export async function detectLaravelApps(root: string): Promise<LaravelApp[]> {
  const paths: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isFile()) {
      paths.push(entry.name);
    } else if (entry.isDirectory() && !skippedDir(entry.name)) {
      try {
        for (const child of await fs.readdir(path.join(root, entry.name), { withFileTypes: true })) {
          if (child.isFile()) paths.push(`${entry.name}/${child.name}`);
        }
      } catch {
        // Unreadable directory: not an app.
      }
    }
  }
  const apps: LaravelApp[] = [];
  for (const dir of candidateAppDirs(paths)) {
    const appPath = dir === '' ? root : path.join(root, dir);
    const facts = classifyComposer(await readJson(path.join(appPath, 'composer.json')));
    if (facts.laravel) apps.push({ dir, path: appPath, boost: facts.boost });
  }
  return apps;
}
