const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, readyHarness, waitFor, waitForStatus } = require('./helpers/harness');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('route approval seeds a ticket board and an agent can ask the user', async t => {
  const { ipcHandlers, events, modelReplies } = await readyHarness(t);
  const plan = await ipcHandlers.get('task:plan')(null, { prompt: 'Build and review the new feature.', provider: 'openai', model: 'model-x' });
  assert.ok(plan.steps.some(step => step.agentId === 'builder'));
  assert.ok(plan.steps.some(step => step.agentId === 'reviewer'));
  modelReplies.push(
    '{"type":"tool","name":"ask_user","arguments":{"question":"Which name should the new file use?"}}',
    '{"type":"final","content":"Builder finished."}',
    '{"type":"final","content":"Reviewer checked it."}'
  );
  await ipcHandlers.get('task:approve-route')(null, plan.id);
  assert.ok(await waitFor(() => events.some(item => item.type === 'question-asked')), 'agent question reaches the inbox');
  const asked = events.find(item => item.type === 'question-asked');
  const mid = await ipcHandlers.get('task:get')(null, plan.id);
  assert.ok(mid.tickets.length >= 2, 'tickets are created when the route is approved');
  assert.ok(mid.tickets.every(ticket => ticket.code.startsWith('T-')), 'tickets have board ids');
  await ipcHandlers.get('approval:respond')(null, asked.approvalId, true, 'name it signup.ts');
  const done = await waitForStatus(ipcHandlers, plan.id, 'completed');
  assert.equal(done.status, 'completed', 'task completes after the user answers');
  assert.ok(done.tickets.every(ticket => ticket.status === 'done'), 'all tickets close when work finishes');
  assert.ok(events.some(item => item.type === 'question-answered'));
});

test('an agent can hand a ticket to another agent, which then runs', async t => {
  const { ipcHandlers, events, modelReplies } = await readyHarness(t);
  const plan = await ipcHandlers.get('task:plan')(null, { prompt: 'Build the new feature.', provider: 'openai', model: 'model-x' });
  assert.deepEqual(plan.steps.map(step => step.agentId), ['builder']);
  modelReplies.push(
    '{"type":"tool","name":"create_ticket","arguments":{"title":"Review the new code","assignTo":"reviewer"}}',
    '{"type":"final","content":"Builder created the change and asked for review."}',
    '{"type":"final","content":"Reviewer approved the change."}'
  );
  await ipcHandlers.get('task:approve-route')(null, plan.id);
  const done = await waitForStatus(ipcHandlers, plan.id, 'completed');
  assert.equal(done.status, 'completed');
  assert.ok(events.some(item => item.type === 'handoff' && item.toAgentId === 'reviewer'), 'handoff is recorded');
  assert.ok(events.some(item => item.type === 'agent-status' && item.agentId === 'reviewer' && item.status === 'completed'), 'reviewer runs after the handoff');
  assert.ok(done.tickets.some(ticket => ticket.assignedAgentId === 'reviewer'), 'ticket is assigned to the reviewer');
});

test('the circuit breaker pauses a task before it overspends', async t => {
  const { ipcHandlers, events, modelReplies } = await readyHarness(t, { taskBudget: 5 });
  const plan = await ipcHandlers.get('task:plan')(null, { prompt: 'Build the new feature.', provider: 'openai', model: 'model-x' });
  for (let i = 0; i < 6; i++) modelReplies.push('{"type":"tool","name":"update_ticket","arguments":{"code":"T-1","status":"doing"}}');
  await ipcHandlers.get('task:approve-route')(null, plan.id);
  const done = await waitForStatus(ipcHandlers, plan.id, 'needs-attention');
  assert.equal(done.status, 'needs-attention', 'task pauses at the budget instead of overspending');
  assert.ok(events.some(item => item.type === 'budget-paused' && item.budget === 5), 'budget pause is reported to the user');
});

