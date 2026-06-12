import * as crypto from 'crypto';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { log } from '../utils/Logger';
import { SessionUpdateHandler } from './SessionUpdateHandler';
import { DIFF_URI_SCHEME } from './DiffContentProvider';

import type { SessionNotification, ToolCall, ToolCallUpdate, ToolCallContent } from '@agentclientprotocol/sdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Kinds that modify files on disk — only these trigger diff preview. */
function isEditKind(kind: string | undefined | null, title?: string | null): boolean {
  if (kind === 'edit' || kind === 'delete' || kind === 'move') { return true; }
  // Some agents (e.g. Hermes) don't send `kind` — fall back to title heuristics
  // Require both an edit verb AND a file reference to reduce false positives
  if (!kind && title) {
    const hasEditVerb = /\b(write|edit|patch|create|delete|move|rename|replace)\b/i.test(title);
    const hasFileRef = /(?:\/[\w.\-]+)+|\b[\w.\-]+\.[a-z]{1,5}\b/i.test(title);
    return hasEditVerb && hasFileRef;
  }
  return false;
}

/**
 * Build an `acp-diff:` URI with the old content base64-encoded in the query.
 * The registered AcpDiffContentProvider decodes it when VS Code renders the
 * diff editor.
 */
function createOldContentUri(filePath: string, oldContent: string): vscode.Uri {
  const fileName = path.basename(filePath);
  // Use a short hash of the full path to avoid collisions between
  // same-named files in different directories (e.g. src/a/config.ts vs src/b/config.ts)
  const hash = crypto.createHash('md5').update(filePath).digest('hex').slice(0, 8);
  const uniqueName = `${hash}_${fileName}`;
  return vscode.Uri.parse(`${DIFF_URI_SCHEME}:${uniqueName}`)
    .with({ query: Buffer.from(oldContent).toString('base64') });
}

/**
 * Synchronously snapshot the current file content.
 *
 * 1. Prefer the open editor (may hold unsaved changes).
 * 2. Fall back to `fs.readFileSync`.
 * 3. Return `undefined` for new files.
 *
 * MUST stay synchronous — called from the session/update listener path.
 */
function snapshotOldContent(filePath: string): string | undefined {
  const openDoc = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.fsPath === filePath,
  );
  if (openDoc) { return openDoc.getText(); }

  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * Extract the most relevant file path from a tool call / update.
 *
 * Priority (ACP spec):
 * 1. `locations[].path`
 * 2. `content[].path` (diff content)
 * 3. `rawInput` recursive key scan
 * 4. `title` regex fallback
 */
function extractFilePaths(toolCall: ToolCall | ToolCallUpdate): string[] {
  // Priority 1
  if (toolCall.locations && toolCall.locations.length > 0) {
    const paths = toolCall.locations
      .map((l) => l.path)
      .filter((p): p is string => !!p);
    if (paths.length > 0) { return paths; }
  }

  // Priority 2
  if (toolCall.content && toolCall.content.length > 0) {
    for (const c of toolCall.content) {
      if (c.type === 'diff' && 'path' in c) {
        const diff = c as { path?: string };
        if (diff.path) { return [diff.path]; }
      }
    }
  }

  // Priority 3
  if (toolCall.rawInput !== undefined && toolCall.rawInput !== null) {
    const paths = scanRawInputForPaths(toolCall.rawInput);
    if (paths.length > 0) { return paths; }
  }

  // Priority 4 — title regex (handles both absolute and relative paths)
  if (toolCall.title) {
    // Try absolute path first (Unix-style)
    const absMatches = toolCall.title.match(/(?:\/[\w.\-]+)+/g);
    if (absMatches && absMatches.length > 0) { return absMatches; }
    // Try relative path with file extension (e.g. "patch (replace): index.html")
    const relMatch = toolCall.title.match(/(?:^|:\s*)([\w.\-\/\\]+\.[a-z]{1,5})\b/i);
    if (relMatch && relMatch[1]) { return [relMatch[1]]; }
  }

  return [];
}

const RAW_INPUT_PATH_KEYS = new Set([
  'path',
  'file',
  'filePath',
  'filepath',
  'filename',
  'targetPath',
  'sourcePath',
]);

/** Convert a possibly-relative file path to absolute using workspace root. */
function normalizePath(filePath: string): string {
  if (path.isAbsolute(filePath)) { return filePath; }
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return path.resolve(workspacePath || process.cwd(), filePath);
}

/** Recursively scan an unknown value for file-path-shaped values. */
function scanRawInputForPaths(obj: unknown): string[] {
  const results: string[] = [];

  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') { return; }

    if (Array.isArray(value)) {
      for (const item of value) { walk(item); }
      return;
    }

    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const val = record[key];
      if (RAW_INPUT_PATH_KEYS.has(key) && typeof val === 'string' && val.includes('/')) {
        results.push(val);
      } else if (typeof val === 'object') {
        walk(val);
      }
    }
  };

  walk(obj);
  return results;
}

