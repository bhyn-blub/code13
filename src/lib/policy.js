const path = require('node:path');

function resolveWorkspacePath(workspace, candidate) {
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, candidate || '.');
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('That path is outside the selected workspace.');
  }
  return resolved;
}

function canRunScheduledTool(toolName) {
  return ['list_files', 'read_file', 'git_status', 'git_diff'].includes(toolName);
}

async function assertNoSymlinkPath(workspace, targetPath) {
  const root = path.resolve(workspace);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('That path is outside the selected workspace.');
  }
  let current = root;
  const rootStat = await require('node:fs/promises').lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error('The selected workspace cannot be a symbolic link.');
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await require('node:fs/promises').lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not followed inside the workspace.');
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  return target;
}

function isSensitivePath(candidate) {
  const normalized = String(candidate).replaceAll('\\', '/').toLowerCase();
  const segments = normalized.split('/');
  const base = segments.at(-1) || '';
  const parent = segments.at(-2) || '';
  const exactNames = ['.env', 'id_rsa', 'id_ed25519', '.npmrc', '.netrc', '_netrc', '.htpasswd'];
  const extensions = ['.pem', '.key', '.pfx', '.p12', '.jks', '.keystore'];
  return exactNames.includes(base)
    || base.startsWith('.env.')
    || extensions.some(extension => base.endsWith(extension))
    || (base.includes('secret'))
    || base.includes('credential')
    || (['.aws', '.kube'].includes(parent) && base === 'config')
    || (parent === '.docker' && (base === 'config' || base === 'config.json'));
}

// Shell commands a human should confirm with extra care before they allow them.
const DANGEROUS_SHELL_PATTERNS = [
  { pattern: /\b(remove-item|rm|del|erase|rd|rmdir)\b[^\n]*(\s-[a-z]*[rf][a-z]*\b|\s--(recursive|force)\b|\s\/[sq]\b)/i, reason: 'recursive or forced delete' },
  { pattern: /\b(format|diskpart|mkfs)\b/i, reason: 'disk formatting or partitioning' },
  { pattern: /\b(shutdown|restart-computer|stop-computer)\b/i, reason: 'system shutdown or restart' },
  { pattern: /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*[fd])/i, reason: 'irreversible Git history or worktree change' },
  { pattern: /\b(invoke-expression|iex|invoke-webrequest|iwr|invoke-restmethod|irm|curl|wget)\b/i, reason: 'remote download or code execution' },
  { pattern: /\b(set-executionpolicy|register-scheduledtask|new-service|sc\s+(create|delete))\b/i, reason: 'system configuration change' },
  { pattern: /\b(reg\s+(add|delete)|takeown|icacls)\b/i, reason: 'registry or permission change' },
  { pattern: /\b(stop-process|taskkill)\b/i, reason: 'process termination' }
];

function assessShellRisk(command) {
  const text = String(command || '');
  const reasons = [...new Set(DANGEROUS_SHELL_PATTERNS.filter(item => item.pattern.test(text)).map(item => item.reason))];
  return { level: reasons.length ? 'high' : 'normal', reasons };
}

function redactForLog(value) {
  return String(value)
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, '[redacted]')
    .replace(/(x-api-key\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[redacted]');
}

module.exports = { resolveWorkspacePath, assertNoSymlinkPath, isSensitivePath, canRunScheduledTool, redactForLog, assessShellRisk };
