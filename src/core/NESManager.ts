import * as vscode from 'vscode';
import type { ClientSideConnection } from '@agentclientprotocol/sdk';

import { log, logError } from '../utils/Logger';

/** ACP NES edit suggestion as returned by nes/suggest. */
export interface NESSuggestion {
  id: string;
  kind: 'edit';
  uri: string;
  edits: {
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    newText: string;
  }[];
  cursorPosition?: { line: number; character: number };
}

/** Debounce delay before sending nes/suggest (ms). */
const SUGGEST_DEBOUNCE_MS = 300;

/**
 * Manages the NES (Next Edit Suggestion) lifecycle for an ACP agent connection.
 *
 * Responsibilities:
 * - Starts an NES session via extMethod("nes/start")
 * - Forwards VS Code document events to the agent via extNotification
 * - Requests suggestions via extMethod("nes/suggest")
 * - Sends accept/reject notifications via extNotification
 */
export class NESManager {
  private nesSessionId: string | null = null;
  private connection: ClientSideConnection | null = null;
  private disposables: vscode.Disposable[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Start NES for a connection.
   * Called after successful agent connection + auth.
   */
  async start(connection: ClientSideConnection): Promise<void> {
    this.connection = connection;

    try {
      const result = await connection.extMethod('nes/start', {
        workspaceUri: vscode.workspace.workspaceFolders?.[0]?.uri.toString(),
        workspaceFolders: vscode.workspace.workspaceFolders?.map(f => ({
          uri: f.uri.toString(),
          name: f.name,
        })),
      });
      this.nesSessionId = result.sessionId as string;
      log(`NESManager: started NES session ${this.nesSessionId}`);
    } catch (e) {
      logError('NESManager: failed to start NES session', e);
      return;
    }

    this.registerDocumentListeners();
    this.syncOpenDocuments();
  }

  /**
   * Request a suggestion for the current cursor position.
   */
  async suggest(
    document: vscode.TextDocument,
    position: vscode.Position,
    triggerKind: 'automatic' | 'manual',
    token: vscode.CancellationToken,
  ): Promise<NESSuggestion[] | null> {
    if (!this.connection || !this.nesSessionId) {
      return null;
    }

    // Debounce: wait before sending to avoid flooding on rapid typing
    await this.debounce(token);
    if (token.isCancellationRequested) {
      return null;
    }

    try {
      const result = await this.connection.extMethod('nes/suggest', {
        sessionId: this.nesSessionId,
        uri: document.uri.toString(),
        version: document.version,
        position: { line: position.line, character: position.character },
        triggerKind,
      });
      return (result.suggestions as NESSuggestion[]) ?? null;
    } catch (e) {
      logError('NESManager: nes/suggest failed', e);
      return null;
    }
  }

  /** Notify agent that user accepted a suggestion. */
  accept(id: string): void {
    if (!this.connection) { return; }
    log(`NESManager: accept ${id}`);
    void this.connection.extNotification('nes/accept', { sessionId: this.nesSessionId, id });
  }

  /** Notify agent that user rejected/ignored a suggestion. */
  reject(id: string, reason: 'rejected' | 'ignored' | 'replaced'): void {
    if (!this.connection) { return; }
    log(`NESManager: reject ${id} (${reason})`);
    void this.connection.extNotification('nes/reject', { sessionId: this.nesSessionId, id, reason });
  }

  /** Whether NES is currently active. */
  get isActive(): boolean {
    return this.nesSessionId !== null;
  }

  /** Stop NES and clean up listeners. */
  stop(): void {
    log('NESManager: stopping');
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.nesSessionId = null;
    this.connection = null;
  }

  dispose(): void {
    this.stop();
  }

  // --- Private ---

  private debounce(token: vscode.CancellationToken): Promise<void> {
    return new Promise<void>(resolve => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(resolve, SUGGEST_DEBOUNCE_MS);
      token.onCancellationRequested(() => {
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
          this.debounceTimer = null;
        }
        resolve();
      });
    });
  }

  private registerDocumentListeners(): void {
    if (!this.connection) { return; }
    const conn = this.connection;

    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument(doc => {
        if (doc.uri.scheme !== 'file') { return; }
        void conn.extNotification('document/didOpen', {
          uri: doc.uri.toString(),
          languageId: doc.languageId,
          version: doc.version,
          text: doc.getText(),
        });
      }),

      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.uri.scheme !== 'file') { return; }
        if (event.contentChanges.length === 0) { return; }
        void conn.extNotification('document/didChange', {
          sessionId: this.nesSessionId,
          uri: event.document.uri.toString(),
          version: event.document.version,
          contentChanges: event.contentChanges.map(c => ({
            range: {
              start: { line: c.range.start.line, character: c.range.start.character },
              end: { line: c.range.end.line, character: c.range.end.character },
            },
            text: c.text,
          })),
        });
      }),

      vscode.workspace.onDidCloseTextDocument(doc => {
        if (doc.uri.scheme !== 'file') { return; }
        void conn.extNotification('document/didClose', {
          sessionId: this.nesSessionId,
          uri: doc.uri.toString(),
        });
      }),

      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (!editor || editor.document.uri.scheme !== 'file') { return; }
        void conn.extNotification('document/didFocus', {
          sessionId: this.nesSessionId,
          uri: editor.document.uri.toString(),
          version: editor.document.version,
          position: {
            line: editor.selection.active.line,
            character: editor.selection.active.character,
          },
          visibleRange: {
            start: { line: editor.visibleRanges[0]?.start.line ?? 0, character: 0 },
            end: { line: editor.visibleRanges[0]?.end.line ?? 0, character: 0 },
          },
        });
      }),
    );
  }

  private syncOpenDocuments(): void {
    if (!this.connection) { return; }
    const conn = this.connection;

    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === 'file') {
        void conn.extNotification('document/didOpen', {
          sessionId: this.nesSessionId,
          uri: doc.uri.toString(),
          languageId: doc.languageId,
          version: doc.version,
          text: doc.getText(),
        });
      }
    }

    // Send didFocus for the currently active editor
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.scheme === 'file') {
      void conn.extNotification('document/didFocus', {
        sessionId: this.nesSessionId,
        uri: activeEditor.document.uri.toString(),
        version: activeEditor.document.version,
        position: {
          line: activeEditor.selection.active.line,
          character: activeEditor.selection.active.character,
        },
        visibleRange: {
          start: { line: activeEditor.visibleRanges[0]?.start.line ?? 0, character: 0 },
          end: { line: activeEditor.visibleRanges[0]?.end.line ?? 0, character: 0 },
        },
      });
    }
  }
}
