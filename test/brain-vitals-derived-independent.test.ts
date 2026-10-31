import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildIndex, candidatesOf } from '../src/brain/index.ts';
import { startHttpServer } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { FakeRunner, FakeTracker, ManualClock, ManualTimers, StaticWorkflow, baseFront, makeWorkflow, tempDir } from './helpers.ts';

// E7-8 (#391), independent tests derived from the issue text: the derived fields of GET /api/v1/brain/vitals,
// computed on a temporary vault with its own git repository and a prepared access log.

type Obj = Record<string, any>;

const NOW = new Date('2026-10-30T12:00:00Z');
const put = (vault: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), text);
};
const note = (status: string | null, body = ''): string => `---\n${status === null ? 'type: note' : `type: note\nstatus: ${status}`}\n---\n${body}\n`;
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });

/** 8 notes (4 approved, 2 candidates, 2 deprecated) with exactly 3 resolvable links: 3 / 8 = 0.375 -> 0.4 per note. */
function vaultFixture(): string {
  const vault = path.join(tempDir(), 'vault');
  put(vault, 'Repos/acme-app/index.md', note('approved', '[[Lessons/b]] [[Decisions/d]]'));
  put(vault, 'Lessons/b.md', note('candidate', '[[Decisions/d]]'));
  put(vault, 'Decisions/d.md', note('approved', 'ende'));
  put(vault, 'Inbox/e.md', note('candidate', 'allein'));
  put(vault, 'Lessons/old.md', note('deprecated', 'alt'));
  put(vault, 'Lessons/old2.md', note('deprecated', 'alt'));
  put(vault, 'Lessons/f.md', note('approved', 'f'));
  put(vault, 'Agents/dev.md', note('approved', 'gedächtnis'));
  return vault;
}

function commits(vault: string, n: number): void {
  sh(vault, 'init', '-q');
  for (let i = 0; i < n; i++) {
    put(vault, `Lessons/c${i}.md`, note('approved', `c${i}`));
    sh(vault, 'add', '-A');
    sh(vault, 'commit', '-q', '-m', `commit ${i}`);
  }
}

const line = (over: Obj): string => JSON.stringify({ at: NOW.toISOString(), run: null, issue: null, role: null, op: 'read', path_or_query: 'x.md', purpose: '', result: 'ok', ...over });
const daysAgo = (d: number): string => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const clashLine = (id: string, at: string, over: Obj = {}): string =>
  line({ at, op: 'write', result: 'rejected', reason: 'hash_mismatch', clash_id: id, path_or_query: 'Lessons/x.md', run: 'r2', role: 'developer', issue: 'acme/app#9', other_run: 'r1', other_role: 'architect', other_issue: 'acme/app#7', other_at: at, ...over });

function accessLog(): string {
  const logDir = tempDir();
  const lines = [
    // today (UTC): 3 reads in Repos, 1 in Lessons, 2 writes
    line({ path_or_query: 'Repos/acme-app/index.md' }),
    line({ path_or_query: 'Repos/acme-app/index.md' }),
    line({ path_or_query: 'Repos/acme-app/other.md' }),
    line({ path_or_query: 'Lessons/b.md' }),
    line({ op: 'write', path_or_query: 'Lessons/b.md' }),
    line({ op: 'append', path_or_query: 'Inbox/e.md' }),
    // yesterday and a failed read do not count today
    line({ at: daysAgo(1), path_or_query: 'Decisions/d.md' }),
    line({ path_or_query: 'Decisions/d.md', result: 'rejected' }),
    // week balance: two clashes inside 7 days (one resolved), one older than 7 days
    clashLine('clash-new', daysAgo(1)),
    clashLine('clash-mid', daysAgo(5)),
    clashLine('clash-old', daysAgo(10)),
    line({ at: daysAgo(4), op: 'resolve', clash_id: 'clash-mid', path_or_query: 'clash-mid' }),
  ];
  fs.mkdirSync(path.join(logDir, 'brain'), { recursive: true });
  fs.writeFileSync(path.join(logDir, 'brain', 'access.jsonl'), lines.join('\n') + '\n');
  return logDir;
}

function orchestratorFor(brain: Obj | null, logDir: string | null = null): Orchestrator {
  const clock = new ManualClock();
  clock.wall = NOW.getTime();
  return new Orchestrator({
    workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), brain ? { brain } : {}))),
    runner: new FakeRunner(), logger: Logger.silent(), env: {}, logDir, timers: new ManualTimers(), createAdapter: () => new FakeTracker(), clock,
  });
}

async function ready(vault: string, extra: Obj = {}, logDir: string | null = accessLog()): Promise<Orchestrator> {
  const orchestrator = orchestratorFor({ enabled: true, path: vault, ...extra }, logDir);
  await orchestrator.buildBrainIndex();
  orchestrator.loadBrainAccess();
  return orchestrator;
}

function getJson(port: number, url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: body ? JSON.parse(body) : null }));
    }).on('error', reject);
  });
}

