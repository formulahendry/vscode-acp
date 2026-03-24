import * as vscode from 'vscode';

let _outputChannel: vscode.OutputChannel | undefined;
let _trafficChannel: vscode.OutputChannel | undefined;

function serializeForLog(value: unknown): string {
  if (value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Error) {
    const errorPayload: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    };

    const code = (value as { code?: unknown }).code;
    if (code !== undefined) {
      errorPayload.code = code;
    }

    if (value.stack) {
      errorPayload.stack = value.stack;
    }

    return JSON.stringify(errorPayload);
  }

  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, currentValue) => {
      if (currentValue instanceof Error) {
        return {
          name: currentValue.name,
          message: currentValue.message,
          stack: currentValue.stack,
        };
      }

      if (typeof currentValue === 'object' && currentValue !== null) {
        if (seen.has(currentValue)) {
          return '[Circular]';
        }
        seen.add(currentValue);
      }

      return currentValue;
    });
  } catch {
    return String(value);
  }
}

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
  const serializedArgs = args
    .map(serializeForLog)
    .filter(arg => arg.length > 0)
    .join(' ');
  const formatted = serializedArgs.length > 0
    ? `[${timestamp}] ${message} ${serializedArgs}`
    : `[${timestamp}] ${message}`;
  getOutputChannel().appendLine(formatted);
}

export function logError(message: string, error?: unknown): void {
  const timestamp = new Date().toISOString();
  const errMsg = serializeForLog(error);
  const formatted = errMsg.length > 0
    ? `[${timestamp}] ERROR: ${message} ${errMsg}`
    : `[${timestamp}] ERROR: ${message}`;
  getOutputChannel().appendLine(formatted);
  if (error instanceof Error && error.stack) {
    getOutputChannel().appendLine(error.stack);
  }
}

export function logTraffic(direction: 'send' | 'recv', data: unknown): void {
  const config = vscode.workspace.getConfiguration('acp');
  if (!config.get<boolean>('logTraffic', true)) {
    return;
  }
  const arrow = direction === 'send' ? '>>> CLIENT → AGENT' : '<<< AGENT → CLIENT';
  const timestamp = new Date().toISOString();

  // Classify message type
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

  getTrafficChannel().appendLine(
    `[${timestamp}] ${arrow}${label}\n${JSON.stringify(data, null, 2)}\n`
  );
}

export function disposeChannels(): void {
  _outputChannel?.dispose();
  _trafficChannel?.dispose();
  _outputChannel = undefined;
  _trafficChannel = undefined;
}
