import { JSX, useEffect, useState } from 'react';

import { onMessage, postMessage, type HostToWebviewMessage } from './vscode';

function getSummary(message: HostToWebviewMessage | null): string {
  if (!message) {
    return 'Waiting for host events';
  }

  switch (message.type) {
    case 'state':
      return 'Initial state received';
    case 'sessionUpdate':
      return 'Session update streamed from host';
    case 'clearChat':
      return 'Legacy clear request received';
    default:
      return `Last event: ${message.type}`;
  }
}

export function App(): JSX.Element {
  const [lastMessage, setLastMessage] = useState<HostToWebviewMessage | null>(null);

  useEffect(() => {
    postMessage({ type: 'ready' });
    return onMessage((message) => {
      setLastMessage(message);
    });
  }, []);

  return (
    <main className="shell">
      <section className="card">
        <p className="eyebrow">ACP Chat v2</p>
        <h1>React webview shell ready</h1>
        <p className="body">
          The legacy chat remains active by default. This shell is scaffolded for the next
          React migration step and already speaks the VS Code webview bridge.
        </p>
        <div className="status-row">
          <span className="status-pill">ready posted</span>
          <span className="status-copy">{getSummary(lastMessage)}</span>
        </div>
      </section>
    </main>
  );
}
