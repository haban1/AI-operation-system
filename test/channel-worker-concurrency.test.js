import test from 'node:test';
import assert from 'node:assert/strict';
import { jobOperationLockMode, jobQueueLane, platformWorkerPlans } from '../agent/job-operation-lane.js';

test('jobs are assigned to channel lanes and lock modes', () => {
  assert.equal(jobOperationLockMode({ job_type: 'COLLECT_MESSAGES', payload: { channelType: 'COMMENT' } }), 'READ_COMMENT');
  assert.equal(jobOperationLockMode({ job_type: 'REPLY', payload: { messageType: 'PRIVATE_MESSAGE' } }), 'WRITE_PRIVATE');
  assert.equal(jobQueueLane({ job_type: 'PUBLISH', payload: {} }), 'COMMENT');
  assert.equal(jobOperationLockMode({ job_type: 'PUBLISH', payload: {} }), 'EXCLUSIVE');
});

test('split platforms receive private, comment and safe general workers', () => {
  const plans = platformWorkerPlans('weibo', { splitEnabled: true });
  assert.deepEqual(plans.map(item => item.queueLanes), [['PRIVATE_MESSAGE'], ['COMMENT'], ['GENERAL', 'COMBINED']]);
});
