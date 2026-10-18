// Path globs of the `pipeline.*_paths` settings, matched against repository-relative paths with `/` separators:
//
// - `*` matches any characters except `/`, `?` one character except `/`
// - `**` matches anything including `/`; as a whole segment followed by `/` (`**/x`, `a/**/x`) it also matches no
//   directory at all, so `**/*.test.*` matches `a.test.ts` as well as `src/a.test.ts`
// - `{a,b}` matches one of the alternatives (no nesting)
//
// Every other character is literal, dots included: unlike a shell, `*` also matches a leading dot. The match covers the
// whole path and is case-sensitive.

/** The regular expression for `glob`; throws an `Error` naming the problem for an invalid glob. */
export function compileGlob(glob: string): RegExp {
  let source = '';
  let braces = false;
  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i);
    if (char === '*') {
      if (glob.charAt(i + 1) !== '*') {
        source += '[^/]*';
        continue;
      }
      const start = i === 0 || glob.charAt(i - 1) === '/';
      while (glob.charAt(i + 1) === '*') i++;
      if (start && glob.charAt(i + 1) === '/') {
        source += '(?:.*/)?';
        i++;
      } else {
        source += '.*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{') {
      if (braces) throw new Error('nested braces are not supported');
      braces = true;
      source += '(?:';
    } else if (char === '}' && braces) {
      braces = false;
      source += ')';
    } else if (char === ',' && braces) {
      source += '|';
    } else {
      source += char.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
    }
  }
  if (braces) throw new Error('unclosed "{"');
  return new RegExp(`^${source}$`);
}

/** Why `glob` cannot be used as a path glob, or null when it can. */
export function globProblem(glob: string): string | null {
  if (glob.trim() === '') return 'must not be empty';
  if (glob.startsWith('/')) return 'must be relative to the repository root, without a leading "/"';
  if (glob.split('/').includes('..')) return 'must not contain ".." segments';
  try {
    compileGlob(glob);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

/** Whether `file` (repository-relative) matches at least one of `globs`; invalid globs match nothing. */
export function matchesAnyGlob(file: string, globs: readonly string[]): boolean {
  const normalized = file.replace(/^\.\//, '');
  return globs.some((glob) => {
    try {
      return compileGlob(glob.replace(/^\.\//, '')).test(normalized);
    } catch {
      return false;
    }
  });
}
