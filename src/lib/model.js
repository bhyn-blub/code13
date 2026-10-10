const { PROVIDERS, DEFAULT_PROVIDERS } = require('./constants');
const { streamProvider } = require('./providers');

// Model I/O bound to the local settings/credential store via injected getters.
function createModelClient({ getProviders, getCredential, fetchImpl = fetch }) {
  function providerConfig(provider) {
    if (!PROVIDERS.includes(provider)) throw new Error('Unknown model provider.');
    const config = getProviders()[provider] || DEFAULT_PROVIDERS[provider];
    if (!config.model) throw new Error(`Choose a model for ${provider}.`);
    if (provider !== 'ollama' && !getCredential(provider)) throw new Error(`Add an API key for ${provider} in Settings.`);
    return config;
  }

  async function callModel(provider, messages, options = {}) {
    const config = providerConfig(provider);
    return streamProvider(provider, messages, {
      config,
      key: provider === 'ollama' ? '' : getCredential(provider),
      onChunk: options.onChunk,
      signal: options.signal
    });
  }

  async function listModels(provider) {
    const config = getProviders()[provider] || DEFAULT_PROVIDERS[provider];
    if (provider === 'ollama') {
      const response = await fetchImpl(new URL('/api/tags', config.baseUrl), { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`Ollama returned ${response.status}.`);
      const data = await response.json();
      return (data.models || []).map(model => model.name);
    }
    const key = getCredential(provider);
    if (!key) throw new Error(`Add an API key for ${provider} first.`);
    const openAiStyle = provider === 'openai' || provider === 'freellm';
    const headers = openAiStyle ? { authorization: `Bearer ${key}` } : { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    const endpoint = openAiStyle ? `${config.baseUrl.replace(/\/$/, '')}/models` : new URL('/v1/models', config.baseUrl);
    const response = await fetchImpl(endpoint, { headers, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`${provider} returned ${response.status}.`);
    const data = await response.json();
    return (data.data || []).map(item => item.id).sort();
  }

  async function testProvider(provider) {
    if (provider === 'ollama') return await listModels(provider);
    const models = await listModels(provider);
    return models.slice(0, 30);
  }

  return { providerConfig, callModel, listModels, testProvider };
}

module.exports = { createModelClient };
