import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BrainAccessLog, type BrainAccess } from '../src/brain/access-log.ts';
import { createVaultGit, initVaultGit } from '../src/brain/git.ts';
import { BrainIndex, buildIndex, candidatesOf, vitalsCounts } from '../src/brain/index.ts';
import { ensureVault } from '../src/brain/vault.ts';
import { startHttpServer } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, tempDir, until } from './helpers.ts';

// Acceptance tests for E7-6a, derived from the issue text (cooolinho/symphony#359).

const put = (vault: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), text);
};
const note = (fields: Record<string, string>, body = ''): string =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`;

function get(port: number, method: string, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function serve(brain: { enabled: boolean; path: string } | null) {
  const orchestrator = new Orchestrator({
    workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), brain ? { brain } : {}))),
    runner: new FakeRunner(),
    logger: Logger.silent(),
    env: {},
    logDir: null,
    timers: new ManualTimers(),
    createAdapter: () => new FakeTracker(),
  });
  await orchestrator.buildBrainIndex();
  return startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
}

describe('buildIndex: four-note fixture', () => {
  // A (Decisions/a) -> [[Lessons/b|Alias]], [[Lessons/c#Abschnitt]], [[Lessons/missing]]
  // B (Lessons/b)  -> [[Lessons/c]]
  // C (Lessons/c)  -> nothing
  // D (Inbox/d)    -> nothing, nobody links to it
  function fixture(): string {
    const vault = tempDir();
    put(vault, 'Decisions/a.md', note({ type: 'decision', status: 'approved' }, '[[Lessons/b|Alias]] [[Lessons/c#Abschnitt]] [[Lessons/missing]]'));
    put(vault, 'Lessons/b.md', note({ type: 'lesson', status: 'candidate' }, 'siehe [[Lessons/c]]'));
    put(vault, 'Lessons/c.md', note({ type: 'lesson', status: 'approved' }, 'Ende'));
    put(vault, 'Inbox/d.md', note({ type: 'note', status: 'candidate' }, 'allein'));
    return vault;
  }

  it('counts alias and section links as links to the same target', async () => {
    const index = await buildIndex(fixture());
    assert.deepEqual([...index.notes.keys()].sort(), ['Decisions/a.md', 'Inbox/d.md', 'Lessons/b.md', 'Lessons/c.md']);
    assert.ok(index.backlinks.get('Lessons/b.md')?.includes('Decisions/a.md'), 'alias link counts');
    assert.deepEqual([...(index.backlinks.get('Lessons/c.md') ?? [])].sort(), ['Decisions/a.md', 'Lessons/b.md'], 'section link counts');
  });

  it('finds the orphan and the broken link', async () => {
    const index = await buildIndex(fixture());
    // A has no incoming link either, so it is an orphan as well.
    assert.deepEqual([...index.orphans].sort(), ['Decisions/a.md', 'Inbox/d.md']);
    assert.equal(index.broken.length, 1);
    assert.equal(index.broken[0]?.from, 'Decisions/a.md');
    assert.match(index.broken[0]!.link, /^Lessons\/missing(\.md)?$/);
  });

  it('exposes the note fields and links[]', async () => {
    const vault = tempDir();
    put(
      vault,
      'Lessons/x.md',
      note({ type: 'lesson', status: 'candidate', repo: 'acme/app', issue: '7', role: 'developer', created: '2026-10-02', updated: '2026-10-03' }, '[[Lessons/y]] [[Lessons/z|Z]]'),
    );
    const entry = (await buildIndex(vault)).notes.get('Lessons/x.md')!;
    assert.equal(entry.type, 'lesson');
    assert.equal(entry.status, 'candidate');
    assert.equal(entry.repo, 'acme/app');
    assert.equal(String(entry.issue), '7');
    assert.equal(entry.role, 'developer');
    assert.equal(entry.created, '2026-10-02');
    assert.equal(entry.updated, '2026-10-03');
    assert.equal(entry.links.length, 2);
  });

  it('ignores .obsidian/, non-markdown files, and exempts Repos/*/index.md from orphans', async () => {
    const vault = tempDir();
    put(vault, '.obsidian/plugin.md', 'x [[Nirgends]]');
    put(vault, 'Inbox/notes.txt', '[[Nirgends]]');
    put(vault, 'Repos/acme-app/index.md', note({ type: 'index', status: 'approved' }, 'index'));
    put(vault, 'Repos/acme-app/other.md', note({ type: 'note' }, 'other'));
    const index = await buildIndex(vault);
    assert.deepEqual([...index.notes.keys()].sort(), ['Repos/acme-app/index.md', 'Repos/acme-app/other.md']);
    assert.deepEqual(index.orphans, ['Repos/acme-app/other.md']);
    assert.deepEqual(index.broken, []);
  });

  it('does not abort on broken frontmatter and still reads its links', async () => {
    const vault = tempDir();
    put(vault, 'Inbox/bad.md', '---\nstatus: [oops\n type: : :\n---\n[[Inbox/ok]]');
    put(vault, 'Inbox/ok.md', note({ status: 'candidate' }, 'ok'));
    const index = await buildIndex(vault);
    assert.equal(index.notes.size, 2);
    assert.ok(index.notes.get('Inbox/bad.md'));
    assert.equal(index.notes.get('Inbox/ok.md')?.status, 'candidate');
  });

  it('ignores links in inline code and in backtick or tilde fences, but counts them in plain text', async () => {
    const vault = tempDir();
    put(vault, 'Inbox/a.md', note({ status: 'candidate' }, [
      'real [[Inbox/real]]',
      'inline `[[Inbox/inline]]` code',
      '```',
      '[[Inbox/fenced]]',
      '```',
      '~~~',
      '[[Inbox/tilde]]',
      '~~~',
      'after [[Inbox/after]]',
    ].join('\n')));
    put(vault, 'Inbox/real.md', note({}, 'x'));
    put(vault, 'Inbox/after.md', note({}, 'x'));
    const index = await buildIndex(vault);
    assert.deepEqual([...(index.notes.get('Inbox/a.md')?.links ?? [])].sort(), ['Inbox/after.md', 'Inbox/real.md']);
    assert.deepEqual(index.broken, []);
  });

  it('indexes 2,000 generated notes in under 2 s', async () => {
    const vault = tempDir();
    for (let i = 0; i < 2000; i++) {
      put(vault, `Lessons/n${i}.md`, note({ type: 'lesson', status: i % 2 ? 'candidate' : 'approved', created: '2026-10-01' }, `[[Lessons/n${(i + 1) % 2000}]] [[n${(i + 5) % 2000}|alias]]`));
    }
    const started = performance.now();
    const index = await buildIndex(vault);
    const ms = performance.now() - started;
    assert.equal(index.notes.size, 2000);
    assert.deepEqual(index.broken, []);
    assert.deepEqual(index.orphans, []);
    assert.ok(ms < 2000, `buildIndex took ${ms} ms`);
  });
});

describe('index follows commits', () => {
  it('updates after an agent commit and after a human commit, and removes deleted files', async () => {
    const vault = tempDir();
    put(vault, 'Inbox/one.md', note({ status: 'candidate' }, 'one'));
    put(vault, 'Inbox/two.md', note({ status: 'candidate' }, 'two'));
    await initVaultGit(vault);
    const holder = new BrainIndex(Logger.silent());
    await holder.rebuild(vault);
    const vaultGit = createVaultGit(vault, Logger.silent(), { onCommit: (_sha, paths) => holder.update(vault, paths) });

    put(vault, 'Inbox/three.md', note({ status: 'candidate' }, '[[Inbox/one]] [[Inbox/ghost]]'));
    await vaultGit.commitWrite({ path: 'Inbox/three.md', issue: 'acme/app#1', run: 'r1', role: 'developer', purpose: 'test' } as never);
    let index = await holder.current(vault);
    assert.ok(index.notes.has('Inbox/three.md'), 'agent commit adds the note');
    assert.deepEqual(index.backlinks.get('Inbox/one.md'), ['Inbox/three.md']);
    assert.deepEqual(index.broken.map((b) => b.from), ['Inbox/three.md']);

    fs.rmSync(path.join(vault, 'Inbox/two.md'));
    put(vault, 'Inbox/one.md', note({ status: 'approved' }, 'one edited'));
    assert.ok(await vaultGit.commitHumanChanges());
    index = await holder.current(vault);
    assert.ok(!index.notes.has('Inbox/two.md'), 'deleted file disappears');
    assert.equal(index.notes.get('Inbox/one.md')?.status, 'approved');
  });
});

