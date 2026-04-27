import * as vscode from 'vscode';
import { log } from '../utils/Logger';

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

/**
 * Read agent configurations from VS Code settings.
 * Warns if workspace-level overrides are detected (supply-chain risk).
 */
export function getAgentConfigs(): Record<string, AgentConfigEntry> {
  const config = vscode.workspace.getConfiguration('acp');
  const inspect = config.inspect<Record<string, AgentConfigEntry>>('agents');

  if ((inspect?.workspaceValue || inspect?.workspaceFolderValue) && !isWorkspaceTrusted()) {
    log('WARNING: Workspace-level agent configs detected but workspace is not trusted — ignoring');
    return inspect.globalValue ?? inspect.defaultValue ?? {};
  }

  return config.get<Record<string, AgentConfigEntry>>('agents', {});
}

/**
 * Check if the current workspace is trusted via VS Code's workspace trust API.
 */
function isWorkspaceTrusted(): boolean {
  return vscode.workspace.isTrusted;
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
