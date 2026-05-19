import * as vscode from 'vscode';
import type { SessionInfo as ProtocolSessionInfo } from '@agentclientprotocol/sdk';
import { SessionManager, AgentCapabilitySummary } from '../core/SessionManager';
import { SessionHistoryStore, PersistedSessionEntry } from '../core/SessionHistoryStore';
import { getAgentNames } from '../config/AgentConfig';
import { log, logError } from '../utils/Logger';

/**
 * Tier-1 — a configured agent. Collapsible only when we believe the agent
 * has any way to expose past sessions (either supports session/list, or has
 * locally-cached entries via {@link SessionHistoryStore}).
 */
export class AgentTreeItem extends vscode.TreeItem {
  constructor(
    public readonly agentName: string,
    public readonly connected: boolean,
    collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(agentName, collapsibleState);

    if (connected) {
      this.contextValue = 'agent-connected';
      this.iconPath = new vscode.ThemeIcon(
        'circle-filled',
        new vscode.ThemeColor('testing.iconPassed'),
      );
      this.description = 'connected';
      this.command = { command: 'acp.openChat', title: 'Open Chat' };
    } else {
      this.contextValue = 'agent-disconnected';
      this.iconPath = new vscode.ThemeIcon('circle-outline');
      this.description = '';
    }

    this.tooltip = connected
      ? `${agentName} — connected\nClick to open chat`
      : `${agentName} — not connected\nUse the plug icon to connect`;
  }
}

/**
 * Tier-2 — a session belonging to an agent. Clicking it routes to
 * `acp.openSession` which calls `session/load` or `session/resume`.
 */
export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly agentName: string,
    public readonly sessionId: string,
    label: string,
    public readonly isActive: boolean,
    description: string | undefined,
    tooltip: string,
    public readonly source: 'agent' | 'local',
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = source === 'local' ? 'session-local' : 'session';
    this.description = description;
    this.tooltip = tooltip;
    if (isActive) {
      this.iconPath = new vscode.ThemeIcon(
        'circle-filled',
        new vscode.ThemeColor('testing.iconPassed'),
      );
    } else {
      this.iconPath = new vscode.ThemeIcon('comment-discussion');
    }
    this.command = {
      command: 'acp.openSession',
      title: 'Open Session',
      arguments: [{ agentName, sessionId }],
    };
  }
}

/**
 * A leaf node used to surface status / errors / fallbacks under an agent.
 */
export class InfoTreeItem extends vscode.TreeItem {
  constructor(
    public readonly kind:
      | 'loading'
      | 'empty'
      | 'unsupported'
      | 'error'
      | 'auth-required'
      | 'load-more',
    public readonly agentName: string,
    label: string,
    tooltip?: string,
    command?: vscode.Command,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = tooltip;
    this.command = command;
    switch (kind) {
      case 'loading':
        this.iconPath = new vscode.ThemeIcon('loading~spin');
        this.contextValue = 'session-info-loading';
        break;
      case 'empty':
        this.iconPath = new vscode.ThemeIcon('inbox');
        this.contextValue = 'session-info-empty';
        break;
      case 'unsupported':
        this.iconPath = new vscode.ThemeIcon('info');
        this.contextValue = 'session-info-unsupported';
        break;
      case 'error':
        this.iconPath = new vscode.ThemeIcon('warning');
        this.contextValue = 'session-info-error';
        break;
      case 'auth-required':
        this.iconPath = new vscode.ThemeIcon('key');
        this.contextValue = 'session-info-auth';
        break;
      case 'load-more':
        this.iconPath = new vscode.ThemeIcon('chevron-down');
        this.contextValue = 'session-info-load-more';
        break;
    }
  }
}

type AgentNode = AgentTreeItem;
type ChildNode = SessionTreeItem | InfoTreeItem;

interface AgentListState {
  state: 'idle' | 'loading' | 'ready' | 'error' | 'unsupported' | 'auth-required';
  /** Agent-provided sessions (only when caps.list is true). */
  agentSessions?: ProtocolSessionInfo[];
  nextCursor?: string;
  error?: string;
}

