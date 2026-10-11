const { spawn } = require('node:child_process');
const path = require('node:path');

// LSP client for language server integration
class LSPClient {
  constructor({ command, args = [], env = {}, cwd, languageId }) {
    this.command = command;
    this.args = args;
    this.env = { ...process.env, ...env };
    this.cwd = cwd;
    this.languageId = languageId;
    this.process = null;
    this.requestId = 0;
    this.pending = new Map();
    this.initialized = false;
    this.capabilities = null;
    this.diagnostics = new Map(); // uri -> diagnostics[]
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let buffer = '';
      this.process.stdout.on('data', (data) => {
        buffer += data.toString();
        this.handleData(buffer);
      });

      this.process.stderr.on('data', (data) => {
        console.error(`[LSP ${this.languageId}]`, data.toString());
      });

      this.process.on('error', (err) => {
        if (!this.initialized) reject(err);
      });

      this.process.on('exit', (code) => {
        if (!this.initialized) {
          reject(new Error(`LSP server exited with code ${code}`));
        }
      });

      // Send initialize request
      this.send({ jsonrpc: '2.0', id: this.nextId(), method: 'initialize', params: {
        processId: process.pid,
        rootUri: `file://${this.cwd}`,
        capabilities: {
          textDocument: {
            hover: { dynamicRegistration: false },
            definition: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
            documentSymbol: { dynamicRegistration: false },
            codeAction: { dynamicRegistration: false },
            completion: { dynamicRegistration: false },
            formatting: { dynamicRegistration: false },
            rename: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: true }
          },
          workspace: {
            didChangeConfiguration: { dynamicRegistration: false },
            didChangeWatchedFiles: { dynamicRegistration: false }
          }
        },
        clientInfo: { name: 'code13', version: '0.1.0' },
        workspaceFolders: [{ uri: `file://${this.cwd}`, name: path.basename(this.cwd) }]
      }}).then(result => {
        this.capabilities = result?.capabilities || {};
        this.initialized = true;
        // Send initialized notification
        this.send({ jsonrpc: '2.0', method: 'initialized' });
        resolve(this);
      }).catch(reject);
    });
  }

  nextId() { return ++this.requestId; }

  handleData(buffer) {
    // Parse Content-Length framed messages
    let idx = 0;
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n', idx);
      if (headerEnd === -1) break;
      const headers = buffer.slice(idx, headerEnd);
      const contentLengthMatch = headers.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) break;
      const contentLength = parseInt(contentLengthMatch[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + contentLength) break;
      const body = buffer.slice(bodyStart, bodyStart + contentLength);
      try {
        const msg = JSON.parse(body);
        this.handleMessage(msg);
      } catch (e) {
        console.error('LSP parse error:', e);
      }
      idx = bodyStart + contentLength;
    }
    if (idx > 0) {
      // Remove processed data from buffer
      this.buffer = buffer.slice(idx);
    }
  }

  send(message) {
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    const data = header + body;
    return new Promise((resolve, reject) => {
      if (!this.process || this.process.killed) {
        reject(new Error('LSP process not running'));
        return;
      }
      if (message.id !== undefined) {
        this.pending.set(message.id, { resolve, reject });
      }
      this.process.stdin.write(data, (err) => {
        if (err) {
          if (message.id !== undefined) this.pending.delete(message.id);
          reject(err);
        } else if (message.id === undefined) {
          resolve();
        }
      });
    });
  }

  handleMessage(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || 'LSP error'));
      else resolve(msg.result);
    } else if (msg.method) {
      this.handleNotification(msg);
    }
  }

  handleNotification(msg) {
    if (msg.method === 'textDocument/publishDiagnostics') {
      const { uri, diagnostics } = msg.params;
      this.diagnostics.set(uri, diagnostics);
    }
    // Could handle other notifications: window/logMessage, window/showMessage, etc.
  }

  async didOpen(uri, text, version = 1) {
    await this.send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
      textDocument: { uri, languageId: this.languageId, version, text }
    }});
  }

  async didChange(uri, text, version) {
    await this.send({ jsonrpc: '2.0', method: 'textDocument/didChange', params: {
      textDocument: { uri, version },
      contentChanges: [{ text }]
    }});
  }

  async didClose(uri) {
    await this.send({ jsonrpc: '2.0', method: 'textDocument/didClose', params: {
      textDocument: { uri }
    }});
  }

  async hover(uri, line, character) {
    return this.send({ jsonrpc: '2.0', id: this.nextId(), method: 'textDocument/hover', params: {
      textDocument: { uri },
      position: { line, character }
    }});
  }

  async definition(uri, line, character) {
    return this.send({ jsonrpc: '2.0', id: this.nextId(), method: 'textDocument/definition', params: {
      textDocument: { uri },
      position: { line, character }
    }});
  }

  async references(uri, line, character, includeDeclaration = true) {
    return this.send({ jsonrpc: '2.0', id: this.nextId(), method: 'textDocument/references', params: {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration }
    }});
  }

  async documentSymbols(uri) {
    return this.send({ jsonrpc: '2.0', id: this.nextId(), method: 'textDocument/documentSymbol', params: {
      textDocument: { uri }
    }});
  }

  async codeAction(uri, range, diagnostics) {
    return this.send({ jsonrpc: '2.0', id: this.nextId(), method: 'textDocument/codeAction', params: {
      textDocument: { uri },
      range,
      context: { diagnostics }
    }});
  }

  async completion(uri, line, character) {
    return this.send({ jsonrpc: '2.0', id: this.nextId(), method: 'textDocument/completion', params: {
      textDocument: { uri },
      position: { line, character }
    }});
  }

  async formatting(uri) {
    return this.send({ jsonrpc: '2.0', id: this.nextId(), method: 'textDocument/formatting', params: {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true }
    }});
  }

  async rename(uri, line, character, newName) {
    return this.send({ jsonrpc: '2.0', id: this.nextId(), method: 'textDocument/rename', params: {
      textDocument: { uri },
      position: { line, character },
      newName
    }});
  }

  getDiagnostics(uri) {
    return this.diagnostics.get(uri) || [];
  }

  async disconnect() {
    if (this.process) {
      this.send({ jsonrpc: '2.0', method: 'shutdown' }).catch(() => {});
      this.send({ jsonrpc: '2.0', method: 'exit' }).catch(() => {});
      this.process.kill();
      this.process = null;
    }
    this.initialized = false;
  }
}

