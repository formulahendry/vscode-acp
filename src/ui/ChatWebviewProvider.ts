import * as vscode from 'vscode';
import { marked } from 'marked';
import { SessionManager } from '../core/SessionManager';
import { SessionUpdateHandler, SessionUpdateListener } from '../handlers/SessionUpdateHandler';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { logError } from '../utils/Logger';
import { sendEvent } from '../utils/TelemetryManager';

/**
 * WebviewViewProvider for the ACP chat sidebar.
 * Renders chat messages, tool calls, plans, and handles user input.
 */
export class ChatWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'acp-chat';

  private view?: vscode.WebviewView;
  private updateListener: SessionUpdateListener;
  private _hasChatContent = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager,
    private readonly sessionUpdateHandler: SessionUpdateHandler,
  ) {
    // Configure marked for safe rendering
    marked.setOptions({
      breaks: true,
      gfm: true,
    });

    // Register as a session update listener
    this.updateListener = (update: SessionNotification) => {
      this.handleSessionUpdate(update);
    };
    this.sessionUpdateHandler.addListener(this.updateListener);
  }

  /**
   * Render markdown text to HTML using marked.
   */
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

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'sendPrompt':
          this._hasChatContent = true;
          await this.handleSendPrompt(message.text);
          break;
        case 'cancelTurn':
          await this.handleCancelTurn();
          break;
        case 'setMode':
          await this.handleSetMode(message.modeId);
          break;
        case 'setModel':
          await this.handleSetModel(message.modelId);
          break;
        case 'executeCommand':
          if (message.command) {
            await vscode.commands.executeCommand(message.command);
          }
          break;
        case 'ready':
          // Webview loaded — send current session state
          this.sendCurrentState();
          break;
        case 'renderMarkdown': {
          // Webview requests markdown rendering for history items
          const items: Array<{index: number; text: string}> = message.items || [];
          const rendered = items.map((item: {index: number; text: string}) => ({
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
    });
  }

  /**
   * Forward session update to webview.
   */
  private handleSessionUpdate(update: SessionNotification): void {
    // Only forward updates for the active session
    const activeId = this.sessionManager.getActiveSessionId();
    if (update.sessionId !== activeId) { return; }

    // Persist available commands on session state
    const updateData = update.update as any;
    if (updateData?.sessionUpdate === 'available_commands_update') {
      const session = this.sessionManager.getSession(update.sessionId);
      if (session) {
        session.availableCommands = updateData.availableCommands || [];
      }
    }

    this.postMessage({
      type: 'sessionUpdate',
      update: update.update,
      sessionId: update.sessionId,
    });
  }

  /**
   * Handle a prompt sent from the webview.
   */
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

    // Tell webview we're processing
    this.postMessage({ type: 'promptStart' });

    try {
      const response = await this.sessionManager.sendPrompt(activeId, text);
      // Render the accumulated assistant text as markdown
      // The webview will have sent us the raw text via promptEnd handling
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

  /**
   * Handle cancel request from webview.
   */
  private async handleCancelTurn(): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (activeId) {
      try {
        await this.sessionManager.cancelTurn(activeId);
      } catch (e) {
        logError('Cancel failed', e);
      }
    }
  }

  /**
   * Handle mode change from webview picker.
   */
  private async handleSetMode(modeId: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !modeId) { return; }
    try {
      await this.sessionManager.setMode(activeId, modeId);
    } catch (e: any) {
      logError('Failed to set mode', e);
      this.postMessage({ type: 'error', message: `Failed to set mode: ${e.message}` });
    }
  }

  /**
   * Handle model change from webview picker.
   */
  private async handleSetModel(modelId: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !modelId) { return; }
    try {
      await this.sessionManager.setModel(activeId, modelId);
    } catch (e: any) {
      logError('Failed to set model', e);
      this.postMessage({ type: 'error', message: `Failed to set model: ${e.message}` });
    }
  }

  /**
   * Send current session state to the webview on load.
   */
  private sendCurrentState(): void {
    const activeId = this.sessionManager.getActiveSessionId();
    const session = activeId ? this.sessionManager.getSession(activeId) : null;
    this.postMessage({
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

  /**
   * Post a message to the webview if it exists.
   */
  private postMessage(message: any): void {
    this.view?.webview.postMessage(message);
  }

  /**
   * Notify webview of a new active session.
   */
  notifyActiveSessionChanged(): void {
    this.sendCurrentState();
  }

  /**
   * Notify webview of mode state changes.
   */
  notifyModesUpdate(modes: any): void {
    this.postMessage({ type: 'modesUpdate', modes });
  }

  /**
   * Notify webview of model state changes.
   */
  notifyModelsUpdate(models: any): void {
    this.postMessage({ type: 'modelsUpdate', models });
  }

  /**
   * Clear the chat history and reset to welcome state.
   * Called when starting a new conversation.
   */
  clearChat(): void {
    this._hasChatContent = false;
    this.postMessage({ type: 'clearChat' });
  }

  /**
   * Whether the chat has any messages.
   */
  get hasChatContent(): boolean {
    return this._hasChatContent;
  }

  /**
   * Generate the HTML content for the webview.
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>ACP Chat</title>
  <style>
    :root {
      --container-padding: 12px;
      --message-radius: 8px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* Session connected banner */
    .session-banner {
      display: none;
      padding: 10px var(--container-padding);
      background: var(--vscode-editorWidget-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 0.9em;
    }
    .session-banner.visible { display: flex; align-items: center; gap: 8px; }
    .session-banner .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--vscode-testing-iconPassed);
      flex-shrink: 0;
    }
    .session-banner .info { flex: 1; }
    .session-banner .agent { font-weight: 600; }
    .session-banner .cwd {
      font-size: 0.85em;
      opacity: 0.6;
      margin-top: 1px;
    }
    .session-banner .status {
      font-size: 0.85em;
      opacity: 0.7;
      flex-shrink: 0;
    }

    /* Messages area */
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: var(--container-padding);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .message {
      padding: 8px 12px;
      border-radius: var(--message-radius);
      max-width: 95%;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .message.user {
      align-self: flex-end;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .message.assistant {
      align-self: flex-start;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
    }
    /* Markdown body inside assistant messages */
    .message.assistant.md-rendered {
      white-space: normal;
    }
    .message.assistant.md-rendered p {
      margin: 0 0 0.5em;
    }
    .message.assistant.md-rendered p:last-child {
      margin-bottom: 0;
    }
    .message.assistant.md-rendered pre {
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 8px 10px;
      overflow-x: auto;
      margin: 0.5em 0;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      line-height: 1.4;
    }
    .message.assistant.md-rendered code {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
    }
    .message.assistant.md-rendered pre code {
      background: none;
      padding: 0;
      border-radius: 0;
    }
    .message.assistant.md-rendered ul,
    .message.assistant.md-rendered ol {
      margin: 0.4em 0;
      padding-left: 1.5em;
    }
    .message.assistant.md-rendered li {
      margin: 0.15em 0;
    }
    .message.assistant.md-rendered h1,
    .message.assistant.md-rendered h2,
    .message.assistant.md-rendered h3,
    .message.assistant.md-rendered h4 {
      margin: 0.6em 0 0.3em;
      font-weight: 600;
    }
    .message.assistant.md-rendered h1 { font-size: 1.3em; }
    .message.assistant.md-rendered h2 { font-size: 1.15em; }
    .message.assistant.md-rendered h3 { font-size: 1.05em; }
    .message.assistant.md-rendered blockquote {
      border-left: 3px solid var(--vscode-focusBorder);
      margin: 0.4em 0;
      padding: 0.2em 0 0.2em 0.8em;
      opacity: 0.85;
    }
    .message.assistant.md-rendered a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .message.assistant.md-rendered a:hover {
      text-decoration: underline;
    }
    .message.assistant.md-rendered table {
      border-collapse: collapse;
      margin: 0.4em 0;
      font-size: 0.9em;
    }
    .message.assistant.md-rendered th,
    .message.assistant.md-rendered td {
      border: 1px solid var(--vscode-panel-border);
      padding: 4px 8px;
    }
    .message.assistant.md-rendered th {
      background: var(--vscode-editorWidget-background);
      font-weight: 600;
    }
    .message.assistant.md-rendered hr {
      border: none;
      border-top: 1px solid var(--vscode-panel-border);
      margin: 0.6em 0;
    }
    /* Thought block — collapsible <details> element */
    .thought-block {
      width: 100%;
      margin-bottom: 4px;
    }
    .thought-block summary {
      font-size: 0.85em;
      opacity: 0.7;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
      list-style: none;
    }
    .thought-block summary::-webkit-details-marker { display: none; }
    .thought-block summary::before {
      content: '▸';
      font-size: 0.9em;
      transition: transform 0.15s;
    }
    .thought-block[open] summary::before {
      content: '▾';
    }
    .thought-block summary:hover { opacity: 1; }
    .thought-block.streaming summary .thought-indicator {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--vscode-progressBar-background);
      animation: thoughtPulse 1.2s ease-in-out infinite;
      flex-shrink: 0;
    }
    @keyframes thoughtPulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 1; }
    }
    .thought-block .thought-content {
      margin-top: 4px;
      padding: 8px 12px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      font-size: 0.88em;
      opacity: 0.75;
      font-style: italic;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 300px;
      overflow-y: auto;
    }

    .message.error {
      align-self: center;
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
    }

    /* Turn container — groups assistant text + tool calls */
    .turn {
      display: flex;
      flex-direction: column;
      gap: 4px;
      align-self: flex-start;
      max-width: 95%;
    }

    /* Tool calls group inside a turn */
    .turn-tools {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding-left: 10px;
      border-left: 2px solid var(--vscode-panel-border);
      margin: 2px 0;
    }
    .turn-tools-summary {
      font-size: 0.8em;
      opacity: 0.6;
      cursor: pointer;
      padding: 2px 0;
      user-select: none;
    }
    .turn-tools-summary:hover { opacity: 0.9; }
    .turn-tools-list { }
    .turn-tools-list.collapsed { display: none; }

    /* Compact inline tool call */
    .tool-call-inline {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 6px;
      font-size: 0.85em;
      border-radius: 4px;
      background: var(--vscode-editorWidget-background);
      opacity: 0.85;
    }
    .tool-call-inline .tc-icon {
      flex-shrink: 0;
      width: 14px;
      text-align: center;
    }
    .tool-call-inline .tc-icon.pending { color: var(--vscode-badge-foreground); }
    .tool-call-inline .tc-icon.running { color: var(--vscode-progressBar-background); }
    .tool-call-inline .tc-icon.completed { color: var(--vscode-testing-iconPassed); }
    .tool-call-inline .tc-icon.failed { color: var(--vscode-testing-iconFailed); }
    .tool-call-inline .tc-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Legacy standalone tool-call card (for history restore) */
    .tool-call {
      padding: 8px 12px;
      border-radius: var(--message-radius);
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      font-size: 0.9em;
    }
    .tool-call .title {
      font-weight: 600;
      margin-bottom: 4px;
    }
    .tool-call .status-badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 0.8em;
      margin-left: 6px;
    }
    .tool-call .status-badge.pending { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .tool-call .status-badge.running { background: var(--vscode-progressBar-background); color: white; }
    .tool-call .status-badge.completed { background: var(--vscode-testing-iconPassed); color: white; }
    .tool-call .status-badge.failed { background: var(--vscode-testing-iconFailed); color: white; }

    /* Plan */
    .plan {
      padding: 8px 12px;
      border-radius: var(--message-radius);
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
    }
    .plan .plan-title { font-weight: 600; margin-bottom: 6px; }
    .plan .plan-entry {
      padding: 2px 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .plan .plan-entry.completed { text-decoration: line-through; opacity: 0.6; }

    /* Empty / welcome state */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      padding: 24px 20px;
      gap: 6px;
      position: relative;
      z-index: 1;
    }
    .empty-state .icon { font-size: 2.4em; margin-bottom: 4px; opacity: 0.85; }
    .empty-state .title {
      font-size: 1.1em;
      font-weight: 600;
      margin-bottom: 2px;
    }
    .empty-state .subtitle {
      font-size: 0.85em;
      opacity: 0.6;
      margin-bottom: 12px;
      line-height: 1.4;
    }
    .empty-state .actions {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      max-width: 220px;
    }
    .empty-state .action-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      font-weight: 500;
      pointer-events: auto;
      position: relative;
      z-index: 2;
    }
    .empty-state .action-btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .empty-state .action-btn.primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .empty-state .action-btn.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .empty-state .action-btn.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .empty-state .hint {
      font-size: 0.8em;
      opacity: 0.5;
      margin-top: 8px;
    }
    .empty-state .hint kbd {
      padding: 1px 5px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.95em;
      background: var(--vscode-editor-background);
    }

    /* Session connected banner */
    .session-banner {
      display: none;
      padding: 10px var(--container-padding);
      background: var(--vscode-editorWidget-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 0.9em;
    }
    .session-banner.visible { display: flex; align-items: center; gap: 8px; }

    /* Input area states */
    .input-area.disabled .input-toolbar,
    .input-area.disabled .input-editor-wrap,
    .input-area.disabled .input-send-row { opacity: 0.4; pointer-events: none; }

    /* Input area container */
    .input-area {
      position: relative;
      border-top: 1px solid var(--vscode-panel-border);
      display: flex;
      flex-direction: column;
      background: var(--vscode-sideBar-background);
    }

    /* Resize handle */
    .input-resize-handle {
      height: 4px;
      cursor: ns-resize;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .input-resize-handle::after {
      content: '';
      width: 32px;
      height: 2px;
      border-radius: 1px;
      background: var(--vscode-panel-border);
      transition: background 0.15s;
    }
    .input-resize-handle:hover::after {
      background: var(--vscode-focusBorder);
    }

    /* Toolbar row */
    .input-toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px var(--container-padding) 0;
      flex-shrink: 0;
    }

    /* Picker wrapper — positioned relatively to anchor the dropdown */
    .picker-wrap {
      position: relative;
    }
    .picker-wrap.hidden { display: none; }

    /* Picker buttons */
    .picker-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border: none;
      border-radius: 3px;
      background: transparent;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: calc(var(--vscode-font-size) - 1px);
      cursor: pointer;
      white-space: nowrap;
      max-width: 140px;
      opacity: 0.8;
    }
    .picker-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
      opacity: 1;
    }
    .picker-btn .picker-icon {
      flex-shrink: 0;
      font-size: 14px;
    }
    .picker-btn .picker-label {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .picker-btn .picker-chevron {
      flex-shrink: 0;
      font-size: 10px;
      opacity: 0.6;
    }

    /* Picker dropdown — sibling of button, positioned from wrapper */
    .picker-dropdown {
      display: none;
      position: absolute;
      bottom: 100%;
      left: 0;
      min-width: 180px;
      max-width: 280px;
      max-height: 200px;
      overflow-y: auto;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      z-index: 100;
      margin-bottom: 4px;
    }
    .picker-dropdown.open { display: block; }
    .picker-dropdown-item {
      padding: 6px 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: calc(var(--vscode-font-size) - 1px);
      color: var(--vscode-dropdown-foreground);
    }
    .picker-dropdown-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .picker-dropdown-item.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .picker-dropdown-item .check {
      width: 14px;
      text-align: center;
      flex-shrink: 0;
    }
    .picker-dropdown-item .item-label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .picker-dropdown-item .item-desc {
      font-size: 0.85em;
      opacity: 0.6;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100px;
    }

    /* Toolbar spacer */
    .toolbar-spacer { flex: 1; }

    /* Editor wrapper */
    .input-editor-wrap {
      padding: 0 var(--container-padding);
      flex: 1;
      min-height: 0;
      display: flex;
    }
    .input-editor-wrap textarea {
      flex: 1;
      resize: none;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      padding: 8px 10px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.4;
      min-height: 38px;
      outline: none;
    }
    .input-editor-wrap textarea:focus {
      border-color: var(--vscode-focusBorder);
    }

    /* Send row */
    .input-send-row {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding: 4px var(--container-padding) 8px;
      gap: 6px;
      flex-shrink: 0;
    }

    /* Send / Stop toggle button — pill-shaped */
    .send-stop-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 4px 14px;
      border: none;
      border-radius: 12px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      font-weight: 500;
      white-space: nowrap;
      min-width: 60px;
      height: 26px;
      transition: background 0.15s;
    }
    .send-stop-btn.send {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .send-stop-btn.send:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .send-stop-btn.send:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .send-stop-btn.stop {
      background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      color: var(--vscode-inputValidation-errorForeground, #f48771);
      border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
    }
    .send-stop-btn.stop:hover {
      opacity: 0.9;
    }

    /* Slash command autocomplete popup */
    .slash-popup {
      display: none;
      position: absolute;
      bottom: 100%;
      left: var(--container-padding);
      right: var(--container-padding);
      max-height: 200px;
      overflow-y: auto;
      background: var(--vscode-editorSuggestWidget-background, var(--vscode-dropdown-background));
      border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-dropdown-border));
      border-radius: 6px;
      box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.25);
      z-index: 200;
      margin-bottom: 4px;
    }
    .slash-popup.open { display: block; }
    .slash-popup-header {
      padding: 6px 10px 4px;
      font-size: 0.8em;
      opacity: 0.5;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .slash-popup-item {
      padding: 6px 10px;
      cursor: pointer;
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .slash-popup-item:hover,
    .slash-popup-item.active {
      background: var(--vscode-list-hoverBackground);
    }
    .slash-popup-item .cmd-name {
      font-weight: 600;
      color: var(--vscode-textLink-foreground);
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family);
    }
    .slash-popup-item .cmd-desc {
      font-size: 0.9em;
      opacity: 0.7;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    /* Spinner */
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--vscode-foreground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      opacity: 0.6;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="session-banner" id="sessionBanner">
    <span class="dot"></span>
    <div class="info">
      <div class="agent" id="bannerAgent"></div>
      <div class="cwd" id="bannerCwd"></div>
    </div>
    <span class="status" id="status"></span>
  </div>

  <div class="messages" id="messages">
    <div class="empty-state" id="emptyState">
      <div class="icon">🤖</div>
      <div class="title">ACP Chat</div>
      <div class="subtitle">Connect to an AI coding agent to start chatting.</div>
      <div class="actions">
        <button class="action-btn primary" id="welcomeConnectAgent">
          🔌 Connect to Agent
        </button>
        <button class="action-btn secondary" id="welcomeAddAgent">
          ⚙ Add Agent
        </button>
      </div>
      <div class="hint">or press <kbd>Ctrl+Shift+A</kbd> anytime</div>
    </div>
  </div>

  <div class="input-area" id="inputArea">
    <div class="slash-popup" id="slashPopup">
      <div class="slash-popup-header">Commands</div>
    </div>
    <div class="input-resize-handle" id="resizeHandle"></div>
    <div class="input-toolbar">
      <div class="picker-wrap hidden" id="modePickerWrap">
        <button class="picker-btn" id="modePickerBtn" title="Select mode">
          <span class="picker-icon">⚡</span>
          <span class="picker-label" id="modePickerLabel">Mode</span>
          <span class="picker-chevron">▾</span>
        </button>
        <div class="picker-dropdown" id="modeDropdown"></div>
      </div>
      <div class="picker-wrap hidden" id="modelPickerWrap">
        <button class="picker-btn" id="modelPickerBtn" title="Select model">
          <span class="picker-icon">🧠</span>
          <span class="picker-label" id="modelPickerLabel">Model</span>
          <span class="picker-chevron">▾</span>
        </button>
        <div class="picker-dropdown" id="modelDropdown"></div>
      </div>
      <span class="toolbar-spacer"></span>
    </div>
    <div class="input-editor-wrap">
      <textarea
        id="promptInput"
        placeholder="Type a message..."
        rows="2"
      ></textarea>
    </div>
    <div class="input-send-row">
      <button class="send-stop-btn send" id="sendStopBtn">Send</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const emptyState = document.getElementById('emptyState');
    const promptInput = document.getElementById('promptInput');
    const sendStopBtn = document.getElementById('sendStopBtn');
    const statusEl = document.getElementById('status');
    const sessionBanner = document.getElementById('sessionBanner');
    const bannerAgent = document.getElementById('bannerAgent');
    const bannerCwd = document.getElementById('bannerCwd');
    const inputArea = document.getElementById('inputArea');
    const resizeHandle = document.getElementById('resizeHandle');
    const slashPopup = document.getElementById('slashPopup');

    // Picker elements
    const modePickerWrap = document.getElementById('modePickerWrap');
    const modePickerBtn = document.getElementById('modePickerBtn');
    const modePickerLabel = document.getElementById('modePickerLabel');
    const modeDropdown = document.getElementById('modeDropdown');
    const modelPickerWrap = document.getElementById('modelPickerWrap');
    const modelPickerBtn = document.getElementById('modelPickerBtn');
    const modelPickerLabel = document.getElementById('modelPickerLabel');
    const modelDropdown = document.getElementById('modelDropdown');

    let hasActiveSession = false;
    let isProcessing = false;

    // Modes / models state
    let availableModes = [];
    let currentModeId = null;
    let availableModels = [];
    let currentModelId = null;

    // Thinking state
    let currentThoughtEl = null;
    let currentThoughtTextEl = null;
    let currentThoughtText = '';
    let thoughtStartTime = null;
    let thoughtEndTime = null;

    // Slash commands state
    let availableCommands = [];
    let slashPopupSelectedIdx = -1;
    let slashFilteredCommands = [];
    let savedPlaceholder = 'Type a message...';

    function updatePlaceholder() {
      savedPlaceholder = availableCommands.length > 0
        ? 'Type a message or / for commands...'
        : 'Type a message...';
      if (!promptInput.value.startsWith('/')) {
        promptInput.placeholder = savedPlaceholder;
      }
    }

    // --- State persistence ---
    let chatHistory = [];
    let sessionState = null;

    function saveState() {
      vscode.setState({ chatHistory, sessionState, hasActiveSession });
    }

    function restoreState() {
      const saved = vscode.getState();
      if (!saved) return;

      chatHistory = saved.chatHistory || [];
      sessionState = saved.sessionState || null;
      hasActiveSession = saved.hasActiveSession || false;

      if (hasActiveSession && sessionState) {
        showSessionConnectedFromState(sessionState);
      }

      const assistantItems = [];
      for (let i = 0; i < chatHistory.length; i++) {
        const item = chatHistory[i];
        switch (item.kind) {
          case 'message':
            addMessageDOM(item.role, item.text);
            if (item.role === 'assistant') {
              assistantItems.push({ index: i, text: item.text });
            }
            break;
          case 'thought':
            addThoughtDOM(item.text, item.durationSec || 0);
            break;
          case 'toolCall':
            addToolCallDOM(item.toolCallId, item.title, item.status);
            break;
          case 'plan':
            addPlanDOM(item.plan);
            break;
        }
      }

      // Request markdown rendering for all restored assistant messages
      if (assistantItems.length > 0) {
        vscode.postMessage({ type: 'renderMarkdown', items: assistantItems });
      }
    }

    // Start with input disabled
    if (inputArea) inputArea.classList.add('disabled');
    let currentAssistantEl = null;
    let currentAssistantText = '';
    let currentTurnEl = null;       // .turn container for current response
    let currentToolsListEl = null;  // .turn-tools-list inside current turn
    let currentToolsCountEl = null; // .turn-tools-summary counter
    let currentToolCount = 0;
    let toolCalls = {};

    // --- Resize handle ---
    let inputAreaHeight = 140;
    const MIN_INPUT_HEIGHT = 90;
    const MAX_INPUT_HEIGHT = 400;

    function applyInputHeight(h) {
      inputAreaHeight = Math.max(MIN_INPUT_HEIGHT, Math.min(MAX_INPUT_HEIGHT, h));
      inputArea.style.height = inputAreaHeight + 'px';
    }

    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = inputArea.offsetHeight;
      function onMove(ev) {
        const delta = startY - ev.clientY;
        applyInputHeight(startHeight + delta);
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // --- Auto-resize textarea (within the input area constraints) ---
    promptInput.addEventListener('input', () => {
      // Slash command autocomplete
      const text = promptInput.value;
      if (text.startsWith('/') && availableCommands.length > 0) {
        const firstSpace = text.indexOf(' ');
        const query = (firstSpace > 0 ? text.slice(1, firstSpace) : text.slice(1)).toLowerCase();
        if (firstSpace < 0) {
          // Still typing command name — show filtered popup
          slashFilteredCommands = availableCommands.filter(c =>
            c.name.toLowerCase().startsWith(query)
          );
          if (slashFilteredCommands.length > 0) {
            renderSlashPopup(slashFilteredCommands);
            slashPopup.classList.add('open');
            slashPopupSelectedIdx = 0;
            highlightSlashItem(0);
          } else {
            slashPopup.classList.remove('open');
          }
        } else {
          slashPopup.classList.remove('open');
        }
      } else {
        slashPopup.classList.remove('open');
        if (!text.startsWith('/')) {
          promptInput.placeholder = savedPlaceholder;
        }
      }
    });

    // Send on Enter (Shift+Enter for newline)
    promptInput.addEventListener('keydown', (e) => {
      // Slash popup navigation
      if (slashPopup.classList.contains('open')) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          slashPopupSelectedIdx = Math.min(slashPopupSelectedIdx + 1, slashFilteredCommands.length - 1);
          highlightSlashItem(slashPopupSelectedIdx);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          slashPopupSelectedIdx = Math.max(slashPopupSelectedIdx - 1, 0);
          highlightSlashItem(slashPopupSelectedIdx);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          selectSlashCommand(slashFilteredCommands[slashPopupSelectedIdx]);
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          selectSlashCommand(slashFilteredCommands[slashPopupSelectedIdx]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          slashPopup.classList.remove('open');
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (isProcessing) {
          handleCancel();
        } else {
          handleSend();
        }
      }
    });

    function handleSend() {
      const text = promptInput.value.trim();
      if (!text || isProcessing) return;

      addMessage('user', text);
      promptInput.value = '';
      vscode.postMessage({ type: 'sendPrompt', text });
    }

    function handleCancel() {
      vscode.postMessage({ type: 'cancelTurn' });
    }

    function execCmd(command) {
      vscode.postMessage({ type: 'executeCommand', command });
    }

    // Wire up buttons
    sendStopBtn.addEventListener('click', () => {
      if (isProcessing) {
        handleCancel();
      } else {
        handleSend();
      }
    });

    const welcomeConnectAgent = document.getElementById('welcomeConnectAgent');
    const welcomeAddAgent = document.getElementById('welcomeAddAgent');
    if (welcomeConnectAgent) welcomeConnectAgent.addEventListener('click', () => execCmd('acp.connectAgent'));
    if (welcomeAddAgent) welcomeAddAgent.addEventListener('click', () => execCmd('acp.addAgent'));

    // --- Send/Stop toggle ---
    function setProcessing(processing) {
      isProcessing = processing;
      if (processing) {
        sendStopBtn.className = 'send-stop-btn stop';
        sendStopBtn.textContent = '■ Stop';
        sendStopBtn.disabled = false;
        promptInput.disabled = true;
        statusEl.innerHTML = '<span class="spinner"></span>';
      } else {
        sendStopBtn.className = 'send-stop-btn send';
        sendStopBtn.textContent = 'Send';
        sendStopBtn.disabled = false;
        promptInput.disabled = false;
        statusEl.textContent = '';
      }
    }

    // --- Mode / Model pickers ---

    // --- Slash command helpers ---
    function renderSlashPopup(commands) {
      slashPopup.innerHTML = '<div class="slash-popup-header">Commands</div>';
      commands.forEach((cmd, i) => {
        const item = document.createElement('div');
        item.className = 'slash-popup-item' + (i === 0 ? ' active' : '');
        item.dataset.index = String(i);
        item.innerHTML =
          '<span class="cmd-name">/' + escapeHtml(cmd.name) + '</span>' +
          '<span class="cmd-desc">' + escapeHtml(cmd.description) + '</span>';
        item.addEventListener('click', () => selectSlashCommand(cmd));
        item.addEventListener('mouseenter', () => {
          slashPopupSelectedIdx = i;
          highlightSlashItem(i);
        });
        slashPopup.appendChild(item);
      });
    }

    function highlightSlashItem(idx) {
      const items = slashPopup.querySelectorAll('.slash-popup-item');
      items.forEach((el, i) => el.classList.toggle('active', i === idx));
      if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
    }

    function selectSlashCommand(cmd) {
      slashPopup.classList.remove('open');
      if (!cmd) return;

      if (cmd.input) {
        // Command expects input — insert "/name " and set placeholder to hint
        promptInput.value = '/' + cmd.name + ' ';
        promptInput.placeholder = cmd.input.hint || 'Type input...';
        promptInput.focus();
      } else {
        // No input required — send immediately
        promptInput.value = '/' + cmd.name;
        handleSend();
      }
    }

    // --- Mode / Model pickers (cont.) ---
    function updateModePicker(modes) {
      if (!modes || !modes.availableModes || modes.availableModes.length === 0) {
        modePickerWrap.classList.add('hidden');
        availableModes = [];
        currentModeId = null;
        return;
      }
      availableModes = modes.availableModes;
      currentModeId = modes.currentModeId || null;
      modePickerWrap.classList.remove('hidden');
      const current = availableModes.find(m => m.id === currentModeId);
      modePickerLabel.textContent = current ? current.name : 'Mode';
      modePickerLabel.title = current && current.description ? current.description : '';
      renderModeDropdown();
    }

    function renderModeDropdown() {
      modeDropdown.innerHTML = '';
      for (const mode of availableModes) {
        const item = document.createElement('div');
        item.className = 'picker-dropdown-item' + (mode.id === currentModeId ? ' selected' : '');
        item.innerHTML =
          '<span class="check">' + (mode.id === currentModeId ? '✓' : '') + '</span>' +
          '<span class="item-label">' + escapeHtml(mode.name) + '</span>' +
          (mode.description ? '<span class="item-desc">' + escapeHtml(mode.description) + '</span>' : '');
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          closePickers();
          if (mode.id !== currentModeId) {
            currentModeId = mode.id;
            const current = availableModes.find(m => m.id === currentModeId);
            modePickerLabel.textContent = current ? current.name : 'Mode';
            renderModeDropdown();
            vscode.postMessage({ type: 'setMode', modeId: mode.id });
          }
        });
        modeDropdown.appendChild(item);
      }
    }

    function updateModelPicker(models) {
      if (!models || !models.availableModels || models.availableModels.length === 0) {
        modelPickerWrap.classList.add('hidden');
        availableModels = [];
        currentModelId = null;
        return;
      }
      availableModels = models.availableModels;
      currentModelId = models.currentModelId || null;
      modelPickerWrap.classList.remove('hidden');
      const current = availableModels.find(m => m.modelId === currentModelId);
      modelPickerLabel.textContent = current ? current.name : 'Model';
      modelPickerLabel.title = current && current.description ? current.description : '';
      renderModelDropdown();
    }

    function renderModelDropdown() {
      modelDropdown.innerHTML = '';
      for (const model of availableModels) {
        const item = document.createElement('div');
        item.className = 'picker-dropdown-item' + (model.modelId === currentModelId ? ' selected' : '');
        item.innerHTML =
          '<span class="check">' + (model.modelId === currentModelId ? '✓' : '') + '</span>' +
          '<span class="item-label">' + escapeHtml(model.name) + '</span>' +
          (model.description ? '<span class="item-desc">' + escapeHtml(model.description) + '</span>' : '');
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          closePickers();
          if (model.modelId !== currentModelId) {
            currentModelId = model.modelId;
            const current = availableModels.find(m => m.modelId === currentModelId);
            modelPickerLabel.textContent = current ? current.name : 'Model';
            renderModelDropdown();
            vscode.postMessage({ type: 'setModel', modelId: model.modelId });
          }
        });
        modelDropdown.appendChild(item);
      }
    }

    // Toggle picker dropdowns
    modePickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = modeDropdown.classList.contains('open');
      closePickers();
      if (!wasOpen) modeDropdown.classList.add('open');
    });

    modelPickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = modelDropdown.classList.contains('open');
      closePickers();
      if (!wasOpen) modelDropdown.classList.add('open');
    });

    function closePickers() {
      modeDropdown.classList.remove('open');
      modelDropdown.classList.remove('open');
    }

    // Close pickers when clicking outside
    document.addEventListener('click', () => closePickers());

    // --- Messages ---
    function addMessage(role, text) {
      chatHistory.push({ kind: 'message', role, text });
      saveState();
      return addMessageDOM(role, text);
    }

    function addMessageDOM(role, text) {
      hideEmpty();
      const el = document.createElement('div');
      el.className = 'message ' + role;
      el.textContent = text;
      messagesEl.appendChild(el);
      scrollToBottom();
      return el;
    }

    function hideEmpty() {
      if (emptyState) emptyState.style.display = 'none';
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function getStatusIcon(status) {
      switch (status) {
        case 'running': return '⟳';
        case 'completed': return '✓';
        case 'failed': return '✗';
        default: return '…';
      }
    }

    // Ensure the current turn has a tools container
    function ensureTurnTools() {
      if (!currentTurnEl) {
        // Create turn container if none (e.g., tool call before first text)
        currentTurnEl = document.createElement('div');
        currentTurnEl.className = 'turn';
        messagesEl.appendChild(currentTurnEl);
      }
      if (!currentToolsListEl) {
        const toolsWrap = document.createElement('div');
        toolsWrap.className = 'turn-tools';

        currentToolCount = 0;
        const summary = document.createElement('div');
        summary.className = 'turn-tools-summary';
        summary.textContent = '▸ Tool calls';
        currentToolsCountEl = summary;
        summary.addEventListener('click', () => {
          const list = summary.nextElementSibling;
          if (list) {
            const count = parseInt(summary.dataset.count || '0', 10);
            const collapsed = list.classList.toggle('collapsed');
            summary.textContent = (collapsed ? '▸ ' : '▾ ') + count + ' tool call' + (count !== 1 ? 's' : '');
          }
        });
        toolsWrap.appendChild(summary);

        const list = document.createElement('div');
        list.className = 'turn-tools-list';
        toolsWrap.appendChild(list);
        currentToolsListEl = list;

        currentTurnEl.appendChild(toolsWrap);
      }
    }

    function addToolCall(toolCallId, title, status) {
      chatHistory.push({ kind: 'toolCall', toolCallId, title, status });
      saveState();
      addToolCallInline(toolCallId, title, status);
    }

    function addToolCallInline(toolCallId, title, status) {
      hideEmpty();
      ensureTurnTools();
      currentToolCount++;
      if (currentToolsCountEl) {
        currentToolsCountEl.dataset.count = String(currentToolCount);
        currentToolsCountEl.textContent = '▾ ' + currentToolCount + ' tool call' + (currentToolCount !== 1 ? 's' : '');
      }

      const el = document.createElement('div');
      el.className = 'tool-call-inline';
      el.id = 'tc-' + toolCallId;
      el.innerHTML =
        '<span class="tc-icon ' + status + '">' + getStatusIcon(status) + '</span>' +
        '<span class="tc-title">' + escapeHtml(title || 'Tool Call') + '</span>';
      currentToolsListEl.appendChild(el);
      toolCalls[toolCallId] = el;
      scrollToBottom();
    }

    // Fallback DOM builder for history restore (standalone card)
    function addToolCallDOM(toolCallId, title, status) {
      hideEmpty();
      const el = document.createElement('div');
      el.className = 'tool-call';
      el.id = 'tc-' + toolCallId;
      el.innerHTML = '<span class="title">' + escapeHtml(title || 'Tool Call') + '</span>'
        + '<span class="status-badge ' + status + '">' + status + '</span>';
      messagesEl.appendChild(el);
      toolCalls[toolCallId] = el;
      scrollToBottom();
    }

    function updateToolCall(toolCallId, status, title) {
      for (let i = chatHistory.length - 1; i >= 0; i--) {
        if (chatHistory[i].kind === 'toolCall' && chatHistory[i].toolCallId === toolCallId) {
          chatHistory[i].status = status;
          if (title) chatHistory[i].title = title;
          break;
        }
      }
      saveState();

      const el = toolCalls[toolCallId] || document.getElementById('tc-' + toolCallId);
      if (!el) return;

      // Inline style (turn-based)
      const iconEl = el.querySelector('.tc-icon');
      if (iconEl) {
        iconEl.className = 'tc-icon ' + status;
        iconEl.textContent = getStatusIcon(status);
        if (title) {
          const titleEl = el.querySelector('.tc-title');
          if (titleEl) titleEl.textContent = title;
        }
        return;
      }
      // Legacy card style fallback
      const badge = el.querySelector('.status-badge');
      if (badge) {
        badge.className = 'status-badge ' + status;
        badge.textContent = status;
      }
      if (title) {
        const titleEl = el.querySelector('.title');
        if (titleEl) titleEl.textContent = title;
      }
    }

    function addPlan(plan) {
      chatHistory.push({ kind: 'plan', plan: plan });
      saveState();
      addPlanDOM(plan);
    }

    function addPlanDOM(plan) {
      hideEmpty();
      const el = document.createElement('div');
      el.className = 'plan';
      let html = '<div class="plan-title">Plan</div>';
      if (plan.entries) {
        for (const entry of plan.entries) {
          const icon = entry.status === 'completed' ? '✅'
            : entry.status === 'in_progress' ? '🔄' : '⬜';
          const cls = entry.status === 'completed' ? ' completed' : '';
          html += '<div class="plan-entry' + cls + '">'
            + icon + ' ' + escapeHtml(entry.title || entry.description || entry.content || '')
            + '</div>';
        }
      }
      el.innerHTML = html;
      messagesEl.appendChild(el);
      scrollToBottom();
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function finalizeThought() {
      if (!currentThoughtEl) return;
      if (thoughtEndTime) return; // already finalized
      thoughtEndTime = Date.now();
      currentThoughtEl.classList.remove('streaming');
      const elapsed = thoughtStartTime ? Math.round((thoughtEndTime - thoughtStartTime) / 1000) : 0;
      const summary = currentThoughtEl.querySelector('summary');
      if (summary) {
        summary.innerHTML = elapsed > 0
          ? 'Thought for ' + elapsed + 's'
          : 'Thought';
      }
    }

    function addThoughtDOM(text, durationSec) {
      hideEmpty();
      const el = document.createElement('details');
      el.className = 'thought-block';
      el.innerHTML =
        '<summary>' + (durationSec > 0 ? 'Thought for ' + durationSec + 's' : 'Thought') + '</summary>' +
        '<div class="thought-content">' + escapeHtml(text) + '</div>';
      messagesEl.appendChild(el);
      scrollToBottom();
    }

    function showSessionConnected(session) {
      hasActiveSession = true;
      sessionState = { agentName: session.agentName, cwd: session.cwd };
      saveState();
      showSessionConnectedFromState(sessionState);

      // Update pickers from session data
      if (session.modes) updateModePicker(session.modes);
      if (session.models) updateModelPicker(session.models);
      // Restore available commands
      if (session.availableCommands) {
        availableCommands = session.availableCommands;
      }
      updatePlaceholder();
    }

    function showSessionConnectedFromState(ss) {
      hasActiveSession = true;
      hideEmpty();
      if (bannerAgent) bannerAgent.textContent = ss.agentName || 'Agent';
      if (bannerCwd) bannerCwd.textContent = ss.cwd || '';
      if (sessionBanner) sessionBanner.classList.add('visible');
      if (inputArea) inputArea.classList.remove('disabled');
      promptInput.disabled = false;
    }

    function showNoSession() {
      hasActiveSession = false;
      sessionState = null;
      saveState();
      if (sessionBanner) sessionBanner.classList.remove('visible');
      if (emptyState) emptyState.style.display = '';
      if (inputArea) inputArea.classList.add('disabled');
      // Hide pickers when disconnected
      modePickerWrap.classList.add('hidden');
      modelPickerWrap.classList.add('hidden');
    }

    // Handle messages from the extension
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'state':
          if (msg.session) {
            showSessionConnected(msg.session);
          } else {
            showNoSession();
          }
          break;

        case 'promptStart':
          setProcessing(true);
          currentAssistantEl = null;
          currentAssistantText = '';
          currentTurnEl = null;
          currentToolsListEl = null;
          currentToolsCountEl = null;
          currentToolCount = 0;
          currentThoughtEl = null;
          currentThoughtTextEl = null;
          currentThoughtText = '';
          thoughtStartTime = null;
          thoughtEndTime = null;
          break;

        case 'promptEnd':
          // Finalize thought block if present
          if (currentThoughtText) {
            finalizeThought();
            const tEnd = thoughtEndTime || Date.now();
            chatHistory.push({
              kind: 'thought',
              text: currentThoughtText,
              durationSec: thoughtStartTime ? Math.round((tEnd - thoughtStartTime) / 1000) : 0,
            });
          }
          if (currentAssistantText) {
            chatHistory.push({ kind: 'message', role: 'assistant', text: currentAssistantText });
            saveState();
            // Request markdown rendering from extension host
            if (currentAssistantEl) {
              vscode.postMessage({
                type: 'renderMarkdown',
                items: [{ index: chatHistory.length - 1, text: currentAssistantText }]
              });
            }
          }
          setProcessing(false);
          currentAssistantEl = null;
          currentAssistantText = '';
          // Auto-collapse tool calls in completed turns
          if (currentToolsListEl && currentToolCount > 3) {
            currentToolsListEl.classList.add('collapsed');
            if (currentToolsCountEl) {
              currentToolsCountEl.dataset.count = String(currentToolCount);
              currentToolsCountEl.textContent = '▸ ' + currentToolCount + ' tool calls';
            }
          }
          currentTurnEl = null;
          currentToolsListEl = null;
          currentToolsCountEl = null;
          currentToolCount = 0;
          currentThoughtEl = null;
          currentThoughtTextEl = null;
          currentThoughtText = '';
          thoughtStartTime = null;
          thoughtEndTime = null;
          break;

        case 'clearChat':
          chatHistory = [];
          sessionState = null;
          saveState();
          currentAssistantEl = null;
          currentAssistantText = '';
          toolCalls = {};
          currentTurnEl = null;
          currentToolsListEl = null;
          currentToolsCountEl = null;
          currentToolCount = 0;
          currentThoughtEl = null;
          currentThoughtTextEl = null;
          currentThoughtText = '';
          thoughtStartTime = null;
          thoughtEndTime = null;
          availableCommands = [];
          slashPopup.classList.remove('open');
          messagesEl.innerHTML = '';
          messagesEl.appendChild(emptyState);
          if (emptyState) emptyState.style.display = '';
          if (sessionBanner) sessionBanner.classList.remove('visible');
          if (inputArea) inputArea.classList.add('disabled');
          modePickerWrap.classList.add('hidden');
          modelPickerWrap.classList.add('hidden');
          setProcessing(false);
          break;

        case 'error':
          addMessage('error', msg.message || 'An error occurred');
          break;

        case 'sessionUpdate':
          handleUpdate(msg.update);
          break;

        case 'modesUpdate':
          updateModePicker(msg.modes);
          break;

        case 'modelsUpdate':
          updateModelPicker(msg.models);
          break;

        case 'markdownRendered': {
          // Extension sent back rendered HTML for messages
          const rendered = msg.items || [];
          for (const item of rendered) {
            // Find the DOM element for this history item
            // For the just-completed streaming message, update the last assistant el
            const historyItem = chatHistory[item.index];
            if (!historyItem || historyItem.role !== 'assistant') continue;

            // Find the element — walk all .message.assistant elements
            const allAssistant = messagesEl.querySelectorAll('.message.assistant');
            // The item.index tracks position in chatHistory; count only assistant messages up to this index
            let assistantIdx = 0;
            for (let i = 0; i < chatHistory.length; i++) {
              if (i === item.index) break;
              if (chatHistory[i].kind === 'message' && chatHistory[i].role === 'assistant') assistantIdx++;
            }
            const el = allAssistant[assistantIdx];
            if (el) {
              el.classList.add('md-rendered');
              el.innerHTML = item.html;
            }
          }
          scrollToBottom();
          break;
        }
      }
    });

    function handleUpdate(update) {
      if (!update) return;
      const type = update.sessionUpdate;

      switch (type) {
        case 'agent_message_chunk': {
          const content = update.content;
          if (content && content.type === 'text' && content.text) {
            currentAssistantText += content.text;
            // Don't create visible element until there's non-whitespace content
            if (!currentAssistantEl && !currentAssistantText.trim()) {
              break;
            }
            // Auto-collapse thought when assistant text starts
            if (currentThoughtEl && currentThoughtEl.open) {
              finalizeThought();
              currentThoughtEl.open = false;
            }
            if (!currentAssistantEl) {
              // Create a turn container, assistant text goes inside it
              if (!currentTurnEl) {
                currentTurnEl = document.createElement('div');
                currentTurnEl.className = 'turn';
                messagesEl.appendChild(currentTurnEl);
                hideEmpty();
              }
              currentAssistantEl = document.createElement('div');
              currentAssistantEl.className = 'message assistant';
              currentTurnEl.insertBefore(currentAssistantEl, currentTurnEl.querySelector('.turn-tools'));
            }
            currentAssistantEl.textContent = currentAssistantText;
            scrollToBottom();
          }
          break;
        }

        case 'user_message_chunk':
          break;

        case 'agent_thought_chunk': {
          const content = update.content;
          if (content && content.type === 'text') {
            if (!currentThoughtEl) {
              // Create thought block inside turn
              if (!currentTurnEl) {
                currentTurnEl = document.createElement('div');
                currentTurnEl.className = 'turn';
                messagesEl.appendChild(currentTurnEl);
                hideEmpty();
              }
              currentThoughtEl = document.createElement('details');
              currentThoughtEl.className = 'thought-block streaming';
              currentThoughtEl.open = true;
              currentThoughtEl.innerHTML =
                '<summary><span class="thought-indicator"></span> Thinking\u2026</summary>' +
                '<div class="thought-content"></div>';
              currentThoughtTextEl = currentThoughtEl.querySelector('.thought-content');
              currentTurnEl.insertBefore(currentThoughtEl, currentTurnEl.firstChild);
              thoughtStartTime = Date.now();
              currentThoughtText = '';
            }
            currentThoughtText += content.text;
            currentThoughtTextEl.textContent = currentThoughtText;
            scrollToBottom();
          }
          break;
        }

        case 'tool_call': {
          const tc = update;
          addToolCall(
            tc.toolCallId || 'unknown',
            tc.title || 'Tool Call',
            tc.status || 'pending',
          );
          break;
        }

        case 'tool_call_update': {
          updateToolCall(
            update.toolCallId || 'unknown',
            update.status || 'completed',
            update.title,
          );
          break;
        }

        case 'plan': {
          addPlan(update);
          break;
        }

        case 'current_mode_update': {
          // Server pushed a mode change
          currentModeId = update.currentModeId || update.modeId || null;
          const current = availableModes.find(m => m.id === currentModeId);
          if (current) {
            modePickerLabel.textContent = current.name;
            renderModeDropdown();
          }
          break;
        }

        case 'available_commands_update':
          availableCommands = update.availableCommands || [];
          updatePlaceholder();
          break;
      }
    }

    // Restore previous state before telling extension we're ready
    restoreState();

    // Tell extension we're ready
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  /**
   * Attach a file URI — notify the webview to include it in the next prompt.
   */
  attachFile(uri: vscode.Uri): void {
    if (this.view) {
      this.view.webview.postMessage({
        type: 'file-attached',
        path: uri.fsPath,
        name: uri.fsPath.split(/[\\/]/).pop() || uri.fsPath,
      });
      this.view.show?.(true);
    }
  }

  dispose(): void {
    this.sessionUpdateHandler.removeListener(this.updateListener);
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