test('a git_diff of a secret file is blocked, reported to the agent, and the run continues', async t => {
  const { ipcHandlers, modelReplies, execCalls } = await readyHarness(t);
  const plan = await ipcHandlers.get('task:plan')(null, { prompt: 'Review the project for issues.', provider: 'openai', model: 'model-x' });
  modelReplies.push(
    '{"type":"tool","name":"git_diff","arguments":{"path":".env"}}',
    '{"type":"final","content":"Reviewed the safe changes."}'
  );
  await ipcHandlers.get('task:approve-route')(null, plan.id);
  const done = await waitForStatus(ipcHandlers, plan.id, 'completed');
  const toolError = done.events.find(item => item.type === 'tool-error' && item.tool === 'git_diff');
  assert.ok(toolError, 'the blocked diff is reported back as a recoverable tool error');
  assert.match(toolError.message, /secret/i, 'the error explains the secret-policy block');
  assert.equal(execCalls.some(call => call.args.includes('.env')), false, 'git is never asked to diff the secret file');
});

test('reading VCS internals is blocked instead of leaking credentials to the model', async t => {
  const { ipcHandlers, modelReplies } = await readyHarness(t);
  const plan = await ipcHandlers.get('task:plan')(null, { prompt: 'Review the project for issues.', provider: 'openai', model: 'model-x' });
  modelReplies.push(
    '{"type":"tool","name":"read_file","arguments":{"path":".git/config"}}',
    '{"type":"final","content":"Reviewed the safe files."}'
  );
  await ipcHandlers.get('task:approve-route')(null, plan.id);
  const done = await waitForStatus(ipcHandlers, plan.id, 'completed');
  const toolError = done.events.find(item => item.type === 'tool-error' && item.tool === 'read_file');
  assert.ok(toolError, 'reading .git internals is reported as a recoverable tool error');
  assert.match(toolError.message, /secret/i);
});

test('a coordination tool error is fed back to the agent instead of failing the task', async t => {
  const { ipcHandlers, events, modelReplies } = await readyHarness(t);
  const plan = await ipcHandlers.get('task:plan')(null, { prompt: 'Build the new feature.', provider: 'openai', model: 'model-x' });
  modelReplies.push(
    '{"type":"tool","name":"update_ticket","arguments":{"code":"T-999","status":"done"}}',
    '{"type":"final","content":"Finished after correcting the ticket."}'
  );
  await ipcHandlers.get('task:approve-route')(null, plan.id);
  const done = await waitForStatus(ipcHandlers, plan.id, 'completed');
  assert.equal(done.status, 'completed', 'a bad tool call does not abort the run');
  const recovery = events.find(item => item.type === 'tool-error' && item.tool === 'update_ticket');
  assert.ok(recovery, 'the tool error is recorded for the reviewer');
  assert.match(recovery.message, /T-999/, 'the error names the rejected ticket code');
});

test('a pathless git_diff excludes sensitive files from the diff', async t => {
  const { ipcHandlers, modelReplies, execCalls } = await readyHarness(t, {
    onExecFile: (_file, args) => {
      if (args.includes('--name-only')) return { stdout: '.env\nsrc/app.js\n', stderr: '' };
      return { stdout: 'diff --git a/src/app.js b/src/app.js\n+hello', stderr: '' };
    }
  });
  const plan = await ipcHandlers.get('task:plan')(null, { prompt: 'Review the project for issues.', provider: 'openai', model: 'model-x' });
  modelReplies.push('{"type":"tool","name":"git_diff","arguments":{}}', '{"type":"final","content":"Reviewed."}');
  await ipcHandlers.get('task:approve-route')(null, plan.id);
  await waitForStatus(ipcHandlers, plan.id, 'completed');
  const diffCall = execCalls.find(call => call.args.includes('diff') && call.args.includes('--no-ext-diff'));
  assert.ok(diffCall, 'a diff is requested');
  assert.ok(diffCall.args.includes('src/app.js'), 'the non-secret change is included');
  assert.equal(diffCall.args.some(argument => argument.includes('.env')), false, 'the secret file is excluded from the diff');
});

test('approving a route twice does not start a second orchestration loop', async t => {
  const { ipcHandlers, events, modelReplies } = await readyHarness(t);
  const plan = await ipcHandlers.get('task:plan')(null, { prompt: 'Build the new feature.', provider: 'openai', model: 'model-x' });
  modelReplies.push('{"type":"final","content":"Builder finished."}');
  const firstApprove = await ipcHandlers.get('task:approve-route')(null, plan.id);
  const secondApprove = await ipcHandlers.get('task:approve-route')(null, plan.id);
  assert.equal(firstApprove.started, true);
  assert.equal(secondApprove.started, false, 'a repeated approval is ignored');
  await waitForStatus(ipcHandlers, plan.id, 'completed');
  await sleep(100);
  const runningEvents = events.filter(item => item.type === 'agent-status' && item.agentId === 'builder' && item.status === 'running');
  assert.equal(runningEvents.length, 1, 'the builder runs exactly once');
});

