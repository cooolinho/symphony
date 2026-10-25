import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { laravelIntegration } from '../src/laravel/integration.ts';
import { effectivePaths, expandForApps } from '../src/workflow/path-globs.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { matchesAnyGlob } from '../src/workflow/glob.ts';
import { tempDir } from './helpers.ts';

const base = { tracker: { kind: 'github', active_states: ['Ready', 'In progress'] } };
const pipelineOf = (pipeline: Record<string, unknown> = {}) =>
  resolveConfig({ ...base, pipeline }, { workflowPath: '/srv/flows/WORKFLOW.md', env: {}, trackerDefaults }).pipeline;

const appDirs = (root: string) => laravelIntegration.appDirs?.(root) ?? Promise.resolve([]);

/** A checkout with a Laravel app in `dir` ('' = root). */
function checkout(dir: string): string {
  const root = tempDir('app-paths-');
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, 'composer.json'), JSON.stringify({ require: { 'laravel/framework': '^12.0' } }));
  fs.writeFileSync(path.join(root, dir, 'artisan'), '');
  return root;
}

describe('pipeline path globs for a Laravel app in a subdirectory', () => {
  it('reproduces the bug: the root-relative defaults reject laravel/tests and laravel/app/Policies', () => {
    const pipeline = pipelineOf();
    assert.equal(matchesAnyGlob('laravel/tests/Fixtures/Foo.php', pipeline.testPaths), false);
    assert.equal(matchesAnyGlob('laravel/app/Policies/FooPolicy.php', pipeline.securityPaths), false);
  });

  it('extends all four defaults with the app prefix', async () => {
    const paths = effectivePaths(pipelineOf(), await appDirs(checkout('laravel')));
    assert.ok(matchesAnyGlob('laravel/tests/Fixtures/Foo.php', paths.testPaths));
    assert.ok(matchesAnyGlob('laravel/tests/Concerns/X.php', paths.testPaths));
    assert.ok(matchesAnyGlob('tests/Feature/X.php', paths.testPaths), 'root globs stay');
    assert.ok(matchesAnyGlob('laravel/app/Policies/FooPolicy.php', paths.securityPaths));
    assert.ok(matchesAnyGlob('laravel/database/migrations/2026_create.php', paths.securityPaths));
    assert.ok(matchesAnyGlob('laravel/config/auth.php', paths.securityPaths));
    assert.ok(matchesAnyGlob('laravel/config/app.php', paths.docsTriggerPaths));
    assert.ok(matchesAnyGlob('laravel/.env.example', paths.docsTriggerPaths));
    assert.ok(matchesAnyGlob('laravel/docs/guide.md', paths.docsPaths));
    assert.ok(!matchesAnyGlob('other/tests/Foo.php', paths.testPaths));
  });

  it('leaves the defaults alone for an app at the repository root', async () => {
    const pipeline = pipelineOf();
    const paths = effectivePaths(pipeline, await appDirs(checkout('')));
    assert.deepEqual(paths, {
      testPaths: pipeline.testPaths,
      docsPaths: pipeline.docsPaths,
      docsTriggerPaths: pipeline.docsTriggerPaths,
      securityPaths: pipeline.securityPaths,
      uiPaths: pipeline.uiPaths,
      screenshotPaths: pipeline.screenshotPaths,
    });
  });

  it('does not extend globs set explicitly in WORKFLOW.md', async () => {
    const pipeline = pipelineOf({ test_paths: ['tests/**'], security_paths: ['app/Policies/**'], docs_paths: [], docs_trigger_paths: ['config/**'], ui_paths: ['views/**'], screenshot_paths: ['shots/**'] });
    const paths = effectivePaths(pipeline, await appDirs(checkout('laravel')));
    assert.deepEqual(paths, { testPaths: ['tests/**'], securityPaths: ['app/Policies/**'], docsPaths: [], docsTriggerPaths: ['config/**'], uiPaths: ['views/**'], screenshotPaths: ['shots/**'] });
  });

  it('extends the UI and screenshot defaults with the app prefix', async () => {
    const paths = effectivePaths(pipelineOf(), await appDirs(checkout('laravel')));
    assert.ok(matchesAnyGlob('laravel/resources/views/a.blade.php', paths.uiPaths));
    assert.ok(matchesAnyGlob('laravel/app/Filament/Pages/A.php', paths.uiPaths));
    assert.ok(matchesAnyGlob('laravel/docs/screenshots/a.png', paths.screenshotPaths));
  });

  it('extends only the settings left at their default', async () => {
    const paths = effectivePaths(pipelineOf({ test_paths: ['tests/**'] }), await appDirs(checkout('laravel')));
    assert.deepEqual(paths.testPaths, ['tests/**']);
    assert.ok(matchesAnyGlob('laravel/app/Policies/FooPolicy.php', paths.securityPaths));
  });

  it('expandForApps skips ** globs and duplicates', () => {
    assert.deepEqual(expandForApps(['tests/**', '**/*Test.php'], ['', 'laravel', 'laravel']), ['tests/**', '**/*Test.php', 'laravel/tests/**']);
  });
});
