const { PROVIDERS } = require('./constants');

async function streamProvider(provider, messages, options = {}) {
  const { config = {}, key = '', onChunk, timeoutMs = 120000, fetchImpl = fetch, signal: externalSignal } = options;
  if (!PROVIDERS.includes(provider)) throw new Error('Unknown model provider.');
  if (!config.model) throw new Error(`Choose a model for ${provider}.`);
  if (provider !== 'ollama' && !key) throw new Error(`Add an API key for ${provider} in Settings.`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const headers = { 'content-type': 'application/json' };
  let url;
  let body;
  if (provider === 'ollama') {
    url = new URL('/api/chat', config.baseUrl).toString();
    body = { model: config.model, messages, stream: true };
  } else if (provider === 'openai' || provider === 'freellm') {
    url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    headers.authorization = `Bearer ${key}`;
    body = { model: config.model, messages, stream: true };
  } else {
    url = new URL('/v1/messages', config.baseUrl).toString();
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    const system = messages.filter(item => item.role === 'system').map(item => item.content).join('\n\n');
    body = { model: config.model, max_tokens: 1800, system, messages: messages.filter(item => item.role !== 'system'), stream: true };
  }
  try {
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) throw new Error(`${provider} returned ${response.status}: ${(await response.text()).slice(0, 400)}`);
    if (!response.body) throw new Error(`${provider} did not return a response stream.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let whole = '';
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      if (done && buffer.trim()) { lines.push(buffer); buffer = ''; }
      for (const line of lines) {
        let chunk = '';
        if (provider === 'ollama') {
          try { chunk = JSON.parse(line).message?.content || ''; } catch { /* keep reading partial/heartbeat line */ }
        } else if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data !== '[DONE]') {
            try {
              const parsed = JSON.parse(data);
              chunk = (provider === 'openai' || provider === 'freellm') ? parsed.choices?.[0]?.delta?.content || '' : parsed.delta?.text || '';
            } catch { /* non-content event */ }
          }
        }
        if (chunk) { whole += chunk; if (onChunk) onChunk(chunk); }
      }
      if (done) break;
    }
    return whole;
  } catch (error) {
    if (error.name === 'AbortError') {
      if (externalSignal?.aborted) throw new Error(`${provider} request cancelled.`);
      throw new Error(`${provider} request timed out.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

module.exports = { streamProvider };
