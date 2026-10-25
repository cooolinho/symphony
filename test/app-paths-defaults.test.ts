import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { matchesAnyGlob } from '../src/workflow/glob.ts';
import { effectivePaths } from '../src/workflow/path-globs.ts';

// Issue #283, written from the acceptance criteria: the four pipeline path settings for an app at the repository root
// and in a subdirectory, defaults versus explicit globs.

const base = { tracker: { kind: 'github', active_states: ['Ready'] } };
const pipelineOf = (pipeline: Record<string, unknown> = {}) =>
  resolveConfig({ ...base, pipeline }, { workflowPath: '/srv/WORKFLOW.md', env: {}, trackerDefaults }).pipeline;

describe('effective pipeline path globs (#283)', () => {
  it('docs_paths and docs_trigger_paths apply below laravel/ by default', () => {
    const paths = effectivePaths(pipelineOf(), ['laravel']);
    for (const file of ['laravel/docs/guide.md', 'laravel/README.md', 'laravel/CHANGELOG.md', 'docs/guide.md']) assert.ok(matchesAnyGlob(file, paths.docsPaths), file);
    for (const file of ['laravel/config/app.php', 'laravel/.env.example', 'config/app.php', '.env.example']) assert.ok(matchesAnyGlob(file, paths.docsTriggerPaths), file);
    assert.ok(!matchesAnyGlob('laravel/app/Models/Foo.php', paths.docsTriggerPaths));
    assert.ok(!matchesAnyGlob('laravel/src/Foo.php', paths.docsPaths));
  });

  it('security_paths cover every default location below laravel/ and still the root', () => {
    const paths = effectivePaths(pipelineOf(), ['laravel']);
    for (const file of ['app/Policies/A.php', 'app/Http/Middleware/A.php', 'routes/web.php', 'database/migrations/x.php', 'config/auth.php']) {
      assert.ok(matchesAnyGlob(file, paths.securityPaths), file);
      assert.ok(matchesAnyGlob(`laravel/${file}`, paths.securityPaths), `laravel/${file}`);
    }
    assert.ok(!matchesAnyGlob('laravel/config/app.php', paths.securityPaths));
    assert.ok(!matchesAnyGlob('laravel/app/Models/Foo.php', paths.securityPaths));
  });

  it('a root app (dir "") and no app leave all four lists exactly as configured', () => {
    const pipeline = pipelineOf();
    for (const dirs of [[''], []]) {
      assert.deepEqual(effectivePaths(pipeline, dirs), {
        testPaths: pipeline.testPaths,
        docsPaths: pipeline.docsPaths,
        docsTriggerPaths: pipeline.docsTriggerPaths,
        securityPaths: pipeline.securityPaths,
        uiPaths: pipeline.uiPaths,
        screenshotPaths: pipeline.screenshotPaths,
      });
    }
  });

  it('several apps each get their prefix', () => {
    const paths = effectivePaths(pipelineOf(), ['api', 'admin']);
    assert.ok(matchesAnyGlob('api/tests/Fixtures/A.php', paths.testPaths));
    assert.ok(matchesAnyGlob('admin/tests/Fixtures/A.php', paths.testPaths));
    assert.ok(matchesAnyGlob('api/routes/api.php', paths.securityPaths));
    assert.ok(!matchesAnyGlob('web/tests/Fixtures/A.php', paths.testPaths));
  });

  it('explicit lists, including an empty one, are never extended', () => {
    const explicit = { test_paths: ['tests/**'], docs_paths: ['docs/**'], docs_trigger_paths: [], security_paths: ['routes/**'], ui_paths: ['web/**'], screenshot_paths: ['shots/**'] };
    const paths = effectivePaths(pipelineOf(explicit), ['laravel']);
    assert.deepEqual(paths, { testPaths: ['tests/**'], docsPaths: ['docs/**'], docsTriggerPaths: [], securityPaths: ['routes/**'], uiPaths: ['web/**'], screenshotPaths: ['shots/**'] });
    assert.ok(!matchesAnyGlob('laravel/tests/Fixtures/Foo.php', paths.testPaths));
    assert.ok(!matchesAnyGlob('laravel/routes/web.php', paths.securityPaths));
  });

  it('an explicit list equal to the default is still explicit', () => {
    const defaults = pipelineOf();
    const paths = effectivePaths(pipelineOf({ test_paths: defaults.testPaths }), ['laravel']);
    assert.deepEqual(paths.testPaths, defaults.testPaths);
    assert.ok(!matchesAnyGlob('laravel/tests/Fixtures/Foo.php', paths.testPaths));
  });

  it('does not mutate the configured lists', () => {
    const pipeline = pipelineOf();
    const before = JSON.stringify(pipeline);
    effectivePaths(pipeline, ['laravel']);
    assert.equal(JSON.stringify(pipeline), before);
  });
});
