import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = path.join(import.meta.dirname, '..');

/** Dockerfile with line continuations joined and comments dropped, one instruction per entry. */
function instructions(): string[] {
  const joined = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8').replace(/\\\r?\n/g, ' ');
  return joined.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).filter((l) => l !== '' && !l.startsWith('#'));
}

describe('Dockerfile: native Claude Code binary of the SDK', () => {
  const lines = instructions();
  const run = lines.find((l) => l.startsWith('RUN ') && /npm ci --omit=dev/.test(l));

  it('installs the dependencies with npm ci, optional packages included', () => {
    assert.ok(run, 'RUN npm ci --omit=dev …');
    assert.doesNotMatch(run, /--omit=optional|--no-optional/, 'the SDK binary is an optional dependency');
  });

  it('derives the platform package from node and checks its binary', () => {
    assert.ok(run);
    assert.match(run, /@anthropic-ai\/claude-agent-sdk-\$\(node -p 'process\.platform \+ "-" \+ process\.arch'\)/);
    assert.match(run, /bin="node_modules\/\$\{pkg\}\/claude"/);
  });

  it('retries npm ci once when the binary is missing, then fails the build', () => {
    assert.ok(run);
    assert.equal(run.match(/npm ci --omit=dev/g)?.length, 2, 'one install plus one retry');
    const retry = run.indexOf('if [ ! -x "${bin}" ]');
    const fail = run.lastIndexOf('if [ ! -x "${bin}" ]');
    assert.ok(retry >= 0 && fail > retry, 'a retry check followed by a final check');
    assert.match(run.slice(fail), /exit 1/);
  });

  it('runs the binary once and cleans the npm cache afterwards', () => {
    assert.ok(run);
    assert.match(run, /"\$\{bin\}" --version/);
    assert.ok(run.indexOf('"${bin}" --version') < run.indexOf('npm cache clean --force'));
  });
});
