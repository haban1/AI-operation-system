import test from 'node:test';
import assert from 'node:assert/strict';
import { operationModesCompatible, PlatformOperationCoordinator } from '../agent/platform-operation-coordinator.js';

const runningControl = { masterSwitch: { enabled: true }, platforms: [{ code: 'douyin', desired_state: 'RUNNING', effective_state: 'RUNNING', lifecycle_state: 'ACTIVE' }] };

test('comment and private lanes are compatible while same lane and publish are exclusive', () => {
  assert.equal(operationModesCompatible('READ_COMMENT', 'READ_PRIVATE'), true);
  assert.equal(operationModesCompatible('READ_COMMENT', 'WRITE_PRIVATE'), true);
  assert.equal(operationModesCompatible('READ_COMMENT', 'WRITE_COMMENT'), false);
  assert.equal(operationModesCompatible('EXCLUSIVE', 'READ_PRIVATE'), false);
});

test('coordinator runs comment and private tasks concurrently but waits for exclusive task', async () => {
  const coordinator = new PlatformOperationCoordinator({ fetchControl: async () => runningControl });
  await coordinator.update(runningControl);
  const events = [];
  let releaseComment;
  const commentGate = new Promise(resolve => { releaseComment = resolve; });
  const comment = coordinator.run('douyin', async () => { events.push('comment-start'); await commentGate; events.push('comment-end'); }, { lockMode: 'READ_COMMENT' });
  const privateTask = coordinator.run('douyin', async () => { events.push('private'); }, { lockMode: 'READ_PRIVATE' });
  await privateTask;
  const publish = coordinator.run('douyin', async () => { events.push('publish'); }, { lockMode: 'EXCLUSIVE' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(events, ['comment-start', 'private']);
  releaseComment();
  await Promise.all([comment, publish]);
  assert.deepEqual(events, ['comment-start', 'private', 'comment-end', 'publish']);
});
