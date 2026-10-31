import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BrainAccess, BrainClash } from '../src/brain/access-log.ts';
import { brainCommitStatus, brainConflictEntry, isObsidianPath } from '../src/changes/brain.ts';
import { tempDir } from './helpers.ts';

describe('brainCommitStatus', () => {
  const added = { status: 'added' } as const;
  const modified = { status: 'modified' } as const;
  it('prefers the subject prefix, then the human author, then the file status', () => {
    assert.equal(brainCommitStatus({ subject: 'approve: Inbox/a.md', author: 'human' }, added), 'approved');
    assert.equal(brainCommitStatus({ subject: '  Approve: x', author: 'symphony-developer' }, modified), 'approved');
    assert.equal(brainCommitStatus({ subject: 'reject: x', author: 'human' }, added), 'rejected_candidate');
    assert.equal(brainCommitStatus({ subject: 'Obsidian: 2 Dateien', author: 'human' }, added), 'human');
    assert.equal(brainCommitStatus({ subject: 'o/r#1 run: p', author: 'symphony-developer' }, added), 'created');
    assert.equal(brainCommitStatus({ subject: 'o/r#1 run: p', author: 'symphony-developer' }, modified), 'updated');
  });
});

describe('isObsidianPath', () => {
  it('matches .obsidian and below only', () => {
    assert.ok(isObsidianPath('.obsidian/app.json'));
    assert.ok(isObsidianPath('.obsidian'));
    assert.equal(isObsidianPath('Inbox/.obsidian/x'), false);
    assert.equal(isObsidianPath('.obsidian-notes/a.md'), false);
  });
});

describe('brainConflictEntry', () => {
  const line = (over: Partial<BrainAccess> = {}): BrainAccess => ({
    at: '2026-10-30T12:00:00.000Z',
    run: 'run2',
    issue: 'acme/shop#1',
    role: 'developer',
    op: 'write',
    path_or_query: 'Inbox/a.md',
    purpose: '',
    result: 'rejected',
    reason: 'hash_mismatch',
    clash_id: 'c1',
    ...over,
  });
  const clash: BrainClash = { id: 'c1', path: 'Inbox/a.md', runs: ['run1', 'run2'], roles: [null, null], at: [null, '2026-10-30T12:00:00.000Z'], reason: 'hash_mismatch', status: 'open' };

  it('builds a conflict entry with role, run, reason and clash', () => {
    const entry = brainConflictEntry(tempDir(), line(), clash)!;
    assert.equal(entry.id, 'brain:conflict:c1');
    assert.deepEqual([entry.type, entry.status, entry.role, entry.run, entry.reason, entry.clash_id, entry.repo, entry.title], ['brain', 'conflict', 'developer', 'run2', 'hash_mismatch', 'c1', 'unknown', 'a']);
  });
  it('gives nothing for .obsidian/, other reasons or other results', () => {
    assert.equal(brainConflictEntry(tempDir(), line({ path_or_query: '.obsidian/app.json' }), clash), null);
    assert.equal(brainConflictEntry(tempDir(), line({ reason: 'not_found' }), clash), null);
    assert.equal(brainConflictEntry(tempDir(), line({ result: 'ok' }), clash), null);
  });
});
