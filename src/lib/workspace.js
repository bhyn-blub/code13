const path = require('node:path');
const fs = require('node:fs/promises');
const { resolveWorkspacePath, assertNoSymlinkPath } = require('./policy');

const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', 'vendor']);
const MAX_ENTRIES = 500;
const MAX_DEPTH = 5;

async function listWorkspaceFiles(workspace, relative) {
  const root = resolveWorkspacePath(workspace, relative);
  await assertNoSymlinkPath(workspace, root);
  const results = [];
  async function visit(directory, depth) {
    if (results.length >= MAX_ENTRIES || depth > MAX_DEPTH) return;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= MAX_ENTRIES) break;
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      const rel = path.relative(workspace, fullPath).replaceAll(path.sep, '/');
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { results.push(`${rel}/`); await visit(fullPath, depth + 1); }
      else results.push(rel);
    }
  }
  await visit(root, 0);
  return results.join('\n') || '(no visible files)';
}

module.exports = { listWorkspaceFiles };
