const { PROVIDERS, DEFAULT_PROVIDERS } = require('./constants');
const { streamProvider, pingProvider } = require('./providers');

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
    if (!PROVIDERS.includes(provider)) throw new Error('Unknown model provider.');
    const config = getProviders()[provider] || DEFAULT_PROVIDERS[provider];
    const key = provider === 'ollama' ? '' : getCredential(provider);
    if (provider !== 'ollama' && !key) throw new Error(`Add an API key for ${provider} first.`);
    const result = await pingProvider(provider, { config, key, fetchImpl, timeoutMs: 10000 });
    if (!result.ok) throw new Error(result.error || `${provider} returned ${result.status}.`);
    return result.models.sort();
  }

  async function testProvider(provider) {
    const models = await listModels(provider);
    return provider === 'ollama' ? models : models.slice(0, 30);
  }

  // Reachability probe for Settings; does not require a key so a router that is
  // up but not yet configured still reports as reachable.
  async function ping(provider) {
    if (!PROVIDERS.includes(provider)) throw new Error('Unknown model provider.');
    const config = getProviders()[provider] || DEFAULT_PROVIDERS[provider];
    const key = provider === 'ollama' ? '' : getCredential(provider);
    return await pingProvider(provider, { config, key, fetchImpl, timeoutMs: 8000 });
  }

  return { providerConfig, callModel, listModels, testProvider, ping };
}

module.exports = { createModelClient };
