import fs from 'node:fs/promises';
import path from 'node:path';
import { isPlainObject } from '../workflow/loader.ts';

/** Packages whose installed version is reported, with the name shown in the dry run. */
const FACT_PACKAGES = {
  'laravel/framework': 'Laravel',
  'filament/filament': 'Filament',
  'livewire/livewire': 'Livewire',
  'pestphp/pest': 'Pest',
  'laravel/boost': 'Boost',
  'laravel/sail': 'Sail',
  'larastan/larastan': 'Larastan',
  'laravel/pint': 'Pint',
} as const;

export type FactPackage = keyof typeof FACT_PACKAGES;

/** What a Laravel app's composer files say; versions are the strings of composer.lock (e.g. `v13.1.0`), null when unknown. */
export interface LaravelFacts {
  /** `require.php` of composer.json (a constraint such as `^8.3`). */
  php: string | null;
  packages: Record<FactPackage, string | null>;
}

function section(json: unknown, key: string): unknown[] {
  const value = isPlainObject(json) ? json[key] : undefined;
  return Array.isArray(value) ? value : [];
}

/** Reads the package versions from `packages` and `packages-dev` of a composer.lock and `require.php` of a composer.json. */
export function parseLaravelFacts(lock: unknown, composer: unknown): LaravelFacts {
  const packages = Object.fromEntries(Object.keys(FACT_PACKAGES).map((name) => [name, null])) as Record<FactPackage, string | null>;
  for (const entry of [...section(lock, 'packages'), ...section(lock, 'packages-dev')]) {
    if (!isPlainObject(entry) || typeof entry.name !== 'string' || typeof entry.version !== 'string') continue;
    if (Object.hasOwn(packages, entry.name)) packages[entry.name as FactPackage] = entry.version;
  }
  const require = isPlainObject(composer) ? composer.require : undefined;
  const php = isPlainObject(require) && typeof require.php === 'string' ? require.php : null;
  return { php, packages };
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Facts of the app in `appPath`; composer.lock exists right after the clone and needs no PHP. */
export async function readLaravelFacts(appPath: string): Promise<LaravelFacts> {
  return parseLaravelFacts(await readJson(path.join(appPath, 'composer.lock')), await readJson(path.join(appPath, 'composer.json')));
}

/** `Laravel v13.1.0 · Filament v5.2.0 · Boost v2.0.1` (known core packages only), or null when the lock file lists none. */
export function formatVersions(facts: LaravelFacts): string | null {
  const parts = (['laravel/framework', 'filament/filament', 'livewire/livewire', 'pestphp/pest', 'laravel/boost'] as const)
    .filter((name) => facts.packages[name] !== null)
    .map((name) => `${FACT_PACKAGES[name]} ${facts.packages[name]}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** Package versions by name for log lines; unknown packages are omitted. */
export function versionFields(facts: LaravelFacts): Record<string, string> {
  return Object.fromEntries(Object.entries(facts.packages).filter((pair): pair is [string, string] => pair[1] !== null));
}
