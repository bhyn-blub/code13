// Config schema validation for structured settings
const CONFIG_SCHEMA = {
  providers: {
    type: 'object',
    properties: {
      ollama: { type: 'object', properties: { baseUrl: { type: 'string', format: 'uri' }, model: { type: 'string' } }, additionalProperties: false },
      openai: { type: 'object', properties: { baseUrl: { type: 'string', format: 'uri' }, model: { type: 'string' } }, additionalProperties: false },
      anthropic: { type: 'object', properties: { baseUrl: { type: 'string', format: 'uri' }, model: { type: 'string' } }, additionalProperties: false },
      freellm: { type: 'object', properties: { baseUrl: { type: 'string', format: 'uri' }, model: { type: 'string' } }, additionalProperties: false }
    },
    additionalProperties: false
  },
  taskBudget: { type: 'integer', minimum: 5, maximum: 500 },
  maxSteps: { type: 'integer', minimum: 4, maximum: 200 },
  hostedModelRouting: { type: 'boolean' },
  workspace: { type: 'string' },
  activeSession: { type: 'string' }
};

function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (config.providers) {
    for (const [provider, cfg] of Object.entries(config.providers)) {
      if (!CONFIG_SCHEMA.providers.properties[provider]) {
        warnings.push(`Unknown provider: ${provider}`);
        continue;
      }
      if (cfg.baseUrl && typeof cfg.baseUrl !== 'string') {
        errors.push(`Provider ${provider}: baseUrl must be a string`);
      }
      if (cfg.model && typeof cfg.model !== 'string') {
        errors.push(`Provider ${provider}: model must be a string`);
      }
    }
  }

  if (config.taskBudget !== undefined) {
    if (!Number.isInteger(config.taskBudget) || config.taskBudget < 5 || config.taskBudget > 500) {
      errors.push('taskBudget must be an integer between 5 and 500');
    }
  }

  if (config.maxSteps !== undefined) {
    if (!Number.isInteger(config.maxSteps) || config.maxSteps < 4 || config.maxSteps > 200) {
      errors.push('maxSteps must be an integer between 4 and 200');
    }
  }

  if (config.hostedModelRouting !== undefined && typeof config.hostedModelRouting !== 'boolean') {
    errors.push('hostedModelRouting must be a boolean');
  }

  if (config.workspace !== undefined && typeof config.workspace !== 'string') {
    errors.push('workspace must be a string');
  }

  return { valid: errors.length === 0, errors, warnings };
}

function sanitizeConfig(config) {
  const sanitized = {};
  if (config.providers) {
    sanitized.providers = {};
    for (const [provider, cfg] of Object.entries(config.providers)) {
      if (CONFIG_SCHEMA.providers.properties[provider]) {
        sanitized.providers[provider] = {};
        if (cfg.baseUrl && typeof cfg.baseUrl === 'string') sanitized.providers[provider].baseUrl = cfg.baseUrl.trim();
        if (cfg.model && typeof cfg.model === 'string') sanitized.providers[provider].model = cfg.model.trim();
      }
    }
  }
  if (config.taskBudget !== undefined) {
    const budget = Math.max(5, Math.min(500, parseInt(config.taskBudget, 10) || 40));
    sanitized.taskBudget = budget;
  }
  if (config.maxSteps !== undefined) {
    const steps = Math.max(4, Math.min(200, parseInt(config.maxSteps, 10) || 24));
    sanitized.maxSteps = steps;
  }
  if (config.hostedModelRouting !== undefined) {
    sanitized.hostedModelRouting = Boolean(config.hostedModelRouting);
  }
  if (config.workspace !== undefined && typeof config.workspace === 'string') {
    sanitized.workspace = config.workspace.trim();
  }
  return sanitized;
}

function getConfigSchema() {
  return { ...CONFIG_SCHEMA };
}

function mergeConfig(current, incoming) {
  const merged = { ...current };
  if (incoming.providers) {
    merged.providers = { ...merged.providers, ...incoming.providers };
  }
  if (incoming.taskBudget !== undefined) merged.taskBudget = incoming.taskBudget;
  if (incoming.maxSteps !== undefined) merged.maxSteps = incoming.maxSteps;
  if (incoming.hostedModelRouting !== undefined) merged.hostedModelRouting = incoming.hostedModelRouting;
  if (incoming.workspace !== undefined) merged.workspace = incoming.workspace;
  return merged;
}

module.exports = { CONFIG_SCHEMA, validateConfig, sanitizeConfig, getConfigSchema, mergeConfig };