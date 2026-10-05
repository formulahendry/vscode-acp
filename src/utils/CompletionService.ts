import * as vscode from 'vscode';
import { ConnectionManager } from '../core/ConnectionManager';
import type { ConnectionInfo } from '../core/ConnectionManager';
import { SessionUpdateHandler, SessionUpdateListener } from '../handlers/SessionUpdateHandler';
import { InlineCompletionProvider } from './InlineCompletionProvider';
import { log, logError } from './Logger';

import type { SessionNotification } from '@agentclientprotocol/sdk';

const DEFAULT_MIN_TRIGGER_CHARS = 12;

/**
 * Wires Copilot-style ghost-text completion to the connected ACP agent.
 *
 * The completion session is deliberately NOT registered in SessionManager:
 * it is created straight from ConnectionManager so it never appears in the
 * session tree, the chat history, or `getActiveSessionId()`. Inline
 * completions are a side channel and must not contaminate the conversation.
 *
 * The agent streams its reply as `agent_message_chunk` notifications and
 * returns only a stopReason from `prompt()`, so the reply text is collected
 * from the update stream — filtered strictly to our own hidden sessionId so
 * a visible chat turn running at the same time cannot bleed into ghost text.
 *
 * ponytail: one completion session per window, reused until the agent
 * connection dies. Upgrade path: one per workspace folder, and re-create on
 * cwd change, for cwd-sensitive models.
 */
