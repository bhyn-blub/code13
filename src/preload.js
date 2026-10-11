const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('code13', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  selectWorkspace: () => ipcRenderer.invoke('workspace:select'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
  testProvider: (provider) => ipcRenderer.invoke('provider:test', provider),
  pingProvider: (provider) => ipcRenderer.invoke('provider:ping', provider),
  listProviderModels: (provider) => ipcRenderer.invoke('provider:models', provider),
  saveAgent: (agent) => ipcRenderer.invoke('agent:save', agent),
  deleteAgent: (id) => ipcRenderer.invoke('agent:delete', id),
  setSchedule: (id, schedule) => ipcRenderer.invoke('agent:schedule', id, schedule),
  createPlan: (request) => ipcRenderer.invoke('task:plan', request),
  approveRoute: (taskId) => ipcRenderer.invoke('task:approve-route', taskId),
  cancelTask: (taskId) => ipcRenderer.invoke('task:cancel', taskId),
  respondApproval: (approvalId, approved, answer, confirmed) => ipcRenderer.invoke('approval:respond', approvalId, approved, answer, confirmed),
  getTask: (taskId) => ipcRenderer.invoke('task:get', taskId),
  getTickets: (taskId) => ipcRenderer.invoke('task:tickets', taskId),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('code13:event', listener);
    return () => ipcRenderer.removeListener('code13:event', listener);
  }
});
