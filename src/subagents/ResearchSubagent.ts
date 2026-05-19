import { Buffer } from 'node:buffer';
import path from 'node:path';

import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

import {
  getAgentConfig,
  getResearchSubAgentConfig,
  type AgentConfigEntry,
} from '../config/AgentConfig';

export interface EnvVariable {
  name: string;
  value: string;
}

export interface LocalMcpServerStdio {
  name: string;
  command: string;
  args: string[];
  env: EnvVariable[];
}

const TOOL_NAME = 'call_research_subagent';
const MCP_SERVER_NAME = 'acp-research-subagent';
const MCP_SERVER_VERSION = '0.1.0';
const MCP_SCRIPT_ENV = 'ACP_RESEARCH_MCP_SCRIPT_BASE64';
const RESEARCH_TIMEOUT_MS = 110_000;
// Final output contract: the sub-agent must write a single JSON object
// on its own final line with the shape {"summary": "..."} and nothing else after it.

export function buildResearchSubagentMcpServer(cwd: string): LocalMcpServerStdio {
  const researchConfig = getResearchSubAgentConfig();
  const backend = resolveResearchBackend(researchConfig.agentName);

  return {
    name: MCP_SERVER_NAME,
    command: 'node',
    args: [path.resolve(__dirname, 'research_mcp.js')],
    env: [
      { name: 'ACP_RESEARCH_TOOL_NAME', value: TOOL_NAME },
      { name: 'ACP_RESEARCH_TOOL_VERSION', value: MCP_SERVER_VERSION },
      { name: 'ACP_RESEARCH_ACP_PROTOCOL_VERSION', value: String(PROTOCOL_VERSION) },
      { name: 'ACP_RESEARCH_SESSION_CWD', value: cwd },
      { name: 'ACP_RESEARCH_TIMEOUT_MS', value: String(RESEARCH_TIMEOUT_MS) },
      {
        name: 'ACP_RESEARCH_AGENT_COMMAND',
        value: backend.config?.command ?? '',
      },
      {
        name: 'ACP_RESEARCH_AGENT_ARGS_JSON',
        value: JSON.stringify(backend.config?.args ?? []),
      },
      {
        name: 'ACP_RESEARCH_AGENT_ENV_JSON',
        value: JSON.stringify(backend.config?.env ?? {}),
      },
      // The research_mcp.js process is spawned as a child of the main agent, which
      // already runs inside Docker. Docker exec must NOT be used from inside the
      // container; the sub-agent command is launched directly in that environment.
      {
        name: 'ACP_DOCKER_ENABLED',
        value: 'false',
      },
      {
        name: 'ACP_DOCKER_CONTAINER',
        value: '',
      },
      {
        name: 'ACP_RESEARCH_CONFIG_ERROR',
        value: backend.error ?? '',
      },
    ],
  };
}

function resolveResearchBackend(agentName: string): {
  config: AgentConfigEntry | null;
  error: string | null;
} {
  if (!agentName) {
    return {
      config: null,
      error:
        'ACP research sub-agent is not configured. Set acp.subAgents.researchAgentName to an existing agent name.',
    };
  }

  const config = getAgentConfig(agentName);
  if (!config) {
    return {
      config: null,
      error: `ACP research sub-agent "${agentName}" does not exist in acp.agents.`,
    };
  }

  return { config, error: null };
}

export function extractResearchSummaryFromTranscript(transcript: string): string | null {
  if (!transcript) {
    return null;
  }
  // Require the final non-empty line to be a single JSON object.
  const lines = transcript.split(/\r?\n/).map(l => l.trim()).filter(() => true);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) {
      continue;
    }
    if (!line.startsWith('{') || !line.endsWith('}')) {
      return null;
    }
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

// The MCP runtime has been extracted to src/subagents/research_mcp.js
// buildResearchMcpScript previously returned the embedded runtime as a string.
// Keep a small shim for API compatibility.
function buildResearchMcpScript(): string {
  return '';
}
