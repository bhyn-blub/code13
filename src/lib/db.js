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
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, task_id TEXT, event_type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), worker_id TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_at TEXT);
    CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), code TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo', assigned_agent_id TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, task_id TEXT, agent_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_tickets_task ON tickets(task_id, created_at);
  `);
  const stamp = new Date().toISOString();
  if (!db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get()) {
    db.prepare("INSERT INTO settings(key,value) VALUES('schema_version','1')").run();
  }
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

module.exports = { openDatabase };
