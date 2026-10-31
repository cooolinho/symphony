import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BrainAccessLog } from '../src/brain/access-log.ts';
import { sameTitleGroups, type VaultIndex } from '../src/brain/index.ts';
import { brainToolsFor, createBrainTools, createBrainVitalsTool, createBrainWriteTools } from '../src/brain/tools.ts';
import { Logger } from '../src/log.ts';
import type { AgentToolContext, ToolResult } from '../src/tracker/types.ts';
import { commandSkills, parseIssueCommand } from '../src/workflow/command.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { roleFor } from '../src/workflow/roles.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { makeIssue, tempDir } from './helpers.ts';

const root = path.join(import.meta.dirname, '..');
const note = (front: string, body = 'Body.'): string => `---\n${front}\n---\n${body}\n`;
const put = (dir: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const context: AgentToolContext = { issue: makeIssue({ id: 'a' }), role: 'brain-gardener', runId: 'run1' };

function setup(approvedWrites: boolean | undefined) {
  const dir = tempDir();
  put(dir, 'Lessons/a.md', note('type: lesson\nstatus: approved', '# Same\nSee [[Lessons/missing]].'));
  put(dir, 'Inbox/c.md', note('type: note\nstatus: candidate', '# Candidate'));
  const logDir = tempDir();
  const log = path.join(logDir, 'access.jsonl');
  const access = new BrainAccessLog(logDir, Logger.silent());
  const tools = Object.fromEntries(
    brainToolsFor({ enabled: true, path: dir }, 'write', Logger.silent(), { access, ...(approvedWrites === undefined ? {} : { approvedWrites }), clashWindowMs: 0 }).map((spec) => [
      spec.name,
      (args: Record<string, unknown>): Promise<ToolResult> => spec.execute({ purpose: 'test', ...args }, context),
    ]),
  );
  const lines = (): any[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, tools, lines };
}
const hashOf = async (tools: ReturnType<typeof setup>['tools'], rel: string): Promise<string> => {
  const result = await tools.brain_read!({ path: rel });
  assert.ok(result.ok);
  return (result.data as any).hash;
};
const fail = (r: ToolResult): any => {
  assert.equal(r.ok, false, JSON.stringify(r));
  return (r as Extract<ToolResult, { ok: false }>).error;
};

describe('brain gardener: write role without approved writes', () => {
  it('gets six tools', () => {
    assert.deepEqual(Object.keys(setup(false).tools).sort(), ['brain_append', 'brain_list', 'brain_read', 'brain_search', 'brain_vitals', 'brain_write']);
  });

  it('rejects brain_write and brain_append on an approved note, leaving the file untouched', async () => {
    const { dir, tools, lines } = setup(false);
    const before = fs.readFileSync(path.join(dir, 'Lessons/a.md'), 'utf8');
    const stale = await tools.brain_write!({ path: 'Lessons/a.md', content: note('type: lesson', 'x'), base_hash: 'stale' });
    assert.equal(fail(stale).category, 'rejected');
    assert.equal(fail(stale).details.reason, 'approved_readonly');
    const hash = await hashOf(tools, 'Lessons/a.md');
    assert.equal(fail(await tools.brain_write!({ path: 'Lessons/a.md', content: note('type: lesson', 'x'), base_hash: hash })).details.reason, 'approved_readonly');
    assert.equal(fail(await tools.brain_append!({ path: 'Lessons/a.md', heading: 'More', text: 'x', base_hash: hash })).details.reason, 'approved_readonly');
    assert.equal(fs.readFileSync(path.join(dir, 'Lessons/a.md'), 'utf8'), before);
    const rejected = lines().filter((l) => l.result === 'rejected' && l.reason === 'approved_readonly');
    assert.equal(rejected.length, 3);
    assert.equal(rejected[0].path_or_query, 'Lessons/a.md');
  });

  it('rejects new content with status approved', async () => {
    const { dir, tools } = setup(false);
    const error = fail(await tools.brain_write!({ path: 'Inbox/new.md', content: note('type: note\nstatus: approved') }));
    assert.equal(error.details.reason, 'approved_status');
    assert.ok(!fs.existsSync(path.join(dir, 'Inbox/new.md')));
  });

  it('still creates notes in Inbox/ and changes candidate notes', async () => {
    const { dir, tools } = setup(false);
    assert.ok((await tools.brain_write!({ path: 'Inbox/garden-x.md', content: note('type: note\nsources: [Lessons/a.md]', '# P\n[[Lessons/a.md]]') })).ok);
    assert.match(fs.readFileSync(path.join(dir, 'Inbox/garden-x.md'), 'utf8'), /status: candidate/);
    const hash = await hashOf(tools, 'Inbox/c.md');
    assert.ok((await tools.brain_write!({ path: 'Inbox/c.md', content: note('type: note', '# Changed'), base_hash: hash })).ok);
  });

  it('without the flag the general approved protection still rejects, without the extra reason', async () => {
    const { tools } = setup(undefined);
    const error = fail(await tools.brain_write!({ path: 'Lessons/a.md', content: note('type: lesson', 'x'), base_hash: await hashOf(tools, 'Lessons/a.md') }));
    assert.match(error.message, /read-only for agents/);
    assert.notEqual(error.details?.reason, 'approved_readonly');
  });

  it('the stale base_hash is checked after the approved gate only when the flag is off', async () => {
    const { tools } = setup(undefined);
    const error = fail(await tools.brain_write!({ path: 'Lessons/a.md', content: note('type: lesson', 'x'), base_hash: 'stale' }));
    assert.equal(error.details.reason, 'hash_mismatch');
  });
});

describe('brain_vitals', () => {
  function vault() {
    const dir = tempDir();
    put(dir, 'Repos/x/index.md', note('type: index', '# X\n[[Lessons/one]]'));
    put(dir, 'Lessons/one.md', note('type: lesson', '# Caching\n[[Lessons/missing]]'));
    put(dir, 'Lessons/two.md', note('type: lesson', '#  caching '));
    put(dir, 'Lessons/old.md', note('type: lesson\nstatus: deprecated', '# Caching'));
    return dir;
  }
  const run = async (spec: ReturnType<typeof createBrainVitalsTool>) => spec.execute({ purpose: 'garden' }, context);

  it('lists orphans, broken links and same-title groups, and logs a vitals read', async () => {
    const dir = vault();
    const logDir = tempDir();
  const log = path.join(logDir, 'access.jsonl');
    const spec = createBrainVitalsTool(dir, Logger.silent(), new BrainAccessLog(logDir, Logger.silent()), null);
    assert.equal(spec.mutates, false);
    const result = await run(spec);
    assert.ok(result.ok);
    const data = (result as any).data;
    assert.ok(data.orphan_paths.includes('Lessons/two.md'));
    assert.ok(!data.orphan_paths.includes('Repos/x/index.md'));
    assert.deepEqual(data.broken, [{ from: 'Lessons/one.md', link: 'Lessons/missing.md' }]);
    assert.deepEqual(data.same_title, [{ title: 'caching', paths: ['Lessons/one.md', 'Lessons/two.md'] }]);
    assert.equal(data.truncated, false);
    const line = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]!);
    assert.equal(line.op, 'vitals');
    assert.equal(line.result, 'ok');
    assert.equal(line.purpose, 'garden');
  });

  it('uses a given index and turns an index error into tool_error', async () => {
    const dir = vault();
    const seen: string[] = [];
    const fake = { notes: new Map(), backlinks: new Map(), orphans: ['A.md'], broken: [], links: 0 } as VaultIndex;
    const ok = await run(createBrainVitalsTool(dir, Logger.silent(), null, { current: async (v) => (seen.push(v), fake) }));
    assert.deepEqual(seen, [dir]);
    assert.deepEqual((ok as any).data.orphan_paths, ['A.md']);
    const bad = await run(createBrainVitalsTool(dir, Logger.silent(), null, { current: async () => Promise.reject(new Error('boom')) }));
    assert.equal(fail(bad).category, 'tool_error');
  });

  it('createBrainTools alone still has three tools; sameTitleGroups ignores single titles', () => {
    assert.equal(createBrainTools(vault(), Logger.silent()).length, 3);
    assert.deepEqual(sameTitleGroups({ notes: new Map([['a.md', { title: 'A', status: null }]]) } as never), []);
  });
});

