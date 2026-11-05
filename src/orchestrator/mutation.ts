import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isPlainObject } from '../workflow/loader.ts';

const execFileAsync = promisify(execFile);

const PHP_TIMEOUT_MS = 10_000;
const PEST_PACKAGE = 'pestphp/pest';
const MIN_PEST_MAJOR = 3;

/** Prints `pcov` when PCOV is loaded, else `xdebug` when Xdebug 3+ is loaded, else nothing. */
const DRIVER_SCRIPT =
  "echo extension_loaded('pcov') ? 'pcov' : (extension_loaded('xdebug') && version_compare((string) phpversion('xdebug'), '3.0.0', '>=') ? 'xdebug' : '');";

export interface MutationFacts {
  /** The workspace root, where the Laravel apps are looked up. */
  workspace: string;
  /** Runs `php` with the arguments in a directory and returns its stdout; defaults to the real binary. */
  php?: (args: string[], cwd: string) => Promise<string>;
}

export type MutationAvailability =
  | { available: true; app: string; pest: string; driver: 'pcov' | 'xdebug' }
  | { available: false; reason: string };

const runPhp = async (args: string[], cwd: string): Promise<string> =>
  (await execFileAsync('php', args, { cwd, timeout: PHP_TIMEOUT_MS })).stdout;

interface App {
  dir: string;
  path: string;
}

const isFile = (file: string): Promise<boolean> => fs.stat(file).then((stat) => stat.isFile(), () => false);

/**
 * Laravel apps in the workspace: the root and its direct subdirectories that hold `artisan` and a `composer.json` with
 * `laravel/framework`. Kept here because the core must not import `src/laravel`.
 */
async function laravelApps(root: string): Promise<App[]> {
  const dirs = [''];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'vendor' && entry.name !== 'node_modules') dirs.push(entry.name);
  }
  const apps: App[] = [];
  for (const dir of dirs) {
    const appPath = path.join(root, dir);
    if (!(await isFile(path.join(appPath, 'artisan')))) continue;
    try {
      const composer: unknown = JSON.parse(await fs.readFile(path.join(appPath, 'composer.json'), 'utf8'));
      const require = isPlainObject(composer) ? composer.require : undefined;
      if (isPlainObject(require) && 'laravel/framework' in require) apps.push({ dir, path: appPath });
    } catch {
      // No readable composer.json: not an app.
    }
  }
  return apps;
}

async function pestVersion(appPath: string): Promise<string | null> {
  let lock: unknown;
  try {
    lock = JSON.parse(await fs.readFile(path.join(appPath, 'composer.lock'), 'utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(lock)) return null;
  for (const section of ['packages', 'packages-dev']) {
    const packages = lock[section];
    if (!Array.isArray(packages)) continue;
    for (const entry of packages) {
      if (isPlainObject(entry) && entry.name === PEST_PACKAGE && typeof entry.version === 'string') return entry.version.replace(/^v/, '');
    }
  }
  return null;
}

/**
 * Whether `pest --mutate` can run in the workspace: a Laravel app (see `laravelApps`) with Pest 3+ in its composer.lock and PCOV or Xdebug 3+
 * loaded in PHP (Pest's mutation testing needs a coverage driver). Never throws: when detection fails, mutation testing
 * counts as unavailable, because no score is required where it cannot run.
 */
export async function pestMutationAvailability(facts: MutationFacts): Promise<MutationAvailability> {
  try {
    const apps = await laravelApps(facts.workspace);
    if (apps.length === 0) return { available: false, reason: 'no Laravel app' };
    const php = facts.php ?? runPhp;
    const reasons: string[] = [];
    for (const app of apps) {
      const version = await pestVersion(app.path);
      const major = version === null ? NaN : Number.parseInt(version, 10);
      if (!(major >= MIN_PEST_MAJOR)) {
        reasons.push(`${app.dir || '.'}: ${version === null ? 'no Pest' : `Pest ${version}`} (mutation testing needs Pest ${MIN_PEST_MAJOR}+)`);
        continue;
      }
      const driver = (await php(['-r', DRIVER_SCRIPT], app.path)).trim();
      if (driver === 'pcov' || driver === 'xdebug') return { available: true, app: app.dir || '.', pest: version as string, driver };
      reasons.push(`${app.dir || '.'}: neither PCOV nor Xdebug 3+ is loaded`);
    }
    return { available: false, reason: reasons.join('; ') };
  } catch (error) {
    return { available: false, reason: `detection failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