describe('candidatesOf / vitalsCounts', () => {
  it('lists candidates oldest first with target from frontmatter or type folder', async () => {
    const vault = tempDir();
    put(vault, 'Inbox/c3.md', note({ type: 'decision', status: 'candidate', created: '2026-10-03' }, '# Dritte'));
    put(vault, 'Inbox/c1.md', note({ type: 'lesson', status: 'candidate', created: '2026-10-01', repo: 'acme/app', issue: '5', role: 'tester', target: 'Lessons/custom.md' }, '# Erste'));
    put(vault, 'Inbox/c2.md', note({ type: 'lesson', status: 'candidate', created: '2026-10-02' }, '# Zweite'));
    put(vault, 'Decisions/ok.md', note({ type: 'decision', status: 'approved', created: '2026-09-01' }, 'approved'));
    put(vault, 'Decisions/old.md', note({ type: 'decision', status: 'deprecated' }, 'old'));
    put(vault, 'Decisions/plain.md', 'no frontmatter');
    const index = await buildIndex(vault);
    const list = candidatesOf(index);
    assert.deepEqual(list.map((c) => c.path), ['Inbox/c1.md', 'Inbox/c2.md', 'Inbox/c3.md']);
    assert.equal(list[0]!.title, 'Erste');
    assert.equal(list[0]!.type, 'lesson');
    assert.equal(list[0]!.repo, 'acme/app');
    assert.equal(String(list[0]!.issue), '5');
    assert.equal(list[0]!.role, 'tester');
    assert.equal(list[0]!.created, '2026-10-01');
    assert.equal(list[0]!.target, 'Lessons/custom.md');
    assert.match(list[1]!.target, /^Lessons\/?/);
    assert.match(list[2]!.target, /^Decisions\/?/);
    const counts = vitalsCounts(index);
    assert.equal(counts.candidates, 3);
    assert.equal(counts.notes_by_status.candidate, 3);
    assert.equal(counts.notes_by_status.approved, 1);
    assert.equal(counts.notes_by_status.deprecated, 1);
  });
});

describe('BrainAccessLog today counters', () => {
  it('counts only successful writes/appends and reads of today', () => {
    const now = new Date('2026-10-31T10:00:00Z');
    const e = (op: BrainAccess['op'], over: Partial<BrainAccess> = {}): BrainAccess => ({
      at: now.toISOString(), run: null, issue: null, role: null, op, path_or_query: 'a.md', purpose: '', result: 'ok', ...over,
    });
    const log = new BrainAccessLog(null, Logger.silent());
    for (const entry of [e('write'), e('append'), e('write', { result: 'rejected' }), e('read'), e('read'), e('read', { at: '2026-10-30T10:00:00Z' }), e('write', { at: '2026-10-30T10:00:00Z' })]) log.record(entry);
    const today = log.todayCounts(now);
    assert.equal(today.writes, 2);
    assert.equal(today.reads, 2);
  });
});