describe('brain vitals: derived fields (E7-8)', () => {
  it('notes.deprecated counts the notes with status deprecated, next to approved and candidates', async () => {
    const orchestrator = await ready(vaultFixture());
    const v = (await orchestrator.brainVitals()) as Obj;
    assert.equal(v.notes.deprecated, 2);
    assert.equal(v.notes.approved, 4);
    assert.equal(v.notes.candidate, 2);
  });

  it('links.per_note is links divided by notes with one decimal', async () => {
    const orchestrator = await ready(vaultFixture());
    const v = (await orchestrator.brainVitals()) as Obj;
    assert.equal(v.links.total, 3);
    assert.equal(v.links.per_note, 0.4);
    const empty = (await (await ready(path.join(tempDir(), 'leer'))).brainVitals()) as Obj;
    assert.equal(empty.links.total, 0);
    assert.equal(empty.links.per_note, 0, 'no notes: no division by zero');
  });

  it('reads_today.by_folder gives the share per first-level folder, ignoring other days and failed reads', async () => {
    const orchestrator = await ready(vaultFixture());
    const v = (await orchestrator.brainVitals()) as Obj;
    assert.equal(v.reads_today.total, 4);
    assert.equal(v.writes_today, 2);
    const byFolder = new Map<string, any>(v.reads_today.by_folder.map((f: Obj) => [f.folder, f]));
    assert.deepEqual([...byFolder.keys()].sort(), ['Lessons', 'Repos']);
    assert.equal(byFolder.get('Repos').pct, 75);
    assert.equal(byFolder.get('Lessons').pct, 25);
    assert.equal(v.reads_today.by_folder[0].folder, 'Repos', 'largest folder first');
  });

  it('reads_today.by_folder is empty without reads', async () => {
    const orchestrator = await ready(vaultFixture(), {}, tempDir());
    const v = (await orchestrator.brainVitals()) as Obj;
    assert.equal(v.reads_today.total, 0);
    assert.deepEqual(v.reads_today.by_folder, []);
  });

  it('clashes.week counts the clashes of the last 7 days and how many are resolved', async () => {
    const orchestrator = await ready(vaultFixture());
    const v = (await orchestrator.brainVitals()) as Obj;
    assert.deepEqual(v.clashes.week, { total: 2, resolved: 1 });
  });

  it('commits.total is the number of vault commits', async () => {
    const vault = vaultFixture();
    commits(vault, 3);
    const orchestrator = await ready(vault);
    assert.equal(((await orchestrator.brainVitals()) as Obj).commits.total, 3);
    put(vault, 'Lessons/new.md', note('approved'));
    sh(vault, 'add', '-A');
    sh(vault, 'commit', '-q', '-m', 'one more');
    assert.equal(((await orchestrator.brainVitals()) as Obj).commits.total, 4);
  });

  it('commits.total is a number (0) for a vault without a repository', async () => {
    const orchestrator = await ready(vaultFixture());
    assert.equal(((await orchestrator.brainVitals()) as Obj).commits.total, 0);
  });

  it('clash_window_min is brain.clash_window_ms in minutes', async () => {
    assert.equal(((await (await ready(vaultFixture(), { clash_window_ms: 300_000 })).brainVitals()) as Obj).clash_window_min, 5);
    assert.equal(((await (await ready(vaultFixture())).brainVitals()) as Obj).clash_window_min, 10, 'default 10 min');
    assert.equal(((await (await ready(vaultFixture(), { clash_window_ms: 0 })).brainVitals()) as Obj).clash_window_min, 0);
  });

  it('keeps the existing vitals (orphans, broken links, candidates, last commit)', async () => {
    const vault = vaultFixture();
    commits(vault, 1);
    const v = (await (await ready(vault)).brainVitals()) as Obj;
    for (const key of ['orphans', 'broken_links', 'candidates', 'writes_today', 'folders', 'last_commit']) assert.ok(key in v, key);
    assert.equal(v.candidates, 2);
    assert.equal(v.last_commit.sha.length, 40);
  });

  it('is served by GET /api/v1/brain/vitals with all new fields, and the endpoint stays 404 without brain.enabled', async () => {
    const vault = vaultFixture();
    commits(vault, 2);
    const orchestrator = await ready(vault, { clash_window_ms: 120_000 });
    const server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent() });
    try {
      const res = await getJson(server.port, '/api/v1/brain/vitals');
      assert.equal(res.status, 200);
      assert.equal(res.body.notes.deprecated, 2);
      assert.equal(res.body.links.per_note, 0.3, '3 links, 8 + 2 commit notes');
      assert.equal(res.body.reads_today.by_folder[0].folder, 'Repos');
      assert.deepEqual(res.body.clashes.week, { total: 2, resolved: 1 });
      assert.equal(res.body.commits.total, 2);
      assert.equal(res.body.clash_window_min, 2);
    } finally {
      await server.close();
    }
    const off = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator: orchestratorFor(null), logger: Logger.silent() });
    try {
      assert.equal((await getJson(off.port, '/api/v1/brain/vitals')).status, 404);
    } finally {
      await off.close();
    }
  });
});

describe('brain candidates API for the review cards (E7-8)', () => {
  it('sends the excerpt without frontmatter and the target from the type folder, oldest first', async () => {
    const vault = path.join(tempDir(), 'vault');
    put(vault, 'Inbox/neu.md', '---\ntype: decision\nstatus: candidate\ncreated: 2026-10-29\n---\n# Entscheidung\nText der Entscheidung\n');
    put(vault, 'Inbox/alt.md', '---\ntype: lesson\nstatus: candidate\ncreated: 2026-10-01\ntarget: Lessons/\n---\nAlt\n');
    const list = candidatesOf(await buildIndex(vault));
    assert.deepEqual(list.map((c) => c.path), ['Inbox/alt.md', 'Inbox/neu.md']);
    const neu = list[1]!;
    assert.equal(neu.target, 'Decisions/');
    assert.ok(!neu.preview.includes('---') && !neu.preview.includes('status:'), neu.preview);
    assert.ok(neu.preview.includes('Text der Entscheidung'));
  });
});