// ---------------------------------------------------------------------------
// Diff line decoration
// ---------------------------------------------------------------------------

/**
 * Decoration style used to highlight the line being edited.
 *
 * A module-level singleton is fine because each editor tracks ranges per
 * decoration type independently. We clear ranges on cleanup.
 */
const editDecoration = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
  overviewRulerLane: vscode.OverviewRulerLane.Right,
});

// ---------------------------------------------------------------------------
// Active-edit bookkeeping
// ---------------------------------------------------------------------------

interface ActiveEdit {
  filePath: string;
  oldContent: string;
  oldUri: vscode.Uri;
  /** Line number (1-based) extracted from locations, or undefined. */
  line: number | undefined;
}

// ---------------------------------------------------------------------------
// DiffPreviewHandler
// ---------------------------------------------------------------------------

/**
 * Listens to `session/update` notifications and provides inline diff preview
 * for file-editing tool calls.
 *
 * Lifecycle
 * ---------
 * 1. **pending / in_progress** – snapshot old content, highlight the target
 *    line in the open editor.
 * 2. **tool_call_update** – optionally update the highlighted line.
 * 3. **completed** – open VS Code diff editor (old ↔ current), clean up.
 * 4. **failed** – clean up without showing a diff.
 * 5. **dispose()** – remove the session-update listener, clear decorations.
 */
export class DiffPreviewHandler {
  private activeEdits = new Map<string, ActiveEdit>();
  private boundOnUpdate: (update: SessionNotification) => void;

  constructor(private sessionUpdateHandler: SessionUpdateHandler) {
    this.boundOnUpdate = this.onUpdate.bind(this);
    this.sessionUpdateHandler.addListener(this.boundOnUpdate);
    log('DiffPreviewHandler initialized');
  }

  // -----------------------------------------------------------------------
  // Public interface
  // -----------------------------------------------------------------------

  dispose(): void {
    this.sessionUpdateHandler.removeListener(this.boundOnUpdate);
    this.cleanupAll();
    editDecoration.dispose();
    log('DiffPreviewHandler disposed');
  }

  // -----------------------------------------------------------------------
  // Session update listener
  // -----------------------------------------------------------------------

  private onUpdate = (notification: SessionNotification): void => {
    const update = notification.update;

    if (update.sessionUpdate === 'tool_call') {
      this.handleToolCall(update as ToolCall & { sessionUpdate: 'tool_call' });
    } else if (update.sessionUpdate === 'tool_call_update') {
      this.handleToolCallUpdate(update as ToolCallUpdate & { sessionUpdate: 'tool_call_update' });
    }
  };

  // -----------------------------------------------------------------------
  // Tool-call handling
  // -----------------------------------------------------------------------

  private handleToolCall(toolCall: ToolCall & { sessionUpdate: 'tool_call' }): void {
    if (!isEditKind(toolCall.kind, toolCall.title)) { return; }

    const status = toolCall.status ?? 'pending';

    if (status === 'pending' || status === 'in_progress') {
      this.startEdit(toolCall);
    } else if (status === 'completed') {
      this.finishEdit(toolCall);
    } else if (status === 'failed') {
      this.cleanupEdit(toolCall.toolCallId);
    }
  }

  private handleToolCallUpdate(update: ToolCallUpdate & { sessionUpdate: 'tool_call_update' }): void {
    // Status transition inside an update (some agents complete via update).
    if (update.status === 'completed') {
      this.finishEditFromUpdate(update);
      return;
    }
    if (update.status === 'failed') {
      this.cleanupEdit(update.toolCallId);
      return;
    }

    // Update decoration line if locations changed.
    if (update.locations && update.locations.length > 0) {
      this.updateDecorationLine(update.toolCallId, update.locations[0].line ?? undefined);
    }
  }

  // -----------------------------------------------------------------------
  // Edit lifecycle
  // -----------------------------------------------------------------------

  private fileWatchers = new Map<string, vscode.FileSystemWatcher>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private startEdit(toolCall: ToolCall): void {
    const paths = extractFilePaths(toolCall);
    if (paths.length === 0) { return; }

    const filePath = normalizePath(paths[0]);
    // If we already track this tool call for this file, skip re-snapshotting.
    if (this.activeEdits.has(toolCall.toolCallId)) { return; }

    const oldContent = snapshotOldContent(filePath) ?? '';
    const oldUri = createOldContentUri(filePath, oldContent);
    const line = toolCall.locations?.[0]?.line ?? undefined;

    this.activeEdits.set(toolCall.toolCallId, {
      filePath,
      oldContent,
      oldUri,
      line,
    });

    this.applyDecoration(filePath, line);

    // Set up a file watcher as fallback for agents that don't send
    // tool_call_update with completed status (e.g. Hermes ACP adapter).
    // When the file changes on disk, show the diff after a debounce
    // to avoid showing partial writes.
    const watcher = vscode.workspace.createFileSystemWatcher(filePath);
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const onChangeHandler = () => {
      if (debounceTimer) { clearTimeout(debounceTimer); }
      debounceTimer = setTimeout(() => {
        this.debounceTimers.delete(toolCall.toolCallId);
        const edit = this.activeEdits.get(toolCall.toolCallId);
        if (edit) {
          this.openDiff(edit.oldUri, vscode.Uri.file(edit.filePath), toolCall.title);
          this.cleanupEdit(toolCall.toolCallId);
        }
      }, 800); // 800ms debounce — wait for file to stabilize
      this.debounceTimers.set(toolCall.toolCallId, debounceTimer);
    };
    watcher.onDidChange(onChangeHandler);
    watcher.onDidCreate(onChangeHandler); // also handle new file creation
    this.fileWatchers.set(toolCall.toolCallId, watcher);
    log(`DiffPreview: tracking edit on ${filePath} (id=${toolCall.toolCallId})`);
  }

