import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { describe, it } from 'node:test';
import { DASHBOARD_HTML } from '../src/http/dashboard.ts';
import { startHttpServer } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { SYMPHONY_VERSION } from '../src/version.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, tempDir } from './helpers.ts';

const packageVersion = (JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

function get(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

describe('release version', () => {
  it('comes from package.json, as a semantic version', () => {
    assert.equal(SYMPHONY_VERSION, packageVersion);
    assert.match(SYMPHONY_VERSION, /^\d+\.\d+\.\d+$/);
  });

  it('is in GET /api/v1/state (health.symphony_version) and in the dashboard header', async () => {
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), {}), { env: {} })),
      runner: new FakeRunner(),
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker(),
    });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      const state = JSON.parse(await get(server.port, '/api/v1/state')) as { health: { symphony_version: string } };
      assert.equal(state.health.symphony_version, packageVersion);
    } finally {
      await server.close();
    }
    assert.match(DASHBOARD_HTML, /<dt>Version<\/dt><dd id="sys-version">/);
    assert.match(DASHBOARD_HTML, /setText\(\$\('sys-version'\), h\.symphony_version \? 'v' \+ h\.symphony_version : '—'\)/);
  });
});