export class CompletionService implements vscode.Disposable {
  private readonly provider: InlineCompletionProvider;
  private readonly listener: SessionUpdateListener;
  private registration: vscode.Disposable | undefined;
  private configWatcher: vscode.Disposable | undefined;
  private sessionId: string | null = null;
  private starting: Promise<string | null> | null = null;
  /** Agent that owns `sessionId`, so a same-agent reconnect keeps it. */
  private sessionAgentId: string | null = null;
  /** Reply text for the in-flight prompt on the hidden session. */
  private buffer = '';
  /**
   * Generation number of the request allowed to append to `buffer`, or 0
   * when nothing is collecting. Chunks carry only a sessionId — both the
   * live and an abandoned request share the hidden session — so the
   * generation is what stops a cancelled turn's trailing chunks from
   * landing in the next turn's ghost text.
   */
  private collecting = 0;
  private generation = 0;

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly sessionUpdateHandler: SessionUpdateHandler,
  ) {
    this.provider = new InlineCompletionProvider(
      (text, signal) => this.complete(text, signal),
      () => this.config().get<number>('inlineCompletion.minTriggerChars', DEFAULT_MIN_TRIGGER_CHARS),
    );
    this.listener = (update: SessionNotification) => this.onUpdate(update);
  }

  activate(): void {
    this.sessionUpdateHandler.addListener(this.listener);
    this.syncRegistration();
    this.configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('acp.inlineCompletion')) {
        return;
      }
      const wasEnabled = this.registration !== undefined;
      this.syncRegistration();
      // A changed trigger length or a fresh enable invalidates cached text.
      if (wasEnabled) {
        this.provider.onAgentChanged();
      }
    });
    log('CompletionService: activated');
  }

  /** Drop cached ghost text when the active agent changes. */
  onAgentChanged(): void {
    this.provider.onAgentChanged();
    const agentId = this.currentAgentId() ?? null;
    if (agentId === this.sessionAgentId) {
      return;
    }
    // The hidden session belongs to the old agent (or a dead one) and will
    // never answer again — drop it so the next request re-opens.
    this.sessionId = null;
    this.sessionAgentId = agentId;
    this.buffer = '';
    this.collecting = 0;
  }

  dispose(): void {
    this.configWatcher?.dispose();
    this.registration?.dispose();
    this.sessionUpdateHandler.removeListener(this.listener);
    this.provider.dispose();
  }

  /** True once the hidden session exists — used by the smoke check. */
  isReady(): boolean {
    return this.sessionId !== null;
  }

  /**
   * Register or unregister the ghost-text provider to match
   * `acp.inlineCompletion.enabled`.
   */
  private syncRegistration(): void {
    const enabled = this.config().get<boolean>('inlineCompletion.enabled', true);
    if (enabled && !this.registration) {
      this.registration = vscode.languages.registerInlineCompletionItemProvider(
        { scheme: 'file', pattern: '**/*' },
        this.provider,
      );
      log('CompletionService: inline completion enabled');
    } else if (!enabled && this.registration) {
      this.registration.dispose();
      this.registration = undefined;
      log('CompletionService: inline completion disabled');
    }
  }

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('acp');
  }

  /**
   * Run one completion prompt on the hidden session and return the reply.
   * Creates the session on first use.
   *
   * `signal` is the caller's cancellation. When it fires we race it against
   * the ACP `prompt()` call so the caller's queue is freed immediately
   * instead of waiting out an abandoned turn, and we tell the agent to
   * cancel so it stops streaming instead of burning tokens on dead text.
   */
  private async complete(text: string, signal: AbortSignal): Promise<string> {
    const sessionId = await this.ensureSession();
    if (!sessionId || signal.aborted) {
      return '';
    }
    const agentId = this.currentAgentId();
    const connInfo = agentId ? this.connectionManager.getConnection(agentId) : undefined;
    if (!connInfo) {
      return '';
    }

    const gen = ++this.generation;
    this.buffer = '';
    this.collecting = gen;

    const turn = connInfo.connection
      .prompt({ sessionId, prompt: [{ type: 'text', text }] })
      .catch(e => {
        logError('Inline completion prompt failed', e);
      });

    try {
      await Promise.race([turn, abortRace(signal)]);
    } finally {
      if (signal.aborted) {
        this.cancelTurn(connInfo, sessionId);
      }
      if (this.collecting === gen) {
        this.collecting = 0;
      }
    }
    return gen === this.generation ? this.buffer : '';
  }

  /** Best-effort: the turn is being abandoned, so its result is unwanted. */
  private cancelTurn(connInfo: ConnectionInfo, sessionId: string): void {
    connInfo.connection
      .cancel({ sessionId })
      .catch(e => logError('Inline completion cancel failed', e));
  }

  /**
   * Accumulate agent_message_chunk text for our hidden session only.
   * Thought and tool_call chunks are ignored: we only want prose the parse
   * step can turn into insertion text.
   */
  private onUpdate(update: SessionNotification): void {
    if (!this.collecting || update.sessionId !== this.sessionId) {
      return;
    }
    const data = update.update as any;
    if (data?.sessionUpdate !== 'agent_message_chunk') {
      return;
    }
    const chunk = data.content;
    const text = typeof chunk === 'string' ? chunk : chunk?.text;
    if (typeof text === 'string') {
      this.buffer += text;
    }
  }

  /**
   * Lazily create the hidden completion session. Concurrent callers share
   * one in-flight start so we never spawn two sessions.
   */
  private ensureSession(): Promise<string | null> {
    if (this.sessionId) {
      return Promise.resolve(this.sessionId);
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.startSession()
      .then(started => {
        if (started) {
          this.sessionId = started.sessionId;
          this.sessionAgentId = started.agentId;
          return started.sessionId;
        }
        return null;
      })
      .catch(e => {
        logError('Failed to create inline completion session', e);
        return null;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  private async startSession(): Promise<{ sessionId: string; agentId: string } | null> {
    const agentId = this.currentAgentId();
    const connInfo = agentId ? this.connectionManager.getConnection(agentId) : undefined;
    if (!agentId || !connInfo) {
      return null;
    }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const res = await connInfo.connection.newSession({ cwd, mcpServers: [] });
    return { sessionId: res.sessionId, agentId };
  }

  /**
   * Agent backing the active chat, so completions follow the user's choice.
   */
  private currentAgentId(): string | undefined {
    return this.connectionManager.getAnyConnectedAgentId();
  }
}

/** Resolves when `signal` aborts, so it can win a race against a pending turn. */
function abortRace(signal: AbortSignal): Promise<'aborted'> {
  if (signal.aborted) {
    return Promise.resolve('aborted');
  }
  return new Promise<'aborted'>(resolve => {
    signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
}