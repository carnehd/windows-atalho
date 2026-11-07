// Pull requests through the GitHub MCP server of an agent's command line, in place of a token kept in the app. For now
// Claude CLI: the server is the user's own, named "github" (added once with `claude mcp add`, with its own way in), and
// the app never sees its token. The agent is started with that one tool of that one server allowed, no tool of its own,
// and asked to call it once. The app takes the answer as the server gave it, from the agent's stream, and stops the
// agent there: the list is not what a model wrote, and nothing in a pull request's text reaches a model that can act on it.
const { spawn } = require('child_process');
const os = require('os');
const shell = require('./shell');

const MCP_SERVER = 'github';
const MCP_TOOL = `mcp__${MCP_SERVER}__list_pull_requests`;
const MCP_TIMEOUT_MS = 180 * 1000;
// Only the tools that read pull requests: the server itself takes nothing else at this address
const MCP_READONLY_URL = 'https://api.githubcopilot.com/mcp/x/pull_requests/readonly';
const MCP_ADD = `claude mcp add --transport http ${MCP_SERVER} ${MCP_READONLY_URL} -H "Authorization: Bearer YOUR_GITHUB_TOKEN" --scope user`;

// The list in the answer of the tool: an array, or the array inside an object.
function pullsInAnswer(text) {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (Array.isArray(data)) return data;
  for (const key of ['pull_requests', 'pullRequests', 'items']) if (data && Array.isArray(data[key])) return data[key];
  return null;
}

const resultText = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('') : '');

// Starts the agent and resolves { pulls } (as the server gave them) or rejects { code, error }. extraArgs: for the checks.
function listByClaude({ file, env, owner, repo, state, page, perPage, extraArgs = [], onStart = () => {} }) {
  return new Promise((resolve, reject) => {
    const input = { owner, repo, state, sort: 'updated', direction: 'desc', perPage, page };
    const prompt = `Call the tool ${MCP_TOOL} exactly once, with exactly these arguments, and do nothing else: ${JSON.stringify(input)}`;
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku',
      // that one tool and nothing else; what is not allowed is refused, nothing is asked
      '--permission-mode', 'dontAsk', '--tools', '', '--allowedTools', MCP_TOOL,
      '--setting-sources', 'user', '--disable-slash-commands', '--no-session-persistence',
      ...extraArgs,
    ];
    let child;
    try {
      // a folder of no repository: nothing of one is read, and the server is the user's own
      // the wait, up to 30 s: on its own it goes on without a server still connecting, and then there is no tool to call
      child = spawn(file, args, { cwd: os.tmpdir(), env: { ...env, MAX_MCP_OUTPUT_TOKENS: '100000', MCP_CONNECTION_NONBLOCKING: 'false', MCP_CONNECT_TIMEOUT_MS: '30000' }, windowsHide: true, detached: !shell.IS_WIN, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject({ code: 'start', error: `Claude CLI could not start: ${e.message}` });
      return;
    }
    const stop = () => shell.killTree(child);
    onStart(stop);
    let finished = false;
    let buffer = '';
    let errors = '';
    let callId = '';
    let said = '';
    const end = (settle, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stop();
      settle(value);
    };
    const timer = setTimeout(() => end(reject, { code: 'timeout', error: `Claude CLI gave no answer in ${MCP_TIMEOUT_MS / 1000} seconds, so it was stopped.` }), MCP_TIMEOUT_MS);
    const take = (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === 'system' && event.subtype === 'init' && Array.isArray(event.mcp_servers)) {
        const server = event.mcp_servers.find((s) => s && s.name === MCP_SERVER);
        if (!server) end(reject, { code: 'no-mcp', error: `Claude CLI has no MCP server called ${MCP_SERVER} on this computer.`, add: MCP_ADD });
        else if (/failed|needs-auth|pending/i.test(String(server.status))) end(reject, { code: 'mcp-down', error: `Claude CLI could not connect to its MCP server ${MCP_SERVER} (${server.status}). See it with: claude mcp list` });
        return;
      }
      const content = event.message && Array.isArray(event.message.content) ? event.message.content : [];
      if (event.type === 'assistant') {
        for (const block of content) {
          if (block.type === 'tool_use' && block.name === MCP_TOOL) callId = block.id;
          else if (block.type === 'text' && block.text) said = block.text;
        }
        return;
      }
      if (event.type === 'user') {
        const answer = content.find((b) => b.type === 'tool_result' && b.tool_use_id === callId && callId);
        if (!answer) return;
        const text = resultText(answer.content);
        if (answer.is_error) {
          end(reject, { code: 'mcp-answer', error: `GitHub answered through the MCP server: ${text.trim().slice(0, 400) || 'an error, with no text'}` });
          return;
        }
        const pulls = pullsInAnswer(text);
        if (pulls) end(resolve, { pulls });
        else end(reject, { code: 'mcp-answer', error: `The MCP server answered something that is not a list of pull requests: ${text.trim().slice(0, 300)}` });
        return;
      }
      if (event.type === 'result') {
        const text = String(event.result || said || '');
        if (/not logged in|\/login/i.test(text)) end(reject, { code: 'login', error: 'Claude CLI is not signed in on this computer. Open a terminal, run "claude", type /login and follow it; then try again.' });
        else end(reject, { code: 'mcp-answer', error: `Claude CLI did not call the MCP server. It said: ${text.trim().slice(0, 400) || 'nothing'}` });
      }
    };
    child.stdout.on('data', (d) => {
      buffer += d;
      let at;
      while (!finished && (at = buffer.indexOf('\n')) >= 0) {
        take(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
      }
    });
    child.stderr.on('data', (d) => (errors = (errors + d).slice(-2000)));
    child.on('error', (e) => end(reject, { code: 'start', error: `Claude CLI could not start: ${e.message}` }));
    child.on('close', (code) => {
      if (buffer.trim()) take(buffer);
      end(reject, { code: 'failed', error: `Claude CLI ended without an answer${code ? ` (exit ${code})` : ''}${errors.trim() ? `: ${errors.trim().split('\n').pop().slice(0, 300)}` : '.'}` });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

module.exports = { listByClaude, pullsInAnswer, MCP_ADD, MCP_READONLY_URL, MCP_SERVER, MCP_TOOL };
