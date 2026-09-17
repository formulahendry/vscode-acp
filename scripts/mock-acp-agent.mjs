#!/usr/bin/env node
// Minimal mock ACP agent used to exercise the chat UI without a real agent.
// Speaks newline-delimited JSON-RPC 2.0 over stdio.
//
// Register it in settings.json, for example:
//   "acp.agents": {
//     "Mock ACP": { "command": "node", "args": ["<repo>/scripts/mock-acp-agent.mjs"] }
//   }
import readline from 'node:readline';

const SESSION_ID = 's-1';
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function notify(update) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION_ID, update } });
}

function textBlock(text) {
  return { type: 'content', content: { type: 'text', text } };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPrompt(id) {
  notify({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'Analyze repository',
    status: 'in_progress',
    content: [textBlock('Starting analysis...')],
  });

  for (let i = 1; i <= 5; i++) {
    await sleep(500);
    notify({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      title: 'Analyze repository - stage ' + i + '/5',
      status: 'in_progress',
      content: [textBlock('Progress: stage ' + i + '/5 - ' + (i * 2) + '/10 groups done.')],
    });
  }

  await sleep(500);
  notify({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    title: 'Analyze repository - done',
    status: 'completed',
    content: [textBlock('Analysis complete. No issues found.')],
  });

  // A second call that fails, to exercise the auto-expand behaviour.
  notify({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-2',
    title: 'Run tests',
    status: 'in_progress',
    content: [textBlock('Running the test suite...')],
  });
  await sleep(500);
  notify({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-2',
    title: 'Run tests - failed',
    status: 'failed',
    content: [textBlock('2 tests failed. See the output above for details.')],
  });

  reply(id, { stopReason: 'end_turn' });
}

function handle(message) {
  const { id, method } = message;
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: 'mock-acp', version: '0.0.1' },
      });
      break;
    case 'session/new':
      reply(id, { sessionId: SESSION_ID });
      break;
    case 'session/prompt':
      runPrompt(id);
      break;
    case 'session/cancel':
      reply(id, null);
      break;
    default:
      if (id !== undefined) {
        replyError(id, -32601, 'Method not found: ' + method);
      }
      break;
  }
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  handle(message);
});
