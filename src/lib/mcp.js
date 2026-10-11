const { spawn } = require('node:child_process');

// MCP client for stdio-based servers
class MCPClient {
  constructor({ command, args = [], env = {}, cwd }) {
    this.command = command;
    this.args = args;
    this.env = { ...process.env, ...env };
    this.cwd = cwd;
    this.process = null;
    this.requestId = 0;
    this.pending = new Map();
    this.tools = [];
    this.resources = [];
    this.initialized = false;
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
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) this.handleMessage(line.trim());
        }
      });

      this.process.stderr.on('data', (data) => {
        console.error(`[MCP ${this.command}]`, data.toString());
      });

      this.process.on('error', (err) => {
        reject(err);
      });

      this.process.on('exit', (code) => {
        if (!this.initialized) {
          reject(new Error(`MCP server exited with code ${code}`));
        }
      });

      // Send initialize request
      this.send({ jsonrpc: '2.0', id: this.nextId(), method: 'initialize', params: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {} },
        clientInfo: { name: 'code13', version: '0.1.0' }
      }}).then(() => {
        this.initialized = true;
        // Send initialized notification
        this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        // List tools
        return this.listTools();
      }).then(() => resolve(this)).catch(reject);
    });
  }

  nextId() { return ++this.requestId; }

  send(message) {
    const line = JSON.stringify(message) + '\n';
    return new Promise((resolve, reject) => {
      if (!this.process || this.process.killed) {
        reject(new Error('MCP process not running'));
        return;
      }
      if (message.id !== undefined) {
        this.pending.set(message.id, { resolve, reject });
      }
      this.process.stdin.write(line, (err) => {
        if (err) {
          if (message.id !== undefined) this.pending.delete(message.id);
          reject(err);
        } else if (message.id === undefined) {
          resolve();
        }
      });
    });
  }

  handleMessage(line) {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'MCP error'));
        else resolve(msg.result);
      } else if (msg.method) {
        // Handle notifications/requests from server
        this.handleNotification(msg);
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  handleNotification(_msg) {
    // Could handle server notifications here (e.g., tools/list_changed)
  }

  async listTools() {
    const result = await this.send({ jsonrpc: '2.0', id: this.nextId(), method: 'tools/list' });
    this.tools = result?.tools || [];
    return this.tools;
  }

  async listResources() {
    const result = await this.send({ jsonrpc: '2.0', id: this.nextId(), method: 'resources/list' });
    this.resources = result?.resources || [];
    return this.resources;
  }

  async callTool(name, args) {
    return this.send({ jsonrpc: '2.0', id: this.nextId(), method: 'tools/call', params: { name, arguments: args } });
  }

  async readResource(uri) {
    return this.send({ jsonrpc: '2.0', id: this.nextId(), method: 'resources/read', params: { uri } });
  }

  async disconnect() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.initialized = false;
  }
}

let mcpClients = new Map();

async function startMCPServer(serverConfig) {
  const { command, args = [], env = {}, cwd } = serverConfig;
  if (mcpClients.has(serverConfig.id)) {
    await mcpClients.get(serverConfig.id).disconnect();
  }
  const client = new MCPClient({ command, args, env, cwd });
  try {
    await client.connect();
    mcpClients.set(serverConfig.id, client);
    return { id: serverConfig.id, tools: client.tools, resources: client.resources };
  } catch (error) {
    mcpClients.delete(serverConfig.id);
    throw error;
  }
}

function getMCPClient(serverId) {
  return mcpClients.get(serverId);
}

function getAllMCPTools() {
  const allTools = [];
  for (const [serverId, client] of mcpClients) {
    for (const tool of client.tools) {
      allTools.push({ ...tool, mcpServerId: serverId, mcpName: `${serverId}.${tool.name}` });
    }
  }
  return allTools;
}

async function stopMCPServer(serverId) {
  const client = mcpClients.get(serverId);
  if (client) {
    await client.disconnect();
    mcpClients.delete(serverId);
  }
}

async function stopAllMCPServers() {
  for (const client of mcpClients.values()) {
    await client.disconnect();
  }
  mcpClients.clear();
}

module.exports = { MCPClient, startMCPServer, getMCPClient, getAllMCPTools, stopMCPServer, stopAllMCPServers };