import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BrainAccessLog } from '../src/brain/access-log.ts';
import { createVaultGit } from '../src/brain/git.ts';
import { createBrainWriteTools } from '../src/brain/tools.ts';
import { ensureVault } from '../src/brain/vault.ts';
import { startHttpServer } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import type { AgentToolContext } from '../src/tracker/types.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, tempDir } from './helpers.ts';

// Independent acceptance tests for E7-6b (#367): access / clashes API, approve / reject / revert of candidates.
// Everything goes through the HTTP surface with a temporary vault, as in production.

type Res = { status: number; body: string };

function request(port: number, method: string, url: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const json = (res: Res): any => JSON.parse(res.body);
const git = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');
const note = (front: string, body = '# N\n'): string => `---\n${front}\n---\n${body}`;
const CANDIDATE = note('type: lesson\nstatus: candidate\ncreated: 2026-10-20');

interface Env {
  vault: string;
  port: number;
  logDir: string;
  close: () => Promise<void>;
}

async function setup(
  files: Record<string, string> = {},
  options: { brain?: boolean; host?: string; allowRemoteControl?: boolean; prepare?: (vault: string, logDir: string) => Promise<void> | void } = {},
): Promise<Env> {
  const vault = path.join(tempDir(), 'vault');
  await ensureVault(vault, ['acme/app'], new Date('2026-10-01T00:00:00Z'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), text);
  }
  git(vault, '-c', 'user.name=t', '-c', 'user.email=t@local', 'add', '-A');
  git(vault, '-c', 'user.name=t', '-c', 'user.email=t@local', 'commit', '-q', '--allow-empty', '-m', 'fixture');
  const logDir = tempDir();
  await options.prepare?.(vault, logDir);
  const orchestrator = new Orchestrator({
    workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir(), options.brain === false ? {} : { brain: { enabled: true, path: vault } }))),
    runner: new FakeRunner(),
    logger: Logger.silent(),
    env: {},
    logDir,
    timers: new ManualTimers(),
    createAdapter: () => new FakeTracker(),
  });
  await orchestrator.buildBrainIndex();
  orchestrator.loadBrainAccess();
  const server = await startHttpServer({
    host: options.host ?? '127.0.0.1',
    port: 0,
    orchestrator,
    logger: Logger.silent(),
    ...(options.allowRemoteControl ? { allowRemoteControl: true } : {}),
  });
  return { vault, port: server.port, logDir, close: () => server.close() };
}

async function withEnv(files: Record<string, string>, run: (env: Env) => Promise<void>, options?: Parameters<typeof setup>[1]): Promise<void> {
  const env = await setup(files, options);
  try {
    await run(env);
  } finally {
    await env.close();
  }
}

const candidates = async (port: number): Promise<string[]> => json(await request(port, 'GET', '/api/v1/brain/candidates')).candidates.map((c: { path: string }) => c.path);
const post = (env: Env, action: string, notePath: string): Promise<Res> => request(env.port, 'POST', `/api/v1/brain/candidates/${encodeURIComponent(notePath)}/${action}`);

