import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHECK_TIMEOUT_BASE_DELAY_MS, CHECK_TIMEOUT_MAX_DELAY_MS, checkTimeoutBackoffMs } from '../src/orchestrator/check-backoff.ts';

describe('checkTimeoutBackoffMs', () => {
  it('waits 5, 10, 20, then 30 minutes for consecutive timed-out hand-off checks', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 50].map((hits) => checkTimeoutBackoffMs(hits) / 60_000), [5, 10, 20, 30, 30, 30]);
    assert.equal(checkTimeoutBackoffMs(0), CHECK_TIMEOUT_BASE_DELAY_MS);
    assert.equal(checkTimeoutBackoffMs(1_000), CHECK_TIMEOUT_MAX_DELAY_MS);
  });
});
