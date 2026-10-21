import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileGlob, globProblem, matchesAnyGlob } from '../src/workflow/glob.ts';

const DEFAULT_TEST_PATHS = ['tests/**', 'test/**', '**/*.test.*', '**/*Test.php'];

describe('path globs', () => {
  it('matches the default test paths', () => {
    for (const file of [
      'tests/Feature/InvoiceTest.php',
      'tests/Pest.php',
      'tests/fixtures/.gitkeep',
      'test/glob.test.ts',
      'src/orchestrator/guard.test.ts',
      'resources/js/app.test.js',
      'guard.test.ts',
      'app/Models/InvoiceTest.php',
      'InvoiceTest.php',
    ]) {
      assert.ok(matchesAnyGlob(file, DEFAULT_TEST_PATHS), file);
    }
  });

  it('rejects production code and look-alikes', () => {
    for (const file of [
      'src/orchestrator/guard.ts',
      'app/Models/Invoice.php',
      'src/tests-helper.ts',
      'src/testing/tests/a.ts',
      'package.json',
      'phpunit.xml',
      'attest/a.ts',
      'src/contest.ts',
      'docs/Test.php.md',
    ]) {
      assert.ok(!matchesAnyGlob(file, DEFAULT_TEST_PATHS), file);
    }
  });

  it('knows `*` (no slash), `**` (slashes, possibly no directory at all), `?` and braces', () => {
    const matches = (glob: string, file: string) => compileGlob(glob).test(file);
    assert.ok(matches('src/*.ts', 'src/a.ts'));
    assert.ok(!matches('src/*.ts', 'src/x/a.ts'));
    assert.ok(matches('src/**/a.ts', 'src/a.ts'));
    assert.ok(matches('src/**/a.ts', 'src/x/y/a.ts'));
    assert.ok(!matches('src/**/a.ts', 'src/xa.ts'));
    assert.ok(matches('src/**', 'src/x/y/a.ts'));
    assert.ok(!matches('src/**', 'srcs/a.ts'));
    assert.ok(matches('a?c', 'abc'));
    assert.ok(!matches('a?c', 'a/c'));
    assert.ok(matches('**/*.{spec,test}.ts', 'src/a.spec.ts'));
    assert.ok(matches('**/*.{spec,test}.ts', 'a.test.ts'));
    assert.ok(!matches('**/*.{spec,test}.ts', 'a.unit.ts'));
    assert.ok(matches('docs/a+b (1).md', 'docs/a+b (1).md'), 'regular expression characters are literal');
    assert.ok(!matches('docs/a.md', 'docs/aXmd'), 'the dot is literal');
  });

  it('matches dotfiles, the whole path and case-sensitively; a leading ./ is ignored', () => {
    assert.ok(matchesAnyGlob('tests/.env.testing', ['tests/**']));
    assert.ok(matchesAnyGlob('.github/a.test.ts', ['**/*.test.*']));
    assert.ok(!matchesAnyGlob('xtests/a.php', ['tests/**']));
    assert.ok(!matchesAnyGlob('Tests/a.php', ['tests/**']));
    assert.ok(matchesAnyGlob('./tests/a.php', ['tests/**']));
    assert.ok(matchesAnyGlob('tests/a.php', ['./tests/**']));
    assert.ok(!matchesAnyGlob('tests/a.php', []), 'no glob, no match');
  });

  it('explains why a glob cannot be used', () => {
    assert.equal(globProblem('tests/**'), null);
    assert.equal(globProblem('**/*.{test,spec}.*'), null);
    assert.equal(globProblem(' '), 'must not be empty');
    assert.match(globProblem('/etc/**') ?? '', /relative to the repository root/);
    assert.match(globProblem('a/../b') ?? '', /must not contain "\.\." segments/);
    assert.equal(globProblem('a/{b,c'), 'unclosed "{"');
    assert.equal(globProblem('{a,{b,c}}'), 'nested braces are not supported');
    assert.ok(!matchesAnyGlob('a/{b', ['a/{b']), 'an invalid glob matches nothing');
  });
});
