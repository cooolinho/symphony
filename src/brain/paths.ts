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

/**
 * Stricter check for writes: on top of `resolveVaultPath` only `.md` notes, nothing hidden (`.obsidian`, `.git`, temp
 * files), not the `README.md` in the vault root (Symphony's rules), no symlink as target and no symlinked folder out
 * of the vault, also when the target does not exist yet.
 */
export function resolveVaultWritePath(vault: string, input: unknown): VaultPath {
  const resolved = resolveVaultPath(vault, input);
  if (!resolved.ok) return resolved;
  const reject = (message: string): VaultPath => ({ ok: false, message });
  const segments = resolved.relative.split('/');
  if (resolved.relative.toLowerCase() === 'readme.md') return reject('README.md in the vault root belongs to Symphony and is not writable');
  if (!resolved.relative.toLowerCase().endsWith('.md')) return reject('only .md notes are writable');
  if (segments.some((segment) => segment.startsWith('.'))) return reject('hidden files and folders are not writable');
  try {
    if (fs.lstatSync(resolved.absolute).isSymbolicLink()) return reject('path is a symlink');
  } catch {
    // Missing target: fine, it is created below.
  }
  const lstatExists = (p: string): boolean => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  let ancestor = path.dirname(resolved.absolute);
  while (!lstatExists(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  try {
    const realVault = fs.realpathSync(vault);
    const realAncestor = fs.realpathSync(ancestor);
    if (realAncestor !== realVault && !isStrictlyInside(realVault, realAncestor)) return reject('path leaves the vault through a symlink');
    if (path.relative(realVault, realAncestor).split(path.sep).some(isObsidian)) return reject(OBSIDIAN_MESSAGE);
  } catch {
    return reject('path cannot be checked');
  }
  return resolved;
}
