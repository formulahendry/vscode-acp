const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const process = require('node:process');

const ACP_PROTOCOL_VERSION = Number(process.env.ACP_RESEARCH_ACP_PROTOCOL_VERSION || '1');
const TOOL_NAME = process.env.ACP_RESEARCH_TOOL_NAME || 'call_research_subagent';
const TOOL_VERSION = process.env.ACP_RESEARCH_TOOL_VERSION || '0.1.0';
const RESEARCH_AGENT_NAME = process.env.ACP_RESEARCH_AGENT_NAME || '';
const RESEARCH_AGENT_COMMAND = process.env.ACP_RESEARCH_AGENT_COMMAND || '';
const RESEARCH_AGENT_ARGS = parseJson(process.env.ACP_RESEARCH_AGENT_ARGS_JSON, []);
const RESEARCH_AGENT_ENV = parseJson(process.env.ACP_RESEARCH_AGENT_ENV_JSON, {});
const SESSION_CWD = process.env.ACP_RESEARCH_SESSION_CWD || process.cwd();
const CONFIG_ERROR = process.env.ACP_RESEARCH_CONFIG_ERROR || '';
const TIMEOUT_MS = Number(process.env.ACP_RESEARCH_TIMEOUT_MS || '120000');
const DOCKER_ENABLED = process.env.ACP_DOCKER_ENABLED === 'true';
const DOCKER_CONTAINER = process.env.ACP_DOCKER_CONTAINER || '';
const DOCKER_ERROR_WINDOWS = 'ACP Docker mode is not supported on Windows.';
const DOCKER_ERROR_MISSING_CONTAINER = 'ACP Docker mode is enabled but no container name or ID is configured.';
// The sub-agent must write a single JSON object as the final output line.

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
}

function toolSchema() {
  return {
    name: TOOL_NAME,
    description: 'Delegate a focused research task to a hidden ACP sub-agent.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The exact topic or question to investigate.',
        },
        depth: {
          type: 'string',
          enum: ['quick', 'thorough'],
          description: 'Research depth. Defaults to quick.',
        },
      },
      required: ['query'],
    },
    annotations: {
      title: 'Research sub-agent',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  };
}

function buildPrompt(query, depth) {
  const detail = depth === 'thorough'
    ? 'Return a thorough research brief with key findings, tradeoffs, and any relevant file references.'
    : 'Return a concise research brief with the most important findings only.';
  return [
    'You are a specialized research sub-agent assisting a parent coding agent.',
    'Work statelessly. Do not assume any prior conversation history.',
    'Do not modify files.',
    'Your final answer MUST be a single JSON object on its own line, and nothing else should follow that line.',
    'The JSON object must be exactly: {"summary": "<concise textual summary>"}',
    'Do NOT include any explanatory text, commentary, or extra newlines after the JSON object.',
    'You may think or report progress before the final JSON line, but the final line must contain only the JSON object intended for the parent agent.',
    'FINAL_BLOCK_START',
    '<final research brief>',
    'FINAL_BLOCK_END',
    'You may think or report progress before the final block, but the final block must contain only the answer intended for the parent agent.',
    '',
    'Research request:',
    query,
  ].join('\n');
}

function extractFinalSummary(transcript) {
  if (!transcript) return null;
  const lines = transcript.split(/\r?\n/).map(l => l.trim()).filter(() => true);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    if (!line.startsWith('{') || !line.endsWith('}')) return null;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.summary === 'string' && obj.summary.trim()) {
        return obj.summary.trim();
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

function makeToolError(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

async function readTextFile(params) {
  const filePath = resolvePath(params.path);
  const raw = await fs.readFile(filePath, 'utf8');
  let content = raw;
  if ((params.line !== undefined && params.line !== null) || (params.limit !== undefined && params.limit !== null)) {
    const lines = content.split('\n');
    const startLine = Math.max((params.line || 1) - 1, 0);
    const endLine = params.limit ? startLine + params.limit : lines.length;
    content = lines.slice(startLine, endLine).join('\n');
  }
  return { content };
}

function resolvePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('A valid path is required.');
  }
  return path.isAbsolute(filePath) ? filePath : path.resolve(SESSION_CWD, filePath);
}