test('cancelling a task aborts the in-flight model request', async t => {
  let started = false;
  let aborted = false;
  const harness = await readyHarness(t, {
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      started = true;
      options.signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
    })
  });
  const plan = await harness.ipcHandlers.get('task:plan')(null, { prompt: 'Build the new feature.', provider: 'openai', model: 'model-x' });
  await harness.ipcHandlers.get('task:approve-route')(null, plan.id);
  assert.ok(await waitFor(() => started), 'the worker starts a model request');
  await harness.ipcHandlers.get('task:cancel')(null, plan.id);
  assert.ok(await waitFor(() => aborted), 'cancelling aborts the request rather than waiting for it');
  const done = await waitForStatus(harness.ipcHandlers, plan.id, 'cancelled');
  assert.equal(done.status, 'cancelled');
});

test('cancelling a task clears its pending approval instead of leaving the worker suspended', async t => {
  const harness = await readyHarness(t);
  const plan = await harness.ipcHandlers.get('task:plan')(null, { prompt: 'Run the tests and review the project.', provider: 'openai', model: 'model-x' });
  harness.modelReplies.push('{"type":"tool","name":"run_shell","arguments":{"command":"npm test"}}', '{"type":"final","content":"Done."}');
  await harness.ipcHandlers.get('task:approve-route')(null, plan.id);
  assert.ok(await waitFor(() => harness.events.some(item => item.type === 'approval-requested' && item.taskId === plan.id)), 'the tool waits for approval');
  const approval = harness.events.find(item => item.type === 'approval-requested' && item.taskId === plan.id);
  await harness.ipcHandlers.get('task:cancel')(null, plan.id);
  const done = await waitForStatus(harness.ipcHandlers, plan.id, 'cancelled');
  assert.equal(done.status, 'cancelled', 'the suspended worker does not block the cancellation');
  assert.equal(harness.shellCalls, 0, 'the unapproved command never runs');
  const boot = await harness.ipcHandlers.get('app:bootstrap')();
  assert.equal(boot.pendingApprovals.some(item => item.id === approval.approvalId), false, 'the cancelled task leaves no pending approval behind');
});

test('a high-risk shell command is not executed until the confirmation is given', async t => {
  const harness = await readyHarness(t);
  const plan = await harness.ipcHandlers.get('task:plan')(null, { prompt: 'Run the tests and review the project.', provider: 'openai', model: 'model-x' });
  harness.modelReplies.push('{"type":"tool","name":"run_shell","arguments":{"command":"Remove-Item -Recurse -Force .\\\\out"}}', '{"type":"final","content":"Done."}');
  await harness.ipcHandlers.get('task:approve-route')(null, plan.id);
  assert.ok(await waitFor(() => harness.events.some(item => item.type === 'approval-requested' && item.taskId === plan.id)), 'a high-risk command is queued for approval');
  const approval = harness.events.find(item => item.type === 'approval-requested' && item.taskId === plan.id);
  assert.equal(approval.payload.risk.level, 'high');
  const unconfirmed = await harness.ipcHandlers.get('approval:respond')(null, approval.approvalId, true);
  assert.equal(unconfirmed.requiresConfirmation, true, 'approval is refused without confirmation');
  assert.equal(harness.shellCalls, 0, 'the command does not run before confirmation');
  await harness.ipcHandlers.get('approval:respond')(null, approval.approvalId, true, undefined, true);
  await waitFor(() => harness.shellCalls === 1);
  assert.equal(harness.shellCalls, 1, 'the command runs after confirmation');
  await waitForStatus(harness.ipcHandlers, plan.id, 'completed');
});

