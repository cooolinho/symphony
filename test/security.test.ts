import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { securityBaseRef, securityNeeded, type SecurityFacts } from '../src/orchestrator/security.ts';

// The trigger of the security review (docs/configuration.md#the-security-auditor).

const PATHS = ['app/Policies/**', 'app/Http/Middleware/**', 'config/auth.php', 'routes/**', 'database/migrations/**'];

function facts(overrides: Partial<SecurityFacts> & { files?: string[] | Error } = {}): SecurityFacts & { calls: number } {
  const { files = ['README.md'], ...rest } = overrides;
  const result = {
    risk: false,
    labels: [] as string[],
    securityPaths: PATHS,
    calls: 0,
    changedFiles: async () => {
      result.calls += 1;
      if (files instanceof Error) throw files;
      return files;
    },
    ...rest,
  };
  return result;
}

describe('securityNeeded', () => {
  it('needs the review for a changed policy', async () => {
    const decision = await securityNeeded(facts({ files: ['README.md', 'app/Policies/PostPolicy.php'] }));
    assert.equal(decision.needed, true);
    assert.match(decision.reason, /1 changed file\(s\) match pipeline\.security_paths: app\/Policies\/PostPolicy\.php/);
  });

  it('skips a docs-only diff', async () => {
    const decision = await securityNeeded(facts({ files: ['README.md', 'docs/usage.md'] }));
    assert.deepEqual(decision, { needed: false, reason: 'no trigger (none of 2 changed file(s) matches pipeline.security_paths)' });
  });

  it('skips an empty diff', async () => {
    assert.equal((await securityNeeded(facts({ files: [] }))).needed, false);
  });

  for (const file of ['app/Http/Middleware/Authenticate.php', 'config/auth.php', 'routes/web.php', 'database/migrations/2026_01_01_create_posts.php']) {
    it(`matches the Laravel default ${file}`, async () => {
      assert.equal((await securityNeeded(facts({ files: [file] }))).needed, true);
    });
  }

  it('does not match look-alikes of the defaults', async () => {
    const decision = await securityNeeded(facts({ files: ['config/authentication.md', 'docs/routes/overview.md', 'app/PoliciesGuide.md'] }));
    assert.equal(decision.needed, false);
  });

  it('is triggered by the security label alone, trimmed and case-insensitive, without asking git', async () => {
    for (const label of ['security', 'Security', ' SECURITY ']) {
      const input = facts({ labels: ['feature', label] });
      const decision = await securityNeeded(input);
      assert.deepEqual([decision.needed, input.calls], [true, 0], label);
      assert.match(decision.reason, /"security" label/);
    }
  });

  it('does not treat other labels as the security label', async () => {
    const decision = await securityNeeded(facts({ labels: ['area:security', 'Security: high', 'insecure'] }));
    assert.equal(decision.needed, false);
  });

  it('is triggered by the risk of the analysis alone, without asking git', async () => {
    const input = facts({ risk: true });
    const decision = await securityNeeded(input);
    assert.deepEqual([decision.needed, decision.reason, input.calls], [true, 'the analysis flags a security risk', 0]);
  });

  it('turns the path trigger off with an empty list, without asking git', async () => {
    const input = facts({ securityPaths: [], files: ['app/Policies/PostPolicy.php'] });
    const decision = await securityNeeded(input);
    assert.deepEqual([decision.needed, input.calls], [false, 0]);
    assert.match(decision.reason, /pipeline\.security_paths is empty/);
    assert.equal((await securityNeeded({ ...input, securityPaths: [], risk: true })).needed, true, 'the other triggers still apply');
  });

  it('uses an explicit list instead of the defaults', async () => {
    const decision = await securityNeeded(facts({ securityPaths: ['src/auth/**'], files: ['app/Policies/PostPolicy.php'] }));
    assert.equal(decision.needed, false);
    assert.equal((await securityNeeded(facts({ securityPaths: ['src/auth/**'], files: ['src/auth/Login.ts'] }))).needed, true);
  });

  it('fails safe: when the changed files cannot be determined the review is needed, and the reason says why', async () => {
    const decision = await securityNeeded(facts({ files: new Error('git could not list the files changed against origin/develop: unknown revision') }));
    assert.equal(decision.needed, true);
    assert.match(decision.reason, /changed files could not be determined \(git could not list the files changed against origin\/develop: unknown revision\), reviewing to be safe/);
  });

  it('names at most five matching files', async () => {
    const files = Array.from({ length: 8 }, (_, i) => `routes/r${i}.php`);
    const decision = await securityNeeded(facts({ files }));
    assert.match(decision.reason, /^8 changed file\(s\) match pipeline\.security_paths: routes\/r0\.php, .*routes\/r4\.php, …$/);
    assert.doesNotMatch(decision.reason, /r5/);
  });
});

describe('securityBaseRef', () => {
  it('is origin/<base_branch> or the remote default branch', () => {
    assert.equal(securityBaseRef('develop'), 'origin/develop');
    assert.equal(securityBaseRef(' develop '), 'origin/develop');
    assert.equal(securityBaseRef(null), 'origin/HEAD');
    assert.equal(securityBaseRef(''), 'origin/HEAD');
    assert.equal(securityBaseRef(undefined), 'origin/HEAD');
  });
});