describe('issue command /brain-garden', () => {
  const env = { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' };
  it('is served by the brain-gardener role with the right switches', async () => {
    assert.deepEqual(parseIssueCommand('/brain-garden'), { name: 'brain-garden', args: '' });
    const file = path.join(root, 'WORKFLOW.md');
    const { definition } = await loadWorkflowFile(file);
    const config = resolveConfig(definition.config, { workflowPath: file, env, trackerDefaults });
    for (const state of ['Ready', 'In progress']) assert.equal(roleFor({ state, description: '/brain-garden' }, config.roles ?? [])?.name, 'brain-gardener');
    const gardener = (config.roles ?? []).find((r) => r.name === 'brain-gardener')!;
    assert.equal(gardener.readOnly, true);
    assert.equal(gardener.brain, 'write');
    assert.equal(gardener.brainApprovedWrites, false);
    assert.equal(gardener.maxSubIssues, null);
    assert.deepEqual(gardener.mayMoveTo, ['In progress', 'In review', 'Blocked']);
    assert.ok(gardener.claude.disallowedTools?.includes('mcp__tracker__open_pull_request'));
    for (const other of (config.roles ?? []).filter((r) => r !== gardener)) assert.equal(other.brainApprovedWrites, true, other.name);
    assert.equal(commandSkills([path.join(root, '.claude')]).get('brain-garden'), 'symphony:brain-garden');
  });

  it('the skill is English and states the rules', () => {
    const skill = fs.readFileSync(path.join(root, '.claude/skills/brain-garden/SKILL.md'), 'utf8');
    assert.match(skill, /^name: brain-garden$/m);
    assert.doesNotMatch(skill, /[äöüßÄÖÜ]/);
    for (const word of ['brain_vitals', 'type: note', 'candidate', 'add_comment', 'In review', 'Never set `status: approved`', 'Inbox/']) assert.ok(skill.includes(word), word);
  });

  it('docs/brain.md has the Gardener section', () => {
    const docs = fs.readFileSync(path.join(root, 'docs/brain.md'), 'utf8');
    const section = docs.split(/^## /m).find((s) => s.startsWith('Gardener')) ?? '';
    for (const word of ['/brain-garden', 'brain_approved_writes', 'brain_vitals', 'Inbox/']) assert.ok(section.includes(word), word);
  });
});
