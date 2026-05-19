import type {
  ChatHistoryItem,
  CurrentTurn,
  ModelsState,
  ModesState,
  PersistedWebviewState,
  PlanUpdate,
  SessionSnapshot,
  SlashCommand,
  ToolCallHistoryItem,
  ToolCallStatus,
} from '../chatTypes';
import {
  normalizePersistedState,
  normalizePlanUpdate,
  normalizeSessionSnapshot,
} from './normalizers';

export const MIN_INPUT_HEIGHT = 90;
export const MAX_INPUT_HEIGHT = 400;
export const DEFAULT_INPUT_HEIGHT = 140;
const FALLBACK_TURN_ID = 'fallback-turn';

export type AppState = {
  persisted: PersistedWebviewState;
  promptText: string;
  inputAreaHeight: number;
  isProcessing: boolean;
  composerUnlocked: boolean;
  isModeDropdownOpen: boolean;
  isModelDropdownOpen: boolean;
  slashSelectedIdx: number;
  slashPopupSuppressedFor: string | null;
  placeholderOverride: string | null;
  renderedMarkdown: Record<number, string>;
  currentTurn: CurrentTurn | null;
  collapsedTools: Record<string, boolean>;
};

export type AppAction =
  | { type: 'setPromptText'; text: string }
  | { type: 'setInputAreaHeight'; height: number }
  | { type: 'toggleModeDropdown' }
  | { type: 'toggleModelDropdown' }
  | { type: 'closePickers' }
  | { type: 'setSlashSelectedIdx'; index: number }
  | { type: 'suppressSlashPopup'; promptText: string | null }
  | { type: 'setPlaceholderOverride'; placeholder: string | null }
  | { type: 'setCollapsedTools'; key: string; collapsed: boolean }
  | { type: 'showSessionConnected'; session: SessionSnapshot }
  | { type: 'showNoSession' }
  | { type: 'appendUserMessage'; text: string }
  | { type: 'appendErrorMessage'; text: string }
  | { type: 'attachFile'; text: string }
  | { type: 'promptStart'; turnId: string }
  | { type: 'promptEnd' }
  | { type: 'clearChat' }
  | { type: 'updateModes'; modes: ModesState }
  | { type: 'updateModels'; models: ModelsState }
  | { type: 'updateCurrentMode'; modeId: string | null }
  | { type: 'updateCurrentModel'; modelId: string | null }
  | { type: 'updateAvailableCommands'; commands: SlashCommand[] }
  | { type: 'appendThoughtChunk'; text: string }
  | { type: 'setCurrentThoughtOpen'; isOpen: boolean }
  | { type: 'appendAssistantChunk'; text: string }
  | { type: 'appendToolCall'; toolCallId: string; title: string; status: ToolCallStatus }
  | { type: 'updateToolCall'; toolCallId: string; title?: string; status: ToolCallStatus }
  | { type: 'appendPlan'; plan: PlanUpdate }
  | { type: 'setRenderedMarkdown'; items: Array<{ index: number; html: string }> };

export function emptyPersistedState(): PersistedWebviewState {
  return {
    chatHistory: [],
    sessionState: null,
    hasActiveSession: false,
  };
}

export function createCurrentTurn(turnId: string): CurrentTurn {
  return {
    turnId,
    assistantText: '',
    thought: null,
    toolCalls: [],
    historyToolCallIndexes: [],
  };
}

