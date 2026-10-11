const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { resolveWorkspacePath, assertNoSymlinkPath, isSensitivePath, canRunScheduledTool, redactForLog, assessShellRisk } = require('./lib/policy');
const { PROVIDERS, DEFAULT_PROVIDERS, LOCAL_PROVIDERS, PROVIDER_LABELS, TOOL_LABELS, COORD_TOOLS, PROJECT_TOOLS, DEFAULT_TASK_BUDGET, DEFAULT_MAX_STEPS, CONTEXT_TOKEN_BUDGET, TOOL_RESULT_LIMIT, PRESETS, destinationForProviders, providerLabel } = require('./lib/constants');
const { openDatabase } = require('./lib/db');
const { createModelClient } = require('./lib/model');
const { compactMessages } = require('./lib/context');
const { listWorkspaceFiles } = require('./lib/workspace');
const { gitStatus, gitDiff } = require('./lib/git');
const { runShell } = require('./lib/shell');
const { toolInstructions } = require('./lib/prompts');
const { parseJson, normalizeToolCall } = require('./lib/parse');
const { startMCPServer, getAllMCPTools, stopMCPServer, getMCPClient } = require('./lib/mcp');
const { getMCPServers, getMCPServer, createMCPServer, updateMCPServer, deleteMCPServer } = require('./lib/db');

let db;
let win;
let schedulerTimer;
const pendingActions = new Map();
const cancelledTasks = new Set();
const taskState = new Map();

function now() { return new Date().toISOString(); }
function makeId() { return randomUUID(); }

function initDb() {
  const databasePath = path.join(app.getPath('userData'), 'code13.sqlite');
  db = openDatabase({ databasePath, presets: PRESETS, defaultProviders: DEFAULT_PROVIDERS, defaultTaskBudget: DEFAULT_TASK_BUDGET });
  backfillSessions();
}
// Give pre-session tasks a home so history is not lost on upgrade.
function backfillSessions() {
  const anySession = db.prepare('SELECT id FROM sessions LIMIT 1').get();
  const orphans = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE session_id IS NULL OR session_id=''").get().n;
  if (orphans && !anySession) {
    const id = makeId();
    const stamp = now();
    db.prepare('INSERT INTO sessions(id,title,created_at,updated_at) VALUES(?,?,?,?)').run(id, 'Earlier tasks', stamp, stamp);
    db.prepare("UPDATE tasks SET session_id=? WHERE session_id IS NULL OR session_id=''").run(id);
  }
}

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}
function getProviders() {
  try { return { ...DEFAULT_PROVIDERS, ...JSON.parse(getSetting('providers', '{}')) }; }
  catch { return { ...DEFAULT_PROVIDERS }; }
}
function getAgents() {
  return db.prepare('SELECT data FROM agents ORDER BY created_at').all().map(row => JSON.parse(row.data));
}
function credentialConfigured(provider) {
  const row = db.prepare('SELECT encrypted_value FROM credentials WHERE provider=?').get(provider);
  if (!row || !safeStorage.isEncryptionAvailable()) return false;
  try { return !!safeStorage.decryptString(row.encrypted_value); } catch { return false; }
}
function getCredential(provider) {
  const row = db.prepare('SELECT encrypted_value FROM credentials WHERE provider=?').get(provider);
  if (!row || !safeStorage.isEncryptionAvailable()) return '';
  try { return safeStorage.decryptString(row.encrypted_value); } catch { return ''; }
}
function saveCredential(provider, value) {
  if (!value) return;
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure credential storage is not available.');
  const encrypted = safeStorage.encryptString(value);
  db.prepare('INSERT INTO credentials(provider,encrypted_value) VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET encrypted_value=excluded.encrypted_value').run(provider, encrypted);
}
// Explain why a provider can or cannot be used, so the UI can guide setup.
function providerReadiness(provider, providers = getProviders()) {
  const config = providers[provider] || {};
  if (provider !== 'ollama' && !credentialConfigured(provider)) return { ready: false, reason: 'no-key' };
  if (!String(config.model || '').trim()) return { ready: false, reason: 'no-model' };
  return { ready: true, reason: 'ready' };
}
function providerReadyMap() {
  return Object.fromEntries(PROVIDERS.map(provider => [provider, providerReadiness(provider).ready]));
}
function providerStatusMap() {
  return Object.fromEntries(PROVIDERS.map(provider => [provider, providerReadiness(provider)]));
}

const modelClient = createModelClient({ getProviders, getCredential });
const { callModel, listModels, testProvider, ping } = modelClient;

// Short-lived cache of provider model lists so the composer can offer models
// without re-hitting the provider on every keystroke.
const MODEL_CACHE_TTL = 60 * 1000;
const modelCache = new Map();
async function getModelsCached(provider, force = false) {
  const entry = modelCache.get(provider);
  if (!force && entry && Date.now() - entry.at < MODEL_CACHE_TTL) return entry.models;
  const models = await listModels(provider);
  modelCache.set(provider, { models, at: Date.now() });
  return models;
}
function cachedModelsMap() {
  return Object.fromEntries([...modelCache].map(([provider, entry]) => [provider, entry.models]));
}
// Resolution order: explicit request -> provider default -> first offered model.
// FreeLLM/OpenAI-compatible providers fall back to "auto" so an empty model
// never blocks starting a task.
async function resolveModel(provider, requested, providers = getProviders()) {
  const explicit = String(requested || providers[provider]?.model || '').trim();
  if (explicit) return explicit;
  if (provider === 'ollama') return '';
  try {
    const models = await getModelsCached(provider);
    if (models.length) return models[0];
  } catch { /* key missing or router offline; fall through */ }
  return provider === 'freellm' ? 'auto' : '';
}

