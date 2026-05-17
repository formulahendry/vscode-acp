import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { SessionUpdateListener } from './SessionUpdateHandler';
import type { SessionNotification } from '@agentclientprotocol/sdk';

/**
 * Shows a diff view when an agent edits files through tool calls.
 *
 * Reasonix (and possibly other agents) writes files directly via Node.js fs
 * rather than calling the ACP writeTextFile method. This handler intercepts
 * session/update notifications for edit-kind tool calls, snapshots the old
 * content before the write, and opens a vscode.diff view afterwards.
 */
export class DiffPreviewHandler {
  private pendingWrites = new Map<string, string>(); // absPath → oldContent

  readonly listener: SessionUpdateListener;

  constructor() {
    this.listener = (update: SessionNotification) => {
      this.handleUpdate(update);
    };
  }

  private handleUpdate(update: SessionNotification): void {
    const u = update as any;
    if (u.sessionUpdate !== 'tool_call_update') { return; }
    if (u.kind !== 'edit') { return; }

    const filePath = this.extractFilePath(u);
    if (!filePath) { return; }

    const status = u.status;
    if (status === 'pending' || status === 'in_progress') {
      this.cacheOldContent(filePath);
    } else if (status === 'completed') {
      // Small delay to let the filesystem settle
      setTimeout(() => this.showDiff(filePath), 100);
    }
  }

  private extractFilePath(update: any): string | null {
    // Prefer locations array (most reliable)
    const locations = update.locations;
    if (locations && locations.length > 0) {
      const p = locations[0].path || locations[0].uri?.path;
      if (p) { return p; }
    }

    // Fall back to parsing title: "write_file /abs/path/to/file.ts"
    const title: string = update.title || '';
    const absMatch = title.match(/(?:\s|^)(\/[^\s]+)/);
    if (absMatch) { return absMatch[1]; }

    return null;
  }

  private async cacheOldContent(absPath: string): Promise<void> {
    if (this.pendingWrites.has(absPath)) { return; }

    const uri = vscode.Uri.file(absPath);

    // Prefer open editor content (may have unsaved changes)
    const openDoc = vscode.workspace.textDocuments.find(
      doc => doc.uri.fsPath === uri.fsPath
    );
    if (openDoc) {
      this.pendingWrites.set(absPath, openDoc.getText());
      return;
    }

    // Read from disk — best-effort, may lose a race with the agent's write
    try {
      const raw = await vscode.workspace.fs.readFile(uri);
      this.pendingWrites.set(absPath, Buffer.from(raw).toString('utf-8'));
    } catch {
      // File doesn't exist yet (new file) — no diff needed
    }
  }

  private async showDiff(absPath: string): Promise<void> {
    const oldContent = this.pendingWrites.get(absPath);
    this.pendingWrites.delete(absPath);

    try {
      const uri = vscode.Uri.file(absPath);
      const raw = await vscode.workspace.fs.readFile(uri);
      const newContent = Buffer.from(raw).toString('utf-8');

      if (oldContent === undefined) {
        // New file — open in editor
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
        return;
      }

      if (oldContent === newContent) { return; }

      const tmpDir = path.join(os.tmpdir(), 'vscode-acp-diffs');
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(tmpDir));
      const oldUri = vscode.Uri.file(path.join(tmpDir, path.basename(absPath)));
      await vscode.workspace.fs.writeFile(oldUri, Buffer.from(oldContent, 'utf-8'));

      await vscode.commands.executeCommand(
        'vscode.diff',
        oldUri,
        uri,
        `${path.basename(absPath)} (before → after)`
      );
    } catch {
      // File may have been deleted or become inaccessible — skip diff
    }
  }

  dispose(): void {
    this.pendingWrites.clear();
  }
}
