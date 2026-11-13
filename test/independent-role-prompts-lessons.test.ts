import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PricingStore } from '../src/costs/pricing.ts';
import { HistoryLog } from '../src/history/history.ts';
import { startHttpServer, type HttpServerHandle } from '../src/http/server.ts';
import { Logger } from '../src/log.ts';
import { Orchestrator } from '../src/orchestrator/orchestrator.ts';
import { commandSkills } from '../src/workflow/command.ts';
import { loadWorkflowFile } from '../src/workflow/loader.ts';
import { compilePrompt, issueTemplateValue, renderPrompt } from '../src/workflow/template.ts';
import { FakeRunner, FakeTracker, ManualTimers, StaticWorkflow, baseFront, makeIssue, makeWorkflow, tempDir } from './helpers.ts';

// Independent tests for #575 group C: the shipped role prompts render recurring findings and brain lessons.

const root = path.join(import.meta.dirname, '..');
const shipped = path.join(root, 'WORKFLOW.md');
const toolbox = path.join(root, '.claude');

const FINDING = { severity: 'major', file: 'src/a.ts', line: 7, problem: 'Screenshots fehlen im PR.', fix: 'Add them.', category: 'screenshots-missing' };
const FINDING_PLAIN = { severity: 'major', file: 'src/b.ts', line: 3, problem: 'Plain problem.', fix: 'Fix it.' };

const RECURRING = [
  {
    category: 'base-branch-conflict',
    triggers: ['same_issue', 'cross_issue'],
    findings: 3,
    issues: ['acme/app#11', 'acme/app#12'],
    examples: [{ issue: 'acme/app#11', problem: 'Branch conflicts with base.' }],
    lesson: { path: 'Lessons/base-branch-conflict.md', status: 'approved', title: 'Rebase early' },
  },
  {
    category: 'tests-outside-test-paths',
    triggers: ['cross_issue'],
    findings: 2,
    issues: ['acme/app#13', 'acme/app#14'],
    examples: [{ issue: 'acme/app#13', problem: 'Tests live outside test paths.' }],
    lesson: null,
  },
];
const KNOWN = [
  { category: 'screenshots-missing', issues: ['acme/app#1', 'acme/app#2'] },
  { category: 'zzz-unique-known-slug', issues: ['acme/app#3'] },
];

const LESSONS = {
  lessons: [
    { title: 'Rebase early', path: 'Lessons/rebase-early.md', status: 'approved', candidate: false, categories: ['base-branch-conflict'], rule: 'Rebase onto the base branch before the first push.' },
    { title: 'Check screenshots', path: 'Lessons/screens.md', status: 'candidate', candidate: true, categories: ['screenshots-missing'], rule: 'Attach screenshots for every UI change.' },
  ],
  more: ['Lessons/extra-one.md', 'Lessons/extra-two.md'],
  total: 4,
};

async function render(role: string, extra: Record<string, unknown> = {}, labels: string[] = ['feature', 'complexity: m']): Promise<string> {
  const { definition } = await loadWorkflowFile(shipped);
  const template = compilePrompt(definition.promptTemplate, definition.partials);
  assert.equal(template.parseError, null);
  const issue = makeIssue({ id: 'PVTI_1', identifier: 'acme/app#42', title: 'Add invoices', description: 'Create it.', state: 'In progress', labels });
  return renderPrompt(template, {
    issue: issueTemplateValue(issue, commandSkills([toolbox])),
    attempt: null,
    role,
    agents: [],
    project_types: [],
    ...extra,
  });
}