function createAcpClient(child) {
  let nextId = 1;
  let nextTerminalId = 1;
  let buffered = '';
  let stderr = '';
  let assistantText = '';
  const pending = new Map();
  const terminals = new Map();

  const rejectAllPending = (error) => {
    for (const { reject } of pending.values()) {
      reject(error);
    }
    pending.clear();
  };

  const handleResponse = (message) => {
    const pendingRequest = pending.get(message.id);
    if (!pendingRequest) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message || 'ACP request failed');
      error.code = message.error.code;
      pendingRequest.reject(error);
      return;
    }
    pendingRequest.resolve(message.result);
  };

  const handleNotification = (message) => {
    if (message.method !== 'session/update') {
      return;
    }
    const update = message.params && message.params.update;
    if (update && update.sessionUpdate === 'agent_message_chunk' && update.content && update.content.type === 'text') {
      assistantText += update.content.text;
    }
  };

  const appendTerminalOutput = (terminal, text) => {
    terminal.output += text;
    const byteLength = Buffer.byteLength(terminal.output, 'utf8');
    if (byteLength <= terminal.outputByteLimit) {
      return;
    }
    const excess = byteLength - terminal.outputByteLimit;
    let cutPoint = 0;
    let bytes = 0;
    for (let index = 0; index < terminal.output.length; index += 1) {
      bytes += Buffer.byteLength(terminal.output[index], 'utf8');
      if (bytes >= excess) {
        cutPoint = index + 1;
        break;
      }
    }
    terminal.output = terminal.output.substring(cutPoint);
    terminal.truncated = true;
  };

  const finalizeTerminal = (terminal, code, signal) => {
    if (terminal.exited) {
      return;
    }
    terminal.exitCode = code;
    terminal.signal = signal;
    terminal.exited = true;
    terminal.resolveExit();
  };

  const getTerminal = (terminalId) => {
    const terminal = terminals.get(terminalId);
    if (!terminal) {
      throw new Error('Terminal not found: ' + terminalId);
    }
    return terminal;
  };

  const createTerminal = (params) => {
    if (!params || typeof params.command !== 'string' || !params.command.trim()) {
      throw new Error('terminal/create requires a command.');
    }
    const terminalId = 'term_' + nextTerminalId++;
    const outputByteLimit = typeof params.outputByteLimit === 'number' && params.outputByteLimit > 0 ? params.outputByteLimit : 1024 * 1024;
    const env = { ...process.env };
    if (Array.isArray(params.env)) {
      for (const entry of params.env) {
        if (entry && typeof entry.name === 'string') {
          env[entry.name] = String(entry.value ?? '');
        }
      }
    }
    const childProcess = spawn(params.command, Array.isArray(params.args) ? params.args : [], {
      cwd: params.cwd ? resolvePath(params.cwd) : SESSION_CWD,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let resolveExit = () => {};
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const terminal = {
      id: terminalId,
      process: childProcess,
      output: '',
      truncated: false,
      outputByteLimit,
      exitCode: null,
      signal: null,
      exited: false,
      exitPromise,
      resolveExit,
    };
    terminals.set(terminalId, terminal);
    childProcess.stdout.on('data', (chunk) => {
      appendTerminalOutput(terminal, chunk.toString('utf8'));
    });
    childProcess.stderr.on('data', (chunk) => {
      appendTerminalOutput(terminal, chunk.toString('utf8'));
    });
    childProcess.on('close', (code, signal) => {
      finalizeTerminal(terminal, code ?? null, signal ?? null);
    });
    childProcess.on('error', (error) => {
      appendTerminalOutput(terminal, 'Failed to start command: ' + (error instanceof Error ? error.message : String(error)) + '\n');
      finalizeTerminal(terminal, 1, null);
    });
    return { terminalId };
  };

  const terminalOutput = (params) => {
    const terminal = getTerminal(params.terminalId);
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      exitStatus: terminal.exited ? { exitCode: terminal.exitCode, signal: terminal.signal } : null,
    };
  };

  const waitForTerminalExit = async (params) => {
    const terminal = getTerminal(params.terminalId);
    await terminal.exitPromise;
    return { exitCode: terminal.exitCode, signal: terminal.signal };
  };

  const killTerminal = async (params) => {
    const terminal = getTerminal(params.terminalId);
    if (!terminal.exited) {
      terminal.process.kill('SIGTERM');
    }
    return {};
  };

  const releaseTerminal = async (params) => {
    const terminal = getTerminal(params.terminalId);
    if (!terminal.exited) {
      terminal.process.kill('SIGTERM');
      await terminal.exitPromise;
    }
    terminals.delete(params.terminalId);
    return {};
  };

  const handleRequest = async (message) => {
    try {
      switch (message.method) {
        case 'session/request_permission': {
          const option = message.params && Array.isArray(message.params.options) ? message.params.options[0] : null;
          if (!option) {
            sendToAgent({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } });
            return;
          }
          sendToAgent({
            jsonrpc: '2.0',
            id: message.id,
            result: { outcome: { outcome: 'selected', optionId: option.optionId } },
          });
          return;
        }
        case 'fs/read_text_file':
          sendToAgent({ jsonrpc: '2.0', id: message.id, result: await readTextFile(message.params || {}) });
          return;
        case 'fs/write_text_file':
          sendToAgent({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32000, message: 'Research sub-agent is read-only.' },
          });
          return;
        case 'terminal/create':
          sendToAgent({ jsonrpc: '2.0', id: message.id, result: createTerminal(message.params || {}) });
          return;
        case 'terminal/output':
          sendToAgent({ jsonrpc: '2.0', id: message.id, result: terminalOutput(message.params || {}) });
          return;
        case 'terminal/wait_for_exit':
          sendToAgent({ jsonrpc: '2.0', id: message.id, result: await waitForTerminalExit(message.params || {}) });
          return;
        case 'terminal/kill':
          sendToAgent({ jsonrpc: '2.0', id: message.id, result: await killTerminal(message.params || {}) });
          return;
        case 'terminal/release':
          sendToAgent({ jsonrpc: '2.0', id: message.id, result: await releaseTerminal(message.params || {}) });
          return;
        default:
          sendToAgent({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Unsupported ACP client method: ' + message.method },
          });
      }
    } catch (error) {
      sendToAgent({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      });
    }
  };

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
      return;
    }
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (message.id !== undefined && !message.method) {
      handleResponse(message);
      return;
    }
    if (message.method && message.id !== undefined) {
      void handleRequest(message);
      return;
    }
    if (message.method) {
      handleNotification(message);
    }
  };

  const sendToAgent = (message) => {
    child.stdin.write(JSON.stringify(message) + '\n');
  };

  child.stdout.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() || '';
    for (const line of lines) {
      handleLine(line);
    }
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  child.on('error', (error) => {
    rejectAllPending(error instanceof Error ? error : new Error(String(error)));
  });

  child.on('close', (code) => {
    if (buffered.trim()) {
      handleLine(buffered);
      buffered = '';
    }
    for (const terminal of terminals.values()) {
      if (!terminal.exited) {
        terminal.process.kill('SIGTERM');
        finalizeTerminal(terminal, terminal.exitCode, terminal.signal);
      }
    }
    if (pending.size > 0) {
      rejectAllPending(new Error('ACP sub-agent exited early with code ' + code + '. ' + stderr.trim()));
    }
  });

  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        sendToAgent({ jsonrpc: '2.0', id, method, params });
      });
    },
    getAssistantText() {
      return assistantText.trim();
    },
    getStderr() {
      return stderr.trim();
    },
    async cleanup() {
      for (const terminal of terminals.values()) {
        if (!terminal.exited) {
          terminal.process.kill('SIGTERM');
          await terminal.exitPromise.catch(() => undefined);
        }
      }
    },
  };
}

