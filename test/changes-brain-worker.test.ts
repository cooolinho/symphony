import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { vaultGitHooks } from '../src/orchestrator/worker.ts';

describe('vaultGitHooks (E6-2 wiring in the worker)', () => {
  it('passes onCommit to the brain index and to onBrainCommit', async () => {
    const calls: string[] = [];
    const hooks = vaultGitHooks('/vault', {
      brainIndex: { update: (vault: string, paths: string[]) => calls.push(`index ${vault} ${paths.join(',')}`) } as never,
      onBrainCommit: async (vault, sha, paths) => {
        calls.push(`brain ${vault} ${sha} ${paths.join(',')}`);
      },
    });
    await hooks.onCommit('abc', ['Inbox/a.md']);
    assert.deepEqual(calls, ['index /vault Inbox/a.md', 'brain /vault abc Inbox/a.md']);
  });

  it('works without any consumer', async () => {
    await vaultGitHooks('/vault', {}).onCommit('abc', []);
  });
});
