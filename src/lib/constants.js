const PROVIDERS = ['ollama', 'openai', 'anthropic', 'freellm'];
const LOCAL_PROVIDERS = ['ollama'];
const DEFAULT_PROVIDERS = {
  ollama: { baseUrl: 'http://localhost:11434', model: '' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: '' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: '' },
  freellm: { baseUrl: 'http://localhost:3001/v1', model: '' }
};
const PROVIDER_LABELS = {
  ollama: 'Ollama',
  openai: 'OpenAI API',
  anthropic: 'Anthropic API',
  freellm: 'FreeLLM · local router'
};

const COORD_TOOLS = ['create_ticket', 'update_ticket', 'assign_ticket', 'ask_user'];
const PROJECT_TOOLS = ['list_files', 'read_file', 'git_status', 'git_diff', 'write_file', 'run_shell'];
const DEFAULT_TASK_BUDGET = 40;
const DEFAULT_MAX_STEPS = 24;
const CONTEXT_TOKEN_BUDGET = 8000;
const TOOL_RESULT_LIMIT = 8000;

const TOOL_LABELS = {
  list_files: 'List files', read_file: 'Read files', git_status: 'Git status', git_diff: 'Git diff',
  write_file: 'Edit files', run_shell: 'Run commands', create_ticket: 'Create ticket',
  update_ticket: 'Update ticket', assign_ticket: 'Hand off ticket', ask_user: 'Ask the user'
};

const PRESETS = [
  { id: 'planner', name: 'Planner', description: 'Breaks a request into a safe, clear route.', instructions: 'Analyze the request and create a concise, ordered plan. Delegate implementation and verification to the right specialists.', tools: ['list_files', 'read_file', 'git_status', 'git_diff'] },
  { id: 'builder', name: 'Builder', description: 'Makes focused project changes.', instructions: 'Implement the requested change carefully. Inspect relevant files first, make the smallest useful edit, and explain what changed.', tools: ['list_files', 'read_file', 'git_status', 'git_diff', 'write_file', 'run_shell'] },
  { id: 'reviewer', name: 'Reviewer', description: 'Finds defects and checks changes.', instructions: 'Review the project and proposed changes. Prioritize concrete bugs, security issues, and missing tests. Do not edit files.', tools: ['list_files', 'read_file', 'git_status', 'git_diff', 'run_shell'] }
];

function providerLabel(provider) { return PROVIDER_LABELS[provider] || String(provider); }
function providerIsLocal(provider) { return LOCAL_PROVIDERS.includes(provider); }
function destinationForProviders(plannedProviders) {
  const remote = [...new Set(plannedProviders.filter(provider => !providerIsLocal(provider)))];
  if (!remote.length) return 'This team route stays on this device.';
  let text = `Task context will be sent to ${remote.map(providerLabel).join(' and ')} when those agents run.`;
  if (remote.includes('freellm')) {
    text += ' FreeLLM is a local router on your machine that forwards requests to free hosted model tiers (Google, Groq and others).';
  }
  return text;
}

module.exports = {
  PROVIDERS, LOCAL_PROVIDERS, DEFAULT_PROVIDERS, PROVIDER_LABELS, TOOL_LABELS,
  COORD_TOOLS, PROJECT_TOOLS, DEFAULT_TASK_BUDGET, DEFAULT_MAX_STEPS, CONTEXT_TOKEN_BUDGET, TOOL_RESULT_LIMIT, PRESETS,
  providerLabel, providerIsLocal, destinationForProviders
};
