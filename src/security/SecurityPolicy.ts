import * as path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

const ENV_DENYLIST = new Set([
  'PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'NODE_PATH',
]);

function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function findExistingAncestor(targetPath: string): string {
  let currentPath = targetPath;

  while (!existsSync(currentPath)) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }

  return currentPath;
}

export function validatePath(filePath: string, workspaceRoot: string): string {
  const rootPath = path.resolve(workspaceRoot);
  const resolvedPath = path.resolve(rootPath, filePath);

  if (!isWithinRoot(rootPath, resolvedPath)) {
    throw new Error(`Path escapes workspace boundary: ${filePath}`);
  }

  const rootRealPath = realpathSync(rootPath);
  const existingPath = findExistingAncestor(resolvedPath);
  const existingRealPath = realpathSync(existingPath);
  if (!isWithinRoot(rootRealPath, existingRealPath)) {
    throw new Error(`Path escapes workspace boundary: ${filePath}`);
  }

  return existsSync(resolvedPath) ? realpathSync(resolvedPath) : resolvedPath;
}

export function filterEnv(agentEnv: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(agentEnv).filter(([key]) => !ENV_DENYLIST.has(key.toUpperCase()))
  );
}

export function escapeWindowsArg(arg: string): string {
  const escaped = arg
    .replace(/(\\*)"/g, (_, bs: string) => '\\'.repeat(bs.length * 2) + '\\"')
    .replace(/(\\+)$/, (_, bs: string) => '\\'.repeat(bs.length * 2));
  return `"${escaped}"`;
}

export const ALLOWED_WEBVIEW_COMMANDS: ReadonlySet<string> = new Set([
  'acp.connectAgent', 'acp.addAgent', 'acp.browseRegistry', 'acp.openChat',
  'acp.disconnectAgent', 'acp.newConversation', 'acp.restartAgent',
]);

export function redactSensitive(text: string): string {
  return text
    .replace(
      /("?(?:api[_-]?key|apikey|token|secret|password|passwd|authorization|bearer)"?\s*[:=]\s*")([^"]*)(")/gi,
      '$1[REDACTED]$3',
    )
    .replace(
      /((?:api[_-]?key|apikey|token|secret|password|passwd|authorization|bearer)\s*[:=]\s*)(\S+)/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_\-]{10,}|xox[baprs]-[A-Za-z0-9\-]{10,}|(?:sk|pk)_[A-Za-z0-9_\-]{10,})\b/g,
      '[REDACTED]',
    );
}