describe('HTTP: /api/v1/brain/*', () => {
  it('answers 404 brain_disabled for both routes without brain', async () => {
    const server = await serve(null);
    try {
      for (const route of ['vitals', 'candidates']) {
        const res = await get(server.port, 'GET', `/api/v1/brain/${route}`);
        assert.equal(res.status, 404);
        assert.equal(JSON.parse(res.body).error.code, 'brain_disabled');
      }
    } finally {
      await server.close();
    }
  });

  it('answers 404 brain_disabled when brain.enabled is false', async () => {
    const server = await serve({ enabled: false, path: path.join(tempDir(), 'vault') });
    try {
      for (const route of ['vitals', 'candidates']) {
        const res = await get(server.port, 'GET', `/api/v1/brain/${route}`);
        assert.equal(res.status, 404);
        assert.equal(JSON.parse(res.body).error.code, 'brain_disabled');
      }
    } finally {
      await server.close();
    }
  });

  it('serves vitals with all fields and last_commit from the vault git', async () => {
    const vault = path.join(tempDir(), 'vault');
    await ensureVault(vault, ['acme/app'], new Date('2026-10-01T00:00:00Z'));
    put(vault, 'Inbox/a.md', note({ type: 'lesson', status: 'candidate', created: '2026-10-02' }, '[[Inbox/b]] [[Inbox/nowhere]]'));
    put(vault, 'Inbox/b.md', note({ type: 'lesson', status: 'approved' }, 'b'));
    put(vault, 'Inbox/lonely.md', note({ type: 'lesson', status: 'deprecated' }, 'lonely'));
    await initVaultGit(vault); // no-op when ensureVault already created the repo
    const server = await serve({ enabled: true, path: vault });
    try {
      const res = await get(server.port, 'GET', '/api/v1/brain/vitals');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      for (const key of ['notes_by_status', 'links', 'orphans', 'broken_links', 'candidates', 'writes_today', 'reads_today', 'last_commit']) {
        assert.ok(key in body, `missing ${key}`);
      }
      assert.equal(body.notes_by_status.candidate, 1);
      assert.equal(body.notes_by_status.approved >= 1, true);
      assert.equal(body.notes_by_status.deprecated, 1);
      assert.equal(body.candidates, 1);
      assert.equal(body.broken_links, 1);
      assert.ok(body.orphans >= 2, 'a.md and lonely.md are orphans');
      assert.ok(body.links.total >= 1);
      assert.equal(body.notes.deprecated, 1);
      assert.ok(body.last_commit === null || (typeof body.last_commit.sha === 'string' && typeof body.last_commit.at === 'string' && typeof body.last_commit.author === 'string'));
    } finally {
      await server.close();
    }
  });

  it('serves candidates oldest first with all listed fields', async () => {
    const vault = path.join(tempDir(), 'vault');
    await ensureVault(vault, [], new Date('2026-10-01T00:00:00Z'));
    put(vault, 'Inbox/newer.md', note({ type: 'decision', status: 'candidate', created: '2026-10-09', repo: 'acme/app', issue: '3', role: 'architect' }, '# Neuer'));
    put(vault, 'Inbox/older.md', note({ type: 'lesson', status: 'candidate', created: '2026-10-02', target: 'Lessons/ziel.md' }, '# Älter'));
    put(vault, 'Inbox/done.md', note({ type: 'lesson', status: 'approved', created: '2026-10-01' }, 'x'));
    const server = await serve({ enabled: true, path: vault });
    try {
      const res = await get(server.port, 'GET', '/api/v1/brain/candidates');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      const list = Array.isArray(body) ? body : body.candidates;
      assert.deepEqual(list.map((c: { path: string }) => c.path), ['Inbox/older.md', 'Inbox/newer.md']);
      for (const key of ['path', 'title', 'type', 'repo', 'issue', 'role', 'created', 'target']) assert.ok(key in list[1], `missing ${key}`);
      assert.equal(list[0].target, 'Lessons/ziel.md');
      assert.equal(list[0].title, 'Älter');
      assert.equal(list[1].role, 'architect');
      assert.match(list[1].target, /^Decisions\/?/);
    } finally {
      await server.close();
    }
  });

  it('rejects non-GET methods with 405', async () => {
    const server = await serve(null);
    try {
      for (const route of ['vitals', 'candidates']) {
        assert.equal((await get(server.port, 'POST', `/api/v1/brain/${route}`)).status, 405);
      }
    } finally {
      await server.close();
    }
  });
});