function listPendingApprovals() {
  return db.prepare("SELECT id,task_id,worker_id,action,payload,created_at FROM approvals WHERE status='pending' ORDER BY created_at").all().map(row => ({
    id: row.id, taskId: row.task_id, workerId: row.worker_id, action: row.action, payload: JSON.parse(row.payload), createdAt: row.created_at
  }));
}
function getMessages(taskId) {
  return db.prepare('SELECT role,content,created_at AS createdAt FROM messages WHERE task_id=? ORDER BY created_at').all(taskId);
}
function getEvents(taskId) {
  return db.prepare('SELECT event_type AS type,payload,created_at AS createdAt FROM events WHERE task_id=? ORDER BY created_at').all(taskId).map(row => ({ type: row.type, ...JSON.parse(row.payload), createdAt: row.createdAt }));
}
function getTickets(taskId) {
  return db.prepare('SELECT id,code,title,status,assigned_agent_id AS assignedAgentId,notes,created_at AS createdAt,updated_at AS updatedAt FROM tickets WHERE task_id=? ORDER BY created_at').all(taskId);
}
function nextTicketCode(taskId) {
  const row = db.prepare('SELECT COUNT(*) AS count FROM tickets WHERE task_id=?').get(taskId);
  return `T-${row.count + 1}`;
}
function createTicket(taskId, title, assignedAgentId = '', notes = '') {
  const id = makeId();
  const code = nextTicketCode(taskId);
  const stamp = now();
  db.prepare('INSERT INTO tickets(id,task_id,code,title,status,assigned_agent_id,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, taskId, code, String(title).slice(0, 200), 'todo', String(assignedAgentId || ''), String(notes || '').slice(0, 2000), stamp, stamp);
  const ticket = { id, code, title: String(title).slice(0, 200), status: 'todo', assignedAgentId: String(assignedAgentId || ''), notes: String(notes || ''), createdAt: stamp, updatedAt: stamp };
  pushEvent(taskId, 'ticket-created', { ticket });
  return ticket;
}
function getTicketByCode(taskId, code) {
  return db.prepare('SELECT id,code,title,status,assigned_agent_id AS assignedAgentId,notes FROM tickets WHERE task_id=? AND code=?').get(taskId, code);
}
function updateTicket(taskId, code, fields = {}) {
  const ticket = getTicketByCode(taskId, code);
  if (!ticket) throw new Error(`Ticket ${code} was not found on this task's board.`);
  const status = ['todo', 'doing', 'done', 'blocked'].includes(fields.status) ? fields.status : ticket.status;
  const assignedAgentId = fields.assignedAgentId !== undefined ? String(fields.assignedAgentId) : ticket.assignedAgentId;
  const notes = fields.notes !== undefined ? String(fields.notes).slice(0, 2000) : ticket.notes;
  db.prepare('UPDATE tickets SET status=?,assigned_agent_id=?,notes=?,updated_at=? WHERE id=?').run(status, assignedAgentId, notes, now(), ticket.id);
  const updated = { ...ticket, status, assignedAgentId, notes, updatedAt: now() };
  pushEvent(taskId, 'ticket-updated', { ticket: updated });
  return updated;
}
function recordMemory(agentId, taskId, content) {
  const id = makeId();
  db.prepare('INSERT INTO memory(id,task_id,agent_id,content,created_at) VALUES(?,?,?,?,?)').run(id, taskId || null, agentId, String(content).slice(0, 2000), now());
}
function readRecentMemory(agentId, limit = 6) {
  const rows = db.prepare('SELECT content FROM memory WHERE agent_id=? ORDER BY created_at DESC LIMIT ?').all(agentId, limit);
  const shared = db.prepare('SELECT content FROM memory WHERE agent_id!=? ORDER BY created_at DESC LIMIT ?').all(agentId, Math.max(0, Math.floor(limit / 2)));
  return [...rows, ...shared].map(row => row.content);
}
function getTaskBudget() {
  const value = Number(getSetting('task_budget', String(DEFAULT_TASK_BUDGET)));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TASK_BUDGET;
}
function getMaxSteps() {
  const value = Number(getSetting('task_max_steps', String(DEFAULT_MAX_STEPS)));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_STEPS;
}
function capToolResult(text, limit = TOOL_RESULT_LIMIT) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated ${value.length - limit} characters]` : value;
}
function getTaskSummary(taskId) {
  const task = db.prepare('SELECT id,title,status,mode,created_at AS createdAt,updated_at AS updatedAt FROM tasks WHERE id=?').get(taskId);
  if (!task) return null;
  return { ...task, messages: getMessages(taskId), events: getEvents(taskId), tickets: getTickets(taskId) };
}
function getSessions() {
  return db.prepare('SELECT id,title,created_at AS createdAt,updated_at AS updatedAt FROM sessions ORDER BY updated_at DESC').all()
    .map(session => ({ ...session, taskCount: db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE session_id=?').get(session.id).n }));
}
function createSession(title = 'New session') {
  const id = makeId();
  const stamp = now();
  const safeTitle = String(title || '').trim().slice(0, 120) || 'New session';
  db.prepare('INSERT INTO sessions(id,title,created_at,updated_at) VALUES(?,?,?,?)').run(id, safeTitle, stamp, stamp);
  return { id, title: safeTitle, createdAt: stamp, updatedAt: stamp, taskCount: 0 };
}
function touchSession(sessionId, title) {
  const stamp = now();
  db.prepare('UPDATE sessions SET updated_at=?, title=COALESCE(?,title) WHERE id=?').run(stamp, title ? String(title).trim().slice(0, 120) : null, sessionId);
}
function activeSessionId() {
  const id = getSetting('active_session');
  if (id && db.prepare('SELECT id FROM sessions WHERE id=?').get(id)) return id;
  const newest = db.prepare('SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1').get();
  if (newest) { setSetting('active_session', newest.id); return newest.id; }
  const created = createSession('New session');
  setSetting('active_session', created.id);
  return created.id;
}
function sessionTasks(sessionId) {
  return db.prepare('SELECT id,title,status,mode,created_at AS createdAt FROM tasks WHERE session_id=? ORDER BY created_at DESC LIMIT 20').all(sessionId);
}

async function expandAtFileReferences(workspace, text) {
  const pattern = /@([^s/][^s,;(){}[]"'`]*|[^s][^s]*\/[^s,;(){}[]"'`]*)/g;
  let result = text;
  let match;
  const seen = new Set();
  while ((match = pattern.exec(text)) !== null) {
    const rel = match[1];
    if (!rel || rel.startsWith('.') || rel.includes('..')) continue;
    const key = rel.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const filePath = resolveWorkspacePath(workspace, rel);
      if (isSensitivePath(rel)) continue;
      await assertNoSymlinkPath(workspace, filePath);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
      if (stat.size > 500000) continue;
      const content = (await fs.readFile(filePath, 'utf8')).slice(0, 16000);
      result = result.replace(new RegExp(`@${escapeRegExp(rel)}(?![^s,;(){}[]"'\`])`, 'g'), `### @${rel}\n\`\`\`${getCodeFence(content)}\n${content}\n\`\`\``);
    } catch { /* ignore missing/unreadable files */ }
  }
  return result;
}
function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[]\]/g, '\\$&'); }
function getCodeFence(content) { return content.includes('```') ? 'text' : ''; }
function emitEvent(message) {
  for (const browser of BrowserWindow.getAllWindows()) browser.webContents.send('code13:event', message);
  return message;
}
function pushEvent(taskId, type, payload = {}) {
  const safePayload = JSON.parse(redactForLog(JSON.stringify(payload)));
  const createdAt = now();
  db.prepare('INSERT INTO events(id,task_id,event_type,payload,created_at) VALUES(?,?,?,?,?)').run(makeId(), taskId || null, type, JSON.stringify(safePayload), createdAt);
  if (taskId) db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(createdAt, taskId);
  return emitEvent({ type, taskId, ...safePayload, createdAt });
}
function saveMessage(taskId, role, content) {
  db.prepare('INSERT INTO messages(id,task_id,role,content,created_at) VALUES(?,?,?,?,?)').run(makeId(), taskId, role, redactForLog(content), now());
}
function setTaskStatus(taskId, status) {
  db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run(status, now(), taskId);
  pushEvent(taskId, 'task-status', { status });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1080, minHeight: 720,
    backgroundColor: '#111319', title: 'Code 13',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

function localRoute(prompt, agents) {
  const text = prompt.toLowerCase();
  const ids = [];
  if (/plan|design|approach|architecture|figure out|investigate/.test(text)) ids.push('planner');
  if (/fix|build|implement|change|add|create|refactor|code/.test(text)) ids.push('builder');
  if (/test|review|check|verify|audit|flaky/.test(text)) ids.push('reviewer');
  if (!ids.length) ids.push('planner');
  const available = new Set(agents.filter(agent => agent.enabled !== false).map(agent => agent.id));
  const selected = ids.filter(id => available.has(id));
  return (selected.length ? selected : agents.filter(agent => agent.enabled !== false).slice(0, 1).map(agent => agent.id));
}

ipcMain.handle('app:bootstrap', () => {
  const providers = getProviders();
  const agents = getAgents();
  const currentSessionId = activeSessionId();
  const recentTasks = sessionTasks(currentSessionId);
  const currentTask = db.prepare('SELECT id,status FROM tasks ORDER BY created_at DESC LIMIT 50').all().find(task => ['awaiting-approval', 'awaiting-route-approval', 'running'].includes(task.status)) || null;
  return {
    workspace: getSetting('workspace'), providers, localProviders: LOCAL_PROVIDERS, taskBudget: getTaskBudget(), maxSteps: getMaxSteps(), hostedModelRouting: getSetting('hosted_model_routing') === 'true',
    providerOrder: PROVIDERS, providerLabels: PROVIDER_LABELS, toolLabels: TOOL_LABELS,
    providerReady: providerReadyMap(),
    providerStatus: providerStatusMap(),
    models: cachedModelsMap(),
    sessions: getSessions(), currentSessionId, recentTasks, agents,
    currentTask: currentTask ? getTaskSummary(currentTask.id) : null,
    pendingApprovals: listPendingApprovals(), secureStorageAvailable: safeStorage.isEncryptionAvailable(),
    mcpServers: getMCPServers(db), mcpTools: getAllMCPTools()
  };
});

ipcMain.handle('session:list', () => ({ sessions: getSessions(), currentSessionId: activeSessionId() }));

ipcMain.handle('session:create', (_event, title) => {
  const session = createSession(title || 'New session');
  setSetting('active_session', session.id);
  return { session, sessions: getSessions(), currentSessionId: session.id, recentTasks: sessionTasks(session.id) };
});

ipcMain.handle('session:set-current', (_event, id) => {
  if (!id || !db.prepare('SELECT id FROM sessions WHERE id=?').get(id)) throw new Error('Session not found.');
  setSetting('active_session', id);
  return { currentSessionId: id, recentTasks: sessionTasks(id), sessions: getSessions() };
});

ipcMain.handle('session:rename', (_event, id, title) => {
  const safeTitle = String(title || '').trim().slice(0, 120);
  if (!safeTitle) throw new Error('Session title cannot be empty.');
  if (!db.prepare('SELECT id FROM sessions WHERE id=?').get(id)) throw new Error('Session not found.');
  touchSession(id, safeTitle);
  return { sessions: getSessions() };
});

ipcMain.handle('session:delete', (_event, id) => {
  if (!db.prepare('SELECT id FROM sessions WHERE id=?').get(id)) throw new Error('Session not found.');
  const taskIds = db.prepare('SELECT id,status FROM tasks WHERE session_id=?').all(id);
  if (taskIds.some(task => ['planning', 'running', 'awaiting-approval', 'awaiting-route-approval'].includes(task.status))) {
    throw new Error('Finish or cancel running tasks in this session before deleting it.');
  }
  for (const task of taskIds) {
    db.prepare('DELETE FROM messages WHERE task_id=?').run(task.id);
    db.prepare('DELETE FROM events WHERE task_id=?').run(task.id);
    db.prepare('DELETE FROM tickets WHERE task_id=?').run(task.id);
    db.prepare('DELETE FROM approvals WHERE task_id=?').run(task.id);
    db.prepare('DELETE FROM tasks WHERE id=?').run(task.id);
  }
  db.prepare('DELETE FROM sessions WHERE id=?').run(id);
  if (getSetting('active_session') === id) setSetting('active_session', '');
  const currentSessionId = activeSessionId();
  return { sessions: getSessions(), currentSessionId, recentTasks: sessionTasks(currentSessionId) };
});

ipcMain.handle('workspace:select', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  setSetting('workspace', path.resolve(result.filePaths[0]));
  return path.resolve(result.filePaths[0]);
});

