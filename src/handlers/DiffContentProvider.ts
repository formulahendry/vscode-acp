import * as vscode from 'vscode';

export const DIFF_URI_SCHEME = 'acp-diff';

/**
 * Provides old (pre-edit) file content for diff preview via custom URI scheme.
 *
 * The old content is base64-encoded in the URI query parameter, making the
 * provider stateless — the URI itself carries everything needed to render the
 * original content in VS Code's diff editor.
 *
 * See AGENTS.md § Diff 预览设计方案 for the full rationale.
 */
export class AcpDiffContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    const encoded = uri.query;
    if (!encoded) { return ''; }
    return Buffer.from(encoded, 'base64').toString('utf-8');
  }
}
