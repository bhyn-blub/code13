const test = require('node:test');
const assert = require('node:assert/strict');
const { streamProvider, pingProvider } = require('../src/lib/providers');

function response(body, status = 200) { return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } }); }
function stream(text) { return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } }); }

test('Ollama NDJSON response streams and collects content', async () => {
  const chunks = [];
  const result = await streamProvider('ollama', [{ role: 'user', content: 'hi' }], { config: { baseUrl: 'http://localhost:11434', model: 'tiny' }, fetchImpl: async () => response(stream('{"message":{"content":"hello"}}\n{"done":true}\n')), onChunk: part => chunks.push(part) });
  assert.equal(result, 'hello');
  assert.deepEqual(chunks, ['hello']);
});

test('OpenAI SSE deltas stream correctly and preserve /v1 base path', async () => {
  let requestedUrl;
  const result = await streamProvider('openai', [{ role: 'user', content: 'hi' }], {
    config: { baseUrl: 'https://api.example.test/v1', model: 'model-x' }, key: 'test-key',
    fetchImpl: async url => { requestedUrl = String(url); return response(stream('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')); }
  });
  assert.equal(result, 'ok');
  assert.equal(requestedUrl, 'https://api.example.test/v1/chat/completions');
});

test('Anthropic streaming extracts text deltas and separates system prompt', async () => {
  let payload;
  const result = await streamProvider('anthropic', [{ role: 'system', content: 'system notes' }, { role: 'user', content: 'hi' }], {
    config: { baseUrl: 'https://api.anthropic.com', model: 'model-y' }, key: 'test-key',
    fetchImpl: async (_url, options) => { payload = JSON.parse(options.body); return response(stream('event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"done"}}\n\n')); }
  });
  assert.equal(result, 'done');
  assert.equal(payload.system, 'system notes');
  assert.equal(payload.messages.length, 1);
});

test('provider errors and timeouts are surfaced', async () => {
  await assert.rejects(streamProvider('ollama', [], { config: { baseUrl: 'http://localhost:11434', model: 'tiny' }, fetchImpl: async () => response(stream('offline'), 503) }), /503/);
  await assert.rejects(streamProvider('openai', [], { config: { baseUrl: 'https://example.test/v1', model: 'x' }, key: 'test', timeoutMs: 10, fetchImpl: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) }), /timed out/);
});

test('hosted calls require a credential and never include it in response data', async () => {
  await assert.rejects(streamProvider('openai', [], { config: { baseUrl: 'https://example.test/v1', model: 'x' } }), /API key/);
});

test('FreeLLM uses the OpenAI-compatible path against its local router', async () => {
  let requestedUrl;
  let authHeader;
  const result = await streamProvider('freellm', [{ role: 'user', content: 'hi' }], {
    config: { baseUrl: 'http://localhost:3001/v1', model: 'auto' }, key: 'freellm-unified-key',
    fetchImpl: async (url, options) => { requestedUrl = String(url); authHeader = options.headers.authorization; return response(stream('data: {"choices":[{"delta":{"content":"routed"}}]}\n\ndata: [DONE]\n\n')); }
  });
  assert.equal(result, 'routed');
  assert.equal(requestedUrl, 'http://localhost:3001/v1/chat/completions');
  assert.equal(authHeader, 'Bearer freellm-unified-key');
});

test('FreeLLM still requires a unified key', async () => {
  await assert.rejects(streamProvider('freellm', [], { config: { baseUrl: 'http://localhost:3001/v1', model: 'auto' } }), /API key/);
});

test('connection failures become actionable messages per provider', async () => {
  const refused = async () => { const error = new TypeError('fetch failed'); error.cause = { code: 'ECONNREFUSED' }; throw error; };
  await assert.rejects(streamProvider('freellm', [], { config: { baseUrl: 'http://localhost:3001/v1' , model: 'auto' }, key: 'k', fetchImpl: refused }), /FreeLLMAPI router not reachable/);
  await assert.rejects(streamProvider('ollama', [], { config: { baseUrl: 'http://localhost:11434', model: 'tiny' }, fetchImpl: refused }), /Ollama not reachable/);
  await assert.rejects(streamProvider('openai', [], { config: { baseUrl: 'https://api.openai.com/v1', model: 'x' }, key: 'k', fetchImpl: refused }), /openai not reachable/);
});

test('HTTP status errors carry a setup hint', async () => {
  await assert.rejects(streamProvider('freellm', [], { config: { baseUrl: 'http://localhost:3001/v1', model: 'auto' }, key: 'bad', fetchImpl: async () => response('unauthorized', 401) }), /unified key was rejected/);
  await assert.rejects(streamProvider('openai', [], { config: { baseUrl: 'https://api.openai.com/v1', model: 'x' }, key: 'bad', fetchImpl: async () => response('missing', 404) }), /Load models/);
});

test('pingProvider reports reachability and models without sending a key requirement', async () => {
  const up = await pingProvider('freellm', { config: { baseUrl: 'http://localhost:3001/v1' }, key: 'k', fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'google/gemini-2.0-flash-001:free' }] }), { status: 200, headers: { 'content-type': 'application/json' } }) });
  assert.equal(up.ok, true);
  assert.deepEqual(up.models, ['google/gemini-2.0-flash-001:free']);
});

test('pingProvider reports a down router with a friendly message', async () => {
  const refused = async () => { const error = new TypeError('fetch failed'); error.cause = { code: 'ECONNREFUSED' }; throw error; };
  const down = await pingProvider('freellm', { config: { baseUrl: 'http://localhost:3001/v1' }, key: 'k', fetchImpl: refused });
  assert.equal(down.reachable, false);
  assert.match(down.error, /FreeLLMAPI router not reachable/);
});
