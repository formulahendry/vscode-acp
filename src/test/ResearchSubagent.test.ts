import * as assert from 'assert';
import * as vscode from 'vscode';

import {
  buildResearchSubagentMcpServer,
  extractResearchSummaryFromTranscript,
} from '../subagents/ResearchSubagent';

suite('ResearchSubagent', () => {
  const originalGetConfiguration = vscode.workspace.getConfiguration;

  teardown(() => {
    (vscode.workspace as any).getConfiguration = originalGetConfiguration;
  });

  test('builds an MCP server with the configured backend agent', () => {
    stubConfiguration({
      'subAgents.researchAgentName': 'Research Agent',
      agents: {
        'Research Agent': {
          command: 'npx',
          args: ['research-agent'],
          env: { FOO: 'bar' },
        },
      },
    });

    const server = buildResearchSubagentMcpServer('/workspace/app');

    assert.strictEqual(server.name, 'acp-research-subagent');
    assert.strictEqual(server.command, 'node');
    assert.ok(server.args.some(arg => arg.includes('ACP_RESEARCH_MCP_SCRIPT_BASE64')));
    assert.strictEqual(getEnv(server, 'ACP_RESEARCH_AGENT_NAME'), 'Research Agent');
    assert.strictEqual(getEnv(server, 'ACP_RESEARCH_AGENT_COMMAND'), 'npx');
    assert.strictEqual(getEnv(server, 'ACP_RESEARCH_AGENT_ARGS_JSON'), '["research-agent"]');
    assert.strictEqual(getEnv(server, 'ACP_RESEARCH_AGENT_ENV_JSON'), '{"FOO":"bar"}');
    assert.strictEqual(getEnv(server, 'ACP_DOCKER_ENABLED'), 'false');
    assert.strictEqual(getEnv(server, 'ACP_DOCKER_CONTAINER'), '');
    assert.strictEqual(getEnv(server, 'ACP_RESEARCH_SESSION_CWD'), '/workspace/app');
    assert.strictEqual(getEnv(server, 'ACP_RESEARCH_TIMEOUT_MS'), '110000');
    assert.strictEqual(getEnv(server, 'ACP_RESEARCH_CONFIG_ERROR'), '');
    assert.ok(getEnv(server, 'ACP_RESEARCH_MCP_SCRIPT_BASE64').length > 0);

    const script = decodeScript(server);
    assert.match(script, /terminal\/create/);
    assert.match(script, /terminal:\s*true/);
    assert.match(script, /read-only terminal commands/);
  });

  test('embeds a configuration error when the backend agent is missing', () => {
    stubConfiguration({
      'subAgents.researchAgentName': 'Missing Agent',
      agents: {},
    });

    const server = buildResearchSubagentMcpServer('/workspace/app');

    assert.strictEqual(getEnv(server, 'ACP_RESEARCH_AGENT_COMMAND'), '');
    assert.match(
      getEnv(server, 'ACP_RESEARCH_CONFIG_ERROR'),
      /Missing Agent/,
    );
  });

  test('extracts only the final marked block from a sub-agent transcript', () => {
    const final = JSON.stringify({
      summary: [
        "Trouvé: le bug vient d'une agrégation de chunks intermédiaires.",
        'Action: renvoyer uniquement le bloc final.',
      ].join('\n'),
    });

    const transcript = [
      "Je vais d'abord inspecter les fichiers pertinents.",
      'Puis je résumerai le résultat.',
      final,
    ].join('\n');

    assert.strictEqual(extractResearchSummaryFromTranscript(transcript), JSON.parse(final).summary);
  });

  test('returns null when no final marked block exists', () => {
    assert.strictEqual(
      extractResearchSummaryFromTranscript('Je vais d\'abord chercher dans le repo.'),
      null,
    );
  });
});

function stubConfiguration(values: Record<string, unknown>): void {
  (vscode.workspace as any).getConfiguration = () =>
    ({
      get: (section: string, defaultValue?: unknown) =>
        Object.prototype.hasOwnProperty.call(values, section)
          ? values[section]
          : defaultValue,
    }) as vscode.WorkspaceConfiguration;
}

function getEnv(
  server: ReturnType<typeof buildResearchSubagentMcpServer>,
  name: string,
): string {
  const envVar = server.env.find(entry => entry.name === name);
  assert.ok(envVar, `Missing env var ${name}`);
  return envVar!.value;
}

function decodeScript(server: ReturnType<typeof buildResearchSubagentMcpServer>): string {
  return Buffer.from(getEnv(server, 'ACP_RESEARCH_MCP_SCRIPT_BASE64'), 'base64').toString('utf8');
}