function pickModelId(models, depth) {
  if (depth !== 'quick' || !models || !Array.isArray(models.availableModels)) {
    return null;
  }
  const modelIds = models.availableModels
    .map((entry) => entry && typeof entry.modelId === 'string' ? entry.modelId : null)
    .filter(Boolean);
  return modelIds.find((modelId) => /mini\/(low|medium)$/.test(modelId))
    || modelIds.find((modelId) => /\/(low|medium)$/.test(modelId))
    || modelIds.find((modelId) => /mini/.test(modelId))
    || null;
}

function buildResearchAgentLaunchSpec() {
  const args = Array.isArray(RESEARCH_AGENT_ARGS) ? RESEARCH_AGENT_ARGS : [];
  const env = { ...RESEARCH_AGENT_ENV };
  if (DOCKER_ENABLED) {
    if (process.platform === 'win32') {
      throw new Error(DOCKER_ERROR_WINDOWS);
    }
    const container = DOCKER_CONTAINER.trim();
    if (!container) {
      throw new Error(DOCKER_ERROR_MISSING_CONTAINER);
    }
    const dockerArgs = ['exec', '-i'];
    if (SESSION_CWD) {
      dockerArgs.push('-w', SESSION_CWD);
    }
    for (const [key, value] of Object.entries(env)) {
      dockerArgs.push('-e', key + '=' + (value ?? ''));
    }
    dockerArgs.push(container, RESEARCH_AGENT_COMMAND, ...args);
    return {
      file: 'docker',
      args: dockerArgs,
      env: { ...process.env },
    };
  }
  return {
    file: RESEARCH_AGENT_COMMAND,
    args,
    env: { ...process.env, ...env },
    cwd: SESSION_CWD,
  };
}

