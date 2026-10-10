const { COORD_TOOLS, PROJECT_TOOLS } = require('./constants');

function toolInstructions(allowedTools, scheduled) {
  const tools = allowedTools.filter(name => PROJECT_TOOLS.includes(name));
  const coord = scheduled ? ['update_ticket', 'ask_user'] : [...COORD_TOOLS];
  return `You are an agent in Code 13. Work only inside the selected workspace. Follow these role instructions: {{ROLE}}.
You can make one tool request at a time. Output EXACTLY one JSON object and nothing else:
For a tool: {"type":"tool","name":"...","arguments":{...}}
For a final report: {"type":"final","content":"..."}
Project tools allowed for you: ${tools.join(', ') || 'none'}.
Coordination tools allowed for you: ${coord.join(', ')}. These manage the shared ticket board rather than the workspace.
File paths are workspace-relative. Never encode secrets. Do not claim a tool ran unless Code 13 returned its result. ${scheduled ? 'This is a scheduled check: prefer read-only tools and do not request changes unless genuinely necessary; requests needing approval will be queued.' : ''}
Arguments: list_files {"path":"."}; read_file {"path":"relative/path"}; git_status {}; git_diff {"path":"optional relative/path"}; write_file {"path":"relative/path","content":"complete new file content"}; run_shell {"command":"exact command"}; create_ticket {"title":"short title","assignTo":"agent id or name (optional)","notes":"optional"}; update_ticket {"code":"T-1","status":"todo|doing|done|blocked","notes":"optional"}; assign_ticket {"code":"T-1","to":"agent id or name","note":"optional reason"}; ask_user {"question":"exact question for a human"}.
Mark your ticket done with update_ticket when your work is complete. Use assign_ticket to hand unfinished work to the right agent, and ask_user only when you genuinely need a human decision.`;
}

module.exports = { toolInstructions };
