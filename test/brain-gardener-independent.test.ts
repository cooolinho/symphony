import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { toolsForRole } from '../src/orchestrator/guard.ts';
import { Logger } from '../src/log.ts';
import { BrainAccessLog } from '../src/brain/access-log.ts';
import { brainToolsFor } from '../src/brain/tools.ts';
import { createGithubTools } from '../src/tracker/github-project/tools.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import type { AgentToolContext, AgentToolSpec, ToolResult } from '../src/tracker/types.ts';
import { commandSkills, parseIssueCommand } from '../src/workflow/command.ts';
import { resolveConfig } from '../src/workflow/config.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { roleFor } from '../src/workflow/roles.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

// Independent tests for E8-5 (/brain-garden), derived from the issue text and not from the implementation.

const root = path.join(import.meta.dirname, '..');
const env = { GITHUB_PROJECT_NUMBER: '1', GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't' };
const note = (front: string, body = '# T'): string => `---\n${front}\n---\n${body}\n`;
const put = (dir: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const read = (dir: string, rel: string): string => fs.readFileSync(path.join(dir, rel), 'utf8');

async function shippedConfig() {
  const file = path.join(root, 'WORKFLOW.md');
  const { definition } = await loadWorkflowFile(file);
  return resolveConfig(definition.config, { workflowPath: file, env, trackerDefaults });
}

/** A session of one role through the real orchestrator: what the worker hands to the agent. */
async function sessionTools(role: Record<string, unknown>) {
  const dir = tempDir();
  put(dir, 'Lessons/approved.md', note('type: lesson\nstatus: approved', '# Approved\nOld text.'));
  put(dir, 'Lessons/upper.md', note('type: lesson\nstatus: Approved', '# Upper\nOld text.'));
  put(dir, 'Inbox/cand.md', note('type: note\nstatus: candidate', '# Cand\nOld text.'));
  for (const args of [['init', '-q'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't'], ['add', '-A'], ['commit', '-qm', 'init']]) execFileSync('git', args, { cwd: dir });
  const rootDir = tempDir();
  const runner = new FakeRunner(() => new Promise(() => undefined));
  const workflow = new StaticWorkflow(makeWorkflow(baseFront(rootDir, { roles: { dev: { states: ['Todo', 'In Progress'], ...role } }, brain: { path: dir, enabled: true } })));
  const orchestrator = new Orchestrator({
    workflow,
    runner,
    logger: Logger.silent(),
    env: {},
    logDir: null,
    clock: new ManualClock(),
    timers: new ManualTimers(),
    createAdapter: () => new FakeTracker([makeIssue({ id: 'a' })]),
  });
  await orchestrator.tickNow();
  await until(() => runner.sessions.length === 1, 3_000, 'one session');
  const specs = (runner.sessions[0]!.params.brainTools ?? []) as AgentToolSpec[];
  const ctx: AgentToolContext = { issue: makeIssue({ id: 'a' }), role: 'dev', runId: 'r1' };
  const call = (name: string, args: Record<string, unknown>): Promise<ToolResult> => specs.find((s) => s.name === name)!.execute({ purpose: 'test', ...args }, ctx);
  return { dir, specs, call, names: specs.map((s) => s.name).sort() };
}
const errorOf = (r: ToolResult): { category: string; message: string; details?: { reason?: string } } => {
  assert.equal(r.ok, false, JSON.stringify(r));
  return (r as Extract<ToolResult, { ok: false }>).error as never;
};
const hashOf = async (call: Awaited<ReturnType<typeof sessionTools>>['call'], rel: string): Promise<string> => {
  const r = await call('brain_read', { path: rel });
  assert.ok(r.ok);
  return (r as any).data.hash;
};

describe('E8-5: role with brain: write and brain_approved_writes: false (worker session)', () => {
  const gardener = { brain: 'write', brain_approved_writes: false };

  it('gets exactly six tools incl. brain_vitals', async () => {
    assert.deepEqual((await sessionTools(gardener)).names, ['brain_append', 'brain_list', 'brain_read', 'brain_search', 'brain_vitals', 'brain_write']);
  });

  it('brain_write on an approved note ends rejected and leaves the file byte-identical', async () => {
    const { dir, call } = await sessionTools(gardener);
    const before = read(dir, 'Lessons/approved.md');
    const hash = await hashOf(call, 'Lessons/approved.md');
    const error = errorOf(await call('brain_write', { path: 'Lessons/approved.md', content: note('type: lesson', '# Approved\nChanged.'), base_hash: hash }));
    assert.equal(error.category, 'rejected');
    assert.equal(read(dir, 'Lessons/approved.md'), before);
  });

  it('brain_append on an approved note ends rejected and leaves the file unchanged', async () => {
    const { dir, call } = await sessionTools(gardener);
    const before = read(dir, 'Lessons/approved.md');
    const hash = await hashOf(call, 'Lessons/approved.md');
    assert.equal(errorOf(await call('brain_append', { path: 'Lessons/approved.md', heading: 'More', text: 'x', base_hash: hash })).category, 'rejected');
    assert.equal(read(dir, 'Lessons/approved.md'), before);
  });

  it('status casing does not bypass the gate (Approved)', async () => {
    const { dir, call } = await sessionTools(gardener);
    const before = read(dir, 'Lessons/upper.md');
    const hash = await hashOf(call, 'Lessons/upper.md');
    assert.equal(errorOf(await call('brain_write', { path: 'Lessons/upper.md', content: note('type: lesson', '# Upper\nX'), base_hash: hash })).category, 'rejected');
    assert.equal(errorOf(await call('brain_append', { path: 'Lessons/upper.md', heading: 'H', text: 'x', base_hash: hash })).category, 'rejected');
    assert.equal(read(dir, 'Lessons/upper.md'), before);
  });

  it('never creates a note with status approved, also not with a different casing', async () => {
    const { dir, call } = await sessionTools(gardener);
    for (const status of ['approved', 'Approved', ' APPROVED ']) {
      const error = errorOf(await call('brain_write', { path: 'Inbox/new.md', content: note(`type: note\nstatus: "${status}"`) }));
      assert.equal(error.category, 'rejected', status);
      assert.ok(!fs.existsSync(path.join(dir, 'Inbox/new.md')), status);
    }
  });

  it('cannot promote an existing candidate to approved', async () => {
    const { dir, call } = await sessionTools(gardener);
    const before = read(dir, 'Inbox/cand.md');
    const hash = await hashOf(call, 'Inbox/cand.md');
    assert.equal(errorOf(await call('brain_write', { path: 'Inbox/cand.md', content: note('type: note\nstatus: approved'), base_hash: hash })).category, 'rejected');
    assert.equal(read(dir, 'Inbox/cand.md'), before);
  });

  it('can still create a proposal in Inbox/ (stored as candidate) and change and append to a candidate note', async () => {
    const { dir, call } = await sessionTools(gardener);
    const created = await call('brain_write', { path: 'Inbox/garden-2026-10-31-dup.md', content: note('type: note\nsources: [Lessons/approved.md]', '# Merge\n[[Lessons/approved.md]]') });
    assert.ok(created.ok, JSON.stringify(created));
    assert.match(read(dir, 'Inbox/garden-2026-10-31-dup.md'), /^status: candidate$/m);
    assert.match(read(dir, 'Inbox/garden-2026-10-31-dup.md'), /^type: note$/m);
    const hash = await hashOf(call, 'Inbox/cand.md');
    const changed = await call('brain_write', { path: 'Inbox/cand.md', content: note('type: note', '# Cand\nFixed [[Lessons/approved.md]].'), base_hash: hash });
    assert.ok(changed.ok, JSON.stringify(changed));
    assert.match(read(dir, 'Inbox/cand.md'), /Fixed \[\[Lessons\/approved\.md\]\]/);
    assert.match(read(dir, 'Inbox/cand.md'), /^status: candidate$/m);
    const next = await hashOf(call, 'Inbox/cand.md');
    assert.ok((await call('brain_append', { path: 'Inbox/cand.md', heading: 'Note', text: 'more', base_hash: next })).ok);
  });

  it('the read tools still work on approved notes', async () => {
    const { call } = await sessionTools(gardener);
    assert.ok((await call('brain_read', { path: 'Lessons/approved.md' })).ok);
    assert.ok((await call('brain_list', { path: 'Lessons' })).ok);
    assert.ok((await call('brain_vitals', {})).ok);
  });
});

describe('E8-5: other roles keep their behavior', () => {
  it('brain: write without the flag has six tools and still writes candidates', async () => {
    const { names, call, dir } = await sessionTools({ brain: 'write' });
    assert.deepEqual(names, ['brain_append', 'brain_list', 'brain_read', 'brain_search', 'brain_vitals', 'brain_write']);
    assert.ok((await call('brain_write', { path: 'Inbox/x.md', content: note('type: note') })).ok);
    assert.ok(fs.existsSync(path.join(dir, 'Inbox/x.md')));
  });

  it('brain: write with brain_approved_writes: true still never overwrites an approved note (general protection)', async () => {
    const { call, dir } = await sessionTools({ brain: 'write', brain_approved_writes: true });
    const before = read(dir, 'Lessons/approved.md');
    const hash = await hashOf(call, 'Lessons/approved.md');
    assert.equal(errorOf(await call('brain_write', { path: 'Lessons/approved.md', content: note('type: lesson', 'x'), base_hash: hash })).category, 'rejected');
    assert.equal(read(dir, 'Lessons/approved.md'), before);
  });

  it('brain: read has the four read tools and no write tool', async () => {
    assert.deepEqual((await sessionTools({ brain: 'read' })).names, ['brain_list', 'brain_read', 'brain_search', 'brain_vitals']);
  });

  it('brain: read with the flag false gets no write tools either', async () => {
    assert.deepEqual((await sessionTools({ brain: 'read', brain_approved_writes: false })).names, ['brain_list', 'brain_read', 'brain_search', 'brain_vitals']);
  });

  it('brain: off gives no brain tools, whatever the flag says', async () => {
    assert.deepEqual((await sessionTools({ brain: 'off', brain_approved_writes: false })).names, []);
  });
});

describe('E8-5: access log of rejected approved writes', () => {
  it('records the rejected write with the role, the path and the reason', async () => {
    const dir = tempDir();
    put(dir, 'Lessons/a.md', note('type: lesson\nstatus: approved'));
    const logDir = tempDir();
    const access = new BrainAccessLog(logDir, Logger.silent());
    const tools = brainToolsFor({ enabled: true, path: dir }, 'write', Logger.silent(), { access, approvedWrites: false, clashWindowMs: 0 });
    const write = tools.find((t) => t.name === 'brain_write')!;
    const result = await write.execute({ purpose: 'p', path: 'Lessons/a.md', content: note('type: lesson', 'x'), base_hash: 'whatever' }, { issue: makeIssue({ id: 'a' }), role: 'brain-gardener', runId: 'r' });
    assert.equal(result.ok, false);
    const lines = fs.readFileSync(path.join(logDir, 'access.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].op, 'write');
    assert.equal(lines[0].result, 'rejected');
    assert.equal(lines[0].role, 'brain-gardener');
    assert.equal(lines[0].path_or_query, 'Lessons/a.md');
  });
});

describe('E8-5: brain_vitals', () => {
  function vault(): string {
    const dir = tempDir();
    put(dir, 'Repos/x/index.md', note('type: index', '# X\n[[Lessons/linked]]'));
    put(dir, 'Lessons/linked.md', note('type: lesson', '# Linked\nSee [[Lessons/nowhere]].'));
    put(dir, 'Lessons/lonely.md', note('type: lesson', '# Lonely'));
    return dir;
  }
  const vitals = (dir: string, access: BrainAccessLog | null = null) =>
    brainToolsFor({ enabled: true, path: dir }, 'read', Logger.silent(), { access }).find((t) => t.name === 'brain_vitals')!;
  const ctx: AgentToolContext = { issue: makeIssue({ id: 'a' }), role: 'brain-gardener', runId: 'r' };

  it('is a read tool with a purpose argument, available for brain: read', () => {
    const spec = vitals(vault());
    assert.equal(spec.mutates, false);
    assert.ok('purpose' in (spec.inputSchema as object));
  });

  it('reports the orphan and the broken link, works on a cold index and does not modify the vault', async () => {
    const dir = vault();
    const snapshot = ['Repos/x/index.md', 'Lessons/linked.md', 'Lessons/lonely.md'].map((f) => read(dir, f));
    const result = await vitals(dir).execute({ purpose: 'garden' }, ctx);
    assert.ok(result.ok, JSON.stringify(result));
    const data = (result as any).data;
    assert.deepEqual(data.orphan_paths, ['Lessons/lonely.md']);
    assert.equal(data.broken.length, 1);
    assert.equal(data.broken[0].from, 'Lessons/linked.md');
    assert.match(data.broken[0].link, /nowhere/);
    assert.equal(data.orphans, 1);
    assert.equal(data.broken_links, 1);
    assert.deepEqual(['Repos/x/index.md', 'Lessons/linked.md', 'Lessons/lonely.md'].map((f) => read(dir, f)), snapshot);
  });

  it('returns empty lists for a healthy vault', async () => {
    const dir = tempDir();
    put(dir, 'Repos/x/index.md', note('type: index', '# X\n[[Lessons/a]]'));
    put(dir, 'Lessons/a.md', note('type: lesson', '# A'));
    const data = ((await vitals(dir).execute({ purpose: 'p' }, ctx)) as any).data;
    assert.deepEqual(data.orphan_paths, []);
    assert.deepEqual(data.broken, []);
    assert.deepEqual(data.same_title, []);
  });

  it('writes an access-log line per call', async () => {
    const dir = vault();
    const logDir = tempDir();
    const access = new BrainAccessLog(logDir, Logger.silent());
    await vitals(dir, access).execute({ purpose: 'tend the vault' }, ctx);
    const lines = fs.readFileSync(path.join(logDir, 'access.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].result, 'ok');
    assert.equal(lines[0].purpose, 'tend the vault');
    assert.equal(lines[0].role, 'brain-gardener');
  });

  it('gives a clear error (no throw) when the vault is unavailable', async () => {
    const result = await vitals(path.join(tempDir(), 'does-not-exist')).execute({ purpose: 'p' }, ctx);
    // either an empty report or a structured error; never an exception
    assert.equal(typeof result.ok, 'boolean');
    if (!result.ok) assert.ok(errorOf(result).message.length > 0);
  });
});

describe('E8-5: shipped WORKFLOW.md role brain-gardener', () => {
  it('has the issue-defined switches', async () => {
    const config = await shippedConfig();
    const role = (config.roles ?? []).find((r) => r.name === 'brain-gardener')!;
    assert.ok(role, 'role exists');
    assert.deepEqual(role.commands, ['brain-garden']);
    assert.equal(role.readOnly, true);
    assert.equal(role.brain, 'write');
    assert.equal(role.brainApprovedWrites, false);
    assert.equal(role.maxSubIssues, null);
    assert.ok(role.mayMoveTo!.includes('In review'));
    assert.ok(!role.mayMoveTo!.includes('Done'));
    assert.ok(!role.mayMoveTo!.includes('Testing'));
  });

  it('only gets set_status and add_comment as tracker writes (no sub-issues, no pull request, no report_result)', async () => {
    const config = await shippedConfig();
    const role = (config.roles ?? []).find((r) => r.name === 'brain-gardener')!;
    assert.equal(role.result, null);
    const specs = createGithubTools({ settings: { baseBranch: null } } as never);
    const names = toolsForRole(specs, role, { labels: [], native_ref: null } as never)
      .map((s) => s.name)
      .filter((n) => !(role.claude.disallowedTools ?? []).includes(`mcp__tracker__${n}`));
    assert.ok(names.includes('add_comment'));
    assert.ok(names.includes('set_status'));
    assert.ok(!names.includes('create_sub_issue'));
    assert.ok(!names.includes('open_pull_request'));
    assert.ok(!names.includes('report_result'));
  });

  it('/brain-garden is served by the role in Ready and In progress, other commands and plain issues are not', async () => {
    const config = await shippedConfig();
    const roles = config.roles ?? [];
    assert.deepEqual(parseIssueCommand('/brain-garden'), { name: 'brain-garden', args: '' });
    assert.equal(roleFor({ state: 'Ready', description: '/brain-garden' }, roles)?.name, 'brain-gardener');
    assert.equal(roleFor({ state: 'In progress', description: '/brain-garden\nmore text' }, roles)?.name, 'brain-gardener');
    assert.notEqual(roleFor({ state: 'Ready', description: '/plan' }, roles)?.name, 'brain-gardener');
    assert.notEqual(roleFor({ state: 'Ready', description: 'fix a bug' }, roles)?.name, 'brain-gardener');
    assert.notEqual(roleFor({ state: 'Ready', description: 'mention /brain-garden in the middle' }, roles)?.name, 'brain-gardener');
  });

  it('no other shipped role has the gate on or an unexpected write switch change', async () => {
    const config = await shippedConfig();
    for (const role of (config.roles ?? []).filter((r) => r.name !== 'brain-gardener')) assert.equal(role.brainApprovedWrites, true, role.name);
  });

  it('the skill is shipped via the plugin directory', () => {
    assert.equal(commandSkills([path.join(root, '.claude')]).get('brain-garden'), 'symphony:brain-garden');
  });
});

describe('E8-5: skill and docs content', () => {
  const skill = fs.readFileSync(path.join(root, '.claude/skills/brain-garden/SKILL.md'), 'utf8');

  it('the skill has valid frontmatter and is English', () => {
    assert.match(skill, /^---\nname: brain-garden\n/);
    assert.match(skill, /^description: .+/m);
    assert.doesNotMatch(skill, /[äöüßÄÖÜ]/);
  });

  it('the skill names the workflow steps: index, vitals, duplicates, Inbox note, comment, In review', () => {
    for (const needle of ['Repos/<repo>/index.md', 'brain_vitals', 'duplicate', 'Inbox/', 'type: note', 'candidate', 'add_comment', 'set_status', 'In review']) {
      assert.ok(skill.includes(needle), needle);
    }
  });

  it('the skill forbids promotion, writing approved notes and merging itself', () => {
    assert.match(skill, /Never write or append to a note with `status: approved`/);
    assert.match(skill, /Never set `status: approved`/);
    assert.match(skill, /never merge/i);
    assert.match(skill, /broken link only inside a note with `status: candidate`/i);
  });

  it('docs/brain.md has a Gardener section with command, flag, tool and limits', () => {
    const docs = read(root, 'docs/brain.md');
    const section = docs.split(/^## /m).find((s) => s.startsWith('Gardener')) ?? '';
    assert.ok(section.length > 100, 'section exists');
    for (const needle of ['/brain-garden', 'brain-gardener', 'brain_approved_writes', 'brain_vitals', 'Inbox/', 'approved']) assert.ok(section.includes(needle), needle);
  });

  it('docs/configuration.md documents brain_approved_writes and roles/brain.md names brain_vitals', () => {
    assert.match(read(root, 'docs/configuration.md'), /brain_approved_writes/);
    assert.match(read(root, 'roles/brain.md'), /brain_vitals/);
  });
});
