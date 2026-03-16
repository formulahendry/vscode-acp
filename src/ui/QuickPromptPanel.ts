import * as vscode from 'vscode';
import type { SessionNotification } from '@agentclientprotocol/sdk';

import { SessionManager } from '../core/SessionManager';
import { SessionUpdateHandler, SessionUpdateListener } from '../handlers/SessionUpdateHandler';
import { logError } from '../utils/Logger';
import type { ChatWebviewProvider } from './ChatWebviewProvider';
import {
  buildEditorSnapshotPromptPrefix,
  buildQuickPromptPanelTitle,
  type EditorSnapshot,
} from './EditorSnapshot';
import { getReactShellHtmlContent } from './WebviewHtml';

type WebviewMessage = {
  type: string;
  [key: string]: unknown;
};

export class QuickPromptPanel {
  private panel?: vscode.WebviewPanel;
  private isViewReady = false;
  private pendingMessages: WebviewMessage[] = [];
  private latestSnapshot: EditorSnapshot | null = null;
  private readonly updateListener: SessionUpdateListener;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager,
    private readonly sessionUpdateHandler: SessionUpdateHandler,
    private readonly chatWebviewProvider: ChatWebviewProvider,
  ) {
    this.updateListener = (update: SessionNotification) => {
      this.handleSessionUpdate(update);
    };
    this.sessionUpdateHandler.addListener(this.updateListener);
  }

  async show(snapshot: EditorSnapshot | null): Promise<void> {
    this.latestSnapshot = snapshot;

    if (this.panel) {
      this.panel.title = buildQuickPromptPanelTitle(snapshot);
      this.panel.reveal(vscode.ViewColumn.Active);
      this.sendCurrentState();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'acp-quick-prompt',
      buildQuickPromptPanelTitle(snapshot),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'resources', 'webview')],
      },
    );
    this.isViewReady = false;

    this.panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      switch (message.type) {
        case 'quickPromptReady':
          this.isViewReady = true;
          this.sendCurrentState();
          this.flushPendingMessages();
          break;
        case 'quickPromptSubmit':
          await this.handleQuickPromptSubmit(String(message.text ?? ''));
          break;
        case 'quickPromptConnect':
          await vscode.commands.executeCommand('acp.connectAgent');
          break;
        case 'quickPromptDismiss':
          this.panel?.dispose();
          break;
        case 'setMode':
          await this.handleSetMode(String(message.modeId ?? ''));
          break;
        case 'setModel':
          await this.handleSetModel(String(message.modelId ?? ''));
          break;
      }
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.isViewReady = false;
      this.pendingMessages = [];
    });

    this.panel.webview.html = await getReactShellHtmlContent(this.extensionUri, this.panel.webview, 'quick-prompt');
  }

  notifyActiveSessionChanged(): void {
    this.sendCurrentState();
  }

  notifyModesUpdate(modes: unknown): void {
    this.postMessage({ type: 'modesUpdate', modes });
  }

  notifyModelsUpdate(models: unknown): void {
    this.postMessage({ type: 'modelsUpdate', models });
  }

  dispose(): void {
    this.sessionUpdateHandler.removeListener(this.updateListener);
    this.panel?.dispose();
  }

  private handleSessionUpdate(update: SessionNotification): void {
    if (update.sessionId !== this.sessionManager.getActiveSessionId()) {
      return;
    }

    this.postMessage({
      type: 'sessionUpdate',
      update: update.update,
      sessionId: update.sessionId,
    });
  }

  private sendCurrentState(): void {
    const activeId = this.sessionManager.getActiveSessionId();
    const session = activeId ? this.sessionManager.getSession(activeId) : null;
    this.postMessage({
      type: 'state',
      activeSessionId: activeId,
      editorSnapshot: this.latestSnapshot,
      session: session ? {
        sessionId: session.sessionId,
        agentName: session.agentDisplayName,
        cwd: session.cwd,
        modes: session.modes,
        models: session.models,
        availableCommands: session.availableCommands,
      } : null,
    });
  }

  private async handleQuickPromptSubmit(text: string): Promise<void> {
    const trimmedText = text.trim();
    if (!trimmedText) {
      return;
    }

    if (!this.sessionManager.getActiveSessionId()) {
      this.postMessage({
        type: 'error',
        message: 'No active session. Connect to an agent first.',
      });
      return;
    }

    const finalPrompt = `${buildEditorSnapshotPromptPrefix(this.latestSnapshot)}${trimmedText}`.trim();
    await vscode.commands.executeCommand('acp-chat.focus');
    void this.chatWebviewProvider.sendPromptFromExtension(finalPrompt);
    this.panel?.dispose();
  }

  private async handleSetMode(modeId: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !modeId) {
      return;
    }

    try {
      await this.sessionManager.setMode(activeId, modeId);
    } catch (e: any) {
      logError('Failed to set mode from quick prompt', e);
      this.postMessage({ type: 'error', message: `Failed to set mode: ${e.message}` });
    }
  }

  private async handleSetModel(modelId: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !modelId) {
      return;
    }

    try {
      await this.sessionManager.setModel(activeId, modelId);
    } catch (e: any) {
      logError('Failed to set model from quick prompt', e);
      this.postMessage({ type: 'error', message: `Failed to set model: ${e.message}` });
    }
  }

  private postMessage(message: WebviewMessage): void {
    if (!this.panel) {
      return;
    }

    if (!this.isViewReady) {
      this.pendingMessages.push(message);
      return;
    }

    this.panel.webview.postMessage(message);
  }

  private flushPendingMessages(): void {
    if (!this.panel || !this.isViewReady || this.pendingMessages.length === 0) {
      return;
    }

    const messages = this.pendingMessages;
    this.pendingMessages = [];
    for (const message of messages) {
      this.panel.webview.postMessage(message);
    }
  }
}
