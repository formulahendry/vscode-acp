import * as vscode from 'vscode';

export type EditorSelectionSnapshot = {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  text: string;
};

export type EditorSnapshot = {
  uriPath: string;
  name: string;
  cursorLine: number;
  cursorCharacter: number;
  selection: EditorSelectionSnapshot | null;
};

export function captureEditorSnapshot(editor: vscode.TextEditor | undefined): EditorSnapshot | null {
  if (!editor?.document?.uri) {
    return null;
  }

  const selection = editor.selection;
  return {
    uriPath: editor.document.uri.fsPath,
    name: editor.document.uri.fsPath.split(/[\\/]/).pop() || editor.document.uri.fsPath,
    cursorLine: selection.active.line + 1,
    cursorCharacter: selection.active.character + 1,
    selection: selection.isEmpty
      ? null
      : {
          startLine: selection.start.line + 1,
          startCharacter: selection.start.character + 1,
          endLine: selection.end.line + 1,
          endCharacter: selection.end.character + 1,
          text: editor.document.getText(selection),
        },
  };
}

export function buildEditorSnapshotPromptPrefix(snapshot: EditorSnapshot | null): string {
  if (!snapshot) {
    return '';
  }

  const cursorPos = `${snapshot.cursorLine}:${snapshot.cursorCharacter}`;
  if (snapshot.selection) {
    const header =
      `${snapshot.name} ` +
      `[${snapshot.selection.startLine}:${snapshot.selection.startCharacter}-${snapshot.selection.endLine}:${snapshot.selection.endCharacter}] ` +
      `[cursor ${cursorPos}]`;
    return `${header}\n${snapshot.selection.text}\n\n`;
  }

  return `${snapshot.name} (${snapshot.uriPath}) [cursor ${cursorPos}]\n\n`;
}

export function buildQuickPromptPanelTitle(snapshot: EditorSnapshot | null): string {
  if (!snapshot) {
    return 'ACP Quick Prompt';
  }

  const cursorPos = `${snapshot.cursorLine}:${snapshot.cursorCharacter}`;
  if (snapshot.selection) {
    return (
      `ACP Quick Prompt — ${snapshot.name} ` +
      `[${snapshot.selection.startLine}:${snapshot.selection.startCharacter}-${snapshot.selection.endLine}:${snapshot.selection.endCharacter}] ` +
      `[cursor ${cursorPos}]`
    );
  }

  return `ACP Quick Prompt — ${snapshot.name} [cursor ${cursorPos}]`;
}
