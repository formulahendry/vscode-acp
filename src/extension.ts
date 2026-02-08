import * as vscode from 'vscode';

import { AgentManager } from './core/AgentManager';
import { ConnectionManager } from './core/ConnectionManager';
import { SessionManager } from './core/SessionManager';
import { SessionUpdateHandler } from './handlers/SessionUpdateHandler';
import { SessionTreeProvider } from './ui/SessionTreeProvider';
import { StatusBarManager } from './ui/StatusBarManager';
import { ChatWebviewProvider } from './ui/ChatWebviewProvider';
import { getAgentNames, getAgentConfigs } from './config/AgentConfig';
import { fetchRegistry } from './config/RegistryClient';
import { log, logError, disposeChannels } from './utils/Logger';

export function activate(context: vscode.ExtensionContext): void {
  log('ACP Client extension activating...');

  // --- Core services ---
  const sessionUpdateHandler = new SessionUpdateHandler();
  const agentManager = new AgentManager();
  const connectionManager = new ConnectionManager(sessionUpdateHandler);
  const sessionManager = new SessionManager(
    agentManager,
    connectionManager,
    sessionUpdateHandler,
  );

  // --- UI ---
  const sessionTreeProvider = new SessionTreeProvider(sessionManager);
  const treeView = vscode.window.createTreeView('acp-sessions', {
    treeDataProvider: sessionTreeProvider,
  });

  const chatWebviewProvider = new ChatWebviewProvider(
    context.extensionUri,
    sessionManager,
    sessionUpdateHandler,
  );
  const chatViewRegistration = vscode.window.registerWebviewViewProvider(
    ChatWebviewProvider.viewType,
    chatWebviewProvider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );

  const statusBarManager = new StatusBarManager(sessionManager);

  // Notify chat webview when active session changes
  sessionManager.on('active-session-changed', () => {
    chatWebviewProvider.notifyActiveSessionChanged();
  });

  // Clear chat when new conversation is started
  sessionManager.on('clear-chat', () => {
    chatWebviewProvider.clearChat();
  });

  // Forward mode/model changes to webview
  sessionManager.on('mode-changed', (_sessionId: string, _modeId: string) => {
    const session = sessionManager.getActiveSession();
    if (session?.modes) {
      chatWebviewProvider.notifyModesUpdate(session.modes);
    }
  });

  sessionManager.on('model-changed', (_sessionId: string, _modelId: string) => {
    const session = sessionManager.getActiveSession();
    if (session?.models) {
      chatWebviewProvider.notifyModelsUpdate(session.models);
    }
  });

  // --- Commands ---

  // Connect to Agent (primary action — inline icon in tree or pick from list)
  const connectAgentCmd = vscode.commands.registerCommand('acp.connectAgent', async (agentNameOrItem?: string | any) => {
    // Handle tree item object or string
    let agentName: string | undefined;
    if (typeof agentNameOrItem === 'string') {
      agentName = agentNameOrItem;
    } else if (agentNameOrItem?.agentName) {
      agentName = agentNameOrItem.agentName;
    }

    if (!agentName) {
      const agentNames = getAgentNames();
      if (agentNames.length === 0) {
        vscode.window.showWarningMessage(
          'No ACP agents configured. Add agents in Settings > ACP > Agents.',
        );
        return;
      }
      agentName = await vscode.window.showQuickPick(agentNames, {
        placeHolder: 'Select an agent to connect',
        title: 'Connect to Agent',
      });
      if (!agentName) { return; }
    }

    // If switching agents and there's chat content, confirm
    const currentAgent = sessionManager.getActiveAgentName();
    if (currentAgent && currentAgent !== agentName && chatWebviewProvider.hasChatContent) {
      const choice = await vscode.window.showWarningMessage(
        `Switch to ${agentName}? This will disconnect ${currentAgent} and clear the chat history.`,
        'Switch Agent',
        'Cancel',
      );
      if (choice !== 'Switch Agent') { return; }
      chatWebviewProvider.clearChat();
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Connecting to ${agentName}...`,
          cancellable: false,
        },
        async () => {
          await sessionManager.connectToAgent(agentName!);
        },
      );
    } catch (e: any) {
      logError('Failed to connect to agent', e);
      vscode.window.showErrorMessage(`Failed to connect: ${e.message}`);
    }
  });

  // New Conversation (disconnect + clear chat + reconnect same agent)
  const newConversationCmd = vscode.commands.registerCommand('acp.newConversation', async () => {
    const activeSession = sessionManager.getActiveSession();
    if (!activeSession) {
      // No active agent — fall back to connect
      await vscode.commands.executeCommand('acp.connectAgent');
      return;
    }

    // Confirm if there's existing chat content
    if (chatWebviewProvider.hasChatContent) {
      const choice = await vscode.window.showWarningMessage(
        'Start a new conversation? This will clear the current chat history.',
        'New Conversation',
        'Cancel',
      );
      if (choice !== 'New Conversation') { return; }
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Starting new conversation with ${activeSession.agentDisplayName}...`,
          cancellable: false,
        },
        async () => {
          await sessionManager.newConversation();
        },
      );
    } catch (e: any) {
      logError('Failed to start new conversation', e);
      vscode.window.showErrorMessage(`Failed to start new conversation: ${e.message}`);
    }
  });

  // Disconnect Agent
  const disconnectAgentCmd = vscode.commands.registerCommand('acp.disconnectAgent', async (item?: any) => {
    const agentName = item?.agentName || sessionManager.getActiveAgentName();
    if (!agentName) {
      vscode.window.showInformationMessage('No agent connected.');
      return;
    }
    await sessionManager.disconnectAgent(agentName);
    vscode.window.showInformationMessage(`Disconnected from ${agentName}.`);
  });

  // Open Chat
  const openChatCmd = vscode.commands.registerCommand('acp.openChat', () => {
    vscode.commands.executeCommand('acp-chat.focus');
  });

  // Send Prompt (from keybinding — just focus chat)
  const sendPromptCmd = vscode.commands.registerCommand('acp.sendPrompt', async () => {
    vscode.commands.executeCommand('acp-chat.focus');
  });

  // Cancel Turn
  const cancelTurnCmd = vscode.commands.registerCommand('acp.cancelTurn', async () => {
    const activeId = sessionManager.getActiveSessionId();
    if (activeId) {
      try {
        await sessionManager.cancelTurn(activeId);
      } catch (e) {
        logError('Cancel failed', e);
      }
    }
  });

  // Restart Agent
  const restartAgentCmd = vscode.commands.registerCommand('acp.restartAgent', async () => {
    const activeSession = sessionManager.getActiveSession();
    if (!activeSession) { return; }

    const agentName = activeSession.agentName;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Restarting ${activeSession.agentDisplayName}...`,
          cancellable: false,
        },
        async () => {
          await sessionManager.disconnectAgent(agentName);
          await sessionManager.connectToAgent(agentName);
        },
      );
      vscode.window.showInformationMessage(`Restarted ${agentName}`);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to restart: ${e.message}`);
    }
  });

  // Show Logs
  const showLogsCmd = vscode.commands.registerCommand('acp.showLogs', () => {
    const { getOutputChannel } = require('./utils/Logger');
    getOutputChannel().show();
  });

  // Show Log
  const showLogCmd = vscode.commands.registerCommand('acp.showLog', () => {
    const { getOutputChannel } = require('./utils/Logger');
    getOutputChannel().show();
  });

  // Show Traffic
  const showTrafficCmd = vscode.commands.registerCommand('acp.showTraffic', () => {
    const { getTrafficChannel } = require('./utils/Logger');
    getTrafficChannel().show();
  });

  // Set Mode
  const setModeCmd = vscode.commands.registerCommand('acp.setMode', async (modeId?: string) => {
    const activeId = sessionManager.getActiveSessionId();
    if (!activeId) { return; }

    if (!modeId) {
      modeId = await vscode.window.showInputBox({
        placeHolder: 'Enter mode ID (e.g., "plan", "code")',
        title: 'Set Agent Mode',
      }) || undefined;
    }
    if (modeId) {
      try {
        await sessionManager.setMode(activeId, modeId);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to set mode: ${e.message}`);
      }
    }
  });

  // Set Model
  const setModelCmd = vscode.commands.registerCommand('acp.setModel', async (modelId?: string) => {
    const activeId = sessionManager.getActiveSessionId();
    if (!activeId) { return; }

    if (!modelId) {
      modelId = await vscode.window.showInputBox({
        placeHolder: 'Enter model ID',
        title: 'Set Agent Model',
      }) || undefined;
    }
    if (modelId) {
      try {
        await sessionManager.setModel(activeId, modelId);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to set model: ${e.message}`);
      }
    }
  });

  // Refresh Agents tree
  const refreshAgentsCmd = vscode.commands.registerCommand('acp.refreshAgents', () => {
    sessionTreeProvider.refresh();
  });

  // Add Agent Configuration
  const addAgentCmd = vscode.commands.registerCommand('acp.addAgent', async () => {
    const name = await vscode.window.showInputBox({
      prompt: 'Agent name',
      placeHolder: 'my-agent',
      title: 'Add ACP Agent',
    });
    if (!name) { return; }

    const command = await vscode.window.showInputBox({
      prompt: 'Command to launch the agent',
      placeHolder: 'npx',
      title: 'Agent Command',
    });
    if (!command) { return; }

    const argsStr = await vscode.window.showInputBox({
      prompt: 'Arguments (space-separated)',
      placeHolder: '-y @my-org/agent',
      title: 'Agent Arguments',
    });
    const args = argsStr ? argsStr.split(/\s+/) : [];

    const config = vscode.workspace.getConfiguration('acp');
    const agents: Record<string, any> = { ...(config.get<Record<string, any>>('agents') || {}) };
    agents[name] = { command, args };
    await config.update('agents', agents, vscode.ConfigurationTarget.Global);
    sessionTreeProvider.refresh();
    vscode.window.showInformationMessage(`Agent "${name}" added.`);
  });

  // Remove Agent
  const removeAgentCmd = vscode.commands.registerCommand('acp.removeAgent', async (item?: any) => {
    const config = vscode.workspace.getConfiguration('acp');
    const agents: Record<string, any> = { ...(config.get<Record<string, any>>('agents') || {}) };
    const agentNames = Object.keys(agents);
    if (agentNames.length === 0) {
      vscode.window.showInformationMessage('No agents configured.');
      return;
    }

    const name = item?.agentName ?? await vscode.window.showQuickPick(agentNames, {
      placeHolder: 'Select agent to remove',
      title: 'Remove ACP Agent',
    });
    if (!name) { return; }

    const confirm = await vscode.window.showWarningMessage(
      `Remove agent "${name}"?`, { modal: true }, 'Remove',
    );
    if (confirm !== 'Remove') { return; }

    // Disconnect if connected
    if (sessionManager.isAgentConnected(name)) {
      await sessionManager.disconnectAgent(name);
    }

    delete agents[name];
    await config.update('agents', agents, vscode.ConfigurationTarget.Global);
    sessionTreeProvider.refresh();
    vscode.window.showInformationMessage(`Agent "${name}" removed.`);
  });

  // Attach File
  const attachFileCmd = vscode.commands.registerCommand('acp.attachFile', async () => {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Attach',
      title: 'Attach File to Chat',
    });
    if (uris && uris.length > 0) {
      chatWebviewProvider.attachFile(uris[0]);
    }
  });

  // Browse Registry
  const browseRegistryCmd = vscode.commands.registerCommand('acp.browseRegistry', async () => {
    try {
      const agents = await fetchRegistry();
      const items = agents.map(a => ({
        label: a.name,
        description: a.command,
        detail: a.description || '',
      }));
      if (items.length === 0) {
        vscode.window.showInformationMessage('No agents found in registry.');
        return;
      }
      await vscode.window.showQuickPick(items, {
        placeHolder: 'ACP Agent Registry',
        title: 'Available ACP Agents',
      });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to fetch registry: ${e.message}`);
    }
  });

  // --- Register disposables ---
  context.subscriptions.push(
    treeView,
    chatViewRegistration,
    statusBarManager,
    connectAgentCmd,
    newConversationCmd,
    disconnectAgentCmd,
    openChatCmd,
    sendPromptCmd,
    cancelTurnCmd,
    restartAgentCmd,
    showLogsCmd,
    showLogCmd,
    showTrafficCmd,
    setModeCmd,
    setModelCmd,
    refreshAgentsCmd,
    addAgentCmd,
    removeAgentCmd,
    attachFileCmd,
    browseRegistryCmd,
    {
      dispose: () => {
        sessionManager.dispose();
        sessionUpdateHandler.dispose();
        chatWebviewProvider.dispose();
        sessionTreeProvider.dispose();
        disposeChannels();
      },
    },
  );

  log('ACP Client extension activated.');
}

export function deactivate(): void {
  log('ACP Client extension deactivated.');
}