test('a queued agent question survives a restart and can be answered afterward', async t => {
  const harness = await readyHarness(t);
  const plan = await harness.ipcHandlers.get('task:plan')(null, { prompt: 'Build the new feature.', provider: 'openai', model: 'model-x' });
  harness.modelReplies.push('{"type":"tool","name":"ask_user","arguments":{"question":"Proceed with the migration?"}}');
  await harness.ipcHandlers.get('task:approve-route')(null, plan.id);
  assert.ok(await waitFor(() => harness.events.some(item => item.type === 'question-asked')), 'question asked before restart');
  const asked = harness.events.find(item => item.type === 'question-asked');
  harness.app.emit('before-quit');
  const second = harness.boot();
  await sleep(50);
  const restored = await second.ipcHandlers.get('app:bootstrap')();
  assert.equal(restored.pendingApprovals.length, 1, 'queued question survives restart');
  assert.equal(restored.pendingApprovals[0].action, 'ask_user');
  const response = await second.ipcHandlers.get('approval:respond')(null, asked.approvalId, true, 'yes, proceed');
  assert.equal(response.recoveryRequired, true, 'a restored question cannot resume the interrupted run');
  const resumed = await second.ipcHandlers.get('task:get')(null, plan.id);
  assert.equal(resumed.status, 'needs-attention');
  assert.ok(resumed.events.some(item => item.type === 'resume-required'));
});

test('bootstrap explains why a provider is not ready yet', async t => {
  const harness = await createHarness(t);
  const first = harness.boot();
  await sleep(50);
  await first.ipcHandlers.get('workspace:select')();
  await first.ipcHandlers.get('settings:save')(null, {
    providers: { freellm: { baseUrl: 'http://localhost:3001/v1', model: '', apiKey: 'freellm-unified-key' } }
  });
  const boot = await first.ipcHandlers.get('app:bootstrap')();
  assert.equal(boot.providerStatus.freellm.reason, 'no-model', 'a key without a model is reported as no-model');
  assert.equal(boot.providerReady.freellm, false);
  assert.equal(boot.providerStatus.openai.reason, 'no-key', 'a provider without a key is reported as no-key');
});

test('FreeLLM drives a full task to completion through the local router', async t => {
  const harness = await createHarness(t);
  const first = harness.boot();
  await sleep(50);
  await first.ipcHandlers.get('workspace:select')();
  await first.ipcHandlers.get('settings:save')(null, {
    providers: { freellm: { baseUrl: 'http://localhost:3001/v1', model: 'auto', apiKey: 'freellm-unified-key' } }
  });
  const plan = await first.ipcHandlers.get('task:plan')(null, { prompt: 'Build the new feature.', provider: 'freellm', model: 'auto' });
  assert.equal(plan.steps[0].provider, 'freellm');
  harness.modelReplies.push('{"type":"final","content":"Routed through FreeLLM."}');
  await first.ipcHandlers.get('task:approve-route')(null, plan.id);
  const done = await waitForStatus(first.ipcHandlers, plan.id, 'completed');
  assert.equal(done.status, 'completed');
  assert.ok(done.messages.some(message => String(message.content).includes('Routed through FreeLLM.')), 'the router answer reaches the conversation');
});

