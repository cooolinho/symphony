import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pestMutationAvailability } from '../src/orchestrator/mutation.ts';
import { tempDir } from './helpers.ts';

function app(pest: string | null, root = tempDir('symphony-mutation-')) {
  fs.writeFileSync(path.join(root, 'artisan'), '');
  fs.writeFileSync(path.join(root, 'composer.json'), JSON.stringify({ require: { 'laravel/framework': '^11.0' } }));
  if (pest !== null) fs.writeFileSync(path.join(root, 'composer.lock'), JSON.stringify({ packages: [{ name: 'pestphp/pest', version: pest }] }));
  return root;
}

describe('pestMutationAvailability', () => {
  it('is unavailable without a Laravel app', async () => {
    const result = await pestMutationAvailability({ workspace: tempDir('symphony-mutation-'), php: async () => 'pcov' });
    assert.deepEqual(result, { available: false, reason: 'no Laravel app' });
  });

  it('is unavailable for Pest 2 or without Pest', async () => {
    assert.equal((await pestMutationAvailability({ workspace: app('v2.34.0'), php: async () => 'pcov' })).available, false);
    assert.equal((await pestMutationAvailability({ workspace: app(null), php: async () => 'pcov' })).available, false);
  });

  it('is available with Pest 3 and a driver', async () => {
    assert.deepEqual(await pestMutationAvailability({ workspace: app('v3.5.0'), php: async () => 'xdebug\n' }), { available: true, app: '.', pest: '3.5.0', driver: 'xdebug' });
  });

  it('is unavailable without a driver, and a failing php does not throw', async () => {
    assert.equal((await pestMutationAvailability({ workspace: app('3.0.0'), php: async () => '' })).available, false);
    const result = await pestMutationAvailability({
      workspace: app('3.0.0'),
      php: async () => {
        throw new Error('php: not found');
      },
    });
    assert.deepEqual(result, { available: false, reason: 'detection failed: php: not found' });
  });
});
