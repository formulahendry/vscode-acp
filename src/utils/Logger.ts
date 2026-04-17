import * as vscode from 'vscode';
import { redactSensitive } from '../security/SecurityPolicy';

let _outputChannel: vscode.OutputChannel | undefined;
let _trafficChannel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel('ACP Client');
  }
  return _outputChannel;
}

export function getTrafficChannel(): vscode.OutputChannel {
  if (!_trafficChannel) {
    _trafficChannel = vscode.window.createOutputChannel('ACP Traffic');
  }
  return _trafficChannel;
}

export function log(message: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const formatted = args.length > 0
    ? `[${timestamp}] ${message} ${args.map(a => JSON.stringify(a)).join(' ')}`
    : `[${timestamp}] ${message}`;
  getOutputChannel().appendLine(formatted);
}

export function logError(message: string, error?: unknown): void {
  const timestamp = new Date().toISOString();
  const errMsg = error instanceof Error ? error.message : String(error ?? '');
  getOutputChannel().appendLine(`[${timestamp}] ERROR: ${message} ${errMsg}`);
  if (error instanceof Error && error.stack) {
    getOutputChannel().appendLine(error.stack);
  }
}

const MAX_TRAFFIC_PAYLOAD = 2048;

export function logTraffic(direction: 'send' | 'recv', data: unknown): void {
  const config = vscode.workspace.getConfiguration('acp');
  if (!config.get<boolean>('logTraffic', false)) {
    return;
  }
  const arrow = direction === 'send' ? '>>> CLIENT → AGENT' : '<<< AGENT → CLIENT';
  const timestamp = new Date().toISOString();

  const msg = data as Record<string, unknown> | null;
  let label = '';
  if (msg && typeof msg === 'object') {
    if ('method' in msg && 'id' in msg) {
      label = ` [REQUEST] ${msg.method}`;
    } else if ('method' in msg && !('id' in msg)) {
      label = ` [NOTIFICATION] ${msg.method}`;
    } else if ('result' in msg || 'error' in msg) {
      label = ` [RESPONSE] id=${msg.id}`;
    }
  }

  let payload = JSON.stringify(data, null, 2);
  if (payload.length > MAX_TRAFFIC_PAYLOAD) {
    payload = payload.substring(0, MAX_TRAFFIC_PAYLOAD) + `\n... [truncated, ${payload.length} bytes total]`;
  }
  payload = redactSensitive(payload);

  getTrafficChannel().appendLine(
    `[${timestamp}] ${arrow}${label}\n${payload}\n`
  );
}

export function disposeChannels(): void {
  _outputChannel?.dispose();
  _trafficChannel?.dispose();
  _outputChannel = undefined;
  _trafficChannel = undefined;
}
