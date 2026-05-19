import { describe, expect, it } from 'vitest';

import { mapSessionUpdateToActions } from './sessionUpdates';

describe('mapSessionUpdateToActions', () => {
  it('maps agent message chunks to assistant updates', () => {
    expect(
      mapSessionUpdateToActions({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      }),
    ).toEqual([{ type: 'appendAssistantChunk', text: 'hello' }]);
  });

  it('maps thought chunks to thought updates', () => {
    expect(
      mapSessionUpdateToActions({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking' },
      }),
    ).toEqual([{ type: 'appendThoughtChunk', text: 'thinking' }]);
  });

  it('provides safe fallbacks for tool call payloads', () => {
    expect(
      mapSessionUpdateToActions({
        sessionUpdate: 'tool_call',
      }),
    ).toEqual([
      {
        type: 'appendToolCall',
        toolCallId: 'unknown',
        title: 'Tool Call',
        status: 'pending',
      },
    ]);

    expect(
      mapSessionUpdateToActions({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
      }),
    ).toEqual([
      {
        type: 'updateToolCall',
        toolCallId: 'tool-1',
        title: undefined,
        status: 'completed',
      },
    ]);
  });

  it('maps plan, mode, and command updates', () => {
    expect(
      mapSessionUpdateToActions({
        sessionUpdate: 'plan',
        entries: [{ title: 'Step 1', status: 'completed' }],
      }),
    ).toEqual([
      {
        type: 'appendPlan',
        plan: {
          sessionUpdate: 'plan',
          entries: [{ title: 'Step 1', status: 'completed', description: undefined, content: undefined }],
        },
      },
    ]);

    expect(
      mapSessionUpdateToActions({
        sessionUpdate: 'current_mode_update',
        modeId: 'plan',
      }),
    ).toEqual([{ type: 'updateCurrentMode', modeId: 'plan' }]);

    expect(
      mapSessionUpdateToActions({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'fix', description: 'Fix code' }],
      }),
    ).toEqual([
      {
        type: 'updateAvailableCommands',
        commands: [{ name: 'fix', description: 'Fix code', input: undefined }],
      },
    ]);
  });

  it('ignores unknown or invalid payloads', () => {
    expect(mapSessionUpdateToActions({ sessionUpdate: 'unknown' })).toEqual([]);
  });
});
