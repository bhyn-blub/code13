const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateTokens, compactMessages } = require('../src/lib/context');

test('estimateTokens approximates from characters', () => {
  assert.equal(estimateTokens([{ role: 'user', content: 'abcd' }]), 1);
  assert.equal(estimateTokens([{ role: 'user', content: 'a'.repeat(400) }]), 100);
  assert.equal(estimateTokens([]), 0);
});

test('compactMessages leaves a short run untouched', () => {
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'task' }, { role: 'assistant', content: 'hi' }];
  const result = compactMessages(messages, { maxTokens: 8000 });
  assert.equal(result.compacted, false);
  assert.equal(result.messages, messages);
});

test('compactMessages digests the middle and keeps the head and tail', () => {
  const messages = [{ role: 'system', content: 'S'.repeat(100) }, { role: 'user', content: 'T'.repeat(100) }];
  for (let i = 0; i < 20; i++) messages.push({ role: i % 2 ? 'user' : 'assistant', content: `step-${i}-${'x'.repeat(200)}` });
  const result = compactMessages(messages, { maxTokens: 500, keepTail: 4 });
  assert.equal(result.compacted, true);
  assert.equal(result.messages[0].content.startsWith('S'), true, 'system prompt is preserved');
  assert.equal(result.messages[1].content.startsWith('T'), true, 'original task is preserved');
  assert.match(result.messages[2].content, /Earlier steps were summarized/, 'a digest replaces the old turns');
  assert.equal(result.messages.at(-1).content, `step-19-${'x'.repeat(200)}`, 'the newest turn is preserved');
  assert.ok(result.messages.length < messages.length, 'the run is shorter after compaction');
});