ipcMain.handle('settings:save', (_event, data) => {
  const providers = getProviders();
  for (const provider of PROVIDERS) {
    if (data.providers?.[provider]) {
      providers[provider] = {
        ...providers[provider],
        baseUrl: data.providers[provider].baseUrl || DEFAULT_PROVIDERS[provider].baseUrl,
        model: String(data.providers[provider].model || '').trim()
      };
      if (data.providers[provider].apiKey) saveCredential(provider, String(data.providers[provider].apiKey).trim());
      if (data.providers[provider].clearKey) db.prepare('DELETE FROM credentials WHERE provider=?').run(provider);
    }
  }
  setSetting('providers', JSON.stringify(providers));
  if (data.taskBudget !== undefined) {
    const budget = Math.max(5, Math.min(500, Number(data.taskBudget) || DEFAULT_TASK_BUDGET));
    setSetting('task_budget', String(budget));
  }
  if (data.maxSteps !== undefined) {
    const steps = Math.max(4, Math.min(200, Number(data.maxSteps) || DEFAULT_MAX_STEPS));
    setSetting('task_max_steps', String(steps));
  }
  if (data.hostedModelRouting !== undefined) {
    setSetting('hosted_model_routing', data.hostedModelRouting ? 'true' : 'false');
  }
  return { providers, providerReady: providerReadyMap(), providerStatus: providerStatusMap(), taskBudget: getTaskBudget(), maxSteps: getMaxSteps() };
});

ipcMain.handle('provider:test', async (_event, provider) => ({ provider, models: await testProvider(provider) }));
ipcMain.handle('provider:models', async (_event, provider, force) => await getModelsCached(provider, !!force));
ipcMain.handle('provider:ping', async (_event, provider) => ({ provider, ...(await ping(provider)) }));

ipcMain.handle('workspace:list-files', async (_event, relativePath = '.') => {
  const workspace = getSetting('workspace');
  if (!workspace || !existsSync(workspace)) throw new Error('Choose a project folder first.');
  const target = relativePath && relativePath !== '.' ? resolveWorkspacePath(workspace, relativePath) : workspace;
  await assertNoSymlinkPath(workspace, target);
  return await listWorkspaceFiles(workspace, relativePath);
});