describe('POST approve (E7-6b)', () => {
  it('moves into the type folder, sets status and updated, commits as human and answers path and hash', async () => {
    await withEnv({ 'Inbox/idea.md': CANDIDATE }, async (env) => {
      const before = git(env.vault, 'rev-list', '--count', 'HEAD');
      const res = await post(env, 'approve', 'Inbox/idea.md');
      assert.equal(res.status, 200, res.body);
      const body = json(res);
      assert.equal(body.path, 'Lessons/idea.md');
      assert.equal(body.hash, sha256(fs.readFileSync(path.join(env.vault, 'Lessons/idea.md'))));
      assert.equal(fs.existsSync(path.join(env.vault, 'Inbox/idea.md')), false);
      const text = fs.readFileSync(path.join(env.vault, 'Lessons/idea.md'), 'utf8');
      assert.match(text, /^status: approved$/m);
      assert.doesNotMatch(text, /status: candidate/);
      assert.match(text, /^updated: ['"]?\d{4}-\d{2}-\d{2}/m);
      assert.match(text, /^created: ['"]?2026-10-20/m, 'other front matter stays');
      assert.match(text, /# N/, 'the body stays');
      assert.equal(Number(git(env.vault, 'rev-list', '--count', 'HEAD')), Number(before) + 1, 'exactly one commit');
      assert.equal(git(env.vault, 'log', '-1', '--format=%an|%s'), 'human|approve: Inbox/idea.md');
      assert.equal(git(env.vault, 'status', '--porcelain'), '', 'the vault is clean after the commit');
      assert.deepEqual(await candidates(env.port), []);
    });
  });

  it('moves to the target of the front matter (folder and full path)', async () => {
    await withEnv(
      {
        'Inbox/a.md': note('type: lesson\nstatus: candidate\ntarget: Decisions/'),
        'Inbox/b.md': note('type: lesson\nstatus: candidate\ntarget: Patterns/Special/b.md'),
      },
      async (env) => {
        assert.equal(json(await post(env, 'approve', 'Inbox/a.md')).path, 'Decisions/a.md');
        assert.equal(json(await post(env, 'approve', 'Inbox/b.md')).path, 'Patterns/Special/b.md');
        assert.ok(fs.existsSync(path.join(env.vault, 'Decisions/a.md')));
        assert.ok(fs.existsSync(path.join(env.vault, 'Patterns/Special/b.md')));
        assert.deepEqual(await candidates(env.port), []);
      },
    );
  });

  it('adds the suffix -2 when the target path is taken and keeps the existing file', async () => {
    const existing = note('type: lesson\nstatus: approved', '# Existing\n');
    await withEnv({ 'Inbox/idea.md': CANDIDATE, 'Lessons/idea.md': existing }, async (env) => {
      // The name idea.md is not unique then; the target gets -2, so the name idea-2.md is unique.
      const res = await post(env, 'approve', 'Inbox/idea.md');
      if (res.status === 200) {
        assert.equal(json(res).path, 'Lessons/idea-2.md');
        assert.equal(fs.readFileSync(path.join(env.vault, 'Lessons/idea.md'), 'utf8'), existing);
        assert.match(fs.readFileSync(path.join(env.vault, 'Lessons/idea-2.md'), 'utf8'), /status: approved/);
        assert.equal(fs.existsSync(path.join(env.vault, 'Inbox/idea.md')), false);
      } else {
        // Acceptable only as the documented name conflict: nothing moved, nothing lost.
        assert.equal(res.status, 409, res.body);
        assert.equal(fs.readFileSync(path.join(env.vault, 'Lessons/idea.md'), 'utf8'), existing);
        assert.equal(fs.readFileSync(path.join(env.vault, 'Inbox/idea.md'), 'utf8'), CANDIDATE);
      }
    });
  });

  it('does not rewrite [[links]] to the old path in other notes', async () => {
    const linker = note('type: lesson\nstatus: approved', 'See [[idea]] and [[Inbox/idea]].\n');
    await withEnv({ 'Inbox/idea.md': CANDIDATE, 'Lessons/linker.md': linker }, async (env) => {
      assert.equal((await post(env, 'approve', 'Inbox/idea.md')).status, 200);
      assert.equal(fs.readFileSync(path.join(env.vault, 'Lessons/linker.md'), 'utf8'), linker);
    });
  });

  it('refuses an ambiguous file name: 409, nothing moved, no commit', async () => {
    await withEnv({ 'Inbox/idea.md': CANDIDATE, 'Decisions/other/idea.md': note('type: decision\nstatus: approved') }, async (env) => {
      const head = git(env.vault, 'rev-parse', 'HEAD');
      const res = await post(env, 'approve', 'Inbox/idea.md');
      assert.equal(res.status, 409, res.body);
      assert.equal(git(env.vault, 'rev-parse', 'HEAD'), head);
      assert.equal(fs.readFileSync(path.join(env.vault, 'Inbox/idea.md'), 'utf8'), CANDIDATE);
      assert.equal(fs.existsSync(path.join(env.vault, 'Lessons/idea.md')), false);
    });
  });

  it('answers 404 for a missing note and 409 for a note that is no candidate', async () => {
    await withEnv({ 'Lessons/done.md': note('type: lesson\nstatus: approved'), 'Inbox/none.md': 'no front matter\n' }, async (env) => {
      const head = git(env.vault, 'rev-parse', 'HEAD');
      assert.equal((await post(env, 'approve', 'Inbox/missing.md')).status, 404);
      assert.equal((await post(env, 'approve', 'Lessons/done.md')).status, 409);
      assert.equal((await post(env, 'reject', 'Lessons/done.md')).status, 409);
      assert.equal((await post(env, 'approve', 'Inbox/none.md')).status, 409);
      assert.equal(git(env.vault, 'rev-parse', 'HEAD'), head, 'no commit for refused requests');
    });
  });

  it('commits manual Obsidian changes first and does not lose them', async () => {
    await withEnv({ 'Inbox/idea.md': CANDIDATE, 'Inbox/other.md': CANDIDATE }, async (env) => {
      fs.writeFileSync(path.join(env.vault, 'Inbox/other.md'), `${CANDIDATE}edited by hand\n`);
      assert.equal((await post(env, 'approve', 'Inbox/idea.md')).status, 200);
      assert.equal(git(env.vault, 'status', '--porcelain'), '');
      assert.match(git(env.vault, 'show', 'HEAD:Inbox/other.md'), /edited by hand/);
    });
  });
});

describe('POST reject (E7-6b)', () => {
  it('sets deprecated, leaves the file in place and commits reject: <path> as human', async () => {
    await withEnv({ 'Inbox/idea.md': CANDIDATE }, async (env) => {
      const res = await post(env, 'reject', 'Inbox/idea.md');
      assert.equal(res.status, 200, res.body);
      assert.equal(json(res).path, 'Inbox/idea.md');
      assert.equal(json(res).hash, sha256(fs.readFileSync(path.join(env.vault, 'Inbox/idea.md'))));
      const text = fs.readFileSync(path.join(env.vault, 'Inbox/idea.md'), 'utf8');
      assert.match(text, /^status: deprecated$/m);
      assert.match(text, /^updated: /m);
      assert.equal(fs.existsSync(path.join(env.vault, '.trash')), false, 'nothing goes to .trash');
      assert.equal(git(env.vault, 'log', '-1', '--format=%an|%s'), 'human|reject: Inbox/idea.md');
      assert.deepEqual(await candidates(env.port), []);
    });
  });
});

describe('POST revert (E7-6b)', () => {
  it('takes the approve commit back with git revert and the candidate is listed again', async () => {
    await withEnv({ 'Inbox/idea.md': CANDIDATE }, async (env) => {
      const approve = json(await post(env, 'approve', 'Inbox/idea.md'));
      assert.deepEqual(await candidates(env.port), []);
      const res = await post(env, 'revert', approve.path);
      assert.equal(res.status, 200, res.body);
      assert.equal(json(res).path, 'Inbox/idea.md');
      assert.equal(fs.readFileSync(path.join(env.vault, 'Inbox/idea.md'), 'utf8'), CANDIDATE);
      assert.equal(fs.existsSync(path.join(env.vault, 'Lessons/idea.md')), false);
      assert.match(git(env.vault, 'log', '-1', '--format=%s'), /^Revert/i, 'a real git revert commit');
      assert.equal(git(env.vault, 'status', '--porcelain'), '');
      assert.deepEqual(await candidates(env.port), ['Inbox/idea.md']);
      // History is kept: approve commit still reachable.
      assert.match(git(env.vault, 'log', '--format=%s'), /approve: Inbox\/idea\.md/);
    });
  });

  it('refuses a note without an approve commit (404 / 409) and changes nothing', async () => {
    await withEnv({ 'Lessons/plain.md': note('type: lesson\nstatus: approved') }, async (env) => {
      const head = git(env.vault, 'rev-parse', 'HEAD');
      const plain = await post(env, 'revert', 'Lessons/plain.md');
      assert.equal(plain.status, 409, plain.body);
      const missing = await post(env, 'revert', 'Lessons/nowhere.md');
      assert.equal(missing.status, 404, missing.body);
      assert.equal(git(env.vault, 'rev-parse', 'HEAD'), head);
    });
  });

  it('aborts cleanly on a conflict: 409, working tree clean, no revert in progress', async () => {
    await withEnv({ 'Inbox/idea.md': CANDIDATE }, async (env) => {
      const approve = json(await post(env, 'approve', 'Inbox/idea.md'));
      // A later change of the same note makes the plain revert conflict.
      const file = path.join(env.vault, approve.path);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('# N', '# Changed later'));
      git(env.vault, '-c', 'user.name=t', '-c', 'user.email=t@local', 'commit', '-q', '-am', 'later edit');
      const head = git(env.vault, 'rev-parse', 'HEAD');
      const res = await post(env, 'revert', approve.path);
      if (res.status === 200) {
        // A clean three-way merge is acceptable only if the later edit survived at the old path.
        assert.match(fs.readFileSync(path.join(env.vault, 'Inbox/idea.md'), 'utf8'), /Changed later/);
        return;
      }
      assert.equal(res.status, 409, res.body);
      assert.equal(git(env.vault, 'rev-parse', 'HEAD'), head);
      assert.equal(git(env.vault, 'status', '--porcelain'), '');
      assert.equal(fs.existsSync(path.join(env.vault, '.git', 'REVERT_HEAD')), false);
      assert.ok(fs.existsSync(file));
    });
  });
});

describe('write routes: security (E7-6b)', () => {
  it('rejects paths that leave the vault or hit .obsidian with 400 and writes nothing', async () => {
    await withEnv({ 'Inbox/idea.md': CANDIDATE }, async (env) => {
      const head = git(env.vault, 'rev-parse', 'HEAD');
      const outside = path.join(path.dirname(env.vault), 'outside.md');
      fs.writeFileSync(outside, CANDIDATE);
      for (const bad of ['../outside.md', 'Inbox/../../outside.md', '.obsidian/app.md', '.obsidian/x/y.md', '/etc/passwd.md']) {
        for (const action of ['approve', 'reject', 'revert']) {
          const res = await post(env, action, bad);
          assert.equal(res.status, 400, `${action} ${bad}: ${res.status} ${res.body}`);
        }
      }
      // Encoded dots in the URL path.
      for (const action of ['approve', 'reject', 'revert']) {
        const res = await request(env.port, 'POST', `/api/v1/brain/candidates/%2e%2e%2foutside.md/${action}`);
        assert.equal(res.status, 400, `${action}: ${res.body}`);
      }
      assert.equal(fs.readFileSync(outside, 'utf8'), CANDIDATE, 'the file outside the vault is untouched');
      assert.equal(git(env.vault, 'rev-parse', 'HEAD'), head);
    });
  });

  it('is not reachable through a symlink out of the vault', async () => {
    const outsideDir = tempDir();
    fs.writeFileSync(path.join(outsideDir, 'secret.md'), CANDIDATE);
    await withEnv({}, async (env) => {
      fs.symlinkSync(outsideDir, path.join(env.vault, 'Inbox', 'link'));
      const res = await post(env, 'approve', 'Inbox/link/secret.md');
      assert.ok(res.status === 400 || res.status === 404, `${res.status} ${res.body}`);
      assert.equal(fs.readFileSync(path.join(outsideDir, 'secret.md'), 'utf8'), CANDIDATE);
    });
  });

  it('answers 403 for every POST route when control is not allowed (remote bind, foreign origin)', async () => {
    const routes = ['candidates/Inbox%2Fidea.md/approve', 'candidates/Inbox%2Fidea.md/reject', 'candidates/Lessons%2Fidea.md/revert', 'clashes/abc/resolve'];
    const remote = await setup({ 'Inbox/idea.md': CANDIDATE }, { host: '0.0.0.0' });
    const proxied = await setup({ 'Inbox/idea.md': CANDIDATE }, { host: '0.0.0.0', allowRemoteControl: true });
    try {
      for (const route of routes) {
        assert.equal((await request(remote.port, 'POST', `/api/v1/brain/${route}`)).status, 403, route);
        assert.equal((await request(proxied.port, 'POST', `/api/v1/brain/${route}`, { origin: 'https://evil.example' })).status, 403, route);
      }
      for (const env of [remote, proxied]) {
        assert.equal(fs.readFileSync(path.join(env.vault, 'Inbox/idea.md'), 'utf8'), CANDIDATE);
        assert.equal(git(env.vault, 'log', '-1', '--format=%s'), 'fixture');
      }
      // The 403 comes before the path check: a bad path is still 403 when control is off.
      assert.equal((await request(remote.port, 'POST', '/api/v1/brain/candidates/..%2Fx.md/approve')).status, 403);
    } finally {
      await remote.close();
      await proxied.close();
    }
  });

  it('allows the POST routes for a remote bind behind the proxy with a same-origin request', async () => {
    await withEnv(
      { 'Inbox/idea.md': CANDIDATE },
      async (env) => {
        const res = await request(env.port, 'POST', '/api/v1/brain/candidates/Inbox%2Fidea.md/reject', { origin: 'https://brain.example', host: 'brain.example' });
        assert.equal(res.status, 200, res.body);
      },
      { host: '0.0.0.0', allowRemoteControl: true },
    );
  });

  it('rejects GET on the write routes with 405 and answers 404 brain_disabled without the brain', async () => {
    await withEnv({ 'Inbox/idea.md': CANDIDATE }, async (env) => {
      assert.equal((await request(env.port, 'GET', '/api/v1/brain/candidates/Inbox%2Fidea.md/approve')).status, 405);
      assert.equal((await request(env.port, 'GET', '/api/v1/brain/clashes/x/resolve')).status, 405);
      assert.equal(fs.readFileSync(path.join(env.vault, 'Inbox/idea.md'), 'utf8'), CANDIDATE);
    });
    await withEnv({}, async (env) => {
      for (const [method, url] of [
        ['GET', '/api/v1/brain/access'],
        ['GET', '/api/v1/brain/clashes'],
        ['POST', '/api/v1/brain/candidates/Inbox%2Fidea.md/approve'],
        ['POST', '/api/v1/brain/candidates/Inbox%2Fidea.md/reject'],
        ['POST', '/api/v1/brain/candidates/Lessons%2Fidea.md/revert'],
        ['POST', '/api/v1/brain/clashes/x/resolve'],
      ] as const) {
        const res = await request(env.port, method, url);
        assert.equal(res.status, 404, url);
        assert.equal(json(res).error.code, 'brain_disabled', url);
      }
    }, { brain: false });
  });
});

describe('GET /api/v1/brain/access (E7-6b)', () => {
  const row = (at: string, role: string, pathOrQuery: string, purpose?: string, op = 'read') =>
    `${JSON.stringify({ at, run: 'r', issue: 'acme/app#1', role, op, path_or_query: pathOrQuery, ...(purpose !== undefined ? { purpose } : {}), result: 'ok' })}\n`;
  const prepare = (log: string) => (_vault: string, logDir: string) => {
    fs.mkdirSync(path.join(logDir, 'brain'), { recursive: true });
    fs.writeFileSync(path.join(logDir, 'brain', 'access.jsonl'), log);
  };
  const paths = (res: Res): string[] => json(res).access.map((a: { path_or_query: string }) => a.path_or_query);

  const log =
    row('2026-10-30T10:00:00.000Z', 'developer', 'Lessons/Caching.md', 'tune') +
    row('2026-10-30T11:00:00.000Z', 'architect', 'Decisions/d.md', 'about CACHING') +
    row('2026-10-30T12:00:00.000Z', 'developer', 'Inbox/x.md') +
    row('2026-10-30T13:00:00.000Z', 'tester', 'cache invalidation', 'verify', 'search') +
    row('2026-10-30T14:00:00.000Z', 'developer', 'Lessons/other.md', '');

  it('lists newest first, and filters by role', async () => {
    await withEnv({}, async (env) => {
      const all = await request(env.port, 'GET', '/api/v1/brain/access');
      assert.equal(all.status, 200);
      assert.deepEqual(paths(all), ['Lessons/other.md', 'cache invalidation', 'Inbox/x.md', 'Decisions/d.md', 'Lessons/Caching.md']);
      assert.deepEqual(paths(await request(env.port, 'GET', '/api/v1/brain/access?role=developer')), ['Lessons/other.md', 'Inbox/x.md', 'Lessons/Caching.md']);
      assert.deepEqual(paths(await request(env.port, 'GET', '/api/v1/brain/access?role=tester')), ['cache invalidation']);
      assert.deepEqual(paths(await request(env.port, 'GET', '/api/v1/brain/access?role=nobody')), []);
    }, { prepare: prepare(log) });
  });

  it('filters by q over path_or_query and purpose, combinable with role', async () => {
    await withEnv({}, async (env) => {
      assert.deepEqual(paths(await request(env.port, 'GET', '/api/v1/brain/access?q=caching')), ['Decisions/d.md', 'Lessons/Caching.md']);
      assert.deepEqual(paths(await request(env.port, 'GET', '/api/v1/brain/access?q=verify')), ['cache invalidation']);
      assert.deepEqual(paths(await request(env.port, 'GET', '/api/v1/brain/access?q=cache')), ['cache invalidation']);
      assert.deepEqual(paths(await request(env.port, 'GET', '/api/v1/brain/access?q=caching&role=architect')), ['Decisions/d.md']);
      assert.deepEqual(paths(await request(env.port, 'GET', '/api/v1/brain/access?q=caching&role=tester')), []);
    }, { prepare: prepare(log) });
  });

  it('delivers an empty or missing purpose as the string ""', async () => {
    await withEnv({}, async (env) => {
      const rows = json(await request(env.port, 'GET', '/api/v1/brain/access')).access;
      for (const r of rows) assert.equal(typeof r.purpose, 'string');
      assert.equal(rows.find((r: { path_or_query: string }) => r.path_or_query === 'Inbox/x.md').purpose, '');
      assert.equal(rows.find((r: { path_or_query: string }) => r.path_or_query === 'Lessons/other.md').purpose, '');
    }, { prepare: prepare(log) });
  });

  it('honours limit, pages with before/next_before without gaps or duplicates and ignores bad parameters', async () => {
    await withEnv({}, async (env) => {
      const seen: string[] = [];
      let before: number | null = null;
      let pages = 0;
      do {
        const res = await request(env.port, 'GET', `/api/v1/brain/access?limit=2${before === null ? '' : `&before=${before}`}`);
        const body = json(res);
        assert.ok(body.access.length <= 2);
        seen.push(...paths(res));
        before = body.next_before;
        pages++;
      } while (before !== null && pages < 10);
      assert.equal(pages, 3);
      assert.deepEqual(seen, ['Lessons/other.md', 'cache invalidation', 'Inbox/x.md', 'Decisions/d.md', 'Lessons/Caching.md']);
      assert.equal(json(await request(env.port, 'GET', '/api/v1/brain/access?limit=1000')).access.length, 5);
      for (const bad of ['limit=abc', 'limit=-3', 'limit=0', 'before=zzz']) {
        const res = await request(env.port, 'GET', `/api/v1/brain/access?${bad}`);
        assert.ok(res.status === 200 || res.status === 400, `${bad}: ${res.status}`);
      }
      assert.equal((await request(env.port, 'POST', '/api/v1/brain/access')).status, 405);
    }, { prepare: prepare(log) });
  });

  it('caps the page size', async () => {
    const many = Array.from({ length: 650 }, (_, i) => row(`2026-10-30T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`, 'developer', `Lessons/n${i}.md`, 'p')).join('');
    await withEnv({}, async (env) => {
      const dflt = json(await request(env.port, 'GET', '/api/v1/brain/access'));
      assert.equal(dflt.access.length, 100, 'default 100');
      assert.notEqual(dflt.next_before, null);
      const huge = json(await request(env.port, 'GET', '/api/v1/brain/access?limit=100000'));
      assert.ok(huge.access.length < 650, `capped, got ${huge.access.length}`);
      assert.equal(huge.access[0].path_or_query, 'Lessons/n649.md');
    }, { prepare: prepare(many) });
  });

  it('survives garbage lines in the log', async () => {
    await withEnv({}, async (env) => {
      const res = await request(env.port, 'GET', '/api/v1/brain/access');
      assert.equal(res.status, 200);
      assert.deepEqual(paths(res), ['Lessons/b.md', 'Lessons/a.md']);
    }, { prepare: prepare(`${row('2026-10-30T10:00:00.000Z', 'developer', 'Lessons/a.md', 'p')}not json\n{"half":\n\n${row('2026-10-30T11:00:00.000Z', 'developer', 'Lessons/b.md', 'p')}`) });
  });
});

describe('GET /api/v1/brain/clashes and resolve (E7-6b)', () => {
  const clashLine = (id: string, at: string, p: string) =>
    `${JSON.stringify({ at, run: 'run2', issue: 'acme/app#1', role: 'developer', op: 'write', path_or_query: p, purpose: '', result: 'rejected', reason: 'window', clash_id: id, other_run: 'run1', other_at: at })}\n`;

  it('lists an open clash from the log with the versions, filters by status and resolves it', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const prepare = (_v: string, logDir: string) => {
      fs.mkdirSync(path.join(logDir, 'brain'), { recursive: true });
      fs.writeFileSync(path.join(logDir, 'brain', 'access.jsonl'), clashLine('c-1', future, 'Inbox/idea.md'));
    };
    await withEnv({ 'Inbox/idea.md': CANDIDATE }, async (env) => {
      const list = await request(env.port, 'GET', '/api/v1/brain/clashes');
      assert.equal(list.status, 200, list.body);
      const [clash] = json(list).clashes;
      assert.equal(clash.id, 'c-1');
      assert.equal(clash.path, 'Inbox/idea.md');
      assert.equal(clash.status, 'open');
      assert.ok('base' in clash && 'attempted' in clash && 'current' in clash, 'both versions plus the current one are delivered');
      assert.equal(clash.current.content, CANDIDATE);
      assert.equal(clash.base.content, CANDIDATE, 'base from git when no stored version');

      assert.equal(json(await request(env.port, 'GET', '/api/v1/brain/clashes?status=open')).clashes.length, 1);
      assert.equal(json(await request(env.port, 'GET', '/api/v1/brain/clashes?status=resolved')).clashes.length, 0);
      assert.equal((await request(env.port, 'GET', '/api/v1/brain/clashes?status=bogus')).status, 400);

      const unknown = await request(env.port, 'POST', '/api/v1/brain/clashes/unknown/resolve');
      assert.equal(unknown.status, 404);
      const ok = await request(env.port, 'POST', '/api/v1/brain/clashes/c-1/resolve');
      assert.equal(ok.status, 200, ok.body);
      assert.equal((await request(env.port, 'POST', '/api/v1/brain/clashes/c-1/resolve')).status, 409);
      assert.equal(json(await request(env.port, 'GET', '/api/v1/brain/clashes?status=open')).clashes.length, 0);
      const resolved = json(await request(env.port, 'GET', '/api/v1/brain/clashes?status=resolved')).clashes;
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0].status, 'resolved');
    }, { prepare });
  });

  it('keeps a resolved clash resolved after a restart (the resolve is logged)', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const prepare = (_v: string, logDir: string) => {
      fs.mkdirSync(path.join(logDir, 'brain'), { recursive: true });
      fs.writeFileSync(path.join(logDir, 'brain', 'access.jsonl'), clashLine('c-9', future, 'Inbox/idea.md'));
    };
    const first = await setup({ 'Inbox/idea.md': CANDIDATE }, { prepare });
    try {
      assert.equal((await request(first.port, 'POST', '/api/v1/brain/clashes/c-9/resolve')).status, 200);
    } finally {
      await first.close();
    }
    const log = new BrainAccessLog(path.join(first.logDir, 'brain'), Logger.silent());
    log.load(new Date());
    assert.equal(log.clash('c-9')?.status, 'resolved');
  });

  it('shows the rejected content of a real rejected write (tool result) next to the version in the vault', async () => {
    const dir = { logBrain: '' };
    const prepare = async (vault: string, logDir: string) => {
      dir.logBrain = path.join(logDir, 'brain');
      const access = new BrainAccessLog(dir.logBrain, Logger.silent());
      const specs = createBrainWriteTools(vault, Logger.silent(), { now: () => new Date(), access, clashWindowMs: 10 * 60_000, versioning: createVaultGit(vault, Logger.silent()) });
      const write = specs.find((s) => s.name === 'brain_write')!;
      const ctx = (run: string): AgentToolContext => ({ issue: makeIssue({ id: 'a' }), role: 'developer', runId: run });
      const first = await write.execute({ purpose: 'p', path: 'Inbox/clash.md', content: note('type: lesson\nstatus: candidate', 'FIRST VERSION\n') }, ctx('run1'));
      assert.ok(first.ok);
      const second = await write.execute({ purpose: 'p', path: 'Inbox/clash.md', content: note('type: lesson\nstatus: candidate', 'SECOND REJECTED VERSION\n') }, ctx('run2'));
      assert.equal(second.ok, false);
    };
    await withEnv({}, async (env) => {
      const clashes = json(await request(env.port, 'GET', '/api/v1/brain/clashes')).clashes;
      assert.equal(clashes.length, 1);
      const [clash] = clashes;
      assert.equal(clash.path, 'Inbox/clash.md');
      assert.equal(clash.status, 'open');
      assert.deepEqual(clash.runs, ['run1', 'run2']);
      assert.match(clash.attempted.content, /SECOND REJECTED VERSION/);
      assert.match(clash.current.content, /FIRST VERSION/);
      assert.doesNotMatch(clash.current.content, /SECOND REJECTED/);
      assert.match(clash.base.content, /FIRST VERSION/);
    }, { prepare });
  });
});
