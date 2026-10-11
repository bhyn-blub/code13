const { PROVIDERS } = require('./constants');

const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

// Turn low-level network failures into text a user can act on.
function friendlyError(provider, baseUrl, error) {
  const code = error?.cause?.code || error?.code || '';
  const message = String(error?.message || '');
  const connection = CONNECTION_CODES.has(code) || /fetch failed|ECONNREFUSED|ENOTFOUND|socket hang up|network error|timed? ?out|aborted/i.test(message);
  if (!connection) return message;
  const target = baseUrl || 'the configured address';
  if (provider === 'freellm') return `FreeLLMAPI router not reachable at ${target}. Start the FreeLLMAPI app and confirm the API base URL in Settings (default http://localhost:3001/v1).`;
  if (provider === 'ollama') return `Ollama not reachable at ${target}. Start Ollama and confirm the address in Settings (default http://localhost:11434).`;
  return `${provider} not reachable at ${target}. Check your connection and the API base URL in Settings.`;
}

// Explain common HTTP failures without leaking response bodies.
function statusHint(provider, status) {
  if (status === 401 || status === 403) {
    return provider === 'freellm'
      ? 'The unified key was rejected. Copy a fresh key from the FreeLLMAPI dashboard.'
      : 'The API key was rejected. Check the key in Settings.';
  }
  if (status === 404) return 'That model may not exist. Click "Load models" and pick one from the list.';
  if (status === 429) return provider === 'freellm' ? 'FreeLLMAPI is rate-limited right now; try again or reorder its fallback chain.' : 'The provider is rate-limited. Try again shortly.';
  if (status >= 500 && provider === 'freellm') return 'FreeLLMAPI could not reach any upstream provider. Check the keys and fallback chain in its dashboard.';
  return '';
}

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
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      const hint = statusHint(provider, response.status);
      throw new Error(`${provider} returned ${response.status}${hint ? ` — ${hint}` : ''}${detail ? ` (${detail})` : ''}`);
    }
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
    throw new Error(friendlyError(provider, config.baseUrl, error));
  } finally {
    clearTimeout(timeout);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

// Lightweight reachability probe used by Settings (no task context is sent).
async function pingProvider(provider, options = {}) {
  const { config = {}, key = '', fetchImpl = fetch, timeoutMs = 8000 } = options;
  if (!PROVIDERS.includes(provider)) throw new Error('Unknown model provider.');
  const headers = {};
  let url;
  if (provider === 'ollama') {
    url = new URL('/api/tags', config.baseUrl).toString();
  } else if (provider === 'openai' || provider === 'freellm') {
    url = `${config.baseUrl.replace(/\/$/, '')}/models`;
    headers.authorization = `Bearer ${key}`;
  } else {
    url = new URL('/v1/models', config.baseUrl).toString();
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  }
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      const hint = statusHint(provider, response.status);
      return { reachable: true, ok: false, status: response.status, models: [], error: `${provider} returned ${response.status}${hint ? ` — ${hint}` : ''}` };
    }
    const data = await response.json().catch(() => ({}));
    const models = (data.models || data.data || []).map(item => item.name || item.id).filter(Boolean);
    return { reachable: true, ok: true, status: response.status, models };
  } catch (error) {
    return { reachable: false, ok: false, status: 0, models: [], error: friendlyError(provider, config.baseUrl, error) };
  }
}

module.exports = { streamProvider, pingProvider, friendlyError, statusHint };
