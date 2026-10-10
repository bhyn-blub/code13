const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { promisify } = require('node:util');

const MAIN_PATH = path.resolve(__dirname, '../../src/main.js');
const SRC_DIR = path.resolve(__dirname, '../../src');

// Drop every cached module under `src/` so each boot re-requires them and, in
// particular, re-captures the mocked `child_process.execFile`.
function clearSrcCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_DIR)) delete require.cache[key];
  }
}

// Boots the real Electron main process with `electron`, `fetch`, and
// `child_process.execFile` mocked. Re-call `boot()` to simulate a restart
// (the caller is responsible for emitting `before-quit` on the prior app).
async function createHarness(t, options = {}) {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'code13-test-userdata-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'code13-test-project-'));
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  const modelReplies = [];
  const execCalls = [];
  let hostedFetches = 0;
  let shellCalls = 0;

  const baseExecFile = function(file, args, _options, callback) {
    shellCalls++;
    execCalls.push({ file, args });
    try {
      const result = options.onExecFile ? options.onExecFile(file, args) : { stdout: options.shellStdout || 'mocked test output', stderr: '' };
      callback(null, result || { stdout: '', stderr: '' });
    } catch (error) {
      callback(error);
    }
  };
  const mockExecFile = (...args) => baseExecFile(...args);
  mockExecFile[promisify.custom] = (...args) => new Promise((resolve, reject) => {
    baseExecFile(...args, (error, result) => error ? reject(error) : resolve(result));
  });

  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return currentElectron;
    if (request === 'node:child_process') return { ...originalLoad.call(this, request, parent, isMain), execFile: mockExecFile };
    return originalLoad.call(this, request, parent, isMain);
  };
  global.fetch = options.fetchImpl || (async () => {
    hostedFetches++;
    const content = modelReplies.shift() || '{"type":"final","content":"Done."}';
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`)); controller.close(); } });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });

  let currentElectron;
  let activeApp;
  const boots = [];

  function boot() {
    const ipcHandlers = new Map();
    const events = [];
    const windows = [];
    let ready;
    const app = new EventEmitter();
    app.whenReady = () => new Promise(resolve => { ready = resolve; });
    app.getPath = () => userData;
    app.setAppUserModelId = () => {};
    class MockWindow {
      constructor() { this.webContents = { send(_channel, payload) { events.push(payload); } }; windows.push(this); }
      loadFile() {}
      static getAllWindows() { return windows; }
    }
    currentElectron = {
      app, BrowserWindow: MockWindow, ipcMain: { handle(name, callback) { ipcHandlers.set(name, callback); } },
      dialog: { async showOpenDialog() { return { canceled: false, filePaths: [workspace] }; } },
      safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString() }
    };
    delete require.cache[MAIN_PATH];
    clearSrcCache();
    require(MAIN_PATH);
    ready();
    activeApp = app;
    const handle = { ipcHandlers, events, app };
    boots.push(handle);
    return handle;
  }

  t.after(async () => {
    if (activeApp) activeApp.emit('before-quit');
    Module._load = originalLoad;
    global.fetch = originalFetch;
    delete require.cache[MAIN_PATH];
    clearSrcCache();
    await fs.rm(userData, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  });

  return {
    boot, modelReplies, workspace, execCalls,
    get hostedFetches() { return hostedFetches; },
    get shellCalls() { return shellCalls; }
  };
}

async function waitFor(predicate, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await predicate()) return true; await new Promise(resolve => setTimeout(resolve, 10)); }
  return await predicate();
}

async function waitForStatus(ipcHandlers, taskId, status, timeout = 3000) {
  await waitFor(async () => (await ipcHandlers.get('task:get')(null, taskId)).status === status, timeout);
  return await ipcHandlers.get('task:get')(null, taskId);
}

// Boots a harness, selects the workspace, and configures a usable hosted
// provider so tests can immediately plan tasks.
async function readyHarness(t, options = {}) {
  const harness = await createHarness(t, options);
  const first = harness.boot();
  await new Promise(resolve => setTimeout(resolve, 50));
  await first.ipcHandlers.get('workspace:select')();
  await first.ipcHandlers.get('settings:save')(null, {
    providers: { openai: { baseUrl: 'https://api.openai.com/v1', model: 'model-x', apiKey: 'secret-test-key' } },
    ...(options.taskBudget ? { taskBudget: options.taskBudget } : {})
  });
  // Keep the harness getters (shellCalls/hostedFetches) live by delegating to
  // the original object instead of spreading (which would snapshot them).
  return Object.assign(Object.create(harness), first);
}

module.exports = { createHarness, readyHarness, waitFor, waitForStatus, MAIN_PATH };
