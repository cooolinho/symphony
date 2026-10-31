import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { NOTE_STATUSES } from '../src/brain/note.ts';
import { VAULT_FOLDERS } from '../src/brain/vault.ts';
import { resolveConfig } from '../src/workflow/config.ts';

/**
 * Documentation checks for the multi-agent pipeline (issue #203): the acceptance criteria are derived from the issue,
 * not from the implementation of the docs. They read the Markdown files in the repository.
 */

const root = path.join(import.meta.dirname, '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(rel) : rel.endsWith('.md') ? [rel] : [];
  });
}

const markdownFiles = ['README.md', 'README.de.md', 'SECURITY.md', 'CONTRIBUTING.md', ...walk('docs')];

/** The text without fenced code blocks. */
function stripFences(text: string): string {
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '');
}

/** GitHub's heading anchor: lowercase, no punctuation except `-` and `_`, spaces to dashes, duplicates numbered. */
function anchors(file: string): Set<string> {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  for (const match of stripFences(read(file)).matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) {
    const text = (match[1] ?? '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*]/g, '')
      .toLowerCase();
    const base = [...text]
      .filter((char) => /[\p{L}\p{N}_\- ]/u.test(char))
      .join('')
      .replace(/ /g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${count}`);
  }
  return result;
}

/** The body of the section that starts at the heading, up to the next heading of the same or a higher level. */
function section(file: string, heading: RegExp): string {
  const text = read(file);
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^#{1,6} /.test(line) && heading.test(line));
  assert.notEqual(start, -1, `${file}: no heading matching ${heading}`);
  const level = /^#+/.exec(lines[start] ?? '')?.[0].length ?? 1;
  let end = lines.length;
  let fenced = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    const h = fenced ? null : /^(#+) /.exec(line);
    if (h && (h[1]?.length ?? 99) <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function links(file: string): { target: string; line: number }[] {
  const found: { target: string; line: number }[] = [];
  const lines = read(file).split('\n');
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return;
    const withoutCode = line.replace(/`[^`]*`/g, '');
    for (const match of withoutCode.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) found.push({ target: match[1] ?? '', line: index + 1 });
  });
  return found;
}

describe('docs: links and anchors', () => {
  for (const file of markdownFiles) {
    it(`${file}: every relative link and anchor resolves`, () => {
      const problems: string[] = [];
      for (const { target, line } of links(file)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const [pathPart = '', fragment] = target.split('#');
        const targetFile = pathPart === '' ? file : path.normalize(path.join(path.dirname(file), decodeURI(pathPart)));
        if (!fs.existsSync(path.join(root, targetFile))) {
          problems.push(`${file}:${line} ${target}: ${targetFile} does not exist`);
          continue;
        }
        if (fragment === undefined || fragment === '' || !targetFile.endsWith('.md')) continue;
        if (/^L\d+/.test(fragment)) continue;
        if (!anchors(targetFile).has(decodeURIComponent(fragment).toLowerCase())) problems.push(`${file}:${line} ${target}: no heading anchor #${fragment} in ${targetFile}`);
      }
      assert.deepEqual(problems, []);
    });
  }

  it('the anchor checker itself finds a missing anchor and a missing file', () => {
    assert.ok(anchors('docs/usage.md').has('rounds-limits-and-manual-resume'));
    assert.ok(!anchors('docs/usage.md').has('no-such-section-anywhere'));
    assert.ok(!fs.existsSync(path.join(root, 'docs/no-such-file.md')));
  });
});

describe('docs: README structure', () => {
  const english = ['📖 About', '✨ Features', '🚀 Getting Started', '📋 Usage', '📁 Project Structure', '📚 Documentation', '🔗 References', '📄 License'];

  function h2(file: string): string[] {
    return [...stripFences(read(file)).matchAll(/^## (.+?)\s*$/gm)].map((match) => match[1] ?? '');
  }

  /** The sections of the fixed structure, matched by emoji (the German README translates the names). */
  const emoji = (heading: string): string => [...heading][0] ?? '';
  const wanted = english.map(emoji);

  // The READMEs predate the fixed structure and open with "Origin", "Built for Laravel" and "How it works" instead of
  // "📖 About"; the issue only asks that its change leaves the structure as it is (see the comparison below).
  const present = wanted.slice(1);

  it('README.md keeps the sections that exist in the fixed order, each with its emoji and name', () => {
    const found = h2('README.md').filter((heading) => present.includes(emoji(heading)));
    assert.deepEqual(found.map(emoji), present);
    assert.deepEqual(
      found.map((heading) => heading.toLowerCase()),
      english.slice(1).map((heading) => heading.toLowerCase()),
    );
  });

  it('README.de.md has the same emojis in the same order', () => {
    const found = h2('README.de.md').filter((heading) => present.includes(emoji(heading)));
    assert.deepEqual(found.map(emoji), present);
    assert.ok(found.every((heading) => /^\S+ \S/.test(heading)));
  });

  it('README.md and README.de.md have the same number of top-level sections', () => {
    assert.equal(h2('README.de.md').length, h2('README.md').length);
  });

  it('the section structure equals the one before the change (commit ea08ab0)', { skip: !fs.existsSync(path.join(root, '.git')) }, () => {
    const { execFileSync } = require_child_process();
    for (const file of ['README.md', 'README.de.md']) {
      let before: string;
      try {
        before = execFileSync('git', ['show', `ea08ab0:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        return; // shallow clone without that commit
      }
      const headings = (text: string): string[] => [...stripFences(text).matchAll(/^#{1,6} (.+?)\s*$/gm)].map((match) => match[1] ?? '');
      assert.deepEqual(headings(read(file)), headings(before), `${file}: headings changed`);
    }
  });

  for (const [file, features, documentation] of [
    ['README.md', /^## ✨ Features/m, /^## 📚 Documentation/m],
    ['README.de.md', /^## ✨ Features/m, /^## 📚 Dokumentation/m],
  ] as const) {
    it(`${file}: the pipeline is linked under Features and Documentation`, () => {
      const text = read(file);
      const featuresStart = text.search(features);
      const documentationStart = text.search(documentation);
      assert.ok(featuresStart >= 0 && documentationStart > featuresStart);
      const nextAfterFeatures = text.slice(featuresStart + 5).search(/^## /m) + featuresStart + 5;
      const featureText = text.slice(featuresStart, nextAfterFeatures);
      assert.match(featureText, /docs\/concepts\/multi-agent\.md/);
      assert.match(featureText, /report_result/);
      const docText = text.slice(documentationStart, documentationStart + 5 + text.slice(documentationStart + 5).search(/^## /m));
      assert.match(docText, /\(docs\/concepts\/multi-agent\.md\)/);
      assert.match(docText, /\(docs\/results\.md\)/);
    });
  }
});

function require_child_process(): typeof import('node:child_process') {
  return process.getBuiltinModule('node:child_process');
}

describe('docs: configuration keys', () => {
  const configuration = read('docs/configuration.md');
  const source = read('src/workflow/config.ts');

  function keysOf(name: string): string[] {
    const match = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(source);
    assert.ok(match, `${name} not found in config.ts`);
    return [...(match[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '');
  }

  const pipelineTable = section('docs/configuration.md', /^### `pipeline`/);
  const rolesTable = section('docs/configuration.md', /^### `roles`/);

  it('every pipeline key has a row in the pipeline table', () => {
    for (const key of keysOf('PIPELINE_KEYS')) assert.match(pipelineTable, new RegExp(`^\\| .*\`${key}\``, 'm'), `pipeline.${key}`);
  });

  it('every role key has a row in the roles table', () => {
    for (const key of keysOf('ROLE_KEYS')) assert.match(rolesTable, new RegExp(`^\\| \`${key}\` \\|`, 'm'), `roles.<n>.${key}`);
  });

  it('every profile key is documented in the profile section', () => {
    const profiles = section('docs/configuration.md', /^#### Workflow profiles/);
    for (const key of keysOf('PROFILE_KEYS')) assert.match(profiles, new RegExp(`\\b${key}\\b`), `profiles.<type>.${key}`);
  });

  it('the pipeline defaults in the table equal the defaults of the code', () => {
    const { pipeline } = resolveConfig({}, { workflowPath: '/w/WORKFLOW.md', env: {}, trackerDefaults });
    const row = (key: string): string => new RegExp(`^\\| \`${key}\`[^|]*\\| ([^|]*) \\|`, 'm').exec(pipelineTable)?.[1] ?? '';
    assert.equal(row('max_review_rounds'), `\`${pipeline.maxReviewRounds}\``);
    assert.equal(row('max_test_rounds'), `\`${pipeline.maxTestRounds}\``);
    assert.equal(row('limit_label'), `\`${pipeline.limitLabel}\``);
    assert.equal(row('default_type'), `\`${pipeline.defaultType}\``);
    assert.equal(row('analysis'), `\`${pipeline.analysis}\``);
    assert.equal(row('type_labels'), '`{}`');
    assert.equal(row('profiles'), '`{}`');
    for (const glob of pipeline.testPaths) assert.ok(row('test_paths').includes(`\`${glob}\``), `test_paths default ${glob}`);
    for (const glob of pipeline.docsPaths) assert.ok(row('docs_paths').includes(`\`${glob}\``), `docs_paths default ${glob}`);
    for (const glob of pipeline.docsTriggerPaths) assert.ok(row('docs_trigger_paths').includes(`\`${glob}\``), `docs_trigger_paths default ${glob}`);
    assert.equal(row('max_check_failures'), `\`${pipeline.maxCheckFailures}\``);
    assert.equal(row('max_security_rounds'), `\`${pipeline.maxSecurityRounds}\``);
    for (const glob of pipeline.securityPaths) assert.ok(row('security_paths').includes(`\`${glob}\``), `security_paths default ${glob}`);
  });

  it('the role defaults named in the issue are stated', () => {
    const cell = (key: string): string => new RegExp(`^\\| \`${key}\` \\| ([^|]*) \\|`, 'm').exec(rolesTable)?.[1] ?? '';
    assert.match(cell('on_result'), /`\{\}`/);
    assert.match(cell('on_missing_result'), /`Blocked`/);
    assert.match(cell('on_round_limit'), /blocked column/);
    assert.match(cell('model_label'), /`apply`/);
    assert.match(cell('result'), /none/);
    assert.match(cell('on_check_failed'), /none/);
  });
});

describe('docs: YAML examples match the config schema', () => {
  const known = new Set(['tracker', 'polling', 'workspace', 'hooks', 'checks', 'agent', 'claude', 'roles', 'pipeline', 'server', 'laravel', 'system', 'brain']);
  let checked = 0;

  for (const file of markdownFiles) {
    const blocks = [...read(file).matchAll(/^```ya?ml[^\n]*\n([\s\S]*?)^```/gm)];
    blocks.forEach((block, index) => {
      let value: unknown;
      try {
        value = parse(block[1] ?? '');
      } catch {
        return; // not a plain YAML document (a template with Liquid or placeholders)
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
      const keys = Object.keys(value);
      if (keys.length === 0 || !keys.every((key) => known.has(key)) || !keys.some((key) => key === 'pipeline' || key === 'roles')) return;
      it(`${file} yaml block ${index + 1} (${keys.join(', ')}) uses only keys of the schema`, () => {
        checked++;
        // Many examples are fragments (a role without its tracker columns, a profile without its roles). Those are
        // rejected for what is missing; what must never appear is a complaint about a key the docs invented.
        const unknownKey = /unknown key|not a known key|unknown top-level key|is not a known/i;
        try {
          const config = resolveConfig(value as Record<string, unknown>, { workflowPath: '/w/WORKFLOW.md', env: new Proxy({}, { get: () => 'x' }) as NodeJS.ProcessEnv, trackerDefaults });
          assert.deepEqual(config.warnings.filter((warning) => unknownKey.test(warning)), []);
        } catch (error) {
          if (error instanceof assert.AssertionError) throw error;
          assert.doesNotMatch(String((error as Error).message), unknownKey);
        }
      });
    });
  }

  it('there are examples to check', () => {
    assert.ok(checked >= 5, `only ${checked} blocks checked`);
  });
});

describe('docs: multi-agent pipeline content', () => {
  it('usage.md has a findable section on rounds, limits and manual resume', () => {
    const text = section('docs/usage.md', /^### Rounds, limits and manual resume/);
    assert.match(text, /needs-human/);
    assert.match(text, /`reset`/);
    assert.match(text, /start at 1/);
    assert.match(text, /max_review_rounds/);
    assert.match(text, /max_test_rounds/);
    assert.match(text, /Blocked/);
    assert.match(text, /`pipeline\.limit_label`/);
  });

  it('usage.md links the new section from the lifecycle', () => {
    const lifecycle = section('docs/usage.md', /^## The lifecycle of an issue/);
    assert.match(lifecycle, /\(#rounds-limits-and-manual-resume\)/);
  });

  it('agent-claude.md describes report_result: no set_status for roles with a result, link to results.md', () => {
    const text = read('docs/agent-claude.md');
    const paragraph = /\*\*`report_result`\*\*[\s\S]*?(?=\n- \*\*|\n\n)/.exec(text)?.[0] ?? '';
    assert.notEqual(paragraph, '', 'no paragraph for report_result');
    assert.match(paragraph, /`result`/);
    assert.match(paragraph, /does \*\*not\*\* get `set_status`/);
    assert.match(paragraph, /results\.md#the-report_result-tool/);
  });

  it('the adapter page documents readResults, the marker protection and the bot account', () => {
    const text = read('docs/adapters/github-project.md');
    assert.match(text, /\| `readResults\(issue\)` \|/);
    assert.match(text, /only comments written by the token's account count/i);
    const markers = section('docs/adapters/github-project.md', /^### Stage-result markers and the bot account/);
    assert.match(markers, /<!-- symphony:/);
    assert.match(markers, /`add_comment`/);
    assert.match(markers, /`create_sub_issue`/);
    assert.match(markers, /viewerLogin\(\)/);
    assert.match(markers, /separate account/i);
    assert.match(markers, /personal token/i);
    assert.match(markers, /SECURITY\.md#stage-result-markers/);
    assert.match(read('SECURITY.md'), /^#+ .*Stage-result markers/im);
  });

  it('add_comment and create_sub_issue do reject markers, as documented (code behind the doc claim)', () => {
    const tools = fs.readFileSync(path.join(root, 'src/tracker/github-project/tools.ts'), 'utf8');
    assert.match(tools, /MARKER_START = \/<!--\\s\*symphony:\/i/);
    const markerChecks = tools.match(/markerProblem\(/g)?.length ?? 0;
    assert.ok(markerChecks >= 3, 'definition plus checks in add_comment and create_sub_issue');
  });

  it('conformance.md lists the pipeline extensions', () => {
    const text = read('docs/conformance.md');
    for (const pattern of [
      /report_result/,
      /roles\.<role>\.result/,
      /Round limits/,
      /max_review_rounds/,
      /max_test_rounds/,
      /Workflow profiles/,
      /without an agent session|without a session/,
      /Pipeline recovery/,
      /`stage_result`/,
      /readResults/,
    ]) {
      assert.match(text, pattern);
    }
  });

  it('index.md links the multi-agent concept and the result contracts', () => {
    const text = read('docs/index.md');
    assert.match(text, /\]\(concepts\/multi-agent\.md\)/);
    assert.match(text, /\]\(results\.md\)/);
  });

  describe('concepts/multi-agent.md', () => {
    const file = 'docs/concepts/multi-agent.md';
    const text = read(file);

    it('has the architecture and the decisions before the spike results, and keeps the spike results', () => {
      const order = ['Architecture', 'Decisions', 'Spike results'].map((name) => text.search(new RegExp(`^## ${name}`, 'm')));
      assert.ok(order.every((p) => p >= 0), `headings missing: ${order}`);
      assert.deepEqual([...order].sort((a, b) => a - b), order);
      for (let n = 1; n <= 6; n++) assert.match(text, new RegExp(`^### ${n}\\. `, 'm'), `spike point ${n}`);
      assert.match(text, /EXCESSIVE_PAGINATION/);
    });

    it('covers resolver, guard, markers as state, rounds, profiles, recovery and cost', () => {
      const architecture = section(file, /^## Architecture/);
      for (const pattern of [/resolver/i, /transition guard/i, /marker/i, /round/i, /profile/i, /recovery/i, /cost/i, /bot account|separate account/i, /report_result/]) {
        assert.match(architecture + section(file, /^## Decisions/) + section(file, /^### Forgery protection/), pattern);
      }
    });

    it('states the defaults the code uses (3 review rounds, 2 test rounds, needs-human)', () => {
      const { pipeline } = resolveConfig({}, { workflowPath: '/w/WORKFLOW.md', env: {}, trackerDefaults });
      assert.match(text, new RegExp(`pipeline\\.max_review_rounds\` \\(default ${pipeline.maxReviewRounds}\\)`));
      assert.match(text, new RegExp(`pipeline\\.max_test_rounds\` \\(default ${pipeline.maxTestRounds}\\)`));
      assert.match(text, new RegExp(pipeline.limitLabel));
    });

    it('names code that exists', () => {
      assert.ok(fs.existsSync(path.join(root, 'src/orchestrator/transitions.ts')));
      assert.match(fs.readFileSync(path.join(root, 'src/orchestrator/transitions.ts'), 'utf8'), /export function resolveTransition/);
      assert.match(text, /resolveTransition/);
      assert.match(fs.readFileSync(path.join(root, 'src/tracker/github-project/adapter.ts'), 'utf8'), /viewerLogin/);
      assert.match(fs.readFileSync(path.join(root, 'src/orchestrator/recovery.ts'), 'utf8'), /status_updated_at/);
    });

    it('does not leave the spike points #210 and #183 as open future work', () => {
      const point4 = section(file, /^### 4\. /);
      assert.match(point4, /As built/);
      assert.doesNotMatch(point4, /\b(will|should be) (be )?(implemented|built)\b/i);
    });

    it('does not claim the phase-4 stages are documented here', () => {
      assert.match(text, /phase 4/i);
    });
  });
});

describe('docs: brain', () => {
  const source = read('src/workflow/config.ts');
  const brainKeys = [...(/const BRAIN_KEYS = new Set\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '');
  const roleKeys = [...(/const ROLE_KEYS = new Set\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '');
  const configuration = read('docs/configuration.md');
  const brainSection = section('docs/configuration.md', /^### `brain`/);
  const rows = [...brainSection.matchAll(/^\| `([a-z_]+)` \|(.*)\|\s*$/gm)].map((m) => ({ key: m[1] ?? '', cells: (m[0] ?? '').split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim()) }));

  it('brain.md has the sections', () => {
    const found = anchors('docs/brain.md');
    for (const name of ['purpose', 'vault-layout', 'frontmatter', 'tools', 'role-switch', 'clash-rules', 'obsidian-container', 'backup', 'reset']) assert.ok(found.has(name), name);
  });

  it('brain.md section contents', () => {
    const layout = section('docs/brain.md', /^## Vault layout/);
    assert.match(layout, /Repos\/<owner>-<name>\/index\.md/);
    for (const folder of VAULT_FOLDERS) assert.ok(layout.includes(`${folder}/`), folder);
    const frontmatter = section('docs/brain.md', /^## Frontmatter/);
    for (const status of NOTE_STATUSES) assert.ok(frontmatter.includes(status), status);
    assert.match(frontmatter, /candidate`? → `?approved`? → `?deprecated/);
    const tools = section('docs/brain.md', /^## Tools/);
    for (const word of ['brain_search', 'brain_read', 'brain_list', 'brain_write', 'brain_append', 'purpose', 'base_hash']) assert.ok(tools.includes(word), word);
    const role = section('docs/brain.md', /^## Role switch/);
    for (const word of ['off', 'read', 'write']) assert.ok(role.includes(word), word);
    const clash = section('docs/brain.md', /^## Clash rules/);
    for (const word of ['clash_window_ms', 'window', 'hash_mismatch']) assert.ok(clash.includes(word), word);
    const obsidian = section('docs/brain.md', /^## Obsidian container/);
    assert.ok(obsidian.includes('BRAIN_DOMAIN'));
    assert.match(obsidian, /basic ?auth/i);
    assert.match(obsidian, /LAN/);
    const backup = section('docs/brain.md', /^## Backup/);
    assert.ok(backup.includes('git') && backup.includes('log') && backup.includes('revert'));
    assert.ok(section('docs/brain.md', /^## Reset/).includes('.obsidian/'));
  });

  it('every BRAIN_KEYS key has a typed row in configuration.md and vice versa', () => {
    assert.deepEqual(rows.map((r) => r.key).sort(), [...brainKeys].sort());
    for (const row of rows) {
      assert.equal(row.cells.length, 4, row.key);
      assert.ok(row.cells.every((c) => c.length > 0), row.key);
    }
    const mentioned = [...configuration.matchAll(/`brain\.([a-z_]+)`/g)].map((m) => m[1] ?? '');
    for (const key of mentioned) assert.ok(brainKeys.includes(key), `brain.${key} is not in BRAIN_KEYS`);
    assert.match(brainSection, /\]\(brain\.md\)/);
  });

  it('the documented defaults equal the resolved ones', () => {
    const config = resolveConfig({}, { workflowPath: '/w/WORKFLOW.md', env: {}, trackerDefaults });
    const cell = (key: string): string => rows.find((r) => r.key === key)?.cells[2] ?? '';
    assert.equal(cell('enabled'), `\`${config.brain.enabled}\``);
    assert.equal(cell('clash_window_ms'), `\`${config.brain.clashWindowMs}\``);
    assert.equal(cell('path'), '`~/brain`');
  });

  it('the role field is documented', () => {
    assert.ok(roleKeys.includes('brain'));
    const row = section('docs/configuration.md', /^### `roles`/).split('\n').find((line) => line.startsWith('| `brain` |')) ?? '';
    assert.match(row, /^\| `brain` \| `off` \|/);
    for (const word of ['off', 'read', 'write']) assert.ok(row.includes(word), word);
    assert.ok(row.includes('brain.md#role-switch'));
  });

  it('brain.md is linked from the index and the READMEs', () => {
    assert.match(read('docs/index.md'), /\]\(brain\.md\)/);
    for (const [file, heading] of [['README.md', /^## 📚 Documentation/m], ['README.de.md', /^## 📚 Dokumentation/m]] as const) {
      const text = read(file);
      const start = text.search(heading);
      assert.ok(start >= 0);
      const rest = text.slice(start + 5);
      assert.match(text.slice(start, start + 5 + rest.search(/^## /m)), /\]\(docs\/brain\.md\)/, file);
    }
  });

  it('brain.obsidian_url is a documented key and brain.md no longer announces it', () => {
    assert.ok(brainKeys.includes('obsidian_url'));
    assert.ok(configuration.includes('`obsidian_url`'));
    assert.ok(!read('docs/brain.md').includes('coming with E7-7a'));
  });
});