ipcMain.handle('agent:save', (_event, agent) => {
  const oldAgent = getAgents().find(item => item.id === agent.id);
  const scheduleEnabled = !!agent.schedule?.enabled;
  const intervalMinutes = Math.max(15, Math.min(1440, Number(agent.schedule?.intervalMinutes) || 60));
  const normalized = {
    id: String(agent.id || makeId()), name: String(agent.name || 'Custom agent').trim().slice(0, 60),
    description: String(agent.description || '').slice(0, 240), instructions: String(agent.instructions || '').slice(0, 5000),
    provider: ['inherit', ...PROVIDERS].includes(agent.provider) ? agent.provider : 'inherit', model: String(agent.model || '').trim(),
    tools: Array.isArray(agent.tools) ? [...new Set(agent.tools.filter(tool => PROJECT_TOOLS.includes(tool)))] : [],
    memory: String(agent.memory || '').slice(0, 12000), advanced: !!agent.advanced, enabled: agent.enabled !== false,
    schedule: { enabled: scheduleEnabled, intervalMinutes, prompt: String(agent.schedule?.prompt || '').slice(0, 1000), nextRunAt: scheduleEnabled ? (oldAgent?.schedule?.enabled && oldAgent.schedule.nextRunAt && Date.parse(oldAgent.schedule.nextRunAt) > Date.now() ? oldAgent.schedule.nextRunAt : new Date(Date.now() + intervalMinutes * 60000).toISOString()) : '' }
  };
  const stamp = now();
  db.prepare('INSERT INTO agents(id,data,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at').run(normalized.id, JSON.stringify(normalized), stamp, stamp);
  return normalized;
});
ipcMain.handle('agent:delete', (_event, id) => {
  if (PRESETS.some(agent => agent.id === id)) throw new Error('Built-in agents cannot be removed; disable or edit them instead.');
  db.prepare('DELETE FROM agents WHERE id=?').run(id);
  return true;
});
ipcMain.handle('agent:schedule', (_event, id, schedule) => {
  const agent = getAgents().find(item => item.id === id);
  if (!agent) throw new Error('Agent not found.');
  const intervalMinutes = Math.max(15, Math.min(1440, Number(schedule.intervalMinutes) || 60));
  agent.schedule = { ...agent.schedule, ...schedule, intervalMinutes, nextRunAt: schedule.enabled ? new Date(Date.now() + intervalMinutes * 60000).toISOString() : '' };
  db.prepare('UPDATE agents SET data=?,updated_at=? WHERE id=?').run(JSON.stringify(agent), now(), id);
  return agent;
});

ipcMain.handle('mcp:list', () => getMCPServers(db));
ipcMain.handle('mcp:get', (_event, id) => getMCPServer(db, id));
ipcMain.handle('mcp:add', async (_event, server) => {
  const id = server.id || makeId();
  const created = createMCPServer(db, { id, name: server.name, command: server.command, args: server.args, env: server.env });
  try { await startMCPServer({ ...created, id }); } catch { /* connection will be retried on use */ }
  return { servers: getMCPServers(db) };
});
ipcMain.handle('mcp:update', async (_event, id, updates) => {
  const updated = updateMCPServer(db, id, updates);
  try { await startMCPServer({ ...updated, id }); } catch { /* connection will be retried on use */ }
  return { servers: getMCPServers(db) };
});
ipcMain.handle('mcp:remove', async (_event, id) => {
  await stopMCPServer(id);
  deleteMCPServer(db, id);
  return { servers: getMCPServers(db) };
});
ipcMain.handle('mcp:connect', async (_event, id) => {
  const server = getMCPServer(db, id);
  if (!server) throw new Error('MCP server not found.');
  await startMCPServer({ ...server, id });
  return { servers: getMCPServers(db) };
});
ipcMain.handle('mcp:tools', () => getAllMCPTools());

ipcMain.handle('task:plan', async (_event, request) => {
  const prompt = String(request.prompt || '').trim();
  const workspace = getSetting('workspace');
  if (!prompt) throw new Error('Describe what you want Code 13 to do.');
  if (!workspace || !existsSync(workspace)) throw new Error('Choose a project folder before starting a task.');
  const expandedPrompt = await expandAtFileReferences(workspace, prompt);
  const providers = getProviders();
  const provider = PROVIDERS.includes(request.provider) ? request.provider : 'ollama';
  const model = await resolveModel(provider, request.model, providers);
  const agents = getAgents().filter(agent => agent.enabled !== false);
  if (!agents.length) throw new Error('Enable at least one agent in the team workspace.');
  const id = makeId();
  const title = prompt.slice(0, 100);
  const sessionId = activeSessionId();
  db.prepare('INSERT INTO tasks(id,title,status,mode,session_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, title, 'planning', 'manual', sessionId, now(), now());
  const session = db.prepare('SELECT title FROM sessions WHERE id=?').get(sessionId);
  touchSession(sessionId, !session || session.title === 'New session' ? title.slice(0, 60) : null);
  saveMessage(id, 'user', expandedPrompt);
  const context = { workspace, provider, model, providers: { [provider]: providers[provider] }, agents: agents.map(({ id: agentId, name, description, tools: allowedTools, provider: agentProvider, model: agentModel }) => ({ id: agentId, name, description, tools: allowedTools, provider: agentProvider === 'inherit' ? provider : agentProvider, model: agentModel || (agentProvider === 'inherit' ? model : providers[agentProvider]?.model || '') })) };
  let chosenIds;
  let rationale = 'The local router matched the request to the closest enabled roles.';
  let routedProvider = provider;
  let routedModel = model;
  let destination = 'Routing uses local matching; no task context has been sent to a hosted provider.';
  const hostedModelRouting = getSetting('hosted_model_routing') === 'true';
  const canModelRoute = model && (provider === 'ollama' || hostedModelRouting);
  let usedHostedModelRouting = false;
  if (canModelRoute) {
    const config = { ...providers[provider], model };
    setSetting('providers', JSON.stringify({ ...providers, [provider]: config }));
    try {
      const text = await callModel(provider, [
        { role: 'system', content: 'You route desktop coding tasks. Return only JSON: {"agents":[agent ids],"reason":"short explanation","steps":["short task step"]}. Pick one to three listed agents. Never invent ids or request tools.' },
        { role: 'user', content: JSON.stringify({ task: expandedPrompt, workspaceName: path.basename(workspace), agents: context.agents }) }
      ]);
      const route = parseJson(text);
      const allowed = new Set(agents.map(agent => agent.id));
      chosenIds = Array.isArray(route?.agents) ? route.agents.filter(agentId => allowed.has(agentId)).slice(0, 3) : [];
      rationale = String(route?.reason || rationale).slice(0, 400);
      if (provider !== 'ollama' && hostedModelRouting) usedHostedModelRouting = true;
    } catch (error) {
      db.prepare('DELETE FROM messages WHERE task_id=?').run(id);
      db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      throw new Error(`Route planning failed with ${provider}: ${error.message}. Code 13 did not switch providers.`);
    }
  }
  if (!chosenIds?.length) chosenIds = localRoute(prompt, agents);
  const selected = chosenIds.map(agentId => agents.find(agent => agent.id === agentId)).filter(Boolean);
  const plannedProviders = [...new Set(selected.map(agent => agent.provider === 'inherit' ? provider : agent.provider))];
  for (const plannedProvider of plannedProviders) {
    if (plannedProvider !== 'ollama' && !credentialConfigured(plannedProvider)) {
      db.prepare('DELETE FROM messages WHERE task_id=?').run(id);
      db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      throw new Error(`Add an API key for ${plannedProvider} before routing work to that provider.`);
    }
  }
  const missingModel = selected.find(agent => {
    const agentProvider = agent.provider === 'inherit' ? provider : agent.provider;
    return !(agent.model || (agent.provider === 'inherit' ? model : providers[agentProvider]?.model || ''));
  });
  if (missingModel) {
    const missingProvider = missingModel.provider === 'inherit' ? provider : missingModel.provider;
    db.prepare('DELETE FROM messages WHERE task_id=?').run(id);
    db.prepare('DELETE FROM tasks WHERE id=?').run(id);
    throw new Error(`Choose a model for ${missingModel.name} (${missingProvider}) in Settings before starting.`);
  }
  destination = usedHostedModelRouting
    ? `Route planning used ${providerLabel(provider)} with your opt-in setting. Task context was sent to ${providerLabel(provider)} before route approval.`
    : destinationForProviders(plannedProviders);
  const plan = { id, title, prompt: expandedPrompt, workspace, provider: routedProvider, model: routedModel, destination, reason: rationale, steps: selected.map(agent => { const agentProvider = agent.provider === 'inherit' ? routedProvider : agent.provider; return { agentId: agent.id, name: agent.name, provider: agentProvider, model: agent.model || (agent.provider === 'inherit' ? routedModel : providers[agentProvider]?.model || ''), tools: agent.tools }; }) };
  db.prepare('UPDATE tasks SET status=? WHERE id=?').run('awaiting-route-approval', id);
  pushEvent(id, 'route-proposed', plan);
  return plan;
});

ipcMain.handle('task:approve-route', async (_event, taskId) => {
  const task = db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId);
  if (!task) throw new Error('Task not found.');
  const event = db.prepare("SELECT payload FROM events WHERE task_id=? AND event_type='route-proposed' ORDER BY created_at DESC LIMIT 1").get(taskId);
  if (!event) throw new Error('Route proposal not found.');
  if (task.status !== 'awaiting-route-approval') return { started: false, reason: 'This route is no longer awaiting approval.' };
  const plan = JSON.parse(event.payload);
  if (!getTickets(taskId).length) {
    for (const step of plan.steps) createTicket(taskId, `${step.name}: ${plan.title}`.slice(0, 120), step.agentId);
  }
  taskState.set(taskId, { budget: getTaskBudget(), modelCalls: 0, handoffs: [], runs: 0, abort: new AbortController() });
  setTaskStatus(taskId, 'running');
  coordinateTask(plan).catch(error => {
    taskState.delete(taskId);
    pushEvent(taskId, 'error', { message: error.message });
    setTaskStatus(taskId, 'failed');
  });
  return { started: true };
});

