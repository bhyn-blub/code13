const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHarness } = require('./helpers/harness');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('coordinator persists its team and proposes hosted routes before any hosted request', async t => {
  const harness = await createHarness(t);
  const first = harness.boot();
  await sleep(50);
  const { ipcHandlers, events } = first;
  const { modelReplies, workspace } = harness;

  const bootstrap = await ipcHandlers.get('app:bootstrap')();
  assert.equal(bootstrap.agents.length, 3);
  await ipcHandlers.get('workspace:select')();
  await ipcHandlers.get('settings:save')(null, { providers: { openai: { baseUrl: 'https://api.openai.com/v1', model: 'model-x', apiKey: 'secret-test-key' } } });
  const plan = await ipcHandlers.get('task:plan')(null, { prompt: 'Fix the failing tests and review the changes.', provider: 'openai', model: 'model-x' });
  assert.ok(plan.steps.some(step => step.agentId === 'builder'));
  assert.ok(plan.steps.some(step => step.agentId === 'reviewer'));
  assert.match(plan.destination, /OpenAI API/);
  assert.equal(harness.hostedFetches, 0);
  assert.equal(JSON.stringify(await ipcHandlers.get('task:get')(null, plan.id)).includes('secret-test-key'), false);

  modelReplies.push('{"type":"tool","name":"write_file","arguments":{"path":"created.txt","content":"approved content"}}', '{"type":"final","content":"Created the requested file."}', '{"type":"final","content":"The new file is present and looks good."}');
  await ipcHandlers.get('task:approve-route')(null, plan.id);
  for (let i = 0; i < 100 && !events.some(item => item.type === 'approval-requested'); i++) await sleep(10);
  const approvalEvent = events.find(item => item.type === 'approval-requested');
  assert.ok(approvalEvent, 'a write must create an approval request');
  await assert.rejects(fs.access(path.join(workspace, 'created.txt')));
  await ipcHandlers.get('approval:respond')(null, approvalEvent.approvalId, true);
  for (let i = 0; i < 100; i++) {
    const task = await ipcHandlers.get('task:get')(null, plan.id);
    if (task.status === 'completed') break;
    await sleep(10);
  }
  assert.equal(await fs.readFile(path.join(workspace, 'created.txt'), 'utf8'), 'approved content');
  const completed = await ipcHandlers.get('task:get')(null, plan.id);
  assert.equal(completed.status, 'completed');
  assert.ok(completed.events.some(item => item.type === 'agent-status' && item.agentId === 'reviewer'), 'reviewer runs after builder work');
  const resultEvent = completed.events.find(item => item.type === 'tool-result');
  assert.equal(resultEvent.result.includes('approved content'), false, 'file contents are not copied into activity logs');

  const commandPlan = await ipcHandlers.get('task:plan')(null, { prompt: 'Run the tests and review the project.', provider: 'openai', model: 'model-x' });
  modelReplies.push('{"type":"tool","name":"run_shell","arguments":{"command":"npm test"}}', '{"type":"final","content":"Tests passed."}');
  await ipcHandlers.get('task:approve-route')(null, commandPlan.id);
  for (let i = 0; i < 100 && !events.some(item => item.type === 'approval-requested' && item.taskId === commandPlan.id); i++) await sleep(10);
  const commandApproval = events.find(item => item.type === 'approval-requested' && item.taskId === commandPlan.id);
  assert.ok(commandApproval, 'a shell command must require approval');
  assert.equal(harness.shellCalls, 0, 'the command must not run before approval');
  await ipcHandlers.get('approval:respond')(null, commandApproval.approvalId, true);
  for (let i = 0; i < 100; i++) {
    const task = await ipcHandlers.get('task:get')(null, commandPlan.id);
    if (task.status === 'completed') break;
    await sleep(10);
  }
  assert.equal(harness.shellCalls, 1, 'the approved command runs once');

  // Restart the app while the write is queued, then approve from the restored queue.
  const restartPlan = await ipcHandlers.get('task:plan')(null, { prompt: 'Fix one bug in the project.', provider: 'openai', model: 'model-x' });
  modelReplies.push('{"type":"tool","name":"write_file","arguments":{"path":"restart-note.txt","content":"approved after restart"}}');
  await ipcHandlers.get('task:approve-route')(null, restartPlan.id);
  for (let i = 0; i < 100 && !events.some(item => item.type === 'approval-requested' && item.taskId === restartPlan.id); i++) await sleep(10);
  const restartApproval = events.find(item => item.type === 'approval-requested' && item.taskId === restartPlan.id);
  assert.ok(restartApproval, 'a second write must reach the approval queue');
  first.app.emit('before-quit');
  const second = harness.boot();
  await sleep(50);
  const restored = await second.ipcHandlers.get('app:bootstrap')();
  assert.equal(restored.pendingApprovals.length, 1, 'queued approval survives restart');
  const response = await second.ipcHandlers.get('approval:respond')(null, restartApproval.approvalId, true);
  assert.equal(response.recoveryRequired, true);
  assert.equal(await fs.readFile(path.join(workspace, 'restart-note.txt'), 'utf8'), 'approved after restart');
  const resumed = await second.ipcHandlers.get('task:get')(null, restartPlan.id);
  assert.equal(resumed.status, 'needs-attention', 'interrupted agent work is not incorrectly marked complete');
  assert.ok(resumed.events.some(item => item.type === 'resume-required'));
  const restartedResult = resumed.events.find(item => item.type === 'tool-result');
  assert.equal(restartedResult.result.includes('approved after restart'), false, 'file contents are not copied into activity logs');
});
