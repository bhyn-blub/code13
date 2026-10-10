const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJson, normalizeToolCall } = require('../src/lib/parse');

test('parseJson handles plain JSON, fenced JSON, and surrounding prose', () => {
  assert.deepEqual(parseJson('{"type":"final","content":"hi"}'), { type: 'final', content: 'hi' });
  assert.deepEqual(parseJson('```json\n{"type":"final","content":"hi"}\n```'), { type: 'final', content: 'hi' });
  assert.deepEqual(parseJson('Sure! {"type":"final","content":"hi"} done.'), { type: 'final', content: 'hi' });
});

test('parseJson extracts the first balanced object when several are present', () => {
  const parsed = parseJson('{"type":"final","content":"done"}\n{"type":"list_files"}');
  assert.equal(parsed.type, 'final');
});

test('normalizeToolCall accepts the strict tool schema', () => {
  assert.deepEqual(normalizeToolCall({ type: 'tool', name: 'git_status', arguments: {} }), { name: 'git_status', arguments: {} });
});

test('normalizeToolCall rescues common small-model shorthand forms', () => {
  assert.deepEqual(normalizeToolCall({ type: 'git_status' }), { name: 'git_status', arguments: {} });
  assert.deepEqual(normalizeToolCall({ type: 'list_files', path: '.' }), { name: 'list_files', arguments: { path: '.' } });
  assert.deepEqual(normalizeToolCall({ tool: 'read_file', arguments: { path: 'a.txt' } }), { name: 'read_file', arguments: { path: 'a.txt' } });
  assert.deepEqual(normalizeToolCall({ tool_name: 'update_ticket', arguments: { code: 'T-1', status: 'done' } }), { name: 'update_ticket', arguments: { code: 'T-1', status: 'done' } });
});

test('normalizeToolCall rejects unknown or malformed names', () => {
  assert.equal(normalizeToolCall({ type: 'frobnicate' }), null);
  assert.equal(normalizeToolCall('nope'), null);
  assert.equal(normalizeToolCall(null), null);
});

test('normalizeToolCall keeps the strict schema name even if unknown, leaving the allow-list to enforce it', () => {
  assert.deepEqual(normalizeToolCall({ type: 'tool', name: 'not_a_tool' }), { name: 'not_a_tool', arguments: {} });
});