ipcMain.handle('task:cancel', (_event, taskId) => {
  cancelledTasks.add(taskId);
  const state = taskState.get(taskId);
  if (state?.abort) state.abort.abort();
  for (const [approvalId, pending] of pendingActions) {
    if (pending.taskId !== taskId) continue;
    pendingActions.delete(approvalId);
    if (typeof pending.reject === 'function') pending.reject(new Error('Task cancelled.'));
  }
  db.prepare("UPDATE approvals SET status='rejected',decided_at=? WHERE task_id=? AND status='pending'").run(now(), taskId);
  setTaskStatus(taskId, 'cancelled');
  db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run('cancelled', now(), taskId);
  return true;
});

ipcMain.handle('task:get', (_event, taskId) => getTaskSummary(taskId));

ipcMain.handle('task:tickets', (_event, taskId) => getTickets(taskId));

ipcMain.handle('approval:respond', async (_event, approvalId, approved, answer, confirmed) => {
  const row = db.prepare("SELECT * FROM approvals WHERE id=? AND status='pending'").get(approvalId);
  if (!row) throw new Error('This approval is no longer pending.');
  const payload = JSON.parse(row.payload);
  const isQuestion = row.action === 'ask_user';
  if (approved && !isQuestion && row.action === 'run_shell') {
    const risk = assessShellRisk(payload.arguments?.command);
    if (risk.level === 'high' && confirmed !== true) return { requiresConfirmation: true, risk };
  }
  const answerText = isQuestion ? String(answer || '').slice(0, 4000) : null;
  db.prepare('UPDATE approvals SET status=?,decided_at=?,response_text=? WHERE id=?').run(approved ? 'approved' : 'rejected', now(), answerText, approvalId);
  if (isQuestion) pushEvent(row.task_id, 'question-answered', { approvalId, question: payload.question, answer: answerText });
  else pushEvent(row.task_id, approved ? 'action-approved' : 'action-rejected', { approvalId, action: row.action, workerId: row.worker_id, summary: approved ? 'Approved action.' : 'Rejected action.' });
  const pending = pendingActions.get(approvalId);
  if (pending) {
    pendingActions.delete(approvalId);
    pending.resolve(isQuestion ? (answerText || '(no answer given)') : !!approved);
    return { approved: !!approved, answer: isQuestion ? answerText : undefined };
  }
  let failed = false;
  if (approved && !isQuestion) {
    try {
      const result = await executeTool(payload.workspace, payload.tool, payload.arguments, payload.allowedTools, payload.taskId, payload.workerId, { approved: true, scheduled: payload.scheduled });
      pushEvent(row.task_id, 'tool-result', { workerId: row.worker_id, tool: payload.tool, result: toolLogSummary(payload.tool, payload.arguments, result) });
    } catch (error) {
      failed = true;
      pushEvent(row.task_id, 'error', { message: `Approved action failed: ${error.message}` });
    }
  }
  const otherPending = listPendingApprovals().some(item => item.taskId === row.task_id);
  if (otherPending) setTaskStatus(row.task_id, 'awaiting-approval');
  else {
    setTaskStatus(row.task_id, 'needs-attention');
    pushEvent(row.task_id, 'resume-required', {
      message: 'This action was handled after the app restarted. The interrupted agent run cannot resume; start a new task to continue.'
    });
  }
  return { approved: !!approved, failed, recoveryRequired: !otherPending, answer: isQuestion ? answerText : undefined };
});

async function coordinateTask(plan) {
  const state = taskState.get(plan.id) || { budget: getTaskBudget(), modelCalls: 0, handoffs: [], runs: 0 };
  taskState.set(plan.id, state);
  const reports = [];
  const queue = plan.steps.map(step => ({ agentId: step.agentId, ticketCode: '' }));
  const queuedKeys = new Set(queue.map(run => `${run.agentId}:${run.ticketCode}`));
  const maxRuns = Math.min(plan.steps.length * 3 + 6, Math.max(8, state.budget));
  while (queue.length) {
    if (cancelledTasks.has(plan.id)) { taskState.delete(plan.id); return; }
    if (state.runs >= maxRuns) break;
    const run = queue.shift();
    const agent = getAgents().find(item => item.id === run.agentId);
    if (!agent) continue;
    state.runs++;
    let ticket = run.ticketCode ? getTicketByCode(plan.id, run.ticketCode) : nextTicketForAgent(plan.id, agent.id);
    if (ticket && ticket.status === 'todo') ticket = updateTicket(plan.id, ticket.code, { status: 'doing' });
    pushEvent(plan.id, 'agent-status', { agentId: agent.id, name: agent.name, status: 'running', ticketCode: ticket?.code || null, provider: agent.provider, model: agent.model || plan.model });
    state.handoffs.length = 0;
    try {
      const report = await runWorker({
        taskId: plan.id, workspace: plan.workspace, agent, request: plan.prompt, reportContext: reports,
        ticketCode: ticket?.code || '',
        provider: agent.provider === 'inherit' ? plan.provider : agent.provider,
        model: agent.model || (agent.provider === 'inherit' ? plan.model : getProviders()[agent.provider]?.model || ''),
        scheduled: false, allowedTools: [...agent.tools, ...getAllMCPTools().map(t => t.mcpName)]
      });
      reports.push({ agent: agent.name, report, ticketCode: ticket?.code || '' });
      if (ticket && getTicketByCode(plan.id, ticket.code)?.status === 'doing') updateTicket(plan.id, ticket.code, { status: 'done' });
      recordMemory(agent.id, plan.id, `${agent.name}${ticket ? ` finished ${ticket.code}` : ''}: ${String(report).slice(0, 400)}`);
      pushEvent(plan.id, 'agent-status', { agentId: agent.id, name: agent.name, status: 'completed' });
    } catch (error) {
      if (error.code === 'BUDGET') {
        pushEvent(plan.id, 'budget-paused', { budget: state.budget, modelCalls: state.modelCalls });
        const note = `Paused: this task reached its ${state.budget} model-call budget before finishing. Raise the budget in Settings and start a new task to continue.`;
        saveMessage(plan.id, 'assistant', note);
        pushEvent(plan.id, 'final', { content: note });
        setTaskStatus(plan.id, 'needs-attention');
        taskState.delete(plan.id);
        return;
      }
      if (cancelledTasks.has(plan.id)) { taskState.delete(plan.id); return; }
      throw error;
    }
    for (const handoff of state.handoffs) {
      const key = `${handoff.toAgentId}:${handoff.ticketCode || ''}`;
      if (handoff.toAgentId && !queuedKeys.has(key)) { queuedKeys.add(key); queue.push({ agentId: handoff.toAgentId, ticketCode: handoff.ticketCode || '' }); }
    }
  }
  if (cancelledTasks.has(plan.id)) { taskState.delete(plan.id); return; }
  const summary = reports.map(item => `### ${item.agent}${item.ticketCode ? ` · ${item.ticketCode}` : ''}\n${item.report}`).join('\n\n');
  saveMessage(plan.id, 'assistant', summary || 'The team completed the task without a report.');
  pushEvent(plan.id, 'final', { content: summary || 'The team completed the task without a report.' });
  setTaskStatus(plan.id, 'completed');
  taskState.delete(plan.id);
}

