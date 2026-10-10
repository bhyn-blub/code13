const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveWorkspacePath, assertNoSymlinkPath, isSensitivePath } = require('./policy');

const execFileAsync = promisify(execFile);
const SECRET_ERROR = 'Code 13 blocks common secret and credential files from agent context.';

async function gitStatus(workspace, { exec = execFileAsync } = {}) {
  const result = await exec('git', ['status', '--short', '--branch'], { cwd: workspace, timeout: 12000, windowsHide: true });
  return result.stdout.slice(0, 8000) || 'Working tree clean.';
}

async function gitDiff(workspace, args = {}, { exec = execFileAsync } = {}) {
  const argsList = ['diff', '--no-ext-diff', '--'];
  if (args.path) {
    if (isSensitivePath(args.path)) throw new Error(SECRET_ERROR);
    const filePath = resolveWorkspacePath(workspace, args.path);
    await assertNoSymlinkPath(workspace, filePath);
    argsList.push(path.relative(workspace, filePath));
  } else {
    const listed = await exec('git', ['diff', '--name-only'], { cwd: workspace, timeout: 12000, windowsHide: true });
    const safeFiles = listed.stdout.split(/\r?\n/).map(name => name.trim()).filter(Boolean).filter(name => !isSensitivePath(name));
    if (!safeFiles.length) return 'No unstaged diff.';
    argsList.push(...safeFiles);
  }
  const result = await exec('git', argsList, { cwd: workspace, timeout: 12000, windowsHide: true });
  return result.stdout.slice(0, 18000) || 'No unstaged diff.';
}

module.exports = { gitStatus, gitDiff, SECRET_ERROR };
