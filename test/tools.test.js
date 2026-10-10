const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { gitDiff, gitStatus } = require('../src/lib/git');
const { listWorkspaceFiles } = require('../src/lib/workspace');
const { runShell } = require('../src/lib/shell');

async function tempDir() { return await fs.mkdtemp(path.join(os.tmpdir(), 'code13-tools-')); }

test('gitDiff with a path asks git only for that file', async t => {
  const workspace = await tempDir();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, 'app.js'), 'x');
  const calls = [];
  const exec = async (_file, args) => { calls.push(args); return { stdout: 'diff --git a/app.js b/app.js' }; };
  const result = await gitDiff(workspace, { path: 'app.js' }, { exec });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['diff', '--no-ext-diff', '--', 'app.js']);
  assert.match(result, /app\.js/);
});

test('gitDiff refuses to diff a secret file', async () => {
  const workspace = await tempDir();
  let called = false;
  const exec = async () => { called = true; return { stdout: '' }; };
  await assert.rejects(gitDiff(workspace, { path: '.env' }, { exec }), /secret/i);
  assert.equal(called, false, 'git is never invoked for a secret path');
});

test('gitDiff without a path excludes sensitive files from the diff', async () => {
  const workspace = await tempDir();
  const calls = [];
  const exec = async (_file, args) => {
    calls.push(args);
    if (args.includes('--name-only')) return { stdout: '.env\nsrc/app.js\nkeys/server.pem\n' };
    return { stdout: 'diff --git a/src/app.js b/src/app.js\n+hello' };
  };
  const result = await gitDiff(workspace, {}, { exec });
  const diffCall = calls.find(args => args.includes('--no-ext-diff'));
  assert.deepEqual(diffCall, ['diff', '--no-ext-diff', '--', 'src/app.js']);
  assert.match(result, /src\/app\.js/);
  assert.equal(calls.some(args => args.some(argument => argument.includes('.env') || argument.includes('.pem'))), false);
});

test('gitDiff reports an empty diff when only secrets changed', async () => {
  const workspace = await tempDir();
  const exec = async (_file, args) => args.includes('--name-only') ? { stdout: '.env\n' } : { stdout: '' };
  assert.equal(await gitDiff(workspace, {}, { exec }), 'No unstaged diff.');
});

test('gitStatus bounds output and falls back to a clean message', async () => {
  assert.equal(await gitStatus('/tmp', { exec: async () => ({ stdout: '' }) }), 'Working tree clean.');
  assert.equal(await gitStatus('/tmp', { exec: async () => ({ stdout: ' M app.js' }) }), ' M app.js');
});

test('listWorkspaceFiles skips ignored and hidden entries', async t => {
  const workspace = await tempDir();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'node_modules', 'pkg'), { recursive: true });
  await fs.mkdir(path.join(workspace, '.github', 'workflows'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'src', 'app.js'), 'x');
  await fs.writeFile(path.join(workspace, 'node_modules', 'pkg', 'index.js'), 'x');
  await fs.writeFile(path.join(workspace, '.github', 'workflows', 'ci.yml'), 'x');
  await fs.writeFile(path.join(workspace, '.hidden'), 'x');
  const listing = await listWorkspaceFiles(workspace, '.');
  assert.match(listing, /src\/app\.js/);
  assert.match(listing, /\.github\/workflows\/ci\.yml/);
  assert.equal(listing.includes('node_modules'), false);
  assert.equal(listing.includes('.hidden'), false);
});

test('runShell refuses to execute outside the Windows build', async () => {
  await assert.rejects(runShell('/tmp', 'npm test', { platform: 'linux', exec: async () => ({ stdout: '' }) }), /Windows/);
});

test('runShell runs through PowerShell and trims output', async () => {
  let captured;
  const exec = async (file, args, options) => { captured = { file, args, options }; return { stdout: 'ok\n', stderr: '' }; };
  const result = await runShell('/tmp', 'npm test', { platform: 'win32', exec });
  assert.equal(captured.file, 'powershell.exe');
  assert.ok(captured.args.includes('npm test'));
  assert.equal(captured.options.cwd, '/tmp');
  assert.equal(result, 'ok');
});