function nextTicketForAgent(taskId, agentId) {
  return db.prepare("SELECT id,code,title,status,assigned_agent_id AS assignedAgentId,notes FROM tickets WHERE task_id=? AND assigned_agent_id=? AND status IN ('todo','doing') ORDER BY created_at LIMIT 1").get(taskId, agentId);
}
function resolveAgentId(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  const agent = getAgents().find(item => item.id === value || item.id.toLowerCase() === text || item.name.toLowerCase() === text);
  return agent ? agent.id : '';
}
function agentName(id) { return getAgents().find(item => item.id === id)?.name || id; }

async function callModelBudget(taskId, provider, messages, options = {}) {
  const state = taskState.get(taskId);
  if (state) {
    if (state.modelCalls >= state.budget) { const error = new Error('Task model-call budget reached.'); error.code = 'BUDGET'; throw error; }
    state.modelCalls += 1;
  }
  return await callModel(provider, messages, { onChunk: options.onChunk, signal: state?.abort?.signal });
}

async function executeCoordTool(tool, args, taskId, workerId) {
  if (tool === 'create_ticket') {
    const title = String(args.title || '').slice(0, 200);
    if (!title) throw new Error('create_ticket requires a title.');
    const to = resolveAgentId(args.assignTo);
    const ticket = createTicket(taskId, title, to || workerId, args.notes || '');
    const state = taskState.get(taskId);
    if (state && to && to !== workerId) {
      state.handoffs.push({ toAgentId: to, ticketCode: ticket.code });
      pushEvent(taskId, 'handoff', { agentId: workerId, toAgentId: to, ticketCode: ticket.code, note: String(args.notes || '') });
    }
    return `Created ${ticket.code}: ${ticket.title}${to ? ` assigned to ${agentName(to)}` : ` assigned to ${agentName(workerId)}`}.`;
  }
  if (tool === 'update_ticket') {
    const ticket = updateTicket(taskId, String(args.code || ''), { status: args.status, notes: args.notes });
    return `Updated ${ticket.code} to ${ticket.status}.`;
  }
  if (tool === 'assign_ticket') {
    const to = resolveAgentId(args.to);
    if (!to) throw new Error('assign_ticket requires a known agent id or name in "to".');
    const ticket = updateTicket(taskId, String(args.code || ''), { assignedAgentId: to, status: args.status });
    const state = taskState.get(taskId);
    if (to !== workerId) {
      if (state) state.handoffs.push({ toAgentId: to, ticketCode: ticket.code, note: args.note });
      pushEvent(taskId, 'handoff', { agentId: workerId, toAgentId: to, ticketCode: ticket.code, note: String(args.note || '') });
    }
    return `Handed ${ticket.code} to ${agentName(to)}.`;
  }
  if (tool === 'ask_user') {
    const question = String(args.question || '').slice(0, 2000);
    if (!question) throw new Error('ask_user requires a question.');
    return await requestQuestion(taskId, workerId, question);
  }
  if (tool === 'spawn_subagent') {
    return await executeSpawnSubagent(args, taskId, workerId);
  }
  throw new Error(`Unknown coordination tool: ${tool}`);
}

async function executeSpawnSubagent(args, taskId, parentAgentId) {
  const goal = String(args.goal || '').trim();
  if (!goal) throw new Error('spawn_subagent requires a goal.');
  const agentId = args.agentId ? resolveAgentId(args.agentId) : '';
  const agents = getAgents().filter(agent => agent.enabled !== false);
  let subAgent;
  if (agentId) {
    subAgent = agents.find(a => a.id === agentId);
    if (!subAgent) throw new Error(`Agent ${args.agentId} not found or disabled.`);
  } else {
    // Use a generic subagent - pick first available or create a minimal one
    subAgent = agents[0];
    if (!subAgent) throw new Error('No enabled agents available for subagent.');
  }
  const providers = getProviders();
  const provider = subAgent.provider === 'inherit' ? providers[subAgent.provider] ? subAgent.provider : 'ollama' : subAgent.provider;
  const model = subAgent.model || (subAgent.provider === 'inherit' ? providers[provider]?.model : providers[subAgent.provider]?.model) || '';
  if (!model) throw new Error(`${subAgent.name} has no model selected.`);
  const allowedTools = subAgent.tools.filter(t => PROJECT_TOOLS.includes(t));
  const role = `${subAgent.instructions}\n\nAgent memory (user-editable local notes):\n${subAgent.memory || '(none)'}`;
  const memory = readRecentMemory(subAgent.id, 4);
  const workspace = getSetting('workspace');
  const board = getTickets(taskId).map(ticket => `${ticket.code} [${ticket.status}] ${ticket.title}${ticket.assignedAgentId ? ` → ${agentName(ticket.assignedAgentId)}` : ''}`);
  const parentContext = {
    parentAgentId,
    goal,
    workspaceName: path.basename(workspace),
    ticketBoard: board,
    institutionalMemory: memory
  };
  let subMessages = [
    { role: 'system', content: toolInstructions(allowedTools, false).replace('{{ROLE}}', role) + '\n\nYou are a subagent with an isolated context. Complete the assigned goal and return a concise final report.' },
    { role: 'user', content: JSON.stringify({ subagentGoal: goal, parentContext }) }
  ];
  const maxSteps = Math.min(8, getMaxSteps());
  pushEvent(taskId, 'subagent-started', { subAgentId: subAgent.id, parentAgentId, goal });
  for (let step = 0; step < maxSteps; step++) {
    if (cancelledTasks.has(taskId)) throw new Error('Task cancelled.');
    pushEvent(taskId, 'agent-thinking', { agentId: subAgent.id, name: `${subAgent.name} (subagent)` });
    const output = await callModelBudget(taskId, provider, subMessages, {
      onChunk: chunk => {
        if (chunk) pushEvent(taskId, 'chunk', { agentId: subAgent.id, content: String(chunk) });
      }
    });
    subMessages.push({ role: 'assistant', content: output });
    const parsed = parseJson(output);
    if (!parsed || parsed.type === 'final' || (!parsed.type && !parsed.name && !parsed.tool && !parsed.tool_name)) {
      const report = String(parsed?.content || output).slice(0, 8000);
      pushEvent(taskId, 'subagent-completed', { subAgentId: subAgent.id, parentAgentId, goal, report });
      return `Subagent ${subAgent.name} completed: ${report}`;
    }
    const toolCall = normalizeToolCall(parsed);
    if (!toolCall) {
      subMessages.push({ role: 'user', content: 'Malformed tool request. Continue with a valid allowed tool or provide your final report.' });
      continue;
    }
    const isCoord = COORD_TOOLS.includes(toolCall.name);
    if (!isCoord && !allowedTools.includes(toolCall.name)) {
      subMessages.push({ role: 'user', content: `Tool request refused: ${toolCall.name} is not allowed for this subagent. Continue with an allowed tool or provide your final report.` });
      continue;
    }
    let toolResult;
    try {
      toolResult = await executeTool(workspace, toolCall.name, toolCall.arguments || {}, allowedTools, taskId, subAgent.id, { scheduled: false });
    } catch (error) {
      if (cancelledTasks.has(taskId)) throw error;
      toolResult = `Tool error: ${error.message}`;
      pushEvent(taskId, 'tool-error', { agentId: subAgent.id, name: subAgent.name, tool: toolCall.name, message: error.message });
    }
    subMessages.push({ role: 'user', content: `Tool result for ${toolCall.name}:\n${capToolResult(toolResult)}` });
    const compacted = compactMessages(subMessages, { maxTokens: CONTEXT_TOKEN_BUDGET });
    if (compacted.compacted) {
      subMessages = compacted.messages;
      pushEvent(taskId, 'context-compacted', { agentId: subAgent.id, name: subAgent.name, tokens: compacted.tokens });
    }
  }
  const report = `Subagent stopped after ${maxSteps} steps.`;
  pushEvent(taskId, 'subagent-completed', { subAgentId: subAgent.id, parentAgentId, goal, report });
  return report;
}

