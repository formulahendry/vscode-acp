import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { SessionUpdateListener } from './SessionUpdateHandler';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { logError } from '../utils/Logger';

interface ActiveToolCall {
  toolCallId: string;
  kind?: string | null;
  title?: string | null;
  status?: string | null;
  locations?: Array<{ path: string; line?: number | null }> | null;
  content?: Array<any> | null;
  rawInput?: unknown;
}

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
  private activeToolCalls = new Map<string, ActiveToolCall>();
  private highlightedToolCalls = new Set<string>();

  private readonly editDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  readonly listener: SessionUpdateListener;

  constructor() {
    this.listener = (update: SessionNotification) => {
      this.handleUpdate(update);
    };
  }

  private handleUpdate(update: SessionNotification): void {
    const u = (update as any).update;
    if (!u || (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update')) { return; }

    const toolCall = this.mergeToolCallUpdate(u);
    if (!this.isEditToolCall(toolCall)) { return; }

    const filePaths = this.extractFilePaths(toolCall);
    if (filePaths.length === 0) { return; }

    const status = toolCall.status ?? (u.sessionUpdate === 'tool_call' ? 'pending' : undefined);
    if (status === 'pending' || status === 'in_progress') {
      for (const filePath of filePaths) {
        void this.cacheOldContent(filePath);
      }
      void this.showActiveEdit(toolCall, filePaths[0]);
    } else if (status === 'completed') {
      this.clearToolCallDecoration(toolCall.toolCallId);
      // Small delay to let the filesystem settle
      for (const filePath of filePaths) {
        setTimeout(() => this.showDiff(filePath), 100);
      }
      this.activeToolCalls.delete(toolCall.toolCallId);
    } else if (status === 'failed') {
      this.clearToolCallDecoration(toolCall.toolCallId);
      this.activeToolCalls.delete(toolCall.toolCallId);
    }
  }

  private mergeToolCallUpdate(update: any): ActiveToolCall {
    const toolCallId = update.toolCallId || 'unknown';
    const previous: ActiveToolCall = this.activeToolCalls.get(toolCallId) ?? { toolCallId };
    const merged: ActiveToolCall = {
      ...previous,
      ...update,
      toolCallId,
      kind: update.kind ?? previous.kind,
      title: update.title ?? previous.title,
      status: update.status ?? previous.status,
      locations: update.locations ?? previous.locations,
      content: update.content ?? previous.content,
      rawInput: update.rawInput ?? previous.rawInput,
    };
    this.activeToolCalls.set(toolCallId, merged);
    return merged;
  }

  private isEditToolCall(update: ActiveToolCall): boolean {
    if (update.kind === 'edit') { return true; }
    if (update.content?.some(item => item?.type === 'diff')) { return true; }

    const title = update.title || '';
    return /\b(write|edit|patch|modify|update|create|delete|move|rename)_?(file)?\b/i.test(title);
  }

  private extractFilePaths(update: ActiveToolCall): string[] {
    const paths = new Set<string>();

    // Prefer locations array (most reliable)
    const locations = update.locations;
    if (locations && locations.length > 0) {
      for (const location of locations) {
        this.addPath(paths, location.path);
      }
    }

    for (const item of update.content ?? []) {
      if (item?.type === 'diff') {
        this.addPath(paths, item.path);
      }
    }

    this.collectPathsFromValue(paths, update.rawInput);

    // Fall back to parsing title: "write_file /abs/path/to/file.ts"
    const title: string = update.title || '';
    const absMatch = title.match(/(?:\s|^)(\/[^\s]+)/);
    if (absMatch) { this.addPath(paths, absMatch[1]); }

    return [...paths];
  }

  private addPath(paths: Set<string>, filePath: unknown): void {
    if (typeof filePath !== 'string' || filePath.length === 0) { return; }
    paths.add(this.normalizePath(filePath));
  }

  private normalizePath(filePath: string): string {
    if (path.isAbsolute(filePath)) { return filePath; }

    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return path.resolve(workspacePath ?? process.cwd(), filePath);
  }

  private collectPathsFromValue(paths: Set<string>, value: unknown, depth = 0): void {
    if (!value || depth > 3) { return; }

    if (typeof value === 'string') {
      if (path.isAbsolute(value)) {
        this.addPath(paths, value);
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        this.collectPathsFromValue(paths, item, depth + 1);
      }
      return;
    }

    if (typeof value !== 'object') { return; }

    for (const [key, item] of Object.entries(value)) {
      if (/^(path|file|filePath|filepath|filename|targetPath|sourcePath)$/i.test(key)) {
        this.addPath(paths, item);
      } else {
        this.collectPathsFromValue(paths, item, depth + 1);
      }
    }
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
        `${path.basename(absPath)} (before -> after)`
      );
    } catch {
      // File may have been deleted or become inaccessible — skip diff
    }
  }

  private async showActiveEdit(toolCall: ActiveToolCall, absPath: string): Promise<void> {
    try {
      const uri = vscode.Uri.file(absPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        preview: true,
        preserveFocus: true,
      });

      this.highlightedToolCalls.add(toolCall.toolCallId);
      this.refreshDecorations();
    } catch (e) {
      logError(`Failed to show active edit: ${absPath}`, e);
    }
  }

  private getDecorationRanges(toolCall: ActiveToolCall, doc: vscode.TextDocument): vscode.Range[] {
    const lineNumbers = (toolCall.locations ?? [])
      .filter(location => this.normalizePath(location.path) === doc.uri.fsPath && typeof location.line === 'number')
      .map(location => Math.max(0, Math.min(doc.lineCount - 1, (location.line ?? 1) - 1)));

    if (lineNumbers.length === 0) {
      const lastLine = Math.max(0, doc.lineCount - 1);
      return [new vscode.Range(0, 0, lastLine, doc.lineAt(lastLine).range.end.character)];
    }

    return lineNumbers.map(line => doc.lineAt(line).range);
  }

  private clearToolCallDecoration(toolCallId: string): void {
    if (!this.highlightedToolCalls.has(toolCallId)) { return; }

    this.highlightedToolCalls.delete(toolCallId);
    this.refreshDecorations();
  }

  private refreshDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const ranges: vscode.Range[] = [];
      for (const toolCallId of this.highlightedToolCalls) {
        const toolCall = this.activeToolCalls.get(toolCallId);
        if (toolCall && this.extractFilePaths(toolCall).includes(editor.document.uri.fsPath)) {
          ranges.push(...this.getDecorationRanges(toolCall, editor.document));
        }
      }

      editor.setDecorations(this.editDecoration, ranges);
    }
  }

  dispose(): void {
    this.pendingWrites.clear();
    this.activeToolCalls.clear();
    this.highlightedToolCalls.clear();
    this.editDecoration.dispose();
  }
}
