const KNOWN_TOOL_NAMES = ['create_ticket', 'update_ticket', 'assign_ticket', 'ask_user', 'list_files', 'read_file', 'git_status', 'git_diff', 'write_file', 'run_shell'];

function tryParseJson(value) { try { return JSON.parse(value); } catch { return null; } }

function firstJsonObject(text) {
  const source = String(text);
  for (let start = 0; start < source.length; start++) {
    if (source[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index++) {
      const ch = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return source.slice(start, index + 1); }
    }
  }
  return '';
}

function parseJson(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return tryParseJson(cleaned) || tryParseJson(firstJsonObject(cleaned));
}

function normalizeToolCall(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.type === 'tool' && typeof parsed.name === 'string') return { name: parsed.name, arguments: parsed.arguments || parsed.args || {} };
  if (typeof parsed.name === 'string' && KNOWN_TOOL_NAMES.includes(parsed.name)) return { name: parsed.name, arguments: parsed.arguments || parsed.args || {} };
  if (typeof parsed.tool === 'string' && KNOWN_TOOL_NAMES.includes(parsed.tool)) return { name: parsed.tool, arguments: parsed.arguments || parsed.args || {} };
  if (typeof parsed.tool_name === 'string' && KNOWN_TOOL_NAMES.includes(parsed.tool_name)) return { name: parsed.tool_name, arguments: parsed.arguments || parsed.args || {} };
  if (typeof parsed.type === 'string' && KNOWN_TOOL_NAMES.includes(parsed.type)) {
    const rest = { ...parsed };
    for (const key of ['type', 'name', 'tool', 'tool_name', 'args', 'arguments']) delete rest[key];
    return { name: parsed.type, arguments: parsed.args || parsed.arguments || rest };
  }
  return null;
}

module.exports = { parseJson, normalizeToolCall, firstJsonObject, KNOWN_TOOL_NAMES };
