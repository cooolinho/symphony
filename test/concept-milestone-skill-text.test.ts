import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('concept skill: milestone rules in the text (#642)', () => {
  const skill = flat(read('.claude/skills/concept/SKILL.md'));

  it('names the three argument forms and the default auto', () => {
    assert.match(skill, /milestone=auto\|off\|<title>/);
    assert.match(skill, /Default `auto`/);
    assert.match(skill, /`off`: no milestone/);
  });

  it('describes auto: highest of SemVer tag and open SemVer milestones, next minor, the example, and the no-SemVer case', () => {
    assert.match(skill, /vX\.Y\.Z/);
    assert.match(skill, /open/i);
    assert.match(skill, /X\.\(Y\+1\)\.0/);
    assert.match(skill, /tag `v1\.4\.0`, open milestone `1\.5\.0` → `1\.6\.0`/);
    assert.match(skill, /Without any SemVer tag and any SemVer milestone: no milestone/);
    assert.match(skill, /consecutive milestones \(`1\.5\.0`, then `1\.6\.0`\)/);
  });

  it('treats "Release 1.5.0" and "in 1.5.0" in the brief like the argument', () => {
    assert.match(skill, /"Release 1\.5\.0" or "in 1\.5\.0" counts like `milestone=1\.5\.0`/);
  });

  it('has the concept issue itself get no milestone and passes the milestone on every create_sub_issue call', () => {
    assert.match(skill, /concept issue itself gets none/);
    assert.match(skill, /pass `milestone: "<title>"` on \*\*every\*\* call, epics and issues alike/);
  });

  it('continuation takes the plan milestone and creates no second one; addendum falls back when closed', () => {
    assert.match(skill, /do not determine it again, so no second milestone is created/);
    assert.match(skill, /addendum uses the milestone of the plan/);
    assert.match(skill, /closed by now/);
  });

  it('never reopens a closed milestone', () => {
    assert.match(skill, /closed milestones are never reopened/);
  });
});

describe('concept templates and usage docs: milestone (#642)', () => {
  it('the plan header has the milestone line with new|existing|off', () => {
    assert.match(read('.claude/skills/concept/templates.md'), /\*\*milestone:\*\* <title> \(new\|existing\|off\)/);
  });

  it('the report names the milestone with a link and lists closed or conflicting milestones as notes', () => {
    const templates = flat(read('.claude/skills/concept/templates.md'));
    assert.match(templates, /\*\*Milestone:\*\* \[<title>\]\(<url>\)/);
    assert.match(templates, /closed or conflicting milestones/);
  });

  it('usage.md describes the argument, the auto rule, the example and the off value', () => {
    const usage = flat(read('docs/usage.md'));
    assert.match(usage, /milestone=<auto\|off\|<title>>/);
    assert.match(usage, /tag `v1\.4\.0` and open milestone `1\.5\.0` give `1\.6\.0`/);
    assert.match(usage, /`off` sets none/);
    assert.match(usage, /Release 1\.5\.0/);
  });
});
