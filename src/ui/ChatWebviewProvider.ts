import * as vscode from 'vscode';
import { marked } from 'marked';
import type { SessionNotification } from '@agentclientprotocol/sdk';

import { SessionManager } from '../core/SessionManager';
import { SessionUpdateHandler, SessionUpdateListener } from '../handlers/SessionUpdateHandler';
import { log, logError } from '../utils/Logger';
import { sendEvent } from '../utils/TelemetryManager';
import { getReactShellHtmlContent } from './WebviewHtml';

type WebviewMessage = {
  type: string;
  [key: string]: unknown;
};

type FileSelection = {
  startLine?: number;
  startCharacter?: number;
  endLine?: number;
  endCharacter?: number;
  text?: string;
  cursorLine?: number;
  cursorCharacter?: number;
} | null;

/**
 * WebviewViewProvider for the ACP chat sidebar.
 * Renders chat messages, tool calls, plans, and handles user input.
 */
export class ChatWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'acp-chat';

  private view?: vscode.WebviewView;
  private updateListener: SessionUpdateListener;
  private _hasChatContent = false;
  private isViewReady = false;
  private pendingMessages: WebviewMessage[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager,
    private readonly sessionUpdateHandler: SessionUpdateHandler,
  ) {
    marked.setOptions({
      breaks: true,
      gfm: true,
    });

    this.updateListener = (update: SessionNotification) => {
      this.handleSessionUpdate(update);
    };
    this.sessionUpdateHandler.addListener(this.updateListener);
    log('ChatWebviewProvider: session update listener registered');
  }

  private renderMarkdown(text: string): string {
    try {
      return marked.parse(text) as string;
    } catch {
      return this.escapeHtml(text);
    }
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    this.view = webviewView;
    this.isViewReady = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'resources', 'webview')],
    };

    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      switch (message.type) {
        case 'sendPrompt':
          this._hasChatContent = true;
          await this.handleSendPrompt(String(message.text ?? ''));
          break;
        case 'cancelTurn':
          await this.handleCancelTurn();
          break;
        case 'setMode':
          await this.handleSetMode(String(message.modeId ?? ''));
          break;
        case 'setModel':
          await this.handleSetModel(String(message.modelId ?? ''));
          break;
        case 'executeCommand':
          if (typeof message.command === 'string' && message.command) {
            await vscode.commands.executeCommand(message.command);
          }
          break;
        case 'ready':
          this.isViewReady = true;
          this.sendCurrentState();
          this.flushPendingMessages();
          break;
        case 'renderMarkdown': {
          const items = Array.isArray(message.items)
            ? message.items as Array<{ index: number; text: string }>
            : [];
          const rendered = items.map((item) => ({
            index: item.index,
            html: this.renderMarkdown(item.text),
          }));
          this.postMessage({ type: 'markdownRendered', items: rendered });
          break;
        }
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.isViewReady = false;
    });

    webviewView.webview.html = await this.getHtmlContent(webviewView.webview);
  }

  private handleSessionUpdate(update: SessionNotification): void {
    const activeId = this.sessionManager.getActiveSessionId();
    log('ChatWebviewProvider.handleSessionUpdate called', update);
    if (update.sessionId !== activeId) {
      return;
    }

    this.postMessage({
      type: 'sessionUpdate',
      update: update.update,
      sessionId: update.sessionId,
    });
  }

  private async handleSendPrompt(text: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId) {
      this.postMessage({
        type: 'error',
        message: 'No active session. Create a session first.',
      });
      return;
    }

    sendEvent('chat/messageSent', {
      agentName: this.sessionManager.getActiveAgentName() ?? '',
    }, {
      messageLength: text.length,
    });

    this.postMessage({ type: 'promptStart' });

    try {
      const response = await this.sessionManager.sendPrompt(activeId, text);
      this.postMessage({
        type: 'promptEnd',
        stopReason: response.stopReason,
        usage: (response as any).usage,
      });
    } catch (e: any) {
      logError('Prompt failed', e);
      this.postMessage({
        type: 'error',
        message: e.message || 'Prompt failed',
      });
      this.postMessage({ type: 'promptEnd', stopReason: 'error' });
    }
  }

  private async handleCancelTurn(): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId) {
      return;
    }

    try {
      await this.sessionManager.cancelTurn(activeId);
    } catch (e) {
      logError('Cancel failed', e);
    }
  }

  private async handleSetMode(modeId: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !modeId) {
      return;
    }

    try {
      await this.sessionManager.setMode(activeId, modeId);
    } catch (e: any) {
      logError('Failed to set mode', e);
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
      logError('Failed to set model', e);
      this.postMessage({ type: 'error', message: `Failed to set model: ${e.message}` });
    }
  }

  private sendCurrentState(): void {
    if (!this.view || !this.isViewReady) {
      return;
    }

    const activeId = this.sessionManager.getActiveSessionId();
    const session = activeId ? this.sessionManager.getSession(activeId) : null;
    this.view.webview.postMessage({
      type: 'state',
      activeSessionId: activeId,
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

  private postMessage(message: WebviewMessage): void {
    if (!this.view || !this.isViewReady) {
      this.pendingMessages.push(message);
      return;
    }

    this.view.webview.postMessage(message);
  }

  private flushPendingMessages(): void {
    if (!this.view || !this.isViewReady || this.pendingMessages.length === 0) {
      return;
    }

    const messages = this.pendingMessages;
    this.pendingMessages = [];
    for (const message of messages) {
      this.view.webview.postMessage(message);
    }
  }

  notifyActiveSessionChanged(): void {
    this.sendCurrentState();
  }

  notifyModesUpdate(modes: any): void {
    if (!this.isViewReady) {
      return;
    }
    this.postMessage({ type: 'modesUpdate', modes });
  }

  notifyModelsUpdate(models: any): void {
    if (!this.isViewReady) {
      return;
    }
    this.postMessage({ type: 'modelsUpdate', models });
  }

  clearChat(): void {
    this._hasChatContent = false;
    this.postMessage({ type: 'clearChat' });
  }

  get hasChatContent(): boolean {
    return this._hasChatContent;
  }

  async sendPromptFromExtension(text: string): Promise<void> {
    if (!text.trim()) {
      return;
    }

    if (!this.sessionManager.getActiveSessionId()) {
      await this.handleSendPrompt(text);
      return;
    }

    this._hasChatContent = true;
    this.postMessage({ type: 'externalUserMessage', text });
    await this.handleSendPrompt(text);
  }

  attachFile(uri: vscode.Uri, selection?: FileSelection): void {
    const payload: WebviewMessage = {
      type: 'file-attached',
      path: uri.fsPath,
      name: uri.fsPath.split(/[\\/]/).pop() || uri.fsPath,
    };

    if (selection) {
      payload.selection = selection;
    }

    this.postMessage(payload);
    this.view?.show?.(true);
  }

  dispose(): void {
    this.sessionUpdateHandler.removeListener(this.updateListener);
  }

  private async getHtmlContent(webview: vscode.Webview): Promise<string> {
    return getReactShellHtmlContent(this.extensionUri, webview, 'chat');
  }
}