/**
 * Tree provider for the ACP Agents view. Tier 1 = agents, tier 2 = sessions.
 *
 * Tier 2 source-of-truth selection per agent:
 *   - If the agent advertises `session/list`: use that (the agent owns the
 *     truth). Local history-store entries for that agent are reconciled
 *     against the server on each list call.
 *   - Else if the agent advertises `session/load` or `session/resume`: use
 *     the local history store as the source.
 *   - Else: a single "not supported" info leaf.
 */
export class SessionTreeProvider implements vscode.TreeDataProvider<AgentNode | ChildNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AgentNode | ChildNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private listStates: Map<string, AgentListState> = new Map();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly historyStore: SessionHistoryStore | null,
    private readonly workspaceCwd: () => string | undefined,
  ) {
    this.sessionManager.on('agent-connected', () => this.refresh());
    this.sessionManager.on('agent-disconnected', () => this.refresh());
    this.sessionManager.on('active-session-changed', () => this.refresh());
    this.sessionManager.on('session-info-changed', () => this.refresh());
    if (this.historyStore) {
      this.historyStore.onDidChange(() => this.refresh());
    }
  }

  refresh(node?: AgentNode | ChildNode): void {
    this._onDidChangeTreeData.fire(node);
  }

  /**
   * Drop cached state for an agent (or all agents) so the next expansion
   * re-runs `session/list` and re-probes capabilities.
   */
  invalidate(agentName?: string): void {
    if (agentName) {
      this.listStates.delete(agentName);
    } else {
      this.listStates.clear();
    }
    this.refresh();
  }

  getTreeItem(element: AgentNode | ChildNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: AgentNode | ChildNode): Promise<(AgentNode | ChildNode)[]> {
    if (!element) {
      return this.getAgentNodes();
    }
    if (element instanceof AgentTreeItem) {
      return this.getAgentChildren(element);
    }
    return [];
  }

  // --- Tier 1 ---

  private getAgentNodes(): AgentTreeItem[] {
    return getAgentNames().map(name => {
      const caps = this.sessionManager.getCachedCapabilities(name);
      const localCount = this.historyStore?.list(name, this.workspaceCwd()).length ?? 0;
      const collapsibleState = this.computeCollapsibleState(name, caps, localCount);
      return new AgentTreeItem(
        name,
        this.sessionManager.isAgentConnected(name),
        collapsibleState,
      );
    });
  }

  private computeCollapsibleState(
    agentName: string,
    caps: AgentCapabilitySummary | undefined,
    localCount: number,
  ): vscode.TreeItemCollapsibleState {
    // Known unsupported (no list, no load, no resume) AND nothing cached
    // locally → no expand affordance to avoid misleading the user.
    if (caps && !caps.list && !caps.load && !caps.resume && localCount === 0) {
      return vscode.TreeItemCollapsibleState.None;
    }
    // Otherwise default to collapsed; expansion triggers probing/fetching.
    return vscode.TreeItemCollapsibleState.Collapsed;
  }

  // --- Tier 2 ---

  private async getAgentChildren(agent: AgentTreeItem): Promise<ChildNode[]> {
    const name = agent.agentName;
    let caps = this.sessionManager.getCachedCapabilities(name);

    // Capability not yet known — probe lazily.
    if (!caps) {
      const probeResult = await this.probeCapabilities(name);
      if (probeResult.kind === 'auth-cancelled') {
        return [this.authRequiredLeaf(name)];
      }
      if (probeResult.kind === 'error') {
        return [this.errorLeaf(name, probeResult.message)];
      }
      caps = probeResult.caps;
    }

    // Source A — agent supports list: fetch from agent (source of truth).
    if (caps.list) {
      return this.getAgentSourcedChildren(name);
    }

    // Source B — agent supports load and/or resume but not list: render the
    // local history store as the tier-2 source.
    if (caps.load || caps.resume) {
      return this.getLocalSourcedChildren(name);
    }

    // Source C — no relevant capability. Show an informative leaf so users
    // understand why expanding this agent shows nothing.
    return [
      new InfoTreeItem(
        'unsupported',
        name,
        'Session list not supported',
        'This agent does not advertise session/list, session/load, or session/resume.\n'
          + 'You can still start a new chat from the agent row.',
      ),
    ];
  }

  // --- Agent-sourced list ---

  private async getAgentSourcedChildren(agentName: string): Promise<ChildNode[]> {
    const state = this.listStates.get(agentName);
    if (state?.state === 'loading') {
      return [this.loadingLeaf(agentName)];
    }
    if (!state || state.state === 'idle' || state.state === 'error') {
      // Kick off the fetch.
      void this.fetchSessionList(agentName);
      return [this.loadingLeaf(agentName)];
    }
    if (state.state === 'auth-required') {
      return [this.authRequiredLeaf(agentName)];
    }
    if (state.state === 'unsupported') {
      return [new InfoTreeItem('unsupported', agentName, 'Session list not supported')];
    }
    // state === 'ready'
    const sessions = state.agentSessions ?? [];
    const activeId = this.sessionManager.getActiveSessionId();
    if (sessions.length === 0 && !state.nextCursor) {
      return [
        new InfoTreeItem('empty', agentName, '(no previous sessions)'),
      ];
    }
    const items: ChildNode[] = sessions.map(s => this.buildAgentSessionItem(agentName, s, activeId));
    if (state.nextCursor) {
      items.push(new InfoTreeItem(
        'load-more',
        agentName,
        'Load more…',
        undefined,
        {
          command: 'acp.loadMoreSessions',
          title: 'Load more sessions',
          arguments: [agentName],
        },
      ));
    }
    return items;
  }

  private buildAgentSessionItem(
    agentName: string,
    info: ProtocolSessionInfo,
    activeId: string | null,
  ): SessionTreeItem {
    const label = info.title?.trim() || shortSessionId(info.sessionId);
    const description = relativeTime(info.updatedAt);
    const tooltip = buildSessionTooltip(agentName, info.sessionId, info.cwd, info.updatedAt, 'agent');
    return new SessionTreeItem(
      agentName,
      info.sessionId,
      label,
      info.sessionId === activeId,
      description,
      tooltip,
      'agent',
    );
  }

  private async fetchSessionList(agentName: string): Promise<void> {
    this.listStates.set(agentName, { state: 'loading' });
    this.refresh();
    try {
      const result = await this.sessionManager.listSessions(agentName, {
        cwd: this.workspaceCwd(),
      });
      this.listStates.set(agentName, {
        state: 'ready',
        agentSessions: result.sessions,
        nextCursor: result.nextCursor,
      });
    } catch (e: any) {
      const message = String(e?.message || 'Unknown error');
      logError(`Failed to list sessions for ${agentName}`, e);
      if (/auth|authentication/i.test(message) || /cancelled/i.test(message)) {
        this.listStates.set(agentName, { state: 'auth-required' });
      } else {
        this.listStates.set(agentName, { state: 'error', error: message });
      }
    } finally {
      this.refresh();
    }
  }

  /** Fetch and append the next page (only meaningful for agent-sourced lists). */
  async loadMore(agentName: string): Promise<void> {
    const state = this.listStates.get(agentName);
    if (!state || state.state !== 'ready' || !state.nextCursor) { return; }
    const cursor = state.nextCursor;
    this.listStates.set(agentName, { ...state, state: 'loading' });
    this.refresh();
    try {
      const result = await this.sessionManager.listSessions(agentName, {
        cwd: this.workspaceCwd(),
        cursor,
      });
      const prev = state.agentSessions ?? [];
      this.listStates.set(agentName, {
        state: 'ready',
        agentSessions: [...prev, ...result.sessions],
        nextCursor: result.nextCursor,
      });
    } catch (e: any) {
      logError(`Failed to load more sessions for ${agentName}`, e);
      // Roll back to previous ready state.
      this.listStates.set(agentName, {
        state: 'ready',
        agentSessions: state.agentSessions,
        nextCursor: state.nextCursor,
        error: String(e?.message || e),
      });
    } finally {
      this.refresh();
    }
  }

  // --- Local-history-store-sourced list ---

  private getLocalSourcedChildren(agentName: string): ChildNode[] {
    if (!this.historyStore) {
      return [
        new InfoTreeItem(
          'unsupported',
          agentName,
          'Session history unavailable',
          'No workspace storage is wired up.',
        ),
      ];
    }
    const cwd = this.workspaceCwd();
    const entries = this.historyStore.list(agentName, cwd);
    if (entries.length === 0) {
      return [
        new InfoTreeItem(
          'empty',
          agentName,
          '(no previous sessions)',
          'Sessions you start with this agent will appear here.',
        ),
      ];
    }
    const activeId = this.sessionManager.getActiveSessionId();
    return entries.map(e => this.buildLocalSessionItem(e, activeId));
  }

  private buildLocalSessionItem(entry: PersistedSessionEntry, activeId: string | null): SessionTreeItem {
    const label = (entry.title?.trim())
      || (entry.firstPrompt?.trim() && truncate(entry.firstPrompt!.trim(), 60))
      || shortSessionId(entry.sessionId);
    const description = relativeTime(entry.lastActiveAt);
    const tooltip = buildSessionTooltip(
      entry.agentName,
      entry.sessionId,
      entry.cwd,
      entry.lastActiveAt,
      'local',
    );
    return new SessionTreeItem(
      entry.agentName,
      entry.sessionId,
      label,
      entry.sessionId === activeId,
      description,
      tooltip,
      'local',
    );
  }

  // --- Capability probe ---

  private async probeCapabilities(agentName: string): Promise<
    | { kind: 'ok'; caps: AgentCapabilitySummary }
    | { kind: 'auth-cancelled' }
    | { kind: 'error'; message: string }
  > {
    log(`Probing capabilities for agent "${agentName}"…`);
    try {
      await this.sessionManager.ensureConnected(agentName);
      const caps = this.sessionManager.getCachedCapabilities(agentName);
      if (!caps) {
        return { kind: 'error', message: 'Failed to determine agent capabilities.' };
      }
      return { kind: 'ok', caps };
    } catch (e: any) {
      const msg = String(e?.message || e);
      logError(`Capability probe failed for ${agentName}`, e);
      if (/cancelled/i.test(msg)) {
        return { kind: 'auth-cancelled' };
      }
      return { kind: 'error', message: msg };
    }
  }

  // --- Info-leaf factories ---

  private loadingLeaf(agentName: string): InfoTreeItem {
    return new InfoTreeItem('loading', agentName, 'Loading sessions…');
  }

  private authRequiredLeaf(agentName: string): InfoTreeItem {
    return new InfoTreeItem(
      'auth-required',
      agentName,
      'Authentication required',
      'Click to retry authentication.',
      {
        command: 'acp.connectAgent',
        title: 'Retry connect',
        arguments: [agentName],
      },
    );
  }

  private errorLeaf(agentName: string, message: string): InfoTreeItem {
    return new InfoTreeItem(
      'error',
      agentName,
      'Failed to load sessions',
      message,
      {
        command: 'acp.refreshSessions',
        title: 'Retry',
        arguments: [agentName],
      },
    );
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

// --- helpers ---

function shortSessionId(id: string): string {
  if (id.length <= 14) { return id; }
  return id.slice(0, 8) + '…' + id.slice(-4);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function relativeTime(iso: string | null | undefined): string | undefined {
  if (!iso) { return undefined; }
  const t = Date.parse(iso);
  if (Number.isNaN(t)) { return undefined; }
  const diff = Date.now() - t;
  if (diff < 0) { return 'just now'; }
  const sec = Math.floor(diff / 1000);
  if (sec < 60) { return `${sec}s ago`; }
  const min = Math.floor(sec / 60);
  if (min < 60) { return `${min}m ago`; }
  const hr = Math.floor(min / 60);
  if (hr < 24) { return `${hr}h ago`; }
  const day = Math.floor(hr / 24);
  if (day < 7) { return `${day}d ago`; }
  const wk = Math.floor(day / 7);
  if (wk < 5) { return `${wk}w ago`; }
  const mo = Math.floor(day / 30);
  if (mo < 12) { return `${mo}mo ago`; }
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

function buildSessionTooltip(
  agentName: string,
  sessionId: string,
  cwd: string | undefined,
  updatedAt: string | undefined | null,
  source: 'agent' | 'local',
): string {
  const lines = [
    `Agent: ${agentName}`,
    `Session: ${sessionId}`,
  ];
  if (cwd) { lines.push(`cwd: ${cwd}`); }
  if (updatedAt) { lines.push(`Last active: ${updatedAt}`); }
  lines.push(source === 'local'
    ? 'Stored locally — agent does not list sessions'
    : 'Listed by agent');
  return lines.join('\n');
}
