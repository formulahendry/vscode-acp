import { describe, expect, it, vi } from 'vitest';

import { appReducer, createInitialState, MAX_INPUT_HEIGHT, MIN_INPUT_HEIGHT } from './state';

describe('appReducer', () => {
  it('persists thoughts and assistant text on prompt end', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1_000);
    nowSpy.mockReturnValueOnce(4_000);

    let state = createInitialState(undefined);
    state = appReducer(state, { type: 'promptStart', turnId: 'turn-1' });
    state = appReducer(state, { type: 'appendThoughtChunk', text: 'Thinking' });
    state = appReducer(state, { type: 'appendAssistantChunk', text: 'Done' });
    state = appReducer(state, { type: 'promptEnd' });

    expect(state.isProcessing).toBe(false);
    expect(state.currentTurn).toBeNull();
    expect(state.persisted.chatHistory).toEqual([
      {
        kind: 'thought',
        text: 'Thinking',
        durationSec: 3,
        turnId: 'turn-1',
      },
      {
        kind: 'message',
        role: 'assistant',
        text: 'Done',
        turnId: 'turn-1',
      },
    ]);

    nowSpy.mockRestore();
  });

  it('keeps tool calls in sync between current turn and history', () => {
    let state = createInitialState(undefined);
    state = appReducer(state, { type: 'promptStart', turnId: 'turn-2' });
    state = appReducer(state, {
      type: 'appendToolCall',
      toolCallId: 'tool-1',
      title: 'Read file',
      status: 'running',
    });
    state = appReducer(state, {
      type: 'updateToolCall',
      toolCallId: 'tool-1',
      title: 'Read file complete',
      status: 'completed',
    });

    expect(state.currentTurn?.toolCalls).toEqual([
      {
        toolCallId: 'tool-1',
        title: 'Read file complete',
        status: 'completed',
      },
    ]);
    expect(state.persisted.chatHistory).toEqual([
      {
        kind: 'toolCall',
        toolCallId: 'tool-1',
        title: 'Read file complete',
        status: 'completed',
        turnId: 'turn-2',
      },
    ]);
  });

  it('resets chat state on clearChat', () => {
    let state = createInitialState({
      hasActiveSession: true,
      sessionState: { agentName: 'Codex', availableCommands: [] },
      chatHistory: [{ kind: 'message', role: 'user', text: 'hello' }],
    });

    state = appReducer(state, { type: 'clearChat' });

    expect(state.persisted).toEqual({
      chatHistory: [],
      sessionState: null,
      hasActiveSession: false,
    });
    expect(state.composerUnlocked).toBe(false);
    expect(state.currentTurn).toBeNull();
    expect(state.renderedMarkdown).toEqual({});
  });

  it('clamps the input area height', () => {
    let state = createInitialState(undefined);

    state = appReducer(state, { type: 'setInputAreaHeight', height: MIN_INPUT_HEIGHT - 50 });
    expect(state.inputAreaHeight).toBe(MIN_INPUT_HEIGHT);

    state = appReducer(state, { type: 'setInputAreaHeight', height: MAX_INPUT_HEIGHT + 50 });
    expect(state.inputAreaHeight).toBe(MAX_INPUT_HEIGHT);
  });
});
