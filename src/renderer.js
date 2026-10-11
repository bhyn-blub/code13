const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { workspace: '', providers: {}, providerReady: {}, providerStatus: {}, models: {}, modelChoice: {}, modelError: {}, router: {}, providerOrder: ['ollama', 'openai', 'anthropic', 'freellm'], providerLabels: {}, toolLabels: {}, agents: [], tasks: [], currentTask: null, currentPlan: null, approvals: [], activity: [], tickets: [], agentStatuses: {}, agentTickets: {}, busy: false, editingAgent: null, activeSettingsTab: 'providers', taskBudget: 40, maxSteps: 24, localProviders: ['ollama'], settingsDirty: false, sessions: [], currentSessionId: '', streaming: null, hostedModelRouting: false };
let TOOL_LABELS = {};

function esc(value = '') { return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function initials(name = '') { return name.split(/\s+/).map(part => part[0] || '').slice(0, 2).join('').toUpperCase() || 'AI'; }
function toast(message) { const node = $('#toast'); node.textContent = message; node.classList.remove('hidden'); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.add('hidden'), 3200); }
function providerLabel(provider) { return provider === 'inherit' ? 'Task provider' : (state.providerLabels || {})[provider] || provider; }
function providerDestination(provider, model) {
  if (provider === 'ollama') return 'This task stays on this device.';
  if (provider === 'freellm') return `Context goes to your local FreeLLM router, which forwards to free hosted tiers (Google, Groq, …)${model ? ` · ${model}` : ''}.`;
  return `Task context will be sent to ${providerLabel(provider)}${model ? ` · ${model}` : ''}.`;
}
function activeProvider() { return $('#routeProvider').value || 'ollama'; }
function readinessText(provider, ready) {
  const status = (state.providerStatus || {})[provider];
  const local = (state.localProviders || []).includes(provider);
  if (status) {
    if (status.reason === 'ready') return local ? 'Local provider' : 'Key stored securely';
    if (status.reason === 'no-model') return 'Add a model';
    if (status.reason === 'no-key') return 'Add an API key';
  }
  if (provider === 'freellm') return ready ? 'Add a model' : 'Add the unified key';
  return ready ? (local ? 'Local provider' : 'Key stored securely') : 'Not configured';
}

function init() {
  $('#composer').addEventListener('submit', submitPrompt);
  $('#promptInput').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#composer').requestSubmit(); } });
  $('#newTaskButton').addEventListener('click', newTask);
  $('#attachFolder').addEventListener('click', selectWorkspace);
  $('#chooseWorkspaceSmall').addEventListener('click', selectWorkspace);
  $('#openSettings').addEventListener('click', () => openModal('settings'));
  $('#manageAgents').addEventListener('click', () => openModal('team'));
  $('#addAgent').addEventListener('click', () => editAgent(null));
  $('#saveSettings').addEventListener('click', saveSettings);
  $('#saveAgent').addEventListener('click', saveAgent);
  $('#routeProvider').addEventListener('change', onProviderChange);
  $('#routeModel').addEventListener('change', () => { state.modelChoice[activeProvider()] = $('#routeModel').value; updateProviderChrome(); });
  $('#routeModelRefresh').addEventListener('click', async () => { await ensureModels(activeProvider(), true); updateProviderChrome(); });
  $('#sessionSelect').addEventListener('change', switchSession);
  $('#newSessionButton').addEventListener('click', createNewSession);
  initFileAutocomplete();
  document.addEventListener('click', event => {
    const close = event.target.closest('[data-close]');
    if (close) closeModals();
    const open = event.target.closest('[data-open]');
    if (open) openModal(open.dataset.open);
    const tab = event.target.closest('[data-tab]');
    if (tab) { state.activeSettingsTab = tab.dataset.tab; renderSettings(); }
    const suggestion = event.target.closest('[data-prompt]');
    if (suggestion) { $('#promptInput').value = suggestion.dataset.prompt; $('#promptInput').focus(); }
  });
  $('#overlay').addEventListener('click', event => { if (event.target === $('#overlay')) closeModals(); });
  $('#routePanel').addEventListener('click', routeAction);
  $('#approvalPanel').addEventListener('click', approvalAction);
  $('#approvalPanel').addEventListener('change', event => {
    const box = event.target.closest('[data-confirm-risk]');
    if (!box) return;
    const button = $(`[data-approve="${box.dataset.confirmRisk}"]`);
    if (button) button.disabled = !box.checked;
  });
  $('#teamCards').addEventListener('click', event => { const edit = event.target.closest('[data-edit-agent]'); if (edit) editAgent(edit.dataset.editAgent); });
  $('#agentManager').addEventListener('click', managerAction);
  $('#agentEditor').addEventListener('click', event => {
    if (event.target.matches('[data-toggle-advanced]')) { $('#advancedFields').classList.toggle('hidden'); event.target.textContent = $('#advancedFields').classList.contains('hidden') ? 'Show advanced settings' : 'Hide advanced settings'; }
  });
  $('#recentTasks').addEventListener('click', async event => { const button = event.target.closest('[data-task-id]'); if (button) await loadTask(button.dataset.taskId); });
  $('#clearActivity').addEventListener('click', () => { state.activity = []; renderActivity(); });
  $('#settingsBody').addEventListener('click', async event => {
    const test = event.target.closest('[data-test-provider]');
    if (test) await testProvider(test.dataset.testProvider);
    const ping = event.target.closest('[data-ping-provider]');
    if (ping) await checkProvider(ping.dataset.pingProvider);
    const models = event.target.closest('[data-load-models]');
    if (models) await loadModels(models.dataset.loadModels);
    if (event.target.closest('#pickWorkspace')) await selectWorkspace();
    // MCP handlers
    if (event.target.closest('[data-mcp-add]')) { addMCPServer(); return; }
    if (event.target.closest('[data-mcp-connect]')) { await connectMCPServer(event.target.closest('[data-mcp-connect]').dataset.mcpConnect); return; }
    if (event.target.closest('[data-mcp-edit]')) { editMCPServer(event.target.closest('[data-mcp-edit]').dataset.mcpEdit); return; }
    if (event.target.closest('[data-mcp-remove]')) { await removeMCPServer(event.target.closest('[data-mcp-remove]').dataset.mcpRemove); return; }
    if (event.target.closest('[data-mcp-save]')) { await saveMCPServer(event); return; }
    if (event.target.closest('[data-mcp-cancel]')) { cancelMCPEditor(); return; }
  });
  $('#settingsBody').addEventListener('input', event => {
    if (event.target.matches('input, textarea, select')) markSettingsDirty();
  });
  window.code13.onEvent(handleEvent);
  document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); newTask(); } if (event.key === 'Escape') closeModals(); });
  bootstrap();
}

async function bootstrap() {
  try {
    const result = await window.code13.bootstrap();
    Object.assign(state, result);
    TOOL_LABELS = result.toolLabels || TOOL_LABELS;
    state.activity = result.currentTask?.events || [];
    state.tickets = result.currentTask?.tickets || [];
    state.tasks = result.recentTasks || [];
    updateWorkspace(); updateProviderChrome(); renderTeam(); renderSessions(); renderRecentTasks(); renderActivity(); renderApprovals(); renderTickets();
    if (result.currentTask) { state.currentTask = result.currentTask; renderTask(result.currentTask); }
    else setEmpty(true);
    onProviderChange();
  } catch (error) { toast(error.message); }
}

