import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { commandSkills, parseIssueCommand, resolveIssueCommand } from '../src/workflow/command.ts';
import { tempDir } from './helpers.ts';

function plugin(dir: string, name: string | null, skills: string[], withoutSkillFile: string[] = []): string {
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  if (name !== null) fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }));
  for (const skill of skills) {
    fs.mkdirSync(path.join(dir, 'skills', skill), { recursive: true });
    if (!withoutSkillFile.includes(skill)) fs.writeFileSync(path.join(dir, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\n---\n`);
  }
  return dir;
}

describe('parseIssueCommand', () => {
  it('reads the name and the arguments of the first non-empty line', () => {
    assert.deepEqual(parseIssueCommand('/refactoring'), { name: 'refactoring', args: '' });
    assert.deepEqual(parseIssueCommand('/refactoring app/Filament  '), { name: 'refactoring', args: 'app/Filament' });
    assert.deepEqual(parseIssueCommand('\n\r\n  /Refactor-Safely  only tests\nMore text'), { name: 'refactor-safely', args: 'only tests' });
    assert.deepEqual(parseIssueCommand('/refactoring\r\nbody'), { name: 'refactoring', args: '' });
  });

  it('ignores text that only mentions a command', () => {
    for (const text of ['Please run /refactoring', 'Intro\n/refactoring', '/api/users returns 500', '/ refactoring', '//refactoring', '/-x', '', '   \n  ']) {
      assert.equal(parseIssueCommand(text), null, JSON.stringify(text));
    }
    assert.equal(parseIssueCommand(null), null);
  });
});

describe('commandSkills', () => {
  it('maps skill directories to plugin-qualified names, using the manifest name', () => {
    const dir = plugin(path.join(tempDir(), 'toolbox'), 'symphony', ['refactoring', 'refactor-safely']);
    assert.deepEqual([...commandSkills([dir])].sort(), [
      ['refactor-safely', 'symphony:refactor-safely'],
      ['refactoring', 'symphony:refactoring'],
    ]);
  });

  it('falls back to the directory name and skips entries without a SKILL.md or a valid name', () => {
    const dir = plugin(path.join(tempDir(), 'toolbox'), null, ['good', 'empty'], ['empty']);
    fs.mkdirSync(path.join(dir, 'skills', 'Not_Valid'));
    fs.writeFileSync(path.join(dir, 'skills', 'Not_Valid', 'SKILL.md'), 'x');
    fs.writeFileSync(path.join(dir, 'skills', 'stray.md'), 'x');
    assert.deepEqual([...commandSkills([dir])], [['good', 'toolbox:good']]);
  });

  it('lets the first plugin win and tolerates plugins without skills', () => {
    const root = tempDir();
    const first = plugin(path.join(root, 'a'), 'one', ['shared']);
    const second = plugin(path.join(root, 'b'), 'two', ['shared', 'extra']);
    assert.deepEqual([...commandSkills([first, second, path.join(root, 'missing')])].sort(), [
      ['extra', 'two:extra'],
      ['shared', 'one:shared'],
    ]);
  });
});

describe('resolveIssueCommand', () => {
  const skills = new Map([['refactoring', 'symphony:refactoring']]);

  it('returns the command with its skill name', () => {
    assert.deepEqual(resolveIssueCommand('/refactoring app', skills), { name: 'refactoring', args: 'app', skill: 'symphony:refactoring' });
  });

  it('treats a command without a skill as no command', () => {
    assert.equal(resolveIssueCommand('/login returns 500', skills), null);
    assert.equal(resolveIssueCommand('No command here', skills), null);
    assert.equal(resolveIssueCommand(null, skills), null);
  });
});

describe('/brain-garden', () => {
  it('is parsed as a command and its skill ships in the toolbox', () => {
    assert.deepEqual(parseIssueCommand('/brain-garden'), { name: 'brain-garden', args: '' });
    assert.equal(commandSkills([path.join(import.meta.dirname, '..', '.claude')]).get('brain-garden'), 'symphony:brain-garden');
  });
});
