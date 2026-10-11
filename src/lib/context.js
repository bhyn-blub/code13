// Context management for long agent runs.
//
// Token counts are a heuristic (roughly four characters per token) because the
// app talks to many providers with different tokenizers. Compaction keeps the
// system prompt and the original task, drops the oldest tool turns into a short
// digest, and preserves the most recent turns so the model still sees its
// immediate work.
function estimateTokens(messages) {
  return Math.ceil((messages || []).reduce((sum, message) => sum + String(message?.content || '').length, 0) / 4);
}

function compactMessages(messages, options = {}) {
  const maxTokens = Number(options.maxTokens) > 0 ? Number(options.maxTokens) : 8000;
  const keepTail = Number(options.keepTail) > 0 ? Math.floor(options.keepTail) : 6;
  const tokens = estimateTokens(messages);
  if (tokens <= maxTokens || messages.length <= keepTail + 2) return { messages, compacted: false, tokens };
  const head = messages.slice(0, 2);
  const tail = messages.slice(-keepTail);
  const middle = messages.slice(2, messages.length - keepTail);
  const digest = middle
    .map(message => `${message.role}: ${String(message.content).replace(/\s+/g, ' ').slice(0, 160)}`)
    .join('\n');
  const note = { role: 'user', content: `[Earlier steps were summarized to save context]\n${digest}` };
  return { messages: [...head, note, ...tail], compacted: true, tokens };
}

module.exports = { estimateTokens, compactMessages };
