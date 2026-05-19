import type {
  ChatHistoryItem,
  MarkdownRenderItem,
  MessageHistoryItem,
  PlanHistoryItem,
  ThoughtHistoryItem,
  ToolCallHistoryItem,
} from '../chatTypes';
import type { AppState } from './state';

export type HistoryTurnBlock = {
  kind: 'turn';
  key: string;
  thought: { item: ThoughtHistoryItem; historyIndex: number } | null;
  assistant: { item: MessageHistoryItem; historyIndex: number } | null;
  toolCalls: Array<{ item: ToolCallHistoryItem; historyIndex: number }>;
  firstIndex: number;
};

export type HistoryBlock =
  | { kind: 'message'; item: MessageHistoryItem; historyIndex: number }
  | { kind: 'plan'; item: PlanHistoryItem; historyIndex: number }
  | HistoryTurnBlock;

function hasTurnAssociation(item: ChatHistoryItem): item is ThoughtHistoryItem | ToolCallHistoryItem | MessageHistoryItem {
  if (item.kind === 'plan') {
    return false;
  }

  if (item.kind === 'message') {
    return item.role === 'assistant' && typeof item.turnId === 'string';
  }

  return typeof item.turnId === 'string';
}

function createHistoryTurnBlock(key: string, firstIndex: number): HistoryTurnBlock {
  return {
    kind: 'turn',
    key,
    thought: null,
    assistant: null,
    toolCalls: [],
    firstIndex,
  };
}

export function getRestoreMarkdownItems(chatHistory: ChatHistoryItem[]): MarkdownRenderItem[] {
  return chatHistory.flatMap((item, index) =>
    item.kind === 'message' && item.role === 'assistant'
      ? [{ index, text: item.text }]
      : [],
  );
}

export function getPromptEndMarkdownItem(state: Pick<AppState, 'currentTurn' | 'persisted'>): MarkdownRenderItem | null {
  if (!state.currentTurn?.assistantText) {
    return null;
  }

  let index = state.persisted.chatHistory.length;
  if (state.currentTurn.thought?.text) {
    index += 1;
  }

  return {
    index,
    text: state.currentTurn.assistantText,
  };
}

export function buildHistoryBlocks(chatHistory: ChatHistoryItem[], excludedIndexes: Set<number>): HistoryBlock[] {
  const blocks: HistoryBlock[] = [];
  const turnBlocks = new Map<string, HistoryTurnBlock>();
  const emittedTurnIds = new Set<string>();

  for (let index = 0; index < chatHistory.length; index += 1) {
    if (excludedIndexes.has(index)) {
      continue;
    }

    const item = chatHistory[index];
    if (!hasTurnAssociation(item) || !item.turnId) {
      continue;
    }

    const turn = turnBlocks.get(item.turnId) ?? createHistoryTurnBlock(`turn-${item.turnId}`, index);
    turn.firstIndex = Math.min(turn.firstIndex, index);
    if (item.kind === 'thought') {
      turn.thought = { item, historyIndex: index };
    } else if (item.kind === 'toolCall') {
      turn.toolCalls.push({ item, historyIndex: index });
    } else {
      turn.assistant = { item, historyIndex: index };
    }
    turnBlocks.set(item.turnId, turn);
  }

  let fallbackTurn: HistoryTurnBlock | null = null;
  const flushFallbackTurn = () => {
    if (!fallbackTurn) {
      return;
    }
    blocks.push(fallbackTurn);
    fallbackTurn = null;
  };

  for (let index = 0; index < chatHistory.length; index += 1) {
    if (excludedIndexes.has(index)) {
      continue;
    }

    const item = chatHistory[index];
    if (hasTurnAssociation(item) && item.turnId) {
      flushFallbackTurn();
      if (!emittedTurnIds.has(item.turnId)) {
        const turnBlock = turnBlocks.get(item.turnId);
        if (turnBlock) {
          blocks.push(turnBlock);
          emittedTurnIds.add(item.turnId);
        }
      }
      continue;
    }

    switch (item.kind) {
      case 'message':
        if (item.role === 'assistant') {
          fallbackTurn ??= createHistoryTurnBlock(`legacy-turn-${index}`, index);
          fallbackTurn.assistant = { item, historyIndex: index };
          flushFallbackTurn();
        } else {
          flushFallbackTurn();
          blocks.push({ kind: 'message', item, historyIndex: index });
        }
        break;

      case 'thought':
        fallbackTurn ??= createHistoryTurnBlock(`legacy-turn-${index}`, index);
        fallbackTurn.thought = { item, historyIndex: index };
        break;

      case 'toolCall':
        fallbackTurn ??= createHistoryTurnBlock(`legacy-turn-${index}`, index);
        fallbackTurn.toolCalls.push({ item, historyIndex: index });
        break;

      case 'plan':
        flushFallbackTurn();
        blocks.push({ kind: 'plan', item, historyIndex: index });
        break;
    }
  }

  flushFallbackTurn();
  return blocks;
}

export function getToolCollapseState(
  turnKey: string,
  toolCount: number,
  collapsedTools: Record<string, boolean>,
): boolean {
  if (turnKey in collapsedTools) {
    return collapsedTools[turnKey];
  }

  return toolCount > 3;
}
