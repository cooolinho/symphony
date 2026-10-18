import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { resolveTransition, type TransitionInput, type TransitionOutcome, type TransitionProfile } from '../src/orchestrator/transitions.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { resolveConfig, type ServiceConfig } from '../src/workflow/config.ts';
import { AGENT_RESULT_KINDS, RESULT_VERDICTS } from '../src/workflow/results.ts';
import type { RoleConfig } from '../src/workflow/roles.ts';
import { profileFor } from '../src/workflow/profile.ts';
import { nextStageProblems } from '../src/workflow/validate.ts';

const resolve = (front: Record<string, unknown>): ServiceConfig =>
  resolveConfig(front, { workflowPath: path.join('/srv/flows', 'WORKFLOW.md'), env: {}, trackerDefaults });

const BOARD = ['Backlog', 'Ready', 'In progress', 'Testing', 'Agent review', 'Security review', 'Blocked', 'In review', 'Done'];

const config = resolve({
  tracker: { kind: 'github', active_states: ['Ready', 'In progress', 'Testing', 'Agent review', 'Security review'], terminal_states: ['Done'] },
  roles: {
    analyst: { states: ['Ready'], result: 'analysis', may_move_to: ['In progress', 'Blocked'], on_result: { ready: 'next', needs_info: 'Blocked' } },
    developer: { states: ['In progress'], result: 'implementation', may_move_to: ['Testing', 'Agent review', 'Blocked'], on_result: { done: 'next' } },
    tester: { states: ['Testing'], result: 'test', may_move_to: ['Agent review', 'Blocked'], on_result: { passed: 'next', failed: 'In progress' } },
    'quick-tester': { states: ['Testing'], commands: ['quick'], result: 'test', may_move_to: ['Agent review', 'Blocked'], on_result: { passed: 'next' } },
    reviewer: {
      states: ['Agent review'],
      read_only: true,
      result: 'review',
      may_move_to: ['In review', 'Blocked'],
      on_result: { approved: 'In review', changes_needed: 'In progress' },
      on_round_limit: 'In review',
    },
    security: { states: ['Security review'], result: 'security', may_move_to: ['In review', 'Blocked'], on_result: { passed: 'In review', issues_found: 'In progress' } },
  },
  pipeline: { max_review_rounds: 3, max_test_rounds: 2 },
});

const roleNamed = (name: string, from: ServiceConfig = config): RoleConfig => {
  const role = from.roles?.find((candidate) => candidate.name === name);
  assert.ok(role, `role ${name}`);
  return role;
};

const profile = (overrides: Partial<TransitionProfile> & { name: string }): TransitionProfile => ({
  skip: [],
  onResult: {},
  maxReviewRounds: null,
  maxTestRounds: null,
  ...overrides,
});

const PROFILES: Record<string, TransitionProfile | null> = {
  none: null,
  bugfix: profile({ name: 'bugfix', skip: ['tester', 'quick-tester'], maxReviewRounds: 2 }),
  strict: profile({ name: 'strict', onResult: { reviewer: { changes_needed: 'Blocked' }, developer: { blocked: 'Agent review' } }, maxTestRounds: 1 }),
};

const run = (role: string, verdict: string, over: Partial<TransitionInput> = {}): TransitionOutcome =>
  resolveTransition({
    role: roleNamed(role),
    verdict,
    history: { reviewRounds: 0, testRounds: 0 },
    profile: null,
    flags: {},
    config,
    boardColumns: BOARD,
    ...over,
  });

const ok = (outcome: TransitionOutcome) => {
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.problem);
  return outcome;
};

