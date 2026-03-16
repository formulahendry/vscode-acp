export type ChatRole = 'user' | 'assistant' | 'error';

export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'failed';

export type PlanEntryStatus = 'completed' | 'in_progress' | 'pending' | string;

export type MarkdownRenderItem = {
  index: number;
  text: string;
};

export type MarkdownRenderedItem = {
  index: number;
  html: string;
};

export type ModeOption = {
  id: string;
  name: string;
  description?: string;
};

export type ModesState = {
  availableModes: ModeOption[];
  currentModeId?: string | null;
};

export type ModelOption = {
  modelId: string;
  name: string;
  description?: string;
};

export type ModelsState = {
  availableModels: ModelOption[];
  currentModelId?: string | null;
};

export type SlashCommandInput = {
  hint?: string;
};

export type SlashCommand = {
  name: string;
  description: string;
  input?: SlashCommandInput | null;
};

export type SessionSnapshot = {
  sessionId?: string;
  agentName?: string;
  cwd?: string;
  modes?: ModesState | null;
  models?: ModelsState | null;
  availableCommands?: SlashCommand[] | null;
};

export type MessageHistoryItem = {
  kind: 'message';
  role: ChatRole;
  text: string;
  turnId?: string;
};

export type ThoughtHistoryItem = {
  kind: 'thought';
  text: string;
  durationSec: number;
  turnId?: string;
};

export type ToolCallHistoryItem = {
  kind: 'toolCall';
  toolCallId: string;
  title: string;
  status: ToolCallStatus;
  turnId?: string;
};

export type PlanEntry = {
  status?: PlanEntryStatus;
  title?: string;
  description?: string;
  content?: string;
};

export type PlanUpdate = {
  sessionUpdate?: 'plan';
  entries?: PlanEntry[];
  [key: string]: unknown;
};

export type PlanHistoryItem = {
  kind: 'plan';
  plan: PlanUpdate;
};

export type ChatHistoryItem =
  | MessageHistoryItem
  | ThoughtHistoryItem
  | ToolCallHistoryItem
  | PlanHistoryItem;

export type PersistedWebviewState = {
  chatHistory: ChatHistoryItem[];
  sessionState: SessionSnapshot | null;
  hasActiveSession: boolean;
};

export type FileSelection = {
  startLine?: number;
  startCharacter?: number;
  endLine?: number;
  endCharacter?: number;
  text?: string;
  cursorLine?: number;
  cursorCharacter?: number;
};

export type EditorSnapshot = {
  uriPath?: string;
  name?: string;
  cursorLine?: number;
  cursorCharacter?: number;
  selection?: FileSelection | null;
};

export type SessionContentChunk = {
  type?: string;
  text?: string;
};

export type AgentMessageChunkUpdate = {
  sessionUpdate: 'agent_message_chunk';
  content?: SessionContentChunk;
};

export type UserMessageChunkUpdate = {
  sessionUpdate: 'user_message_chunk';
  content?: SessionContentChunk;
};

export type AgentThoughtChunkUpdate = {
  sessionUpdate: 'agent_thought_chunk';
  content?: SessionContentChunk;
};

export type ToolCallUpdate = {
  sessionUpdate: 'tool_call';
  toolCallId?: string;
  title?: string;
  status?: ToolCallStatus;
};

export type ToolCallStatusUpdate = {
  sessionUpdate: 'tool_call_update';
  toolCallId?: string;
  title?: string;
  status?: ToolCallStatus;
};

export type CurrentModeUpdate = {
  sessionUpdate: 'current_mode_update';
  currentModeId?: string | null;
  modeId?: string | null;
};

export type AvailableCommandsUpdate = {
  sessionUpdate: 'available_commands_update';
  availableCommands?: SlashCommand[];
};

export type SessionUpdate =
  | AgentMessageChunkUpdate
  | UserMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | ToolCallUpdate
  | ToolCallStatusUpdate
  | PlanUpdate
  | CurrentModeUpdate
  | AvailableCommandsUpdate
  | {
      sessionUpdate: string;
      [key: string]: unknown;
    };

export type CurrentThought = {
  text: string;
  startedAt: number | null;
  finishedAt: number | null;
  isOpen: boolean;
};

export type CurrentToolCall = {
  toolCallId: string;
  title: string;
  status: ToolCallStatus;
};

export type CurrentTurn = {
  turnId: string;
  assistantText: string;
  thought: CurrentThought | null;
  toolCalls: CurrentToolCall[];
  historyToolCallIndexes: number[];
};