function updateWorkspace() {
  const name = state.workspace ? state.workspace.split(/[\\/]/).filter(Boolean).pop() : 'No project selected';
  $('#sidebarWorkspace').textContent = name;
  $('#topWorkspace').textContent = name;
  const composer = $('#composerWorkspace');
  composer.textContent = state.workspace ? name : 'Choose a workspace to start';
  composer.title = state.workspace || '';
}
function providerModels(provider) { return (state.models || {})[provider] || []; }
function currentModel(provider) {
  const remembered = (state.modelChoice || {})[provider];
  if (remembered) return remembered;
  const configured = state.providers?.[provider]?.model;
  if (configured) return configured;
  return providerModels(provider)[0] || '';
}
function renderModelSelect() {
  const select = $('#routeModel'); if (!select) return;
  const provider = activeProvider();
  const chosen = currentModel(provider);
  const values = [...new Set([...(chosen ? [chosen] : []), ...providerModels(provider)])];
  if (!values.length) { select.innerHTML = '<option value="">No model yet — reload ⟳</option>'; select.value = ''; return; }
  select.innerHTML = values.map(model => `<option value="${esc(model)}">${esc(model)}</option>`).join('');
  select.value = chosen;
}
function renderAgentModelList() {
  let list = $('#agentModelList');
  if (!list) { list = document.createElement('datalist'); list.id = 'agentModelList'; document.body.append(list); }
  const values = [...new Set(Object.values(state.models || {}).flat())];
  list.innerHTML = values.map(model => `<option value="${esc(model)}"></option>`).join('');
}
async function ensureModels(provider, force = false) {
  const needsKey = !(state.localProviders || []).includes(provider);
  if (needsKey && state.providerStatus?.[provider]?.reason === 'no-key' && !force) return providerModels(provider);
  try {
    const models = await window.code13.listProviderModels(provider, force);
    state.models = { ...(state.models || {}), [provider]: models };
    if (state.modelError) delete state.modelError[provider];
    renderAgentModelList();
    return models;
  } catch (error) {
    state.modelError = { ...(state.modelError || {}), [provider]: error.message };
    return providerModels(provider);
  }
}
async function onProviderChange() {
  const provider = activeProvider();
  await ensureModels(provider);
  if (provider === 'freellm') {
    try { state.router = { ...(state.router || {}), [provider]: await window.code13.pingProvider(provider) }; }
    catch (error) { state.router = { ...(state.router || {}), [provider]: { reachable: false, error: error.message } }; }
  }
  updateProviderChrome();
}
function updateComposerHint() {
  const hint = $('#composerHint'); if (!hint) return;
  const provider = activeProvider();
  const status = state.providerStatus?.[provider];
  const messages = [];
  if (provider !== 'ollama' && status?.reason === 'no-key') messages.push(`${providerLabel(provider)} needs an API key — open Settings to add one.`);
  if (state.modelError?.[provider]) messages.push(state.modelError[provider]);
  const router = state.router?.[provider];
  if (provider === 'freellm' && router && !router.reachable) messages.push(router.error || 'FreeLLMAPI router is not reachable — start it, then reload models.');
  if (provider !== 'ollama' && !currentModel(provider)) messages.push(`${providerLabel(provider)} has no model selected — pick one above or open Settings.`);
  if (messages.length) { hint.textContent = messages[0]; hint.classList.remove('hidden'); }
  else hint.classList.add('hidden');
}
function updateProviderChrome() {
  const provider = activeProvider();
  $('#providerStatus').textContent = providerLabel(provider);
  $('#providerDot').classList.toggle('remote', provider !== 'ollama');
  renderModelSelect();
  $('#egressHint').textContent = providerDestination(provider, currentModel(provider));
  updateComposerHint();
}
function setEmpty(show) {
  $('#emptyState').classList.toggle('hidden', !show);
  $('#conversationHeader').classList.toggle('hidden', !show);
}
function newTask() {
  state.currentTask = null; state.currentPlan = null; state.activity = []; state.approvals = []; state.tickets = [];
  $('#messages').innerHTML = ''; $('#routePanel').classList.add('hidden'); $('#approvalPanel').innerHTML = '';
  renderActivity(); renderTickets(); setEmpty(true); $('#promptInput').focus();
}
async function selectWorkspace() {
  try {
    const folder = await window.code13.selectWorkspace();
    if (folder) {
      state.workspace = folder;
      updateWorkspace();
      if (!$('#settingsModal').classList.contains('hidden')) renderSettings();
      toast('Project workspace selected.');
    }
  }
  catch (error) { toast(error.message); }
}

async function submitPrompt(event) {
  event.preventDefault();
  if (state.busy) return;
  const prompt = $('#promptInput').value.trim();
  if (!prompt) return;
  state.busy = true; $('#sendButton').disabled = true; $('#typingIndicator').classList.remove('hidden');
  setEmpty(false); $('#conversationHeader').classList.add('hidden'); $('#routePanel').classList.add('hidden'); $('#approvalPanel').innerHTML = '';
  try {
    const plan = await window.code13.createPlan({ prompt, provider: activeProvider(), model: currentModel(activeProvider()) });
    state.currentTask = { id: plan.id, title: plan.title, status: 'awaiting-route-approval', messages: [{ role: 'user', content: prompt }], events: [] };
    state.currentPlan = plan; $('#promptInput').value = ''; renderTask(state.currentTask); renderRoute(plan); renderRecentTasks();
    const session = (state.sessions || []).find(item => item.id === state.currentSessionId);
    if (session) { session.taskCount += 1; if (session.title === 'New session') session.title = plan.title.slice(0, 60); renderSessions(); }
  } catch (error) {
    const needsSettings = /model|provider|settings|api key|reachable|router/i.test(error.message);
    toast(needsSettings ? `${error.message} — opening Settings.` : error.message);
    if (needsSettings) openModal('settings');
    setEmpty(!state.currentTask);
  }
  finally { state.busy = false; $('#sendButton').disabled = false; $('#typingIndicator').classList.add('hidden'); }
}

