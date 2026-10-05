import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { formatVersions, parseLaravelFacts, readLaravelFacts } from '../src/laravel/facts.ts';
import { tempDir } from './helpers.ts';

const LOCK = {
  packages: [
    { name: 'laravel/framework', version: 'v13.1.0' },
    { name: 'filament/filament', version: 'v5.2.1' },
    { name: 'livewire/livewire', version: 'v4.0.3' },
    { name: 'symfony/console', version: 'v8.0.0' },
  ],
  'packages-dev': [
    { name: 'pestphp/pest', version: 'v4.1.0' },
    { name: 'laravel/boost', version: 'v2.0.1' },
    { name: 'laravel/pint', version: 'v1.30.0' },
  ],
};

describe('Laravel facts', () => {
  it('reads the versions from packages and packages-dev as written in the lock file', () => {
    const facts = parseLaravelFacts(LOCK, { require: { php: '^8.3' } });
    assert.deepEqual(facts, {
      php: '^8.3',
      packages: {
        'laravel/framework': 'v13.1.0',
        'filament/filament': 'v5.2.1',
        'livewire/livewire': 'v4.0.3',
        'pestphp/pest': 'v4.1.0',
        'laravel/boost': 'v2.0.1',
        'laravel/sail': null,
        'larastan/larastan': null,
        'laravel/pint': 'v1.30.0',
      },
    });
    assert.equal(formatVersions(facts), 'Laravel v13.1.0 · Filament v5.2.1 · Livewire v4.0.3 · Pest v4.1.0 · Boost v2.0.1');
  });

  it('yields null for every package without a lock file', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'composer.json'), JSON.stringify({ require: { php: '^8.4' } }));
    const facts = await readLaravelFacts(root);
    assert.equal(facts.php, '^8.4');
    assert.ok(Object.values(facts.packages).every((version) => version === null));
    assert.equal(formatVersions(facts), null);
    assert.deepEqual(parseLaravelFacts(null, null).php, null);
  });

  it('ignores malformed lock entries', () => {
    const facts = parseLaravelFacts({ packages: [null, { name: 'laravel/framework' }, { name: 'laravel/sail', version: 'v1.0.0' }], 'packages-dev': 'x' }, []);
    assert.equal(facts.packages['laravel/framework'], null);
    assert.equal(facts.packages['laravel/sail'], 'v1.0.0');
  });
});