  private finishEdit(toolCall: ToolCall): void {
    const edit = this.activeEdits.get(toolCall.toolCallId);

    if (edit) {
      this.openDiff(edit.oldUri, vscode.Uri.file(edit.filePath), toolCall.title);
      this.cleanupEdit(toolCall.toolCallId);
      return;
    }

    // No pending snapshot — try Diff content's oldText.
    this.tryFinishWithDiffContent(toolCall.content, toolCall.title);
  }

  private finishEditFromUpdate(update: ToolCallUpdate): void {
    const edit = this.activeEdits.get(update.toolCallId);
    if (!edit) { return; }

    this.openDiff(edit.oldUri, vscode.Uri.file(edit.filePath), update.title ?? undefined);
    this.cleanupEdit(update.toolCallId);
  }

  /**
   * Best-effort: if we never saw a `pending` notification but the completed
   * notification includes Diff content with oldText, build the URI from it.
   */
  private tryFinishWithDiffContent(
    content: ToolCallContent[] | undefined,
    title: string | undefined,
  ): void {
    if (!content) { return; }

    for (const c of content) {
      if (c.type === 'diff' && 'oldText' in c) {
        const diff = c as { path?: string; oldText?: string | null };
        if (diff.path && diff.oldText !== undefined && diff.oldText !== null) {
          const oldUri = createOldContentUri(diff.path, diff.oldText);
          this.openDiff(oldUri, vscode.Uri.file(diff.path), title);
          return;
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Decoration helpers
  // -----------------------------------------------------------------------

  private applyDecoration(filePath: string, line: number | undefined): void {
    if (line === undefined || line < 1) { return; }

    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.fsPath === filePath) {
        const range = new vscode.Range(line - 1, 0, line - 1, 0);
        editor.setDecorations(editDecoration, [range]);
        return;
      }
    }
  }

  private updateDecorationLine(toolCallId: string, newLine: number | undefined): void {
    const edit = this.activeEdits.get(toolCallId);
    if (!edit) { return; }

    // Clear old decoration by removing all ranges first, then applying the new one.
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.fsPath === edit.filePath) {
        editor.setDecorations(editDecoration, []);
        break;
      }
    }

    edit.line = newLine;
    this.applyDecoration(edit.filePath, newLine);
  }

  // -----------------------------------------------------------------------
  // Diff view
  // -----------------------------------------------------------------------

  private openDiff(oldUri: vscode.Uri, newUri: vscode.Uri, title: string | undefined): void {
    const diffTitle = title
      ? `${path.basename(newUri.fsPath)}: ${title}`
      : `${path.basename(newUri.fsPath)}: Original ↔ Agent's Changes`;

    vscode.commands.executeCommand('vscode.diff', oldUri, newUri, diffTitle);
    log(`DiffPreview: opened diff for ${newUri.fsPath}`);
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  private cleanupEdit(toolCallId: string): void {
    const edit = this.activeEdits.get(toolCallId);
    if (!edit) { return; }

    // Clear decoration ranges for this file.
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.fsPath === edit.filePath) {
        editor.setDecorations(editDecoration, []);
        break;
      }
    }

    // Clean up file watcher if any
    const watcher = this.fileWatchers.get(toolCallId);
    if (watcher) {
      watcher.dispose();
      this.fileWatchers.delete(toolCallId);
    }

    // Clean up debounce timer if any
    const timer = this.debounceTimers.get(toolCallId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(toolCallId);
    }

    this.activeEdits.delete(toolCallId);
    log(`DiffPreview: cleaned up edit ${toolCallId}`);
  }

  private cleanupAll(): void {
    for (const toolCallId of this.activeEdits.keys()) {
      this.cleanupEdit(toolCallId);
    }
    this.activeEdits.clear();
    // Clean up any remaining file watchers
    for (const watcher of this.fileWatchers.values()) {
      watcher.dispose();
    }
    this.fileWatchers.clear();
    // Clean up any remaining debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