function renderTask(task) {
  state.currentTask = task;
  const messages = $('#messages'); messages.innerHTML = '';
  for (const message of task.messages || []) appendMessage(message.role, message.content);
  const route = [...(task.events || [])].reverse().find(item => item.type === 'route-proposed');
  if (route && task.status === 'awaiting-route-approval') renderRoute(route);
  const final = [...(task.events || [])].reverse().find(item => item.type === 'final');
  if (final && !(task.messages || []).some(message => message.role === 'assistant')) appendMessage('assistant', final.content);
  $('#typingIndicator').classList.toggle('hidden', !['planning', 'running'].includes(task.status));
  setEmpty(!(task.messages || []).length);
  state.tickets = task.tickets || [];
  renderTickets();
  renderApprovals();
}
function appendMessage(role, content) {
  const node = document.createElement('div');
  if (role === 'user') { node.className = 'user-message'; node.textContent = content; }
  else { node.className = 'assistant-message'; node.innerHTML = `<div class="assistant-mark">13</div><div class="assistant-content">${esc(content)}</div>`; }
  $('#messages').append(node);
  node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return node;
}
function renderRoute(plan) {
  state.currentPlan = plan;
  const hosted = plan.steps.some(step => step.provider !== 'ollama');
  $('#routePanel').innerHTML = `<div class="route-top"><div><div class="route-title">Proposed route</div><div class="route-sub">Code 13 will coordinate ${plan.steps.length} agent${plan.steps.length === 1 ? '' : 's'} for this task.</div></div><span class="route-privacy ${hosted ? 'remote' : ''}">${hosted ? '↗' : '●'} ${esc(plan.destination)}</span></div><div class="route-reason">${esc(plan.reason)}</div><div class="route-steps">${plan.steps.map((step, index) => `<div class="route-step"><span class="mini-agent">${index + 1}</span><strong>${esc(step.name)}</strong><span class="step-detail">${esc(providerLabel(step.provider))} · ${esc(step.model || 'model not selected')} · ${(step.tools || []).map(tool => esc(TOOL_LABELS[tool] || tool)).join(', ') || 'no tools'}</span></div>`).join('')}</div><div class="route-tickets"><div class="route-tickets-title">Tickets opened when you approve</div>${plan.steps.map((step, index) => `<div class="route-ticket-row"><span class="ticket-code">T-${index + 1}</span><span class="ticket-title">${esc(step.name)} · ${esc(plan.title)}</span><span class="ticket-agent">→ ${esc(step.name)}</span></div>`).join('')}</div><div class="route-footer"><span class="route-privacy ${hosted ? 'remote' : ''}">${hosted ? 'Provider receives the task and relevant context when workers run.' : 'Project data and model requests stay local.'}</span><div class="route-actions"><button data-route-cancel class="secondary-button">Cancel</button><button data-route-approve class="primary-button">Approve route</button></div></div>`;
  $('#routePanel').classList.remove('hidden');
}
async function routeAction(event) {
  if (event.target.closest('[data-route-cancel]')) { $('#routePanel').classList.add('hidden'); if (state.currentTask) await window.code13.cancelTask(state.currentTask.id); toast('Route cancelled.'); }
  if (event.target.closest('[data-route-approve]')) {
    const button = event.target.closest('[data-route-approve]'); button.disabled = true; button.textContent = 'Starting…';
    try { await window.code13.approveRoute(state.currentTask.id); $('#routePanel').classList.add('hidden'); $('#typingIndicator').classList.remove('hidden'); toast('Route approved. Your team is getting started.'); }
    catch (error) { toast(error.message); button.disabled = false; button.textContent = 'Approve route'; }
  }
}

