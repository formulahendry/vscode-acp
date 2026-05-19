import * as vscode from 'vscode';

/**
 * Configuration for a single ACP agent.
 */
export interface AgentConfigEntry {
  /** NPX package to run (e.g., "@anthropic-ai/claude-code@latest") */
  command: string;
  /** Command-line arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Display name */
  displayName?: string;
}

export interface ResearchSubAgentConfigEntry {
  agentName: string;
}

function getAcpConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('acp');
}

/**
 * Read agent configurations from VS Code settings.
 * Returns a map of agent name → config.
 */
export function getAgentConfigs(): Record<string, AgentConfigEntry> {
  const config = getAcpConfiguration();
  const agents = config.get<Record<string, AgentConfigEntry>>('agents', {});
  return agents;
}

/**
 * Get the list of agent names available.
 */
export function getAgentNames(): string[] {
  return Object.keys(getAgentConfigs());
}

/**
 * Get a specific agent config by name.
 */
export function getAgentConfig(name: string): AgentConfigEntry | undefined {
  return getAgentConfigs()[name];
}

export function getResearchSubAgentConfig(): ResearchSubAgentConfigEntry {
  const config = getAcpConfiguration();
  return {
    agentName: config.get<string>('subAgents.researchAgentName', '').trim(),
  };
}

export function getDefaultWorkingDirectory(): string {
  return getAcpConfiguration().get<string>('defaultWorkingDirectory', '').trim();
}

export function resolveSessionWorkingDirectory(): string {
  const configured = getDefaultWorkingDirectory();
  if (configured) {
    return configured;
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
}
