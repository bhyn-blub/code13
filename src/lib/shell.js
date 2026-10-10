const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 12000;

async function runShell(workspace, command, { exec = execFileAsync, platform = process.platform } = {}) {
  if (platform !== 'win32') throw new Error('Shell execution is supported only in the Windows build.');
  const result = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', String(command || '')], { cwd: workspace, timeout: 120000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  return `${result.stdout}\n${result.stderr}`.trim().slice(0, MAX_OUTPUT) || 'Command completed with no output.';
}

module.exports = { runShell };
