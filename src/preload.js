const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('code13', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  listSessions: () => ipcRenderer.invoke('session:list'),
  createSession: (title) => ipcRenderer.invoke('session:create', title),
  setCurrentSession: (id) => ipcRenderer.invoke('session:set-current', id),
  renameSession: (id, title) => ipcRenderer.invoke('session:rename', id, title),
  deleteSession: (id) => ipcRenderer.invoke('session:delete', id),
  selectWorkspace: () => ipcRenderer.invoke('workspace:select'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
  testProvider: (provider) => ipcRenderer.invoke('provider:test', provider),
  pingProvider: (provider) => ipcRenderer.invoke('provider:ping', provider),
  listProviderModels: (provider, force) => ipcRenderer.invoke('provider:models', provider, force),
  listWorkspaceFiles: (relativePath) => ipcRenderer.invoke('workspace:list-files', relativePath),
  saveAgent: (agent) => ipcRenderer.invoke('agent:save', agent),
  deleteAgent: (id) => ipcRenderer.invoke('agent:delete', id),
  setSchedule: (id, schedule) => ipcRenderer.invoke('agent:schedule', id, schedule),
  createPlan: (request) => ipcRenderer.invoke('task:plan', request),
  approveRoute: (taskId) => ipcRenderer.invoke('task:approve-route', taskId),
  cancelTask: (taskId) => ipcRenderer.invoke('task:cancel', taskId),
  respondApproval: (approvalId, approved, answer, confirmed) => ipcRenderer.invoke('approval:respond', approvalId, approved, answer, confirmed),
  getTask: (taskId) => ipcRenderer.invoke('task:get', taskId),
  getTickets: (taskId) => ipcRenderer.invoke('task:tickets', taskId),
  listMCPServers: () => ipcRenderer.invoke('mcp:list'),
  addMCPServer: (server) => ipcRenderer.invoke('mcp:add', server),
  updateMCPServer: (id, updates) => ipcRenderer.invoke('mcp:update', id, updates),
  removeMCPServer: (id) => ipcRenderer.invoke('mcp:remove', id),
  connectMCPServer: (id) => ipcRenderer.invoke('mcp:connect', id),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('code13:event', listener);
    return () => ipcRenderer.removeListener('code13:event', listener);
  }
});
