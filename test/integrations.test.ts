import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SessionExtensions } from '../src/agent/types.ts';
import { defaultIntegrations, prepareIntegrations } from '../src/integrations/registry.ts';
import type { IntegrationPrepareContext, WorkspaceIntegration } from '../src/integrations/types.ts';
import { Logger } from '../src/log.ts';
import { SymphonyError } from '../src/util/errors.ts';

const server = (command: string) => ({ command, args: [], env: {} });

function fake(id: string, result: Partial<SessionExtensions> | null | Error): WorkspaceIntegration<true> {
  return {
    id,
    configKey: id,
    resolveConfig: () => ({ config: true, errors: [], warnings: [] }),
    prepare: async () => {
      if (result instanceof Error) throw result;
      return result && { mcpServers: {}, contextSections: [], additionalDirectories: [], env: {}, ...result };
    },
  };
}

function setup() {
  const lines: string[] = [];
  const logger = Logger.create({ sinks: [{ name: 'memory', write: (line) => lines.push(line) }], level: 'debug' });
  const ctx: IntegrationPrepareContext = { workspacePath: '/ws', env: {}, logger, signal: new AbortController().signal };
  return { lines, ctx };
}

describe('integration registry', () => {
  it('has no default integrations yet', () => {
    assert.deepEqual(defaultIntegrations(), []);
  });

  it('merges extensions in list order and skips integrations without config', async () => {
    const { ctx } = setup();
    const list = [
      fake('a', { mcpServers: { one: server('a') }, contextSections: ['A'], additionalDirectories: ['/x'], env: { K: 'a', A: '1' } }),
      fake('skipped', { contextSections: ['never'] }),
      fake('b', { mcpServers: { two: server('b') }, contextSections: ['B'], additionalDirectories: ['/x', '/y'], env: { K: 'b' } }),
    ];
    const merged = await prepareIntegrations(list, { a: true, b: true }, ctx);
    assert.deepEqual(Object.keys(merged!.mcpServers), ['one', 'two']);
    assert.deepEqual(merged!.contextSections, ['A', 'B']);
    assert.deepEqual(merged!.additionalDirectories, ['/x', '/y']);
    assert.deepEqual(merged!.env, { K: 'b', A: '1' });
  });

  it('skips a duplicate MCP server name with a warning', async () => {
    const { ctx, lines } = setup();
    const merged = await prepareIntegrations(
      [fake('a', { mcpServers: { dup: server('first') } }), fake('b', { mcpServers: { dup: server('second') } })],
      { a: true, b: true },
      ctx,
    );
    assert.equal(merged!.mcpServers.dup!.command, 'first');
    assert.ok(lines.some((line) => line.includes('level=warn') && line.includes('dup')));
  });

  it('logs and skips an integration that throws', async () => {
    const { ctx, lines } = setup();
    const merged = await prepareIntegrations(
      [fake('bad', new Error('boom')), fake('ok', { contextSections: ['fine'] })],
      { bad: true, ok: true },
      ctx,
    );
    assert.deepEqual(merged!.contextSections, ['fine']);
    assert.ok(lines.some((line) => line.includes('level=error') && line.includes('boom')));
  });

  it('rejects the reserved tracker server name', async () => {
    const { ctx } = setup();
    await assert.rejects(
      prepareIntegrations([fake('a', { mcpServers: { tracker: server('x') } })], { a: true }, ctx),
      (error) => error instanceof SymphonyError && error.code === 'invalid_session_extensions',
    );
  });

  it('returns null when integrations return null or nothing is configured', async () => {
    const { ctx } = setup();
    assert.equal(await prepareIntegrations([fake('a', null)], { a: true }, ctx), null);
    assert.equal(await prepareIntegrations([fake('a', { contextSections: ['x'] })], {}, ctx), null);
  });
});