export function createInitialState(persistedValue: unknown): AppState {
  const persisted = normalizePersistedState(persistedValue);
  return {
    persisted,
    promptText: '',
    inputAreaHeight: DEFAULT_INPUT_HEIGHT,
    isProcessing: false,
    composerUnlocked: persisted.hasActiveSession,
    isModeDropdownOpen: false,
    isModelDropdownOpen: false,
    slashSelectedIdx: 0,
    slashPopupSuppressedFor: null,
    placeholderOverride: null,
    renderedMarkdown: {},
    currentTurn: null,
    collapsedTools: {},
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function ensureSessionState(state: AppState): SessionSnapshot {
  return state.persisted.sessionState ?? { availableCommands: [] };
}

function ensureCurrentTurn(state: AppState): CurrentTurn {
  return state.currentTurn ?? createCurrentTurn(FALLBACK_TURN_ID);
}

function updateHistoryToolCall(
  chatHistory: ChatHistoryItem[],
  toolCallId: string,
  status: ToolCallStatus,
  title?: string,
): ChatHistoryItem[] {
  for (let index = chatHistory.length - 1; index >= 0; index -= 1) {
    const item = chatHistory[index];
    if (item.kind === 'toolCall' && item.toolCallId === toolCallId) {
      const nextItem: ToolCallHistoryItem = {
        ...item,
        status,
        title: title ?? item.title,
      };
      return [
        ...chatHistory.slice(0, index),
        nextItem,
        ...chatHistory.slice(index + 1),
      ];
    }
  }

  return chatHistory;
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'setPromptText':
      return {
        ...state,
        promptText: action.text,
      };

    case 'setInputAreaHeight':
      return {
        ...state,
        inputAreaHeight: clamp(action.height, MIN_INPUT_HEIGHT, MAX_INPUT_HEIGHT),
      };

    case 'toggleModeDropdown':
      return {
        ...state,
        isModeDropdownOpen: !state.isModeDropdownOpen,
        isModelDropdownOpen: false,
      };

    case 'toggleModelDropdown':
      return {
        ...state,
        isModeDropdownOpen: false,
        isModelDropdownOpen: !state.isModelDropdownOpen,
      };

    case 'closePickers':
      return {
        ...state,
        isModeDropdownOpen: false,
        isModelDropdownOpen: false,
      };

    case 'setSlashSelectedIdx':
      return {
        ...state,
        slashSelectedIdx: action.index,
      };

    case 'suppressSlashPopup':
      return {
        ...state,
        slashPopupSuppressedFor: action.promptText,
      };

    case 'setPlaceholderOverride':
      return {
        ...state,
        placeholderOverride: action.placeholder,
      };

    case 'setCollapsedTools':
      return {
        ...state,
        collapsedTools: {
          ...state.collapsedTools,
          [action.key]: action.collapsed,
        },
      };

    case 'showSessionConnected':
      return {
        ...state,
        persisted: {
          ...state.persisted,
          hasActiveSession: true,
          sessionState: normalizeSessionSnapshot(action.session) ?? action.session,
        },
        composerUnlocked: true,
      };

    case 'showNoSession':
      return {
        ...state,
        persisted: {
          ...state.persisted,
          hasActiveSession: false,
          sessionState: null,
        },
        composerUnlocked: false,
        isModeDropdownOpen: false,
        isModelDropdownOpen: false,
      };

    case 'appendUserMessage':
      return {
        ...state,
        persisted: {
          ...state.persisted,
          chatHistory: [
            ...state.persisted.chatHistory,
            { kind: 'message', role: 'user', text: action.text },
          ],
        },
      };

    case 'appendErrorMessage':
      return {
        ...state,
        persisted: {
          ...state.persisted,
          chatHistory: [
            ...state.persisted.chatHistory,
            { kind: 'message', role: 'error', text: action.text },
          ],
        },
      };

    case 'attachFile':
      return {
        ...state,
        promptText: action.text,
        composerUnlocked: true,
      };

    case 'promptStart':
      return {
        ...state,
        isProcessing: true,
        currentTurn: createCurrentTurn(action.turnId),
        slashPopupSuppressedFor: null,
      };

    case 'promptEnd': {
      if (!state.currentTurn) {
        return {
          ...state,
          isProcessing: false,
        };
      }

      const nextHistory = [...state.persisted.chatHistory];
      if (state.currentTurn.thought?.text) {
        const endTime = state.currentTurn.thought.finishedAt ?? Date.now();
        const durationSec = state.currentTurn.thought.startedAt
          ? Math.round((endTime - state.currentTurn.thought.startedAt) / 1000)
          : 0;
        nextHistory.push({
          kind: 'thought',
          text: state.currentTurn.thought.text,
          durationSec,
          turnId: state.currentTurn.turnId,
        });
      }

      if (state.currentTurn.assistantText) {
        nextHistory.push({
          kind: 'message',
          role: 'assistant',
          text: state.currentTurn.assistantText,
          turnId: state.currentTurn.turnId,
        });
      }

      return {
        ...state,
        persisted: {
          ...state.persisted,
          chatHistory: nextHistory,
        },
        isProcessing: false,
        currentTurn: null,
      };
    }

    case 'clearChat':
      return {
        ...state,
        persisted: emptyPersistedState(),
        isProcessing: false,
        composerUnlocked: false,
        isModeDropdownOpen: false,
        isModelDropdownOpen: false,
        slashPopupSuppressedFor: null,
        placeholderOverride: null,
        renderedMarkdown: {},
        currentTurn: null,
      };

    case 'updateModes': {
      const sessionState = ensureSessionState(state);
      return {
        ...state,
        persisted: {
          ...state.persisted,
          sessionState: {
            ...sessionState,
            modes: action.modes,
          },
        },
      };
    }

    case 'updateModels': {
      const sessionState = ensureSessionState(state);
      return {
        ...state,
        persisted: {
          ...state.persisted,
          sessionState: {
            ...sessionState,
            models: action.models,
          },
        },
      };
    }

    case 'updateCurrentMode': {
      const sessionState = ensureSessionState(state);
      return {
        ...state,
        persisted: {
          ...state.persisted,
          sessionState: {
            ...sessionState,
            modes: {
              ...(sessionState.modes ?? { availableModes: [] }),
              currentModeId: action.modeId,
            },
          },
        },
      };
    }

    case 'updateCurrentModel': {
      const sessionState = ensureSessionState(state);
      return {
        ...state,
        persisted: {
          ...state.persisted,
          sessionState: {
            ...sessionState,
            models: {
              ...(sessionState.models ?? { availableModels: [] }),
              currentModelId: action.modelId,
            },
          },
        },
      };
    }

    case 'updateAvailableCommands': {
      const sessionState = ensureSessionState(state);
      return {
        ...state,
        persisted: {
          ...state.persisted,
          sessionState: {
            ...sessionState,
            availableCommands: action.commands,
          },
        },
      };
    }

    case 'appendThoughtChunk': {
      const currentTurn = ensureCurrentTurn(state);
      return {
        ...state,
        currentTurn: {
          ...currentTurn,
          thought: currentTurn.thought
            ? {
                ...currentTurn.thought,
                text: currentTurn.thought.text + action.text,
              }
            : {
                text: action.text,
                startedAt: Date.now(),
                finishedAt: null,
                isOpen: true,
              },
        },
      };
    }

    case 'setCurrentThoughtOpen':
      if (!state.currentTurn?.thought) {
        return state;
      }

      return {
        ...state,
        currentTurn: {
          ...state.currentTurn,
          thought: {
            ...state.currentTurn.thought,
            isOpen: action.isOpen,
          },
        },
      };

    case 'appendAssistantChunk': {
      const currentTurn = ensureCurrentTurn(state);
      const assistantText = currentTurn.assistantText + action.text;
      const shouldCloseThought = assistantText.trim().length > 0 && currentTurn.thought;
      return {
        ...state,
        currentTurn: {
          ...currentTurn,
          assistantText,
          thought:
            currentTurn.thought && shouldCloseThought
              ? {
                  ...currentTurn.thought,
                  finishedAt: currentTurn.thought.finishedAt ?? Date.now(),
                  isOpen: false,
                }
              : currentTurn.thought,
        },
      };
    }

    case 'appendToolCall': {
      const currentTurn = ensureCurrentTurn(state);
      const historyIndex = state.persisted.chatHistory.length;
      return {
        ...state,
        persisted: {
          ...state.persisted,
          chatHistory: [
            ...state.persisted.chatHistory,
            {
              kind: 'toolCall',
              toolCallId: action.toolCallId,
              title: action.title,
              status: action.status,
              turnId: currentTurn.turnId,
            },
          ],
        },
        currentTurn: {
          ...currentTurn,
          toolCalls: [
            ...currentTurn.toolCalls,
            {
              toolCallId: action.toolCallId,
              title: action.title,
              status: action.status,
            },
          ],
          historyToolCallIndexes: [...currentTurn.historyToolCallIndexes, historyIndex],
        },
      };
    }

    case 'updateToolCall': {
      const nextHistory = updateHistoryToolCall(
        state.persisted.chatHistory,
        action.toolCallId,
        action.status,
        action.title,
      );
      const nextTurn = state.currentTurn
        ? {
            ...state.currentTurn,
            toolCalls: state.currentTurn.toolCalls.map((toolCall) =>
              toolCall.toolCallId === action.toolCallId
                ? {
                    ...toolCall,
                    status: action.status,
                    title: action.title ?? toolCall.title,
                  }
                : toolCall,
            ),
          }
        : null;

      return {
        ...state,
        persisted: {
          ...state.persisted,
          chatHistory: nextHistory,
        },
        currentTurn: nextTurn,
      };
    }

    case 'appendPlan':
      return {
        ...state,
        persisted: {
          ...state.persisted,
          chatHistory: [
            ...state.persisted.chatHistory,
            {
              kind: 'plan',
              plan: normalizePlanUpdate(action.plan),
            },
          ],
        },
      };

    case 'setRenderedMarkdown': {
      const renderedMarkdown = { ...state.renderedMarkdown };
      for (const item of action.items) {
        renderedMarkdown[item.index] = item.html;
      }
      return {
        ...state,
        renderedMarkdown,
      };
    }

    default:
      return state;
  }
}
