import * as path from 'node:path';
import { realpathSync } from 'node:fs';

const ENV_DENYLIST = new Set([
  'PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'NODE_PATH',
]);

export function validatePath(filePath: string, workspaceRoot: string): string {
  const resolved = realpathSync(path.resolve(workspaceRoot, filePath));
  const root = realpathSync(workspaceRoot);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`Path escapes workspace boundary: ${filePath}`);
  }
  return resolved;
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

export const REDACT_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|apikey|token|secret|password|passwd|authorization|bearer)\s*[:=]\s*\S+/gi,
  /(?:sk|pk|key|pat|ghp|gho|ghu|ghs|ghr|glpat|xox[bpas])-[A-Za-z0-9_\-]{10,}/g,
];

export function redactSensitive(text: string): string {
  return REDACT_PATTERNS.reduce((t, re) => t.replace(re, '[REDACTED]'), text);
}