describe('fence kinds (follow-up of the review)', () => {
  it('a tilde line inside a backtick fence does not close it, and vice versa', async () => {
    const vault = tempDir();
    put(vault, 'a.md', ['```', '~~~', '[[hidden-one]]', '```', '[[visible-one]]', '~~~', '```', '[[hidden-two]]', '~~~', '[[visible-two]]'].join('\n'));
    const index = await buildIndex(vault);
    assert.deepEqual([...(index.notes.get('a.md')?.links ?? [])].sort(), ['visible-one.md', 'visible-two.md']);
  });
});

describe('index follows the issue summary commit (E8-3 x E7-6a)', () => {
  it('a merge writes Issues/<repo>/<nr>.md and vitals/candidates see it without a restart, including a pending Obsidian edit', async () => {
    const vault = path.join(tempDir(), 'vault');
    await ensureVault(vault, ['acme/app']);
    put(vault, 'Inbox/idea.md', note({ type: 'decision', status: 'candidate', created: '2026-10-01' }, 'idea'));
    await initVaultGit(vault);
    const tracker = new FakeTracker([
      makeIssue({ id: 'r', identifier: 'acme/app#r', title: 'Retry me', description: 'Goal.', state: 'Human Review', labels: ['awaiting-checks'], native_ref: { base_branch: 'main' } }),
    ]);
    tracker.issueRepository = () => 'acme/app';
    let finished = false;
    tracker.mergeWatch = () => ({
      column: 'Human Review',
      awaiting: (issue) => issue.labels.includes('awaiting-checks'),
      retry: async (issue) => {
        tracker.set(issue.id, { state: 'Done', labels: [] });
        // a human edit made in Obsidian right before the summary is written
        put(vault, 'Inbox/idea.md', note({ type: 'decision', status: 'approved', created: '2026-10-01' }, 'idea edited'));
        finished = true;
        return { merged: true, pull_request: 9, status: 'Done', reason: 'merged', pull_request_url: 'https://github.com/acme/app/pull/9', checks: { state: 'success' as const, failing: [], pending: [] } };
      },
    });
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), { brain: { enabled: true, path: vault } }))),
      runner: new FakeRunner(),
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => tracker,
    });
    await orchestrator.buildBrainIndex();
    const before = await orchestrator.brainVitals();
    assert.ok(before);
    assert.equal(before.notes_by_status.candidate, 1);
    const total = (v: NonNullable<typeof before>) => Object.values(v.notes_by_status).reduce((a, b) => a + b, 0);
    const approvedBefore = before.notes_by_status.approved ?? 0;
    try {
      await orchestrator.tickNow();
      await until(() => finished && fs.existsSync(path.join(vault, 'Issues', 'acme-app', 'r.md')), 15_000, 'summary written');
      const deadline = Date.now() + 15_000;
      let after = await orchestrator.brainVitals();
      while (Date.now() < deadline && (after === null || total(after) !== total(before) + 1)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        after = await orchestrator.brainVitals();
      }
      assert.ok(after);
      assert.equal(after.notes_by_status.candidate ?? 0, 0, 'the human edit committed by beforeWrite is indexed');
      // the edited note and the summary note (status approved) both count
      assert.equal(after.notes_by_status.approved, approvedBefore + 2);
      assert.deepEqual(await orchestrator.brainCandidates(), []);
      // the summary note links to Repos/acme-app/index, so the total grew by one and nothing is broken
      assert.equal(after.broken_links, before.broken_links);
      assert.equal(total(after), total(before) + 1);
    } finally {
      await orchestrator.shutdown(1_000);
    }
  });
});