// Language to LSP server command mapping
const LSP_SERVERS = {
  typescript: { command: 'npx', args: ['-y', 'typescript-language-server', '--stdio'] },
  javascript: { command: 'npx', args: ['-y', 'typescript-language-server', '--stdio'] },
  python: { command: 'pylsp', args: [] },
  rust: { command: 'rust-analyzer', args: [] },
  go: { command: 'gopls', args: [] },
  // Add more as needed
};

let lspClients = new Map();

async function startLSPServer(languageId, workspacePath) {
  const config = LSP_SERVERS[languageId];
  if (!config) throw new Error(`No LSP server configured for ${languageId}`);
  const key = `${languageId}:${workspacePath}`;
  if (lspClients.has(key)) return lspClients.get(key);

  const client = new LSPClient({ ...config, cwd: workspacePath, languageId });
  try {
    await client.connect();
    lspClients.set(key, client);
    return client;
  } catch (error) {
    lspClients.delete(key);
    throw error;
  }
}

function getLSPClient(languageId, workspacePath) {
  return lspClients.get(`${languageId}:${workspacePath}`);
}

async function stopLSPServer(languageId, workspacePath) {
  const key = `${languageId}:${workspacePath}`;
  const client = lspClients.get(key);
  if (client) {
    await client.disconnect();
    lspClients.delete(key);
  }
}

async function stopAllLSPServers() {
  for (const client of lspClients.values()) {
    await client.disconnect();
  }
  lspClients.clear();
}

module.exports = { LSPClient, startLSPServer, getLSPClient, stopLSPServer, stopAllLSPServers, LSP_SERVERS };