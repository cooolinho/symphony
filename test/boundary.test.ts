import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const SRC = path.join(import.meta.dirname, '..', 'src');
/** Generic core: only src/integrations/registry.ts and src/repo-init/* may import a concrete integration. */
const CORE = ['orchestrator', 'workflow', 'agent', 'tracker', 'workspace'];

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** Module specifiers of static imports, re-exports and dynamic imports. */
function specifiers(source: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
  return [...source.matchAll(pattern)].map((match) => match[1]!);
}

describe('integration boundary', () => {
  it('keeps the core free of imports from src/laravel', () => {
    const files = [...CORE.flatMap((dir) => tsFiles(path.join(SRC, dir))), path.join(SRC, 'service.ts')];
    assert.ok(files.length > 20, `found only ${files.length} core files`);
    const offenders = files.flatMap((file) =>
      specifiers(fs.readFileSync(file, 'utf8'))
        .filter((spec) => /(^|\/)laravel\//.test(spec))
        .map((spec) => `${path.relative(SRC, file)} imports ${spec}`),
    );
    assert.deepEqual(offenders, []);
  });

  it('detects a laravel import', () => {
    assert.deepEqual(specifiers("import { x } from '../laravel/boost.ts';\nexport * from './laravel/detect.ts';"), [
      '../laravel/boost.ts',
      './laravel/detect.ts',
    ]);
  });
});
