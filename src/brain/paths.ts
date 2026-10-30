import fs from 'node:fs';
import path from 'node:path';
import { isStrictlyInside } from '../util/paths.ts';

export type VaultPath = { ok: true; absolute: string; relative: string } | { ok: false; message: string };

const OBSIDIAN = '.obsidian';
const OBSIDIAN_MESSAGE = '.obsidian/ belongs to the human and is never read';

function isObsidian(segment: string): boolean {
  return segment.toLowerCase() === OBSIDIAN;
}

/**
 * Checks a path an agent gave for the knowledge vault: relative, no `..`, nothing under `.obsidian/`, and (when it
 * exists) no symlink out of the vault. `relative` is normalized with `/`; the vault root is `''`.
 */
export function resolveVaultPath(vault: string, input: unknown, options: { allowRoot?: boolean } = {}): VaultPath {
  const allowRoot = options.allowRoot === true;
  const reject = (message: string): VaultPath => ({ ok: false, message });
  if (typeof input !== 'string') return reject('path must be a string');
  if (input.includes('\0')) return reject('path must not contain NUL characters');
  if (input.includes('\\')) return reject('path must use "/" as separator');
  if (input.startsWith('~') || path.isAbsolute(input) || path.win32.isAbsolute(input)) return reject('path must be relative to the vault');
  const segments = input.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) return reject('path must not contain ..');
  if (segments.some(isObsidian)) return reject(OBSIDIAN_MESSAGE);
  if (segments.length === 0 && !allowRoot) return reject('path must name a file or folder in the vault');

  const absolute = segments.length === 0 ? path.resolve(vault) : path.join(path.resolve(vault), ...segments);
  if (segments.length > 0 && !isStrictlyInside(path.resolve(vault), absolute)) return reject('path leaves the vault');

  let real: string;
  let realVault: string;
  try {
    real = fs.realpathSync(absolute);
    realVault = fs.realpathSync(vault);
  } catch {
    // Missing path: nothing to follow; the tool reports not_found.
    return { ok: true, absolute, relative: segments.join('/') };
  }
  if (real !== realVault) {
    if (!isStrictlyInside(realVault, real)) return reject('path leaves the vault through a symlink');
    if (path.relative(realVault, real).split(path.sep).some(isObsidian)) return reject(OBSIDIAN_MESSAGE);
  }
  return { ok: true, absolute, relative: segments.join('/') };
}
