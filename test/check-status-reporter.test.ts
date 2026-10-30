import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkStatusReporter } from '../src/orchestrator/worker.ts';
import type { CheckStatus } from '../src/tracker/types.ts';
import { makeIssue } from './helpers.ts';

describe('checkStatusReporter', () => {
  const issue = makeIssue({ id: '7', identifier: 'acme/app#7' });
  const config = (reportStatus: boolean, publicUrl: string | null) => ({
    checks: { timeoutMs: 1, retries: 0, onEnter: new Map(), reportStatus },
    server: { port: null, host: '127.0.0.1', allowRemoteControl: false, publicUrl },
    system: { gpu: false },
  });

  it('reports only with checks.report_status and a tracker that can', () => {
    const posted: CheckStatus[] = [];
    const adapter = { reportCheckStatus: async (_issue: unknown, status: CheckStatus) => void posted.push(status) };
    assert.deepEqual(checkStatusReporter(config(false, null), adapter, issue), {});
    assert.deepEqual(checkStatusReporter(config(true, null), {}, issue), {});
  });

  it('links the agent page when server.public_url is set', async () => {
    const posted: CheckStatus[] = [];
    const adapter = { reportCheckStatus: async (_issue: unknown, status: CheckStatus) => void posted.push(status) };
    await checkStatusReporter(config(true, 'https://symphony.example'), adapter, issue).reportStatus?.({ name: 'ci', sha: 'abc', state: 'success', description: 'ok' });
    await checkStatusReporter(config(true, null), adapter, issue).reportStatus?.({ name: 'ci', sha: 'abc', state: 'failure', description: 'no' });
    assert.deepEqual(posted, [
      { name: 'ci', sha: 'abc', state: 'success', description: 'ok', targetUrl: 'https://symphony.example/agent?id=acme%2Fapp%237' },
      { name: 'ci', sha: 'abc', state: 'failure', description: 'no', targetUrl: null },
    ]);
  });
});