function handleEvent(event) {
  if (event.taskId && state.currentTask && event.taskId !== state.currentTask.id) {
    if (['schedule-started', 'approval-requested', 'error', 'final', 'tool-result', 'tool-error', 'resume-required', 'context-compacted'].includes(event.type)) { state.activity.unshift(event); renderActivity(); }
    if (event.type === 'task-status') { const task = state.tasks.find(item => item.id === event.taskId); if (task) task.status = event.status; }
    renderRecentTasks(); return;
  }
  state.activity.unshift(event); state.activity = state.activity.slice(0, 45); renderActivity();
  if (event.type === 'route-proposed') { state.currentPlan = event; renderRoute(event); }
  if (event.type === 'task-status') { if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') { state.streaming = null; $('#streamingMessage')?.remove(); } if (state.currentTask?.id === event.taskId) { state.currentTask.status = event.status; $('#typingIndicator').classList.toggle('hidden', event.status !== 'running'); } const task = state.tasks.find(item => item.id === event.taskId); if (task) task.status = event.status; renderRecentTasks(); }
  if (event.type === 'agent-status') { state.agentStatuses[event.agentId] = event.status; if (event.ticketCode) state.agentTickets[event.agentId] = event.ticketCode; renderTeam(); }
  if (event.type === 'chunk') { renderStreamingChunk(event.agentId, event.content); }
  if (event.type === 'ticket-created') { state.tickets.push(event.ticket); renderTickets(); }
  if (event.type === 'ticket-updated') { const index = state.tickets.findIndex(ticket => ticket.code === event.ticket.code); if (index >= 0) state.tickets[index] = { ...state.tickets[index], ...event.ticket }; else state.tickets.push(event.ticket); renderTickets(); }
  if (event.type === 'approval-requested') { state.approvals.unshift({ ...event, id: event.approvalId, taskId: event.taskId }); renderApprovals(); }
  if (event.type === 'question-asked') { state.approvals.unshift({ ...event, id: event.approvalId, taskId: event.taskId, action: 'ask_user', tool: 'ask_user' }); renderApprovals(); }
  if (event.type === 'question-answered') { state.approvals = state.approvals.filter(item => item.id !== event.approvalId); renderApprovals(); }
  if (event.type === 'action-approved' || event.type === 'action-rejected') { state.approvals = state.approvals.filter(item => item.id !== event.approvalId); renderApprovals(); }
  if (event.type === 'budget-paused') { appendMessage('assistant', `Paused: this task used its model-call budget (${event.modelCalls}/${event.budget}) before finishing. Raise the budget in Settings and start a new task to continue.`); $('#typingIndicator').classList.add('hidden'); }
  if (event.type === 'handoff') { const from = state.agents.find(agent => agent.id === event.agentId)?.name || event.agentId; const to = state.agents.find(agent => agent.id === event.toAgentId)?.name || event.toAgentId; appendMessage('assistant', `${from} handed over ${event.ticketCode} to ${to}.${event.note ? ` ${event.note}` : ''}`); }
  if (event.type === 'tool-result') appendMessage('assistant', `${event.workerId ? state.agents.find(agent => agent.id === event.workerId)?.name || 'Agent' : 'Agent'} · ${event.tool}\n${event.result}`);
  if (event.type === 'tool-error') appendMessage('assistant', `${event.name || 'Agent'} · ${event.tool}\nTool error: ${event.message}`);
  if (event.type === 'final') { state.streaming = null; $('#streamingMessage')?.remove(); appendMessage('assistant', event.content); $('#typingIndicator').classList.add('hidden'); }
  if (event.type === 'error') { state.streaming = null; $('#streamingMessage')?.remove(); appendMessage('assistant', `The run stopped: ${event.message}`); $('#typingIndicator').classList.add('hidden'); }
  if (event.type === 'resume-required') appendMessage('assistant', event.message);
  renderRecentTasks();
}
function renderStreamingChunk(agentId, content) {
  const container = $('#messages');
  if (!container) return;
  const agent = state.agents.find(item => item.id === agentId);
  const name = agent ? agent.name : 'Agent';
  let el = $('#streamingMessage');
  if (!el) {
    el = document.createElement('div');
    el.id = 'streamingMessage';
    el.className = 'message assistant-message streaming-message';
    el.innerHTML = `<div class="message-agent">${esc(name)}</div><div class="message-content streaming-content"></div>`;
    container.appendChild(el);
  }
  const contentEl = el.querySelector('.streaming-content');
  if (contentEl) {
    contentEl.textContent += content;
    contentEl.scrollTop = contentEl.scrollHeight;
  }
  container.scrollTop = container.scrollHeight;
}
function renderApprovals() {
  const pending = state.approvals.filter(item => item.status !== 'approved' && item.status !== 'rejected');
  $('#approvalPanel').innerHTML = pending.map(item => {
    if (item.action === 'ask_user' || item.tool === 'ask_user') {
      const question = item.question || item.payload?.question || 'The agent needs an answer.';
      const who = item.workerId ? (state.agents.find(agent => agent.id === item.workerId)?.name || item.workerId) : 'Agent';
      return `<article class="approval-card question-card" data-approval-id="${esc(item.id)}"><div class="approval-header"><div><div class="approval-title">Ask me · ${esc(who)}</div><div class="approval-sub">A question needs your answer</div></div><span class="provider-badge remote">REQUIRES YOU</span></div><pre class="approval-preview">${esc(question)}</pre><div class="approval-actions"><input class="answer-input" data-answer="${esc(item.id)}" placeholder="Type your answer…" /><button class="primary-button" data-answer-submit="${esc(item.id)}">Send answer</button></div></article>`;
    }
    const payload = item.payload || {};
    let preview = '';
    if (payload.content !== undefined) preview = `File: ${payload.path}\n\nExisting contents:\n${payload.previous || '(new file)'}\n\nProposed contents:\n${payload.content}`;
    else if (payload.command) preview = `Command:\n${payload.command}\n\nWorking directory:\n${payload.cwd || ''}`;
    else if (payload.arguments?.content !== undefined) preview = `File: ${payload.arguments.path}\n\nProposed contents:\n${payload.arguments.content}`;
    else if (payload.arguments?.command) preview = `Command:\n${payload.arguments.command}\n\nWorking directory:\n${payload.workspace || ''}`;
    const highRisk = payload.risk?.level === 'high';
    const riskNote = highRisk ? `<div class="risk-warning">This command looks high-risk: ${payload.risk.reasons.map(esc).join(', ')}. It can affect your machine beyond the project folder.</div><label class="check-item risk-confirm"><input type="checkbox" data-confirm-risk="${esc(item.id)}" /> I understand and want to allow it</label>` : '';
    return `<article class="approval-card${highRisk ? ' high-risk' : ''}" data-approval-id="${esc(item.id)}"><div class="approval-header"><div><div class="approval-title">Approval needed · ${esc(TOOL_LABELS[item.tool] || item.tool)}</div><div class="approval-sub">${item.scheduled ? 'Scheduled run' : 'Active task'} · ${esc(item.workerId || 'Agent')}</div></div><span class="provider-badge">${highRisk ? 'HIGH RISK' : 'WAITING'}</span></div>${preview ? `<pre class="approval-preview">${esc(preview)}</pre>` : ''}${riskNote}<div class="approval-actions"><button class="secondary-button" data-reject="${esc(item.id)}">Reject</button><button class="primary-button" data-approve="${esc(item.id)}"${highRisk ? ' disabled' : ''}>Approve action</button></div></article>`;
  }).join('');
}
async function approvalAction(event) {
  const answerSubmit = event.target.closest('[data-answer-submit]');
  if (answerSubmit) {
    const id = answerSubmit.dataset.answerSubmit;
    const input = $(`[data-answer="${id}"]`);
    const answer = input ? input.value.trim() : '';
    if (!answer) { toast('Type an answer first.'); return; }
    answerSubmit.disabled = true;
    try {
      const result = await window.code13.respondApproval(id, true, answer);
      state.approvals = state.approvals.filter(item => item.id !== id); renderApprovals();
      toast(result.recoveryRequired ? 'Answer recorded. Start a new task to continue the interrupted work.' : 'Answer sent to the agent.');
    } catch (error) { toast(error.message); answerSubmit.disabled = false; }
    return;
  }
  const approve = event.target.closest('[data-approve]'); const reject = event.target.closest('[data-reject]');
  if (!approve && !reject) return;
  const id = approve?.dataset.approve || reject.dataset.reject;
  const button = approve || reject; button.disabled = true;
  const confirmBox = $(`[data-confirm-risk="${id}"]`);
  const confirmed = confirmBox ? confirmBox.checked : true;
  try {
    const result = await window.code13.respondApproval(id, !!approve, undefined, confirmed);
    if (result.requiresConfirmation) { toast('Tick the confirmation box to allow this high-risk command.'); button.disabled = false; return; }
    state.approvals = state.approvals.filter(item => item.id !== id); renderApprovals();
    if (result.failed) toast('The approved action failed. Check the task activity.');
    else if (result.recoveryRequired) toast(approve ? 'Action approved. Start a new task to continue the interrupted work.' : 'Action rejected. Start a new task to continue the interrupted work.');
    else toast(approve ? 'Action approved.' : 'Action rejected.');
  }
  catch (error) { toast(error.message); button.disabled = false; }
}

function renderTickets() {
  const count = $('#ticketCount'); if (count) count.textContent = state.tickets.length;
  const list = $('#ticketList'); if (!list) return;
  if (!state.tickets.length) { list.innerHTML = '<div class="ticket-empty">Agents plan their work as tickets after a route is approved.</div>'; return; }
  list.innerHTML = state.tickets.map(ticket => {
    const agent = state.agents.find(item => item.id === ticket.assignedAgentId);
    const statusClass = ticket.status === 'doing' ? 'doing' : ticket.status === 'done' ? 'done' : ticket.status === 'blocked' ? 'blocked' : '';
    return `<div class="ticket-row"><span class="ticket-status ${statusClass}"></span><span class="ticket-code">${esc(ticket.code)}</span><span class="ticket-title">${esc(ticket.title)}</span><span class="ticket-agent">${agent ? esc(agent.name) : 'unassigned'}</span></div>`;
  }).join('');
}
function renderTeam() {
  $('#agentCount').textContent = state.agents.length;
  $('#teamCards').innerHTML = state.agents.map(agent => {
    const status = state.agentStatuses[agent.id] || (agent.enabled === false ? 'disabled' : agent.schedule?.enabled ? 'scheduled' : 'ready');
    const cls = agent.id === 'builder' ? 'builder' : agent.id === 'reviewer' ? 'reviewer' : agent.id === 'planner' ? '' : 'custom';
    const currentTicket = state.agentTickets[agent.id];
    const statusLabel = status === 'running' ? (currentTicket ? `Working on ${currentTicket}` : 'Working now') : status === 'completed' ? 'Done' : status === 'failed' ? 'Needs attention' : status === 'scheduled' ? `Scheduled · every ${agent.schedule.intervalMinutes}m` : status === 'disabled' ? 'Disabled' : agent.description || 'Ready for work';
    return `<article class="agent-card"><div class="agent-avatar ${cls}">${esc(initials(agent.name))}</div><div class="agent-main"><div class="agent-name">${esc(agent.name)}<span class="agent-state ${status}"></span></div><div class="agent-description">${esc(statusLabel)}</div><div class="agent-provider">${esc(providerLabel(agent.provider))} · ${esc(agent.model || state.providers[agent.provider]?.model || 'Choose a model')}</div></div><button class="edit-agent" data-edit-agent="${esc(agent.id)}" title="Edit ${esc(agent.name)}">···</button></article>`;
  }).join('');
}
function renderActivity() {
  const list = $('#activityList');
  if (!state.activity.length) { list.innerHTML = '<div class="activity-empty">Your team’s activity will appear here.</div>'; return; }
  list.innerHTML = state.activity.slice(0, 16).map(item => {
    const label = item.type === 'route-proposed' ? 'Route proposed' : item.type === 'agent-status' ? `${item.name} · ${item.status}` : item.type === 'approval-requested' ? `Approval needed · ${TOOL_LABELS[item.tool] || item.tool}` : item.type === 'tool-result' ? `${item.tool} completed` : item.type === 'tool-error' ? `${item.tool} failed · ${item.message}` : item.type === 'task-status' ? `Task ${item.status}` : item.type === 'final' ? 'Team report ready' : item.type === 'error' ? `Run issue · ${item.message}` : item.type === 'resume-required' ? item.message : item.type === 'schedule-started' ? `${item.name} schedule started` : item.type === 'context-compacted' ? `${item.name || 'Agent'} · context compacted` : item.type === 'subagent-started' ? `${item.name || 'Subagent'} started for ${item.parentAgentId || 'parent'}: ${item.goal?.slice(0, 60)}` : item.type === 'subagent-completed' ? `${item.name || 'Subagent'} completed: ${item.report?.slice(0, 80)}` : item.type.replaceAll('-', ' ');
    const glyph = item.type === 'approval-requested' ? '!' : item.type === 'tool-result' ? '✓' : item.type === 'tool-error' ? '⚠' : item.type === 'error' ? '×' : item.type === 'agent-status' ? '◌' : item.type === 'subagent-started' ? '⚡' : item.type === 'subagent-completed' ? '✓' : '↳';
    return `<div class="activity-item"><span class="activity-icon">${glyph}</span><div>${esc(label)}<time>${esc(formatTime(item.createdAt))}</time></div></div>`;
  }).join('');
}
function formatTime(value) { if (!value) return 'just now'; const date = new Date(value); return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function renderSessions() {
  const select = $('#sessionSelect');
  if (!select) return;
  const sessions = state.sessions || [];
  select.innerHTML = sessions.map(session => `<option value="${esc(session.id)}">${esc(session.title)} · ${session.taskCount}</option>`).join('') || '<option value="">No sessions</option>';
  select.value = state.currentSessionId || '';
  $('#sessionCount').textContent = sessions.length;
}
async function switchSession() {
  const id = $('#sessionSelect').value;
  if (!id || id === state.currentSessionId) return;
  try {
    const result = await window.code13.setCurrentSession(id);
    state.currentSessionId = result.currentSessionId;
    state.sessions = result.sessions || state.sessions;
    state.tasks = result.recentTasks || [];
    state.currentTask = null; state.currentPlan = null; state.activity = []; state.tickets = []; state.approvals = []; state.streaming = null; $('#streamingMessage')?.remove();
    $('#messages').innerHTML = ''; $('#routePanel').classList.add('hidden'); $('#approvalPanel').innerHTML = '';
    renderSessions(); renderRecentTasks(); renderActivity(); renderTickets(); setEmpty(true);
  } catch (error) { toast(error.message); renderSessions(); }
}
async function createNewSession() {
  try {
    const result = await window.code13.createSession();
    state.sessions = result.sessions || [];
    state.currentSessionId = result.currentSessionId;
    state.tasks = result.recentTasks || [];
    newTask();
    renderSessions(); renderRecentTasks();
    toast('New session started.');
  } catch (error) { toast(error.message); }
}
function debounce(fn, delay) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), delay); };
}