async function runResearchSubagent(query, depth, progressCallback) {
  if (CONFIG_ERROR) {
    throw new Error(CONFIG_ERROR);
  }
  if (!RESEARCH_AGENT_COMMAND) {
    throw new Error('Research sub-agent command is not configured.');
  }

  const launchSpec = buildResearchAgentLaunchSpec();
  const child = spawn(launchSpec.file, launchSpec.args, {
    ...(launchSpec.cwd ? { cwd: launchSpec.cwd } : {}),
    env: launchSpec.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const client = createAcpClient(child);

  let heartbeatTimer;
  if (typeof progressCallback === 'function') {
    // send progress every 10s
    heartbeatTimer = setInterval(() => {
      try {
        progressCallback(client);
      } catch {
        // ignore progress failures
      }
    }, 10000);
  }

  const run = (async () => {
    await client.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: { name: 'acp-research-subagent', version: TOOL_VERSION },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: false },
        terminal: true,
      },
    });
    const session = await client.request('session/new', { cwd: SESSION_CWD, mcpServers: [] });
    const modelId = pickModelId(session.models, depth);
    if (modelId && session.models && session.models.currentModelId !== modelId) {
      try {
        await client.request('session/set_model', { sessionId: session.sessionId, modelId });
      } catch {}
    }
    await client.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: buildPrompt(query, depth) }],
      _meta: { parentTool: TOOL_NAME },
    });
    const transcript = client.getAssistantText();
    const summary = extractFinalSummary(transcript) || transcript;
    if (!summary) {
      const stderr = client.getStderr();
      throw new Error(stderr || 'Research sub-agent returned no text.');
    }
    child.kill('SIGTERM');
    return { summary, raw: transcript };
  })();

  // Fire before the MCP client's ~60 s request timeout so we can return a
  // useful result (partial transcript) instead of a protocol-level error.
  const timeout = new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const partial = client.getAssistantText().trim();
      resolve({ timedOut: true, partial });
    }, TIMEOUT_MS);
    child.on('close', () => clearTimeout(timer));
  });

  // Prevent unhandled rejection from `run` if timeout wins the race.
  run.catch(() => undefined);

  try {
    const winner = await Promise.race([run, timeout]);
    if (winner.timedOut) {
      if (winner.partial) {
        return { summary: winner.partial + '\n[Réponse incomplète — délai dépassé]', raw: winner.partial };
      }
      throw new Error('Research sub-agent timed out after ' + TIMEOUT_MS + 'ms without producing a response.');
    }
    return winner;
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    await client.cleanup().catch(() => undefined);
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
}

async function handleToolCall(params) {
  const name = params && params.name;
  if (name !== TOOL_NAME) {
    return makeToolError('Unknown tool: ' + String(name));
  }
  const args = params && params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const depth = args.depth === 'thorough' ? 'thorough' : 'quick';
  if (!query) {
    return makeToolError('call_research_subagent requires a non-empty query.');
  }
  try {
    // progressCallback will send periodic `tools/call_update` notifications
    const toolCallId = params && params.toolCallId ? params.toolCallId : undefined;
    const rawInput = params && params.rawInput ? params.rawInput : (params && params.arguments ? params.arguments : {});

    const progressCallback = (client) => {
      try {
        const partial = client.getAssistantText().trim();
        send({
          jsonrpc: '2.0',
          method: 'tools/call_update',
          params: {
            kind: 'other',
            rawInput,
            rawOutput: { output: partial || '[working]' },
            status: 'in_progress',
            title: 'acp-research-subagent_call_research_subagent',
            toolCallId,
          },
        });
      } catch {
        // ignore
      }
    };

    const result = await runResearchSubagent(query, depth, progressCallback);
    return {
      content: [{ type: 'text', text: result.summary }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return makeToolError('Research sub-agent failed: ' + message);
  }
}

async function handleRequest(message) {
  switch (message.method) {
    case 'initialize':
      sendResult(message.id, {
        protocolVersion: (message.params && message.params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'acp-research-subagent', version: TOOL_VERSION },
      });
      return;
    case 'tools/list':
      sendResult(message.id, { tools: [toolSchema()] });
      return;
    case 'tools/call':
      sendResult(message.id, await handleToolCall(message.params || {}));
      return;
    case 'ping':
      sendResult(message.id, {});
      return;
    default:
      sendError(message.id, -32601, 'Method not found: ' + message.method);
  }
}

process.stdin.setEncoding('utf8');
let inputBuffer = '';
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  const lines = inputBuffer.split(/\r?\n/);
  inputBuffer = lines.pop() || '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!message || typeof message !== 'object' || !message.method) {
      continue;
    }
    if (message.id === undefined) {
      continue;
    }
    void handleRequest(message);
  }
});
