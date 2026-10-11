const { DatabaseSync } = require('node:sqlite');

// Creates and migrates the local SQLite store, then seeds defaults.
function openDatabase({ databasePath, presets = [], defaultProviders = {}, defaultTaskBudget = 40 }) {
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS credentials (provider TEXT PRIMARY KEY, encrypted_value BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, task_id TEXT, event_type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), worker_id TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_at TEXT);
    CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), code TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo', assigned_agent_id TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, task_id TEXT, agent_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, command TEXT NOT NULL, args TEXT NOT NULL DEFAULT '[]', env TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_tickets_task ON tickets(task_id, created_at);
  `);
  const stamp = new Date().toISOString();
  const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name);
  if (!taskColumns.includes('session_id')) db.exec("ALTER TABLE tasks ADD COLUMN session_id TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id, created_at)');
  const approvalColumns = db.prepare('PRAGMA table_info(approvals)').all().map(row => row.name);
  if (!approvalColumns.includes('response_text')) db.exec('ALTER TABLE approvals ADD COLUMN response_text TEXT');
  if (!db.prepare("SELECT value FROM settings WHERE key='task_budget'").get()) {
    db.prepare("INSERT INTO settings(key,value) VALUES('task_budget',?)").run(String(defaultTaskBudget));
  }
  if (!db.prepare("SELECT value FROM settings WHERE key='providers'").get()) {
    db.prepare("INSERT INTO settings(key,value) VALUES('providers',?)").run(JSON.stringify(defaultProviders));
  }
  if (!db.prepare("SELECT value FROM settings WHERE key='workspace'").get()) {
    db.prepare("INSERT INTO settings(key,value) VALUES('workspace','')").run();
  }
  for (const preset of presets) {
    if (!db.prepare('SELECT id FROM agents WHERE id=?').get(preset.id)) {
      const agent = { ...preset, provider: 'inherit', model: '', memory: '', advanced: false, enabled: true, schedule: { enabled: false, intervalMinutes: 60, prompt: '' } };
      db.prepare('INSERT INTO agents(id,data,created_at,updated_at) VALUES(?,?,?,?)').run(agent.id, JSON.stringify(agent), stamp, stamp);
    }
  }
  db.prepare("UPDATE tasks SET status='interrupted',updated_at=? WHERE status IN ('planning','running')").run(stamp);
  return db;
}

module.exports = { openDatabase, getMCPServers, getMCPServer, createMCPServer, updateMCPServer, deleteMCPServer };

// MCP server helpers
function getMCPServers(db) {
  return db.prepare('SELECT id, name, command, args, env, enabled, created_at AS createdAt, updated_at AS updatedAt FROM mcp_servers ORDER BY created_at').all();
}

function getMCPServer(db, id) {
  return db.prepare('SELECT id, name, command, args, env, enabled, created_at AS createdAt, updated_at AS updatedAt FROM mcp_servers WHERE id=?').get(id);
}

function createMCPServer(db, { id, name, command, args = [], env = {} }) {
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO mcp_servers(id,name,command,args,env,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, name, command, JSON.stringify(args), JSON.stringify(env), 1, stamp, stamp);
  return getMCPServer(db, id);
}

function updateMCPServer(db, id, updates) {
  const fields = [];
  const values = [];
  if (updates.name !== undefined) { fields.push('name=?'); values.push(updates.name); }
  if (updates.command !== undefined) { fields.push('command=?'); values.push(updates.command); }
  if (updates.args !== undefined) { fields.push('args=?'); values.push(JSON.stringify(updates.args)); }
  if (updates.env !== undefined) { fields.push('env=?'); values.push(JSON.stringify(updates.env)); }
  if (updates.enabled !== undefined) { fields.push('enabled=?'); values.push(updates.enabled ? 1 : 0); }
  if (!fields.length) return getMCPServer(db, id);
  fields.push('updated_at=?');
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE mcp_servers SET ${fields.join(',')} WHERE id=?`).run(...values);
  return getMCPServer(db, id);
}

function deleteMCPServer(db, id) {
  db.prepare('DELETE FROM mcp_servers WHERE id=?').run(id);
}