// A fetch fake that answers `/models` with a configurable list and streams a
// chat completion otherwise, so Phase A's model auto-resolution can be tested.
function routerFetch(info = {}) {
  const calls = { modelFetches: 0 };
  const impl = async url => {
    if (String(url).includes('/models')) {
      calls.modelFetches++;
      const list = info.modelList || ['alpha', 'beta'];
      return new Response(JSON.stringify({ data: list.map(id => ({ id })) }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const content = '{"type":"final","content":"Done."}';
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`)); controller.close(); } });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { impl, calls };
}

test('task:plan falls back to the provider default model when the request omits one', async t => {
  const { ipcHandlers } = await readyHarness(t);
  const plan = await ipcHandlers.get('task:plan')(null, { prompt: 'Build the new feature.', provider: 'openai' });
  assert.equal(plan.steps[0].model, 'model-x', 'the configured provider model is used');
});

test('task:plan auto-selects the first model a router offers', async t => {
  const router = routerFetch({ modelList: ['zeta', 'alpha'] });
  const harness = await createHarness(t, { fetchImpl: router.impl });
  const first = harness.boot();
  await sleep(50);
  await first.ipcHandlers.get('workspace:select')();
  await first.ipcHandlers.get('settings:save')(null, { providers: { freellm: { baseUrl: 'http://localhost:3001/v1', model: '', apiKey: 'freellm-unified-key' } } });
  const plan = await first.ipcHandlers.get('task:plan')(null, { prompt: 'Build the new feature.', provider: 'freellm' });
  assert.equal(plan.steps[0].provider, 'freellm');
  assert.equal(plan.steps[0].model, 'alpha', 'the sorted model list yields a usable model');
});

test('task:plan falls back to FreeLLM "auto" when the router is unreachable', async t => {
  const refused = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); };
  const harness = await createHarness(t, { fetchImpl: refused });
  const first = harness.boot();
  await sleep(50);
  await first.ipcHandlers.get('workspace:select')();
  await first.ipcHandlers.get('settings:save')(null, { providers: { freellm: { baseUrl: 'http://localhost:3001/v1', model: '', apiKey: 'freellm-unified-key' } } });
  const plan = await first.ipcHandlers.get('task:plan')(null, { prompt: 'Build the new feature.', provider: 'freellm' });
  assert.equal(plan.steps[0].model, 'auto', 'an empty model never blocks task creation');
});

test('provider:models caches a router list and reloads when forced', async t => {
  const router = routerFetch({ modelList: ['alpha'] });
  const harness = await createHarness(t, { fetchImpl: router.impl });
  const first = harness.boot();
  await sleep(50);
  await first.ipcHandlers.get('settings:save')(null, { providers: { freellm: { baseUrl: 'http://localhost:3001/v1', model: '', apiKey: 'freellm-unified-key' } } });
  assert.deepEqual(await first.ipcHandlers.get('provider:models')(null, 'freellm'), ['alpha']);
  assert.deepEqual(await first.ipcHandlers.get('provider:models')(null, 'freellm'), ['alpha']);
  assert.equal(router.calls.modelFetches, 1, 'the second call is served from cache');
  assert.deepEqual(await first.ipcHandlers.get('provider:models')(null, 'freellm', true), ['alpha']);
  assert.equal(router.calls.modelFetches, 2, 'force bypasses the cache');
});

test('bootstrap exposes cached provider models to the composer', async t => {
  const router = routerFetch({ modelList: ['alpha', 'beta'] });
  const harness = await createHarness(t, { fetchImpl: router.impl });
  const first = harness.boot();
  await sleep(50);
  await first.ipcHandlers.get('settings:save')(null, { providers: { freellm: { baseUrl: 'http://localhost:3001/v1', model: '', apiKey: 'freellm-unified-key' } } });
  await first.ipcHandlers.get('provider:models')(null, 'freellm');
  const boot = await first.ipcHandlers.get('app:bootstrap')();
  assert.deepEqual(boot.models.freellm, ['alpha', 'beta']);
});

test('a worker keeps going past the old eight-step cap', async t => {
  const { ipcHandlers, events, modelReplies } = await readyHarness(t, { taskBudget: 30 });
  const plan = await ipcHandlers.get('task:plan')(null, { prompt: 'Fix one bug in the project.', provider: 'openai', model: 'model-x' });
  assert.deepEqual(plan.steps.map(step => step.agentId), ['builder'], 'a narrow fix routes to one agent');
  for (let i = 0; i < 9; i++) modelReplies.push('{"type":"tool","name":"update_ticket","arguments":{"code":"T-1","status":"doing"}}');
  modelReplies.push('{"type":"final","content":"Finished after a long run."}');
  await ipcHandlers.get('task:approve-route')(null, plan.id);
  const done = await waitForStatus(ipcHandlers, plan.id, 'completed');
  assert.equal(done.status, 'completed');
  assert.ok(done.messages.some(message => String(message.content).includes('Finished after a long run.')), 'the run reached its final report');
  assert.ok(events.filter(item => item.type === 'agent-thinking').length >= 10, 'the worker took more than eight model turns');
});

test('bootstrap exposes the max tool-step setting to Settings', async t => {
  const { ipcHandlers } = await readyHarness(t);
  const boot = await ipcHandlers.get('app:bootstrap')();
  assert.equal(boot.maxSteps, 24);
  const saved = await ipcHandlers.get('settings:save')(null, { maxSteps: 12 });
  assert.equal(saved.maxSteps, 12);
});
