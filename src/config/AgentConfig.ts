import * as vscode from 'vscode';

/**
 * SSH target for running an agent's command on a remote machine instead of
 * spawning it locally. `command`/`args`/`env` are unchanged — they describe
 * how to launch the agent on the remote host.
 */
export interface RemoteConfigEntry {
  /** Remote hostname or IP (e.g., a host from your SSH config, or a raw address) */
  host: string;
  /** SSH user. Omit to use ssh's default (current user / ssh config). */
  user?: string;
  /** SSH port. Omit to use the default (22) or ssh config. */
  port?: number;
  /** Path to a private key file. Supports a leading "~". */
  identityFile?: string;
}

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
  /**
   * If set, `command`/`args` are run on this remote host over SSH instead of
   * locally. The agent process's stdio is tunneled through the ssh session,
   * so it works with any ACP agent (e.g. Hermes Agent) already installed on
   * the remote machine.
   */
  remote?: RemoteConfigEntry;
}

/**
 * Read agent configurations from VS Code settings.
 * Returns a map of agent name → config.
 */
export function getAgentConfigs(): Record<string, AgentConfigEntry> {
  const config = vscode.workspace.getConfiguration('acp');
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
