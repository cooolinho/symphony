import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeTracker, makeIssue } from './helpers.ts';

describe('FakeTracker adapter operations', () => {
  const setup = () => {
    const issue = makeIssue({ id: '1' });
    return { tracker: new FakeTracker([issue]), issue };
  };

  it('keeps posted comments with the viewer as author, oldest first', async () => {
    const { tracker, issue } = setup();
    tracker.viewer = 'bot';
    const { url } = await tracker.postComment(issue, 'first');
    await tracker.postComment(issue, 'second');
    const comments = await tracker.readComments(issue);
    assert.deepEqual(comments.map((c) => [c.author, c.body]), [['bot', 'first'], ['bot', 'second']]);
    assert.equal(comments[0]?.url, url);
    assert.ok((comments[0]?.createdAt.getTime() ?? 0) < (comments[1]?.createdAt.getTime() ?? 0));
    assert.equal(await tracker.viewerLogin(), 'bot');
    assert.deepEqual(await tracker.readComments(makeIssue({ id: '2' })), []);
  });

  it('moves the issue and records the call, also through the set_status tool', async () => {
    const { tracker, issue } = setup();
    assert.deepEqual(await tracker.setStatus(issue, 'Agent review'), { previous: 'Todo', status: 'Agent review' });
    const tool = tracker.agentToolSpecs().find((t) => t.name === 'set_status');
    assert.deepEqual(await tool?.execute({ status: 'Done' }, { issue }), { ok: true, data: { previous_status: 'Agent review', status: 'Done' } });
    assert.equal(tracker.issues.get('1')?.state, 'Done');
    assert.deepEqual(tracker.statusCalls, ['Agent review', 'Done']);
  });

  it('adds only labels the repository has, creating the pipeline families on request, and removes them', async () => {
    const { tracker, issue } = setup();
    tracker.repositoryLabels.add('bug');
    assert.deepEqual(await tracker.addLabels(issue, ['bug', 'Type: feature', 'wontfix'], { create: true }), {
      added: ['bug', 'Type: feature'],
      created: ['Type: feature'],
      unknown: ['wontfix'],
    });
    assert.deepEqual(tracker.issues.get('1')?.labels, ['bug', 'type: feature']);
    assert.deepEqual(await tracker.addLabels(issue, ['needs-human']), { added: [], created: [], unknown: ['needs-human'] });
    assert.deepEqual(await tracker.removeLabels(issue, ['Bug', 'gone']), { removed: ['Bug'], unknown: ['gone'] });
    assert.deepEqual(tracker.issues.get('1')?.labels, ['type: feature']);
  });
});
