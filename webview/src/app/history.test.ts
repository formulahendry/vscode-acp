import { describe, expect, it } from 'vitest';

import type { ChatHistoryItem } from '../chatTypes';
import { buildHistoryBlocks, getToolCollapseState } from './history';

describe('buildHistoryBlocks', () => {
  it('groups turn-associated items by turnId', () => {
    const chatHistory: ChatHistoryItem[] = [
      { kind: 'message', role: 'user', text: 'hello' },
      { kind: 'thought', text: 'thinking', durationSec: 1, turnId: 'turn-1' },
      { kind: 'toolCall', toolCallId: 'tool-1', title: 'Read', status: 'running', turnId: 'turn-1' },
      { kind: 'message', role: 'assistant', text: 'done', turnId: 'turn-1' },
    ];

    const blocks = buildHistoryBlocks(chatHistory, new Set());

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      kind: 'message',
      item: { role: 'user', text: 'hello' },
    });
    expect(blocks[1]).toMatchObject({
      kind: 'turn',
      thought: { item: { text: 'thinking' } },
      assistant: { item: { text: 'done' } },
    });
    expect(blocks[1].kind === 'turn' ? blocks[1].toolCalls : []).toHaveLength(1);
  });

  it('keeps legacy assistant turns together without turnId', () => {
    const chatHistory: ChatHistoryItem[] = [
      { kind: 'thought', text: 'legacy thought', durationSec: 2 },
      { kind: 'toolCall', toolCallId: 'tool-legacy', title: 'Search', status: 'completed' },
      { kind: 'message', role: 'assistant', text: 'legacy answer' },
    ];

    const blocks = buildHistoryBlocks(chatHistory, new Set());

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'turn',
      thought: { item: { text: 'legacy thought' } },
      assistant: { item: { text: 'legacy answer' } },
    });
    expect(blocks[0].kind === 'turn' ? blocks[0].toolCalls : []).toHaveLength(1);
  });

  it('excludes tool calls already represented by the current turn', () => {
    const chatHistory: ChatHistoryItem[] = [
      { kind: 'toolCall', toolCallId: 'tool-1', title: 'Read', status: 'running', turnId: 'turn-1' },
      { kind: 'message', role: 'assistant', text: 'done', turnId: 'turn-1' },
    ];

    const blocks = buildHistoryBlocks(chatHistory, new Set([0]));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'turn',
      assistant: { item: { text: 'done' } },
    });
    expect(blocks[0].kind === 'turn' ? blocks[0].toolCalls : []).toHaveLength(0);
  });
});

describe('getToolCollapseState', () => {
  it('defaults to collapsed when a turn has more than three tool calls', () => {
    expect(getToolCollapseState('turn-1', 4, {})).toBe(true);
    expect(getToolCollapseState('turn-1', 3, {})).toBe(false);
  });

  it('prefers explicit collapsed state over the default', () => {
    expect(getToolCollapseState('turn-1', 5, { 'turn-1': false })).toBe(false);
  });
});