describe('resolveTransition', () => {
  describe('matrix of verdict × round × profile', () => {
    // [role, verdict, earlier rounds of the role's kind, profile, target, limitReached]
    const matrix: [string, string, number, keyof typeof PROFILES, string, boolean][] = [
      ['analyst', 'ready', 0, 'none', 'In progress', false],
      ['analyst', 'needs_info', 0, 'none', 'Blocked', false],
      ['developer', 'done', 0, 'none', 'Testing', false],
      ['developer', 'done', 0, 'bugfix', 'Agent review', false],
      ['developer', 'done', 0, 'strict', 'Testing', false],
      ['developer', 'blocked', 0, 'none', 'Blocked', false],
      ['developer', 'blocked', 0, 'strict', 'Agent review', false],
      ['tester', 'passed', 0, 'none', 'Agent review', false],
      ['tester', 'passed', 5, 'none', 'Agent review', false],
      ['tester', 'failed', 0, 'none', 'In progress', false],
      ['tester', 'failed', 1, 'none', 'Blocked', true],
      ['tester', 'failed', 4, 'none', 'Blocked', true],
      ['tester', 'failed', 0, 'strict', 'Blocked', true],
      ['tester', 'failed', 1, 'bugfix', 'Blocked', true],
      ['tester', 'blocked', 1, 'none', 'Blocked', false],
      ['reviewer', 'approved', 0, 'none', 'In review', false],
      ['reviewer', 'approved', 2, 'none', 'In review', false],
      ['reviewer', 'changes_needed', 0, 'none', 'In progress', false],
      ['reviewer', 'changes_needed', 1, 'none', 'In progress', false],
      ['reviewer', 'changes_needed', 2, 'none', 'In review', true],
      ['reviewer', 'changes_needed', 7, 'none', 'In review', true],
      ['reviewer', 'changes_needed', 0, 'bugfix', 'In progress', false],
      ['reviewer', 'changes_needed', 1, 'bugfix', 'In review', true],
      ['reviewer', 'changes_needed', 0, 'strict', 'Blocked', false],
      ['reviewer', 'changes_needed', 2, 'strict', 'In review', true],
      ['reviewer', 'blocked', 2, 'none', 'Blocked', false],
      ['security', 'passed', 0, 'none', 'In review', false],
      ['security', 'issues_found', 9, 'none', 'In progress', false],
    ];
    for (const [role, verdict, rounds, profileName, target, limitReached] of matrix) {
      it(`${role} ${verdict}, ${rounds} earlier round(s), profile ${profileName} → ${target}`, () => {
        const outcome = ok(run(role, verdict, { history: { reviewRounds: rounds, testRounds: rounds }, profile: PROFILES[profileName] ?? null }));
        assert.equal(outcome.target, target);
        assert.equal(outcome.limitReached, limitReached);
        assert.deepEqual(outcome.labels, limitReached ? { add: ['needs-human'], remove: [] } : { add: [], remove: ['needs-human'] });
      });
    }
  });

  it('counts the round from the persisted loop verdicts and leaves other kinds without one', () => {
    assert.equal(ok(run('reviewer', 'approved', { history: { reviewRounds: 2, testRounds: 0 } })).round, 3);
    assert.equal(ok(run('tester', 'failed', { history: { reviewRounds: 2, testRounds: 0 } })).round, 1);
    assert.equal(ok(run('developer', 'done')).round, null);
  });

  it('applies the rules in order: blocked, round limit, on_result', () => {
    assert.equal(ok(run('reviewer', 'blocked', { history: { reviewRounds: 9, testRounds: 9 } })).rule, 'blocked');
    const limit = ok(run('reviewer', 'changes_needed', { history: { reviewRounds: 2, testRounds: 0 } }));
    assert.equal(limit.rule, 'round_limit');
    assert.equal(limit.reason, 'review changes_needed (round 3 of 3) → "In review" (round limit reached, on_round_limit)');
    assert.equal(ok(run('reviewer', 'changes_needed')).rule, 'on_result');
  });

  it('sends the round limit to the blocked column without on_round_limit, with the configured label', () => {
    const labelled = { ...config, pipeline: { ...config.pipeline, limitLabel: 'stuck' } };
    const outcome = ok(run('tester', 'failed', { history: { reviewRounds: 0, testRounds: 1 }, config: labelled }));
    assert.deepEqual([outcome.target, outcome.labels.add, outcome.reason], ['Blocked', ['stuck'], 'test failed (round 2 of 2) → "Blocked" (round limit reached, blocked column)']);
  });

  it('sends a blocked verdict to on_result.blocked when it names a column, never to next', () => {
    const custom = { ...roleNamed('developer'), onResult: { done: 'next', blocked: 'Agent review' }, mayMoveTo: ['Testing', 'Agent review', 'Blocked'] };
    assert.equal(ok(run('developer', 'blocked', { role: custom })).target, 'Agent review');
    const next = { ...custom, onResult: { done: 'next', blocked: 'next' } };
    assert.equal(ok(run('developer', 'blocked', { role: next })).target, 'Blocked');
  });

  it('sends a verdict without a target, or an unknown one, to the blocked column', () => {
    const security = ok(run('security', 'blocked'));
    assert.deepEqual([security.target, security.rule], ['Blocked', 'blocked']);
    for (const verdict of ['not_a_verdict', 'toString', '__proto__']) {
      const outcome = ok(run('developer', verdict));
      assert.deepEqual([outcome.target, outcome.rule], ['Blocked', 'unmapped'], verdict);
      assert.match(outcome.reason, new RegExp(`no on_result target for ${verdict}`));
    }
  });

  it('falls back to on_missing_result when the roles share no blocked column', () => {
    const single = resolve({
      tracker: { kind: 'github', active_states: ['In progress', 'Agent review'], terminal_states: ['Done'] },
      roles: {
        developer: { states: ['In progress'] },
        reviewer: { states: ['Agent review'], result: 'review', on_result: { approved: 'In review' }, on_missing_result: 'Parked' },
      },
    });
    const outcome = ok(run('reviewer', 'blocked', { role: roleNamed('reviewer', single), config: single }));
    assert.deepEqual([outcome.target, outcome.reason], ['Parked', 'review blocked (round 1 of 3) → "Parked" (blocked column (on_missing_result))']);
  });

  describe('next', () => {
    it('passes over stages the profile skips or whose condition does not hold', () => {
      assert.equal(ok(run('developer', 'done', { flags: { tester: true } })).target, 'Testing');
      const skipped = ok(run('developer', 'done', { flags: { tester: false } }));
      assert.deepEqual([skipped.target, skipped.reason], ['Agent review', 'implementation done → "Agent review" (on_result.done = next, tester not needed)']);
      const profiled = ok(run('developer', 'done', { profile: PROFILES.bugfix ?? null }));
      assert.equal(profiled.reason, 'implementation done → "Agent review" (on_result.done = next, tester skipped by profile bugfix)');
    });

    it('asks roleFor which role serves a later column, so issue commands count', () => {
      const quickSkipped = profile({ name: 'quick', skip: ['quick-tester'] });
      assert.equal(ok(run('developer', 'done', { profile: quickSkipped, issue: { description: '/quick\nfast path' } })).target, 'Agent review');
      assert.equal(ok(run('developer', 'done', { profile: quickSkipped, issue: { description: 'no command' } })).target, 'Testing');
      assert.equal(ok(run('developer', 'done', { profile: quickSkipped })).target, 'Testing');
    });

    it('follows the board order, not the order of tracker.active_states', () => {
      const board = ['Ready', 'In progress', 'Agent review', 'Testing', 'Security review', 'Blocked', 'In review', 'Done'];
      assert.equal(ok(run('developer', 'done', { boardColumns: board })).target, 'Agent review');
      assert.equal(ok(run('developer', 'done', { boardColumns: board.filter((column) => column !== 'Agent review') })).target, 'Testing');
    });

    it('is a validation error without a known board order, and the resolver reports the same problem', () => {
      for (const boardColumns of [null, []]) {
        const outcome = run('developer', 'done', { boardColumns });
        assert.equal(outcome.ok, false);
        const problems = nextStageProblems(config, boardColumns);
        const message = `roles.developer.on_result.done: "next" needs the board's column order, which the tracker does not provide (name the column instead)`;
        assert.ok(problems.includes(message), problems.join('\n'));
        assert.equal(outcome.ok ? '' : outcome.problem, `implementation done: ${message}`);
      }
    });

    it('reports a pipeline whose later stages are all skipped', () => {
      const outcome = run('tester', 'passed', { flags: { reviewer: false, security: false } });
      assert.equal(outcome.ok ? '' : outcome.problem, 'test passed (round 1 of 2): roles.tester.on_result.passed: "next" has no later active stage after testing on the board (reviewer not needed, security not needed)');
    });

    it('reports a role whose columns are not on the board', () => {
      const outcome = run('developer', 'done', { boardColumns: ['Ready', 'Testing'] });
      assert.match(outcome.ok ? '' : outcome.problem, /roles\.developer\.on_result\.done: "next" needs the columns of role developer on the board/);
    });
  });

  describe('may_move_to invariant', () => {
    it('refuses a profile target outside may_move_to instead of returning it', () => {
      const outcome = run('reviewer', 'approved', { profile: profile({ name: 'odd', onResult: { reviewer: { approved: 'Testing' } } }) });
      assert.equal(outcome.ok ? '' : outcome.problem, 'review approved (round 1 of 3): role reviewer may not move issues to "Testing" (on_result.approved)');
    });

    it('refuses a next stage outside may_move_to, and validation reports it up front', () => {
      const tester = { ...roleNamed('tester'), mayMoveTo: ['Blocked'] };
      assert.equal(run('tester', 'passed', { role: tester }).ok, false);
      const narrow = resolve({
        tracker: { kind: 'github', active_states: ['In progress', 'Agent review'], terminal_states: ['Done'] },
        roles: {
          developer: { states: ['In progress'], result: 'implementation', may_move_to: ['Blocked'], on_result: { done: 'next' } },
          reviewer: { states: ['Agent review'] },
        },
      });
      assert.deepEqual(nextStageProblems(narrow, ['In progress', 'Agent review', 'Blocked', 'Done']), [
        'roles.developer.on_result.done: "next" leads to "Agent review", which is not in roles.developer.may_move_to (add it there)',
      ]);
    });

    it('rejects a role without a result', () => {
      const plain = { ...roleNamed('developer'), result: null };
      assert.equal(run('developer', 'done', { role: plain }).ok, false);
    });
  });
});