async function requestQuestion(taskId, workerId, question) {
  const approvalId = makeId();
  const payload = { question };
  db.prepare('INSERT INTO approvals(id,task_id,worker_id,action,payload,status,created_at) VALUES(?,?,?,?,?,?,?)').run(approvalId, taskId, workerId, 'ask_user', JSON.stringify(payload), 'pending', now());
  pushEvent(taskId, 'question-asked', { approvalId, workerId, question });
  setTaskStatus(taskId, 'awaiting-approval');
  return await new Promise((resolve, reject) => pendingActions.set(approvalId, { taskId, resolve: answer => { resolve(String(answer || '(no answer given)')); }, reject }));
}

async function runWorker({ taskId, workspace, agent, request, reportContext, provider, model, scheduled, allowedTools, ticketCode }) {
  if (!model) throw new Error(`${agent.name} has no model selected. Choose one in the team settings.`);
  const role = `${agent.instructions}\n\nAgent memory (user-editable local notes):\n${agent.memory || '(none)'}`;
  const memory = readRecentMemory(agent.id, 6);
  const board = getTickets(taskId).map(ticket => `${ticket.code} [${ticket.status}] ${ticket.title}${ticket.assignedAgentId ? ` → ${agentName(ticket.assignedAgentId)}` : ''}`);
  let messages = [
    { role: 'system', content: toolInstructions(allowedTools, scheduled).replace('{{ROLE}}', role) },
    { role: 'user', content: JSON.stringify({ task: request, currentTicket: ticketCode || null, workspaceName: path.basename(workspace), ticketBoard: board, priorRuns: (reportContext || []).map(item => `${item.agent}${item.ticketCode ? ` (${item.ticketCode})` : ''}: ${String(item.report).slice(0, 1200)}`), institutionalMemory: memory }) }
  ];
  const maxSteps = getMaxSteps();
  for (let step = 0; step < maxSteps; step++) {
    if (cancelledTasks.has(taskId)) throw new Error('Task cancelled.');
    pushEvent(taskId, 'agent-thinking', { agentId: agent.id, name: agent.name });
    const output = await callModelBudget(taskId, provider, messages, {
      onChunk: chunk => {
        if (chunk) pushEvent(taskId, 'chunk', { agentId: agent.id, content: String(chunk) });
      }
    });
    messages.push({ role: 'assistant', content: output });
    const parsed = parseJson(output);
    if (!parsed || parsed.type === 'final' || (!parsed.type && !parsed.name && !parsed.tool && !parsed.tool_name)) {
      return String(parsed?.content || output).slice(0, 12000);
    }
    const toolCall = normalizeToolCall(parsed);
    if (!toolCall) {
      messages.push({ role: 'user', content: 'Malformed tool request. Continue with a valid allowed tool or provide your final report.' });
      continue;
    }
    const isCoord = COORD_TOOLS.includes(toolCall.name);
    if (!isCoord && !allowedTools.includes(toolCall.name)) {
      messages.push({ role: 'user', content: `Tool request refused: ${toolCall.name} is not allowed for this agent. Continue with an allowed tool or provide your final report.` });
      continue;
    }
    let toolResult;
    try {
      toolResult = await executeTool(workspace, toolCall.name, toolCall.arguments || {}, allowedTools, taskId, agent.id, { scheduled });
    } catch (error) {
      if (cancelledTasks.has(taskId)) throw error;
      toolResult = `Tool error: ${error.message}`;
      pushEvent(taskId, 'tool-error', { agentId: agent.id, name: agent.name, tool: toolCall.name, message: error.message });
    }
    messages.push({ role: 'user', content: `Tool result for ${toolCall.name}:\n${capToolResult(toolResult)}` });
    const compacted = compactMessages(messages, { maxTokens: CONTEXT_TOKEN_BUDGET });
    if (compacted.compacted) {
      messages = compacted.messages;
      pushEvent(taskId, 'context-compacted', { agentId: agent.id, name: agent.name, tokens: compacted.tokens });
    }
  }
  return `Stopped after ${maxSteps} tool steps to keep this run bounded. Continue in a new task if more work is needed.`;
}

