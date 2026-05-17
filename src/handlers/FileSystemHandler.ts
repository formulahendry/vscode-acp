import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { log, logError } from '../utils/Logger';

import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

/**
 * Handles ACP file system requests using VS Code's workspace filesystem API.
 * This gives us access to unsaved editor buffers automatically.
 */
export class FileSystemHandler {

  /**
   * Read a text file. Uses VS Code API to include unsaved editor content.
   */
  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    log(`readTextFile: ${params.path}`);

    try {
      const uri = vscode.Uri.file(params.path);

      // Check if the file is open in an editor with unsaved changes
      const openDoc = vscode.workspace.textDocuments.find(
        doc => doc.uri.fsPath === uri.fsPath
      );

      let content: string;
      if (openDoc) {
        content = openDoc.getText();
      } else {
        const raw = await vscode.workspace.fs.readFile(uri);
        content = Buffer.from(raw).toString('utf-8');
      }

      // Handle line/limit parameters
      if (params.line !== undefined && params.line !== null
        || params.limit !== undefined && params.limit !== null) {
        const lines = content.split('\n');
        const startLine = (params.line ?? 1) - 1; // 1-based → 0-based
        const endLine = params.limit
          ? startLine + params.limit
          : lines.length;
        content = lines.slice(startLine, endLine).join('\n');
      }

      return { content };
    } catch (e) {
      logError(`readTextFile failed: ${params.path}`, e);
      throw e;
    }
  }

  /**
   * Write a text file. Creates parent directories if needed.
   * Shows a diff view for existing files so the user can review changes.
   */
  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    log(`writeTextFile: ${params.path}`);

    try {
      const uri = vscode.Uri.file(params.path);
      const newContent = params.content;
      const encoded = Buffer.from(newContent, 'utf-8');

      // Read old content (if file exists) before overwriting
      let oldContent: string | null = null;
      try {
        const oldRaw = await vscode.workspace.fs.readFile(uri);
        oldContent = Buffer.from(oldRaw).toString('utf-8');
      } catch {
        // File doesn't exist yet — no diff needed
      }

      await vscode.workspace.fs.writeFile(uri, encoded);

      if (oldContent !== null && oldContent !== newContent) {
        // Show diff: write old content to a temp file, then open vscode.diff
        const tmpDir = path.join(os.tmpdir(), 'vscode-acp-diffs');
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(tmpDir));
        const oldUri = vscode.Uri.file(
          path.join(tmpDir, path.basename(params.path))
        );
        await vscode.workspace.fs.writeFile(oldUri, Buffer.from(oldContent, 'utf-8'));

        await vscode.commands.executeCommand(
          'vscode.diff',
          oldUri,
          uri,
          `${path.basename(params.path)} (before → after)`
        );
      } else if (oldContent === null) {
        // New file: open in editor
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
      }
      // If oldContent === newContent, no change — do nothing

      return {};
    } catch (e) {
      logError(`writeTextFile failed: ${params.path}`, e);
      throw e;
    }
  }
}