describe('reviewer and security auditor: recurring findings', () => {
  for (const role of ['reviewer', 'security-auditor']) {
    it(`${role}: shows the recurring-findings section with category, issues and lesson path when the list is non-empty`, async () => {
      const prompt = await render(role, { brain: 'write', recurring_findings: RECURRING, known_categories: KNOWN });
      assert.match(prompt, /Recurring findings/);
      assert.match(prompt, /base-branch-conflict/);
      assert.match(prompt, /acme\/app#11/);
      assert.match(prompt, /acme\/app#12/);
      assert.match(prompt, /Lessons\/base-branch-conflict\.md/);
      assert.match(prompt, /tests-outside-test-paths/);
      assert.match(prompt, /acme\/app#14/);
    });

    it(`${role}: shows no recurring-findings section for an empty list`, async () => {
      const prompt = await render(role, { brain: 'write', recurring_findings: [], known_categories: KNOWN });
      assert.doesNotMatch(prompt, /## Recurring findings/);
      assert.doesNotMatch(prompt, /Lessons\/base-branch-conflict\.md/);
      assert.doesNotMatch(prompt, /base-branch-conflict` \(/);
    });

    it(`${role}: lists the known repository categories so equal patterns get equal names`, async () => {
      const prompt = await render(role, { brain: 'write', recurring_findings: [], known_categories: KNOWN });
      assert.match(prompt, /zzz-unique-known-slug/);
      assert.match(prompt, /screenshots-missing/);
      const without = await render(role, { brain: 'write', recurring_findings: [], known_categories: [] });
      assert.doesNotMatch(without, /zzz-unique-known-slug/);
    });

    it(`${role}: asks for a kebab-case category on major and blocker findings and a lessons field`, async () => {
      const prompt = await render(role, { brain: 'write' });
      assert.match(prompt, /`category`/);
      assert.match(prompt, /kebab-case/);
      assert.match(prompt, /blocker/);
      assert.match(prompt, /`lessons`/);
    });
  }

  it('reviewer rule text: brain_write into Lessons/ with tags review-lesson and review/<category>, or brain_append', async () => {
    const prompt = await render('reviewer', { brain: 'write', recurring_findings: RECURRING });
    assert.match(prompt, /brain_write/);
    assert.match(prompt, /brain_append/);
    assert.match(prompt, /`Lessons\/`/);
    assert.match(prompt, /review-lesson/);
    assert.match(prompt, /review\/<category>/);
    assert.match(prompt, /repo/);
    assert.match(prompt, /rule or check step/);
    assert.match(prompt, /no log/);
  });

  it('with brain off the reviewer prompt gives no brain_write or lesson-writing instruction', async () => {
    for (const recurring of [[], RECURRING]) {
      const prompt = await render('reviewer', { brain: 'off', recurring_findings: recurring });
      assert.doesNotMatch(prompt, /brain_write/);
      assert.doesNotMatch(prompt, /brain_append/);
      assert.doesNotMatch(prompt, /review-lesson/);
    }
  });

  it('with brain read the security-auditor prompt cannot be told to write to the vault', async () => {
    const prompt = await render('security-auditor', { brain: 'read', recurring_findings: RECURRING });
    assert.doesNotMatch(prompt, /brain_write` a new/);
    const off = await render('security-auditor', { brain: 'off', recurring_findings: RECURRING });
    assert.doesNotMatch(off, /brain_write/);
    assert.doesNotMatch(off, /review-lesson/);
  });
});

describe('developer, test-engineer and architect: brain_lessons', () => {
  const roles = ['developer', 'test-engineer', 'architect'];

  for (const role of roles) {
    it(`${role}: renders title, path and rule per lesson, marks candidates and lists the rest by path`, async () => {
      const prompt = await render(role, { brain: 'read', brain_lessons: LESSONS });
      for (const lesson of LESSONS.lessons) {
        assert.ok(prompt.includes(lesson.title), lesson.title);
        assert.ok(prompt.includes(lesson.path), lesson.path);
        assert.ok(prompt.includes(lesson.rule), lesson.rule);
      }
      assert.match(prompt, /candidate: check it against the code/);
      // only the candidate carries the marker
      assert.equal(prompt.split('candidate: check it against the code').length - 1, 1);
      const approvedLine = prompt.split('\n').find((l) => l.includes('Lessons/rebase-early.md'))!;
      assert.doesNotMatch(approvedLine, /candidate/);
      assert.ok(prompt.includes('Lessons/extra-one.md'));
      assert.ok(prompt.includes('Lessons/extra-two.md'));
    });

    it(`${role}: renders no lessons block for null`, async () => {
      const prompt = await render(role, { brain: 'read', brain_lessons: null });
      assert.doesNotMatch(prompt, /\n## Lessons of this repository/);
      assert.doesNotMatch(prompt, /candidate: check it against the code/);
      assert.doesNotMatch(prompt, /Lessons\/rebase-early\.md/);
    });

    it(`${role}: renders no lessons block for an empty lesson list`, async () => {
      const prompt = await render(role, { brain: 'read', brain_lessons: { lessons: [], more: [], total: 0 } });
      assert.doesNotMatch(prompt, /\n## Lessons of this repository/);
      assert.doesNotMatch(prompt, /candidate: check it against the code/);
    });
  }

  it('developer: the lessons block comes before the open findings and findings show their category', async () => {
    const prompt = await render('developer', {
      brain: 'write',
      brain_lessons: LESSONS,
      results: { open_findings: [FINDING, FINDING_PLAIN], security_findings: [] },
      round: 2,
    });
    const lessonsAt = prompt.indexOf('Lessons/rebase-early.md');
    const findingsAt = prompt.indexOf('Open findings of the latest agent review');
    assert.ok(lessonsAt >= 0, 'lessons rendered');
    assert.ok(findingsAt >= 0, 'findings rendered');
    assert.ok(lessonsAt < findingsAt, 'lessons first');
    assert.match(prompt, /screenshots-missing/);
    const line = prompt.split('\n').find((l) => l.includes('Screenshots fehlen im PR.'))!;
    assert.match(line, /screenshots-missing/);
    const plain = prompt.split('\n').find((l) => l.includes('Plain problem.'))!;
    assert.doesNotMatch(plain, /null|undefined/);
  });

  it('developer: without open findings there is no findings heading', async () => {
    const prompt = await render('developer', { brain: 'read', brain_lessons: LESSONS });
    assert.doesNotMatch(prompt, /Open findings of the latest agent review/);
  });
});

describe('developer brain search rule', () => {
  it('with the brain on, the developer must brain_search before the first change', async () => {
    for (const brain of ['read', 'write']) {
      const prompt = await render('developer', { brain });
      assert.match(prompt, /Before your first change, run `brain_search`/);
    }
  });

  it('in a rework round the developer reads the lessons of the finding categories and names the lesson in the notes', async () => {
    const prompt = await render('developer', { brain: 'write', results: { open_findings: [FINDING], security_findings: [] }, round: 2 });
    assert.match(prompt, /rework round/);
    assert.match(prompt, /read the lessons for the categories of the open findings/);
    assert.match(prompt, /`notes`/);
    assert.match(prompt, /lessons? you followed/);
    const first = await render('developer', { brain: 'write' });
    assert.doesNotMatch(first, /read the lessons for the categories of the open findings/);
  });

  it('with the brain off none of the brain_search text appears', async () => {
    const prompt = await render('developer', { brain: 'off', results: { open_findings: [FINDING], security_findings: [] }, round: 2 });
    assert.doesNotMatch(prompt, /brain_search/);
    assert.doesNotMatch(prompt, /read the lessons for the categories/);
  });

  it('roles/brain.md (read-role instructions) carries the same rework rule', async () => {
    const prompt = await render('test-engineer', { brain: 'read' });
    assert.match(prompt, /Knowledge vault \(brain\)/);
    assert.match(prompt, /open findings/);
    assert.match(prompt, /read the lessons for their categories/);
    assert.match(prompt, /name the lessons you followed in your result/);
    const file = fs.readFileSync(path.join(root, 'roles', 'brain.md'), 'utf8');
    assert.match(file, /read the lessons for their categories/);
  });
});

describe('prompt defaults for the new variables', () => {
  it('every role renders without recurring_findings, known_categories and brain_lessons', async () => {
    const roles = ['developer', 'test-engineer', 'architect', 'reviewer', 'security-auditor', 'docs', 'issue-analyst'];
    for (const brain of ['off', 'read', 'write']) {
      for (const role of roles) {
        const prompt = await render(role, { brain });
        assert.ok(prompt.length > 100, `${role}/${brain}`);
        assert.doesNotMatch(prompt, /## Recurring findings/, `${role}/${brain}`);
        assert.doesNotMatch(prompt, /\n## Lessons of this repository/, `${role}/${brain}`);
        assert.doesNotMatch(prompt, /undefined|\[object Object\]/, `${role}/${brain}`);
      }
    }
  });

  it('renders without the brain variable at all', async () => {
    const prompt = await render('reviewer');
    assert.doesNotMatch(prompt, /brain_write/);
  });
});

describe('documentation and configuration', () => {
  it('docs/brain.md has a review lessons section with category, triggers, injection and config keys', () => {
    const doc = fs.readFileSync(path.join(root, 'docs', 'brain.md'), 'utf8');
    const start = doc.search(/^##+ .*[Rr]eview lessons/m);
    assert.ok(start >= 0, 'section heading');
    const rest = doc.slice(start + 3);
    const next = rest.search(/^## /m);
    const section = next < 0 ? rest : rest.slice(0, next);
    assert.match(section, /category/i);
    assert.match(section, /same[_ ]issue|round/i);
    assert.match(section, /min_issues/);
    assert.match(section, /window_days/);
    assert.match(section, /brain_lessons/);
    for (const key of ['review_lessons', 'window_days', 'min_issues', 'inject_budget_chars', 'enabled']) assert.ok(section.includes(key), key);
    assert.match(section, /developer/i);
  });

  it('WORKFLOW.md front matter has brain.review_lessons with the defaults', async () => {
    const { definition } = await loadWorkflowFile(shipped);
    const brain = definition.config.brain as Record<string, unknown>;
    assert.ok(brain && typeof brain === 'object');
    assert.deepEqual(brain.review_lessons, { enabled: true, window_days: 14, min_issues: 2, inject_budget_chars: 6000 });
  });
});

describe('analytics over HTTP', () => {
  let server: HttpServerHandle;
  before(async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'model-costs.yml'), 'default: { input: 5, output: 25 }\n');
    const pricing = new PricingStore(path.join(dir, 'model-costs.yml'), Logger.silent());
    const historyLog = new HistoryLog(path.join(dir, 'repositories'), pricing, Logger.silent());
    historyLog.note('acme/app', 'workspace_removed', { issue: 'acme/app#2', state: 'Done' });
    const orchestrator = new Orchestrator({
      workflow: new StaticWorkflow(makeWorkflow(baseFront(tempDir()))),
      runner: new FakeRunner(),
      logger: Logger.silent(),
      env: {},
      logDir: null,
      timers: new ManualTimers(),
      createAdapter: () => new FakeTracker(),
    });
    server = await startHttpServer({ host: '127.0.0.1', port: 0, orchestrator, logger: Logger.silent(), history: { dir: historyLog.dir, pricing } });
  });
  after(async () => {
    await server.close();
  });

  it('/api/v1/history/analytics contains finding_categories as a list', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: server.port, path: '/api/v1/history/analytics' }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve(text));
        })
        .on('error', reject);
    });
    const analytics = JSON.parse(body);
    assert.ok('finding_categories' in analytics);
    assert.ok(Array.isArray(analytics.finding_categories));
  });
});
