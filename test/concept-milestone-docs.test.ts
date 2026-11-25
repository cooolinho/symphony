import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('concept milestone docs (#642)', () => {
  it('the skill describes the argument, the auto rule and the tools', () => {
    const skill = read('.claude/skills/concept/SKILL.md');
    assert.match(skill, /milestone=<auto\|off\|<title>>/);
    assert.match(skill, /list_milestones/);
    assert.match(skill, /git tag --merged/);
    assert.match(skill, /`\*\*milestone:\*\*` line of the plan/);
  });

  it('plan and report templates name the milestone', () => {
    const templates = read('.claude/skills/concept/templates.md');
    assert.match(templates, /\*\*milestone:\*\* <title> \(new\|existing\|off\)/);
    assert.match(templates, /\*\*Milestone:\*\* \[<title>\]\(<url>\)/);
  });

  it('usage and adapter docs mention milestone and list_milestones', () => {
    assert.match(read('docs/usage.md'), /milestone=<auto\|off\|<title>>/);
    const adapter = read('docs/adapters/github-project.md');
    assert.match(adapter, /list_milestones/);
    assert.match(adapter, /`milestone\?`/);
  });
});