async function executeTool(workspace, tool, args, allowedTools, taskId, workerId, options = {}) {
  if (COORD_TOOLS.includes(tool)) {
    if (options.scheduled && (tool === 'create_ticket' || tool === 'assign_ticket')) throw new Error(`${tool} is not available during scheduled checks.`);
    return await executeCoordTool(tool, args, taskId, workerId);
  }
  // MCP tools: format is "serverId.toolName"
  if (tool.includes('.') && getAllMCPTools().some(t => t.mcpName === tool)) {
    if (!allowedTools.includes(tool)) throw new Error(`${tool} is not permitted for this agent.`);
    const mcpTool = getAllMCPTools().find(t => t.mcpName === tool);
    const client = getMCPClient(mcpTool.mcpServerId);
    if (!client) throw new Error(`MCP server ${mcpTool.mcpServerId} not connected.`);
    return await client.callTool(mcpTool.name, args);
  }
  if (!allowedTools.includes(tool)) throw new Error(`${tool} is not permitted for this agent.`);
  if (options.scheduled && canRunScheduledTool(tool)) {
    // Read-only scheduled operations may run without prompting.
  } else if ((tool === 'write_file' || tool === 'run_shell') && !options.approved) {
    return await requestApproval(workspace, tool, args, allowedTools, taskId, workerId, options.scheduled);
  }
  if (tool === 'list_files') return await listWorkspaceFiles(workspace, args.path || '.');
  if (tool === 'read_file') {
    const filePath = resolveWorkspacePath(workspace, args.path);
    if (isSensitivePath(args.path)) throw new Error('Code 13 blocks common secret and credential files from agent context.');
    await assertNoSymlinkPath(workspace, filePath);
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > 500000) throw new Error('File is missing, not a regular file, or larger than 500 KB.');
    return (await fs.readFile(filePath, 'utf8')).slice(0, 16000);
  }
  if (tool === 'git_status') return await gitStatus(workspace);
  if (tool === 'git_diff') return await gitDiff(workspace, args);
  if (tool === 'write_file') {
    if (isSensitivePath(args.path)) throw new Error('Code 13 blocks writes to common secret and credential files.');
    const target = resolveWorkspacePath(workspace, args.path);
    await assertNoSymlinkPath(workspace, target);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, String(args.content ?? ''), 'utf8');
    return `Wrote ${path.relative(workspace, target)} (${String(args.content ?? '').length} characters).`;
  }
  if (tool === 'run_shell') return await runShell(workspace, args.command);
  throw new Error(`Unknown tool: ${tool}`);
}

async function requestApproval(workspace, tool, args, allowedTools, taskId, workerId, scheduled) {
  let preview;
  if (tool === 'write_file') {
    let previous = '';
    try {
      const target = resolveWorkspacePath(workspace, args.path);
      await assertNoSymlinkPath(workspace, target);
      const stat = await fs.stat(target);
      if (stat.isFile() && stat.size <= 100000) previous = (await fs.readFile(target, 'utf8')).slice(0, 5000);
    } catch { /* a new file or unreadable previous contents */ }
    preview = { path: args.path, previous, content: args.content };
  } else {
    preview = { command: args.command, cwd: workspace, risk: assessShellRisk(args.command) };
  }
  const approvalId = makeId();
  const payload = { workspace, tool, arguments: args, allowedTools, taskId, workerId, scheduled: !!scheduled };
  db.prepare('INSERT INTO approvals(id,task_id,worker_id,action,payload,status,created_at) VALUES(?,?,?,?,?,?,?)').run(
    approvalId, taskId, workerId, tool, JSON.stringify(payload), 'pending', now()
  );
  const summary = tool === 'write_file' ? `Write ${args.path}` : tool === 'run_shell' ? `Run command in ${path.basename(workspace)}` : `${tool} needs approval`;
  pushEvent(taskId, 'approval-requested', { approvalId, workerId, tool, summary, payload: preview, scheduled: !!scheduled });
  setTaskStatus(taskId, 'awaiting-approval');
  return await new Promise((resolve, reject) => pendingActions.set(approvalId, { taskId, resolve: async approved => {
    if (!approved) { resolve('User rejected this action. Continue without it or explain why it is needed.'); return; }
    try {
      const result = await executeTool(workspace, tool, args, allowedTools, taskId, workerId, { approved: true, scheduled });
      pushEvent(taskId, 'tool-result', { workerId, tool, result: toolLogSummary(tool, args, result) });
      if (!listPendingApprovals().some(item => item.taskId === taskId)) setTaskStatus(taskId, 'running');
      resolve(result);
    } catch (error) { resolve(`Action failed: ${error.message}`); }
  }, reject }));
}

function toolLogSummary(tool, args, result) {
  if (tool === 'read_file') return `Read ${args.path} (${String(result).length} characters).`;
  if (tool === 'list_files') return `Listed ${String(result).split('\n').filter(Boolean).length} workspace entries.`;
  if (tool === 'git_diff') return String(result).startsWith('No unstaged diff') ? 'No unstaged diff.' : `Retrieved Git diff (${String(result).length} characters).`;
  if (tool === 'run_shell') return `Approved command completed (${String(result).length} output characters).`;
  if (tool === 'write_file') return `Approved write completed for ${args.path}.`;
  return redactForLog(String(result)).slice(0, 500);
}

function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(() => { runDueSchedules().catch(error => console.error('Scheduler error:', error.message)); }, 30000);
}
async function runDueSchedules() {
  const workspace = getSetting('workspace');
  if (!workspace || !existsSync(workspace)) return;
  for (const agent of getAgents()) {
    if (!agent.enabled || !agent.schedule?.enabled || !agent.schedule.nextRunAt || Date.parse(agent.schedule.nextRunAt) > Date.now()) continue;
    const nextRunAt = new Date(Date.now() + agent.schedule.intervalMinutes * 60000).toISOString();
    agent.schedule.nextRunAt = nextRunAt;
    db.prepare('UPDATE agents SET data=?,updated_at=? WHERE id=?').run(JSON.stringify(agent), now(), agent.id);
    const id = makeId();
    const prompt = agent.schedule.prompt || 'Review the current workspace for relevant changes and report concise findings.';
    db.prepare('INSERT INTO tasks(id,title,status,mode,session_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, `[Scheduled] ${agent.name}: ${prompt.slice(0, 70)}`, 'running', 'scheduled', activeSessionId(), now(), now());
    saveMessage(id, 'user', prompt);
    pushEvent(id, 'schedule-started', { agentId: agent.id, name: agent.name, nextRunAt });
    taskState.set(id, { budget: getTaskBudget(), modelCalls: 0, handoffs: [], runs: 0, abort: new AbortController() });
    try {
      pushEvent(id, 'agent-status', { agentId: agent.id, name: agent.name, status: 'running', provider: agent.provider, model: agent.model || getProviders()[agent.provider]?.model });
      const readonly = agent.tools.filter(canRunScheduledTool);
      const mcpToolNames = getAllMCPTools().map(t => t.mcpName);
      const scheduledProvider = agent.provider === 'inherit' ? 'ollama' : agent.provider;
      const report = await runWorker({ taskId: id, workspace, agent, request: prompt, reportContext: [], provider: scheduledProvider, model: agent.model || getProviders()[scheduledProvider]?.model, scheduled: true, allowedTools: [...readonly, ...mcpToolNames] });
      if (!listPendingApprovals().some(item => item.taskId === id)) {
        saveMessage(id, 'assistant', report);
        pushEvent(id, 'final', { content: report, scheduled: true });
        setTaskStatus(id, 'completed');
      } else {
        pushEvent(id, 'scheduled-report', { content: report, readOnlyTools: readonly });
        setTaskStatus(id, 'awaiting-approval');
      }
    } catch (error) {
      pushEvent(id, 'error', { message: error.message });
      setTaskStatus(id, 'failed');
    } finally {
      taskState.delete(id);
    }
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.code13.desktop');
  initDb();
  createWindow();
  startScheduler();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (schedulerTimer) clearInterval(schedulerTimer); if (db) db.close(); });
