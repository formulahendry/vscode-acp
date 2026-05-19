import type {
  EditorSnapshot,
  FileSelection,
  MarkdownRenderItem,
  MarkdownRenderedItem,
  ModelsState,
  ModesState,
  SessionSnapshot,
  SessionUpdate,
} from './chatTypes';

export type HostToWebviewMessage =
  | {
      type: 'state';
      activeSessionId?: string | null;
      session?: SessionSnapshot | null;
      editorSnapshot?: EditorSnapshot | null;
    }
  | { type: 'sessionUpdate'; update: SessionUpdate; sessionId?: string }
  | { type: 'promptStart' }
  | { type: 'promptEnd'; stopReason?: string; usage?: unknown }
  | { type: 'clearChat' }
  | { type: 'error'; message?: string }
  | { type: 'modesUpdate'; modes: ModesState }
  | { type: 'modelsUpdate'; models: ModelsState }
  | { type: 'externalUserMessage'; text: string }
  | { type: 'file-attached'; path?: string; name?: string; selection?: FileSelection }
  | { type: 'markdownRendered'; items: MarkdownRenderedItem[] }
  | { type: string; [key: string]: unknown };

export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'quickPromptReady' }
  | { type: 'quickPromptSubmit'; text: string }
  | { type: 'quickPromptConnect' }
  | { type: 'quickPromptDismiss' }
  | { type: 'sendPrompt'; text: string }
  | { type: 'cancelTurn' }
  | { type: 'setMode'; modeId: string }
  | { type: 'setModel'; modelId: string }
  | { type: 'executeCommand'; command: string }
  | { type: 'renderMarkdown'; items: MarkdownRenderItem[] };

type VsCodeApi<State> = {
  postMessage(message: WebviewToHostMessage): void;
  getState(): State | undefined;
  setState(state: State): void;
};

declare function acquireVsCodeApi<State = unknown>(): VsCodeApi<State>;

const vscode = acquireVsCodeApi<unknown>();

export function postMessage(message: WebviewToHostMessage): void {
  vscode.postMessage(message);
}

export function getState<State>(): State | undefined {
  return vscode.getState() as State | undefined;
}

export function setState<State>(state: State): void {
  vscode.setState(state);
}

export function onMessage(listener: (message: HostToWebviewMessage) => void): () => void {
  const handler = (event: MessageEvent<HostToWebviewMessage>) => {
    listener(event.data);
  };

  window.addEventListener('message', handler);
  return () => {
    window.removeEventListener('message', handler);
  };
}