describe('profiles read from pipeline.profiles', () => {
  const profiled = resolve({
    tracker: { kind: 'github', active_states: ['Ready', 'In progress', 'Testing', 'Agent review', 'Security review'], terminal_states: ['Done'] },
    roles: {
      analyst: { states: ['Ready'], result: 'analysis', may_move_to: ['In progress', 'Blocked'], on_result: { ready: 'next', needs_info: 'Blocked' } },
      developer: { states: ['In progress'], result: 'implementation', may_move_to: ['Testing', 'Agent review', 'Blocked'], on_result: { done: 'next' } },
      tester: { states: ['Testing'], result: 'test', may_move_to: ['Agent review', 'In progress', 'Blocked'], on_result: { passed: 'next', failed: 'In progress' } },
      reviewer: {
        states: ['Agent review'],
        read_only: true,
        result: 'review',
        may_move_to: ['In review', 'In progress', 'Blocked'],
        on_result: { approved: 'In review', changes_needed: 'In progress' },
        on_round_limit: 'In review',
      },
      security: { states: ['Security review'], result: 'security', may_move_to: ['In review', 'In progress', 'Blocked'], on_result: { passed: 'In review', issues_found: 'In progress' } },
    },
    pipeline: {
      max_review_rounds: 3,
      profiles: {
        bugfix: { skip: ['tester', 'security'], max_review_rounds: 2 },
        refactor: { skip: ['analyst'], on_result: { reviewer: { changes_needed: 'Blocked' }, tester: { failed: 'Blocked' } } },
        default: { skip: ['security'] },
      },
    },
  });
  const resolveWith = (role: string, verdict: string, type: 'bugfix' | 'feature' | 'refactor' | null, over: Partial<TransitionInput> = {}) =>
    ok(
      resolveTransition({
        role: roleNamed(role, profiled),
        verdict,
        history: { reviewRounds: 0, testRounds: 0 },
        profile: profileFor(profiled.pipeline, type),
        flags: {},
        config: profiled,
        boardColumns: BOARD,
        ...over,
      }),
    );

  it('picks the profile of the issue type, else the default profile, else none', () => {
    assert.equal(profileFor(profiled.pipeline, 'bugfix')?.name, 'bugfix');
    assert.equal(profileFor(profiled.pipeline, 'refactor')?.name, 'refactor');
    assert.equal(profileFor(profiled.pipeline, 'feature')?.name, 'default');
    assert.equal(profileFor(profiled.pipeline, null)?.name, 'default');
    assert.equal(profileFor(config.pipeline, 'bugfix'), null);
    assert.equal(profileFor(config.pipeline, null), null);
  });

  it('skips Testing for a profile with skip: [tester] and keeps it for the others', () => {
    const bugfix = resolveWith('developer', 'done', 'bugfix');
    assert.deepEqual([bugfix.target, bugfix.reason], ['Agent review', 'implementation done → "Agent review" (on_result.done = next, tester skipped by profile bugfix)']);
    assert.equal(resolveWith('developer', 'done', 'feature').target, 'Testing');
    assert.equal(resolveWith('developer', 'done', null).target, 'Testing');
  });

  it('matrix: next target per type', () => {
    // [role, verdict, type, target]
    const matrix: [string, string, 'bugfix' | 'feature' | 'refactor' | null, string][] = [
      ['analyst', 'ready', 'bugfix', 'In progress'],
      ['analyst', 'ready', 'refactor', 'In progress'],
      ['developer', 'done', 'bugfix', 'Agent review'],
      ['developer', 'done', 'feature', 'Testing'],
      ['developer', 'done', 'refactor', 'Testing'],
      ['tester', 'passed', 'feature', 'Agent review'],
      ['tester', 'passed', 'refactor', 'Agent review'],
      ['tester', 'failed', 'feature', 'In progress'],
      ['tester', 'failed', 'refactor', 'Blocked'],
      ['reviewer', 'changes_needed', 'bugfix', 'In progress'],
      ['reviewer', 'changes_needed', 'feature', 'In progress'],
      ['reviewer', 'changes_needed', 'refactor', 'Blocked'],
      ['reviewer', 'approved', 'refactor', 'In review'],
    ];
    for (const [role, verdict, type, target] of matrix) {
      assert.equal(resolveWith(role, verdict, type).target, target, `${role} ${verdict} for ${type}`);
    }
  });

  it('applies the profile round limit', () => {
    const bugfix = resolveWith('reviewer', 'changes_needed', 'bugfix', { history: { reviewRounds: 1, testRounds: 0 } });
    assert.deepEqual([bugfix.target, bugfix.limitReached], ['In review', true]);
    const feature = resolveWith('reviewer', 'changes_needed', 'feature', { history: { reviewRounds: 1, testRounds: 0 } });
    assert.deepEqual([feature.target, feature.limitReached], ['In progress', false]);
  });

  it('validates `next` per profile against the board', () => {
    assert.deepEqual(nextStageProblems(profiled, BOARD), []);
  });
});