function initFileAutocomplete() {
  const input = $('#promptInput');
  const suggestions = $('#suggestions');
  if (!input || !suggestions) return;
  let active = 0;
  let items = [];
  let last = '';
  input.addEventListener('input', debounce(async () => {
    const value = input.value;
    const cursor = input.selectionStart || 0;
    const before = value.slice(0, cursor);
    const match = before.match(/@([^\s,;(){}[\]"'`]*)$/);
    if (!match || match[1].length === 0) {
      suggestions.classList.add('hidden');
      return;
    }
    const token = match[1].toLowerCase();
    if (last === token && items.length > 0) return;
    last = token;
    try {
      const files = await window.code13.listWorkspaceFiles('.');
      items = files.filter(f => f.toLowerCase().includes(token)).slice(0, 10);
      renderSuggestions(items, 0);
    } catch {
      suggestions.classList.add('hidden');
    }
  }, 150));
  input.addEventListener('keydown', (e) => {
    if (suggestions.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); renderSuggestions(items, active); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); renderSuggestions(items, active); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applySuggestion(items[active]); }
    else if (e.key === 'Escape') { suggestions.classList.add('hidden'); }
  });
  suggestions.addEventListener('click', (e) => {
    const item = e.target.closest('.suggestion-item');
    if (item) applySuggestion(item.dataset.path);
  });
  function renderSuggestions(list, idx) {
    active = idx;
    suggestions.innerHTML = list.map((p, i) => `<div class="suggestion-item ${i===idx?'active':''}" data-path="${esc(p)}">${esc(p)}</div>`).join('');
    suggestions.classList.toggle('hidden', list.length === 0);
  }
  function applySuggestion(path) {
    const cursor = input.selectionStart || 0;
    const before = input.value.slice(0, cursor);
    const after = input.value.slice(cursor);
    input.value = before.replace(/@[^\s,;(){}[\]"'`]*$/, '@' + path + ' ') + after;
    suggestions.classList.add('hidden');
    input.focus();
    input.selectionStart = input.selectionEnd = before.replace(/@[^\s,;(){}[\]"'`]*$/, '@' + path + ' ').length;
  }
}
function renderRecentTasks() {
  const tasks = [...state.tasks];
  if (state.currentTask && !tasks.some(task => task.id === state.currentTask.id)) tasks.unshift({ id: state.currentTask.id, title: state.currentTask.title, status: state.currentTask.status, createdAt: new Date().toISOString() });
  $('#taskCount').textContent = tasks.length;
  $('#recentTasks').innerHTML = tasks.slice(0, 30).map(task => `<button class="recent-task ${state.currentTask?.id === task.id ? 'active' : ''}" data-task-id="${esc(task.id)}"><span class="task-state ${esc(task.status)}"></span><span>${esc(task.title)}</span></button>`).join('') || '<div class="empty-helper">Your tasks will show up here.</div>';
}
async function loadTask(taskId) {
  try { const task = await window.code13.getTask(taskId); if (!task) return; state.currentTask = task; state.activity = task.events || []; state.tickets = task.tickets || []; state.currentPlan = null; state.streaming = null; $('#streamingMessage')?.remove(); renderTask(task); renderActivity(); }
  catch (error) { toast(error.message); }
}

function openModal(name) {
  $('#overlay').classList.remove('hidden');
  $('#settingsModal').classList.toggle('hidden', name !== 'settings');
  $('#teamModal').classList.toggle('hidden', name !== 'team');
  $('#agentModal').classList.add('hidden');
  if (name === 'settings') renderSettings(); else if (name === 'team') renderAgentManager();
}
function closeModals() { $('#overlay').classList.add('hidden'); $('#settingsModal').classList.add('hidden'); $('#teamModal').classList.add('hidden'); $('#agentModal').classList.add('hidden'); }

function renderSettings() {
  $$('.modal-tabs button').forEach(button => button.classList.toggle('active', button.dataset.tab === state.activeSettingsTab));
  const body = $('#settingsBody');
  if (state.activeSettingsTab === 'providers') {
    body.innerHTML = state.providerOrder.map(provider => {
      const config = state.providers[provider] || {};
      const local = state.localProviders.includes(provider);
      const isRouter = provider === 'freellm';
      const ready = state.providerReady[provider];
      const badge = isRouter ? 'LOCAL ROUTER' : (local ? 'LOCAL' : 'HOSTED');
      return `<article class="provider-card" data-provider-card="${provider}"><div class="provider-card-head"><strong>${esc(providerLabel(provider))}</strong><span class="provider-badge ${isRouter ? 'router' : (local ? '' : 'remote')}">${badge}</span></div><div class="form-grid"><div class="field"><label>Model</label><input data-model="${provider}" value="${esc(config.model || '')}" placeholder="${provider === 'ollama' ? 'e.g. qwen2.5-coder:7b' : provider === 'freellm' ? 'e.g. google/gemini-2.0-flash-001:free' : 'Model name'}" /></div><div class="field"><label>${local ? 'Ollama address' : (isRouter ? 'Unified API key' : 'API key')}</label><input data-${local ? 'url' : 'key'}="${provider}" type="${local ? 'url' : 'password'}" value="${local ? esc(config.baseUrl || '') : ''}" placeholder="${local ? 'http://localhost:11434' : (isRouter ? 'Paste the unified key from your FreeLLM dashboard' : ready ? 'Saved securely · enter to replace' : 'Paste provider API key')}" autocomplete="off" /></div></div>${!local ? `<div class="field"><label>API base URL</label><input data-url="${provider}" type="url" value="${esc(config.baseUrl || '')}" placeholder="${isRouter ? 'http://localhost:3001/v1' : ''}" /></div>` : ''}<div class="settings-actions">${isRouter ? `<button class="small-button" data-ping-provider="${provider}">Check router</button>` : ''}<button class="small-button" data-test-provider="${provider}">Test connection</button><button class="small-button" data-load-models="${provider}">Load models</button><span class="settings-result" id="providerResult-${provider}">${readinessText(provider, ready)}</span></div>${isRouter ? '<p class="settings-note">FreeLLMAPI is a separate open-source local router installed on this machine. Add free provider keys on its dashboard (freellmapi.co), then paste its unified key here. Code 13 sends requests to your local router, which forwards to free hosted model tiers.</p>' : ''}</article>`;
    }).join('') + `<div class="privacy-row"><strong>Task limits</strong><p>The model-call budget pauses a task before it overspends. Max steps bounds how many tool turns a single agent run may take before it reports back.</p></div><div class="form-grid"><div class="field"><label>Budget per task</label><input data-budget type="number" min="5" max="500" value="${esc(String(state.taskBudget || 40))}" /></div><div class="field"><label>Max tool steps per run</label><input data-max-steps type="number" min="4" max="200" value="${esc(String(state.maxSteps || 24))}" /></div></div><p class="settings-note">Hosted providers receive the task and context needed to answer when you approve a route. API keys are stored with Windows secure storage and never written to activity logs.</p>`;
  } else if (state.activeSettingsTab === 'workspace') {
    body.innerHTML = `<div class="workspace-picker"><div><div class="field"><label>Active project folder</label><strong>${esc(state.workspace || 'No project selected')}</strong></div></div><button id="pickWorkspace" class="secondary-button">Choose folder</button></div><p class="settings-note">File access is limited to this project folder. Code 13 ignores dependency/build folders and follows no symbolic links while browsing.</p>`;
  } else if (state.activeSettingsTab === 'mcp') {
    const servers = state.mcpServers || [];
    const tools = state.mcpTools || [];
    body.innerHTML = `<div class="mcp-section"><div class="mcp-header"><strong>MCP Servers</strong><button class="small-button" data-mcp-add>＋ Add server</button></div><div id="mcpServersList">${servers.length ? servers.map(server => `<div class="mcp-server-card" data-mcp-id="${esc(server.id)}"><div class="mcp-server-head"><strong>${esc(server.name)}</strong><span class="provider-badge ${server.enabled ? '' : 'remote'}">${server.enabled ? 'Connected' : 'Disconnected'}</span></div><div class="mcp-server-meta"><span>Command: ${esc(server.command)}</span>${server.args && server.args.length ? `<span>Args: ${esc(server.args.join(' '))}</span>` : ''}</div><div class="mcp-server-tools">${tools.filter(t => t.mcpServerId === server.id).map(t => `<span class="mcp-tool-tag">${esc(t.name)}</span>`).join('') || '<span class="mcp-no-tools">No tools exposed</span>'}</div><div class="mcp-server-actions"><button class="small-button" data-mcp-connect="${esc(server.id)}"${server.enabled ? '' : ''}>${server.enabled ? 'Reconnect' : 'Connect'}</button><button class="small-button" data-mcp-edit="${esc(server.id)}">Edit</button><button class="small-button" data-mcp-remove="${esc(server.id)}">Remove</button></div></div>`).join('') : '<p class="mcp-empty">No MCP servers configured. Add a server to extend agent capabilities with external tools.</p>'}</div></div><div id="mcpEditor" class="mcp-editor hidden"></div>`;
  } else {
    body.innerHTML = `<div class="privacy-row"><strong>Local orchestration</strong><p>Task state, activity, ticket board, agent configurations, and memory notes are stored on this device in the app’s local database.</p></div><div class="privacy-row"><strong>Provider data flow</strong><p>Ollama requests stay on this device. OpenAI and Anthropic receive prompts and relevant context after you approve a route that names that provider. FreeLLM sends context to your local router, which forwards to free hosted model tiers you selected there.</p></div><div class="privacy-row"><strong>Model-driven routing</strong><p>By default, route planning uses local keyword matching only — no task context is sent to hosted providers before you approve a route. Enable this to let hosted providers (OpenAI, Anthropic, FreeLLM) see the task context for routing before approval.</p><label class="check-item"><input type="checkbox" data-hosted-model-routing ${state.hostedModelRouting ? 'checked' : ''} /> Allow hosted providers to see task context for route planning before approval</label></div><div class="privacy-row"><strong>Ask me</strong><p>When an agent needs a human decision, the question appears in the approval area and waits for your answer. You never approve blindly.</p></div><div class="privacy-row"><strong>Approvals</strong><p>Code 13 asks before each file-write operation and shell command. Scheduled checks can read project files and Git status, but write/command actions wait in the approval queue.</p></div><div class="privacy-row"><strong>Credentials</strong><p>${state.secureStorageAvailable ? 'Windows secure credential storage is available.' : 'Windows secure credential storage is unavailable. Provider keys cannot be stored safely in this session.'} Secrets are excluded from activity history.</p></div>`;
  }
}
function updateSaveButton() {
  const button = $('#saveSettings');
  if (!button) return;
  button.classList.toggle('attention', state.settingsDirty);
  button.textContent = state.settingsDirty ? 'Save settings *' : 'Save settings';
}
function markSettingsDirty() {
  state.settingsDirty = true;
  updateSaveButton();
}
async function saveSettings() {
  const data = { providers: {} };
  for (const provider of state.providerOrder) {
    const card = $(`[data-provider-card="${provider}"]`); if (!card) continue;
    data.providers[provider] = { model: $(`[data-model="${provider}"]`, card).value.trim(), baseUrl: $(`[data-url="${provider}"]`, card).value.trim(), apiKey: $(`[data-key="${provider}"]`, card)?.value || '' };
  }
  const budget = Number($('[data-budget]')?.value);
  if (Number.isFinite(budget) && budget > 0) data.taskBudget = budget;
  const maxSteps = Number($('[data-max-steps]')?.value);
  if (Number.isFinite(maxSteps) && maxSteps > 0) data.maxSteps = maxSteps;
  data.hostedModelRouting = !!$('input[data-hosted-model-routing]')?.checked;
  $('#settingsMessage').textContent = 'Saving…';
  try { const result = await window.code13.saveSettings(data); state.providers = result.providers; state.providerReady = result.providerReady; state.providerStatus = result.providerStatus || state.providerStatus; state.taskBudget = result.taskBudget ?? state.taskBudget; state.maxSteps = result.maxSteps ?? state.maxSteps; state.hostedModelRouting = result.hostedModelRouting ?? state.hostedModelRouting; state.settingsDirty = false; updateSaveButton(); updateProviderChrome(); renderTeam(); onProviderChange(); $('#settingsMessage').textContent = 'Settings saved locally.'; toast('Provider settings saved.'); setTimeout(() => { $('#settingsMessage').textContent = ''; }, 1800); }
  catch (error) { $('#settingsMessage').textContent = error.message; }
}
async function checkProvider(provider) {
  const result = $(`#providerResult-${provider}`); result.textContent = 'Checking…';
  try {
    const status = await window.code13.pingProvider(provider);
    if (status.ok) result.textContent = `Router reachable · ${status.models.length} model${status.models.length === 1 ? '' : 's'}`;
    else if (status.reachable) result.textContent = status.error || `Reachable (HTTP ${status.status})`;
    else result.textContent = status.error || 'Not reachable';
    toast(status.ok ? `${providerLabel(provider)} reachable.` : (status.error || 'Not reachable'));
  } catch (error) { result.textContent = error.message; }
}
async function testProvider(provider) {
  const result = $(`#providerResult-${provider}`); result.textContent = 'Connecting…';
  try { const response = await window.code13.testProvider(provider); result.textContent = `Connected · ${response.models.length} model${response.models.length === 1 ? '' : 's'}`; toast(`${providerLabel(provider)} connected.`); }
  catch (error) { result.textContent = error.message; }
}
async function loadModels(provider) {
  const result = $(`#providerResult-${provider}`); result.textContent = 'Loading models…';
  try {
    const models = await window.code13.listProviderModels(provider);
    const input = $(`[data-model="${provider}"]`);
    if (models.length) { if (!input.value.trim()) input.value = models[0]; let datalist = $(`#models-${provider}`); if (!datalist) { datalist = document.createElement('datalist'); datalist.id = `models-${provider}`; document.body.append(datalist); input.setAttribute('list', datalist.id); } datalist.innerHTML = models.map(model => `<option value="${esc(model)}"></option>`).join(''); }
    result.textContent = `${models.length} models available.`;
  } catch (error) { result.textContent = error.message; }
}

async function addMCPServer() {
  const editor = $('#mcpEditor');
  editor.classList.remove('hidden');
  editor.innerHTML = `<div class="mcp-editor-form"><h4>Add MCP Server</h4><div class="form-grid"><div class="field"><label>Name</label><input name="name" placeholder="e.g. filesystem, github" /></div><div class="field"><label>Command</label><input name="command" placeholder="e.g. npx, docker, python" /></div></div><div class="form-grid"><div class="field"><label>Args (JSON array)</label><input name="args" placeholder='["-y", "@modelcontextprotocol/server-filesystem", "/path"]' /></div><div class="field"><label>Env (JSON object)</label><input name="env" placeholder='{"KEY": "value"}' /></div></div><div class="mcp-editor-actions"><button class="secondary-button" data-mcp-cancel>Cancel</button><button class="primary-button" data-mcp-save>Save</button></div></div>`;
  $('#mcpServersList').classList.add('hidden');
}
async function editMCPServer(id) {
  const server = state.mcpServers.find(s => s.id === id);
  if (!server) return;
  const editor = $('#mcpEditor');
  editor.classList.remove('hidden');
  editor.innerHTML = `<div class="mcp-editor-form"><h4>Edit MCP Server</h4><div class="form-grid"><div class="field"><label>Name</label><input name="name" value="${esc(server.name)}" /></div><div class="field"><label>Command</label><input name="command" value="${esc(server.command)}" /></div></div><div class="form-grid"><div class="field"><label>Args (JSON array)</label><input name="args" value="${esc(JSON.stringify(server.args))}" /></div><div class="field"><label>Env (JSON object)</label><input name="env" value="${esc(JSON.stringify(server.env))}" /></div></div><div class="mcp-editor-actions"><button class="secondary-button" data-mcp-cancel>Cancel</button><button class="primary-button" data-mcp-save data-mcp-id="${esc(id)}">Save</button></div></div>`;
  $('#mcpServersList').classList.add('hidden');
}
async function saveMCPServer(event) {
  const id = event.target.dataset.mcpId || crypto.randomUUID();
  const form = event.target.closest('.mcp-editor-form');
  const name = $('[name="name"]', form).value.trim();
  const command = $('[name="command"]', form).value.trim();
  const args = JSON.parse($('[name="args"]', form).value || '[]');
  const env = JSON.parse($('[name="env"]', form).value || '{}');
  if (!name || !command) { toast('Name and command are required.'); return; }
  try {
    if (event.target.dataset.mcpId) {
      await window.code13.updateMCPServer(id, { name, command, args, env });
    } else {
      await window.code13.addMCPServer({ id, name, command, args, env });
    }
    state.mcpServers = (await window.code13.listMCPServers()) || [];
    state.mcpTools = (await window.code13.mcpTools?.()) || state.mcpTools || [];
    renderSettings();
    toast(event.target.dataset.mcpId ? 'MCP server updated.' : 'MCP server added.');
  } catch (error) { toast(error.message); }
}
async function removeMCPServer(id) {
  if (!confirm('Remove this MCP server?')) return;
  try {
    await window.code13.removeMCPServer(id);
    state.mcpServers = (await window.code13.listMCPServers()) || [];
    renderSettings();
    toast('MCP server removed.');
  } catch (error) { toast(error.message); }
}
async function connectMCPServer(id) {
  try {
    await window.code13.connectMCPServer(id);
    state.mcpServers = (await window.code13.listMCPServers()) || [];
    state.mcpTools = (await window.code13.mcpTools?.()) || state.mcpTools || [];
    renderSettings();
    toast('MCP server connected.');
  } catch (error) { toast(error.message); }
}
function cancelMCPEditor() {
  $('#mcpEditor').classList.add('hidden');
  $('#mcpEditor').innerHTML = '';
  $('#mcpServersList')?.classList.remove('hidden');
}

function renderAgentManager() {
  $('#agentManager').innerHTML = `<div class="manager-row"><div class="agent-avatar custom">＋</div><div><strong>Add a custom agent</strong><p>Choose a role, model, tools, notes, and optional read-only schedule.</p></div><div class="manager-actions"><button class="small-button" data-new-agent>Create</button></div></div>` + state.agents.map(agent => `<div class="manager-row"><div class="agent-avatar ${agent.id === 'builder' ? 'builder' : agent.id === 'reviewer' ? 'reviewer' : ''}">${esc(initials(agent.name))}</div><div><strong>${esc(agent.name)}${agent.enabled === false ? ' · disabled' : ''}</strong><p>${esc(agent.description || agent.instructions.slice(0, 100) || 'Custom specialist')} · ${esc(providerLabel(agent.provider))}${agent.schedule?.enabled ? ` · every ${agent.schedule.intervalMinutes}m` : ''}</p></div><div class="manager-actions"><button class="small-button" data-edit="${esc(agent.id)}">Edit</button>${!['planner', 'builder', 'reviewer'].includes(agent.id) ? `<button class="small-button" data-delete="${esc(agent.id)}">Delete</button>` : ''}</div></div>`).join('');
}
function managerAction(event) {
  if (event.target.closest('[data-new-agent]')) editAgent(null);
  const edit = event.target.closest('[data-edit]'); if (edit) editAgent(edit.dataset.edit);
  const remove = event.target.closest('[data-delete]'); if (remove) deleteAgent(remove.dataset.delete);
}
function editAgent(agentId) {
  state.editingAgent = state.agents.find(agent => agent.id === agentId) || null;
  const agent = state.editingAgent || { id: '', name: '', description: '', instructions: '', provider: 'inherit', model: '', tools: ['list_files', 'read_file', 'git_status'], memory: '', advanced: true, enabled: true, schedule: { enabled: false, intervalMinutes: 60, prompt: '' } };
  $('#agentModalTitle').textContent = agent.id ? `Edit ${agent.name}` : 'New specialist';
  $('#agentEditor').innerHTML = `<div class="form-grid"><div class="field"><label>Agent name</label><input name="name" value="${esc(agent.name)}" placeholder="e.g. Docs specialist" maxlength="60" /></div><div class="field"><label>Provider</label><select name="provider">${['inherit', ...state.providerOrder].map(item => `<option value="${item}" ${agent.provider === item ? 'selected' : ''}>${item === 'inherit' ? 'Use task provider' : esc(providerLabel(item))}</option>`).join('')}</select></div></div><div class="form-grid"><div class="field"><label>Model override</label><input name="model" list="agentModelList" value="${esc(agent.model || '')}" placeholder="Blank uses provider default" /></div><div class="field"><label>Short description</label><input name="description" value="${esc(agent.description)}" maxlength="240" placeholder="What this agent is best at" /></div></div><div class="field"><label>Role instructions</label><textarea name="instructions" placeholder="Give this agent a clear job and working style">${esc(agent.instructions)}</textarea></div><div class="editor-section">Allowed project tools</div><div class="checkbox-grid">${Object.entries(TOOL_LABELS).map(([tool, label]) => `<label class="check-item"><input type="checkbox" name="tools" value="${tool}" ${agent.tools.includes(tool) ? 'checked' : ''} />${esc(label)}</label>`).join('')}</div><div class="editor-section">Private memory · stored locally</div><div class="field"><textarea name="memory" placeholder="Optional editable notes for this agent. These are included in its prompt.">${esc(agent.memory || '')}</textarea></div><div id="advancedFields" class="${agent.advanced ? '' : 'hidden'}"><div class="editor-section">Schedule · read-only checks run automatically</div><div class="schedule-row"><label class="check-item"><input name="scheduleEnabled" type="checkbox" ${agent.schedule?.enabled ? 'checked' : ''} /> Enable schedule</label><select name="intervalMinutes"><option value="15" ${agent.schedule?.intervalMinutes === 15 ? 'selected' : ''}>Every 15 min</option><option value="30" ${agent.schedule?.intervalMinutes === 30 ? 'selected' : ''}>Every 30 min</option><option value="60" ${!agent.schedule?.intervalMinutes || agent.schedule?.intervalMinutes === 60 ? 'selected' : ''}>Every hour</option><option value="240" ${agent.schedule?.intervalMinutes === 240 ? 'selected' : ''}>Every 4 hours</option><option value="1440" ${agent.schedule?.intervalMinutes === 1440 ? 'selected' : ''}>Daily</option></select></div><div class="field"><label>Scheduled prompt</label><textarea name="schedulePrompt" placeholder="What should this agent check?">${esc(agent.schedule?.prompt || '')}</textarea></div><label class="check-item"><input name="enabled" type="checkbox" ${agent.enabled !== false ? 'checked' : ''} /> Agent enabled</label></div>${!agent.advanced ? '<button class="small-button" data-toggle-advanced>Show advanced settings</button>' : ''}`;
  $('#agentMessage').textContent = '';
  $('#overlay').classList.remove('hidden'); $('#settingsModal').classList.add('hidden'); $('#teamModal').classList.add('hidden'); $('#agentModal').classList.remove('hidden');
}
async function saveAgent() {
  const form = $('#agentEditor'); const val = name => $(`[name="${name}"]`, form);
  const agent = {
    id: state.editingAgent?.id || undefined, name: val('name').value.trim(), description: val('description').value.trim(), instructions: val('instructions').value.trim(),
    provider: val('provider').value, model: val('model').value.trim(), tools: $$('[name="tools"]:checked', form).map(node => node.value), memory: val('memory').value,
    advanced: true, enabled: val('enabled')?.checked ?? true,
    schedule: { enabled: val('scheduleEnabled')?.checked || false, intervalMinutes: Number(val('intervalMinutes')?.value || 60), prompt: val('schedulePrompt')?.value || '' }
  };
  if (!agent.name || !agent.instructions) { $('#agentMessage').textContent = 'Enter an agent name and role instructions.'; return; }
  try { const saved = await window.code13.saveAgent(agent); const index = state.agents.findIndex(item => item.id === saved.id); if (index < 0) state.agents.push(saved); else state.agents[index] = saved; renderTeam(); renderAgentManager(); $('#agentModal').classList.add('hidden'); $('#teamModal').classList.remove('hidden'); toast('Agent saved.'); }
  catch (error) { $('#agentMessage').textContent = error.message; }
}
async function deleteAgent(id) {
  if (!confirm('Delete this custom agent?')) return;
  try { await window.code13.deleteAgent(id); state.agents = state.agents.filter(agent => agent.id !== id); renderAgentManager(); renderTeam(); toast('Agent deleted.'); }
  catch (error) { toast(error.message); }
}

init();
