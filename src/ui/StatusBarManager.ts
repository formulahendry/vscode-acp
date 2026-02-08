import * as vscode from 'vscode';
import { SessionManager } from '../core/SessionManager';

/**
 * Manages the status bar item showing ACP connection status.
 */
export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;

  constructor(private readonly sessionManager: SessionManager) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.statusBarItem.command = 'acp.connectAgent';
    this.updateStatus();

    // Update on agent changes
    this.sessionManager.on('agent-connected', () => this.updateStatus());
    this.sessionManager.on('agent-disconnected', () => this.updateStatus());
    this.sessionManager.on('active-session-changed', () => this.updateStatus());
    this.sessionManager.on('agent-error', () => this.showError());
    this.sessionManager.on('agent-closed', () => this.updateStatus());
  }

  private updateStatus(): void {
    const activeSession = this.sessionManager.getActiveSession();
    const connectedAgents = this.sessionManager.getConnectedAgentNames();

    if (connectedAgents.length === 0) {
      this.statusBarItem.text = '$(hubot) ACP: Disconnected';
      this.statusBarItem.tooltip = 'Click to connect to an agent';
      this.statusBarItem.backgroundColor = undefined;
    } else {
      const agentName = activeSession?.agentDisplayName || connectedAgents[0];
      this.statusBarItem.text = `$(hubot) ACP: ${agentName}`;
      this.statusBarItem.tooltip = `Connected to ${agentName}\n${connectedAgents.length} agent(s) connected`;
      this.statusBarItem.backgroundColor = undefined;
    }

    this.statusBarItem.show();
  }

  private showError(): void {
    this.statusBarItem.text = '$(error) ACP: Error';
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}