/** Deterministic PRNG (mulberry32), so a failing generated case reproduces. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('resolveTransition over generated inputs', () => {
  const COLUMNS = ['A', 'B', 'C', 'D', 'E', 'Blocked', 'Review', 'Done'];
  const ACTIVE_POOL = ['A', 'B', 'C', 'D', 'E'];
  const TERMINAL = ['Done'];

  it('never yields a column outside may_move_to, and fails only where validation already complains', () => {
    const rand = random(186);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
    const subset = <T>(items: readonly T[], p = 0.5): T[] => items.filter(() => rand() < p);
    const shuffle = <T>(items: readonly T[]): T[] => items.map((item) => ({ item, at: rand() })).sort((a, b) => a.at - b.at).map(({ item }) => item);
    const target = (): string => pick([...COLUMNS, 'next', 'next']);

    const seen = { cases: 0, ok: 0, problems: 0, rules: new Set<string>(), limits: 0 };
    for (let i = 0; i < 3000; i++) {
      const active = shuffle(ACTIVE_POOL).slice(0, 1 + Math.floor(rand() * ACTIVE_POOL.length));
      const roleCount = 1 + Math.floor(rand() * Math.min(3, active.length));
      const states: string[][] = Array.from({ length: roleCount }, () => []);
      active.forEach((column, index) => (states[index < roleCount ? index : Math.floor(rand() * roleCount)] as string[]).push(column));
      const roles: Record<string, Record<string, unknown>> = {};
      states.forEach((owned, index) => {
        const role: Record<string, unknown> = { states: owned };
        if (rand() < 0.8) {
          const kind = pick(AGENT_RESULT_KINDS);
          role.result = kind;
          role.on_result = Object.fromEntries(subset(RESULT_VERDICTS[kind], 0.7).map((verdict) => [verdict, target()]));
          if ((kind === 'review' || kind === 'test') && rand() < 0.5) role.on_round_limit = pick(COLUMNS.filter((column) => column !== 'Done'));
          if (rand() < 0.3) role.on_missing_result = pick(['Blocked', 'Review', 'A']);
        }
        if (rand() < 0.8) role.may_move_to = subset(COLUMNS.filter((column) => column !== 'Done'));
        roles[`r${index}`] = role;
      });
      let generated: ServiceConfig;
      try {
        generated = resolve({
          tracker: { kind: 'github', active_states: active, terminal_states: TERMINAL },
          roles,
          pipeline: { max_review_rounds: 1 + Math.floor(rand() * 3), max_test_rounds: 1 + Math.floor(rand() * 3) },
        });
      } catch {
        continue; // an invalid config never reaches the resolver
      }
      const boardColumns = rand() < 0.15 ? null : rand() < 0.2 ? shuffle(COLUMNS).slice(0, 4) : shuffle(COLUMNS);
      const names = (generated.roles ?? []).map((role) => role.name);
      for (const role of generated.roles ?? []) {
        if (role.result === null) continue;
        const withProfile = rand() < 0.5;
        const flags = Object.fromEntries(subset(names, 0.3).map((name) => [name, rand() < 0.5]));
        const input: TransitionInput = {
          role,
          verdict: rand() < 0.1 ? 'unknown' : pick(RESULT_VERDICTS[role.result]),
          history: { reviewRounds: Math.floor(rand() * 5), testRounds: Math.floor(rand() * 5) },
          profile: withProfile
            ? profile({
                name: 'generated',
                skip: subset(names, 0.3),
                onResult: rand() < 0.5 ? { [role.name]: Object.fromEntries(subset(RESULT_VERDICTS[role.result]).map((verdict) => [verdict, target()])) } : {},
                maxReviewRounds: rand() < 0.5 ? 1 + Math.floor(rand() * 3) : null,
                maxTestRounds: rand() < 0.5 ? 1 + Math.floor(rand() * 3) : null,
              })
            : null,
          flags,
          config: generated,
          boardColumns,
        };
        const outcome = resolveTransition(input);
        const context = JSON.stringify({ roles, active, boardColumns, role: role.name, verdict: input.verdict, profile: input.profile, flags: input.flags });
        seen.cases++;
        if (outcome.ok) {
          seen.ok++;
          seen.rules.add(outcome.rule);
          if (outcome.limitReached) seen.limits++;
          assert.ok(!TERMINAL.includes(outcome.target), `terminal target ${outcome.target}: ${context}`);
          if (role.mayMoveTo !== null) {
            assert.ok(role.mayMoveTo.some((column) => column.toLowerCase() === outcome.target.toLowerCase()), `target ${outcome.target} outside may_move_to: ${context}`);
          }
          assert.equal(outcome.labels.add.includes(generated.pipeline.limitLabel), outcome.limitReached, context);
          assert.equal(outcome.rule === 'round_limit', outcome.limitReached, context);
        } else {
          seen.problems++;
          // Profiles and conditions are runtime data; without them every failure is a config the validation rejects.
          if (!withProfile && !Object.values(flags).includes(false)) {
            const path = `roles.${role.name}.on_result.${input.verdict}`;
            assert.ok(nextStageProblems(generated, boardColumns).some((problem) => problem.startsWith(path)), `runtime-only problem "${outcome.problem}": ${context}`);
          }
        }
      }
    }
    assert.ok(seen.cases > 1000, `only ${seen.cases} generated cases`);
    assert.ok(seen.ok > 500 && seen.problems > 20 && seen.limits > 20, JSON.stringify({ ...seen, rules: [...seen.rules] }));
    assert.deepEqual([...seen.rules].sort(), ['blocked', 'on_result', 'round_limit', 'unmapped']);
  });
});
