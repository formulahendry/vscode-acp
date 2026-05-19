import type { SessionUpdate } from '../chatTypes';
import {
  normalizePlanUpdate,
  normalizeSlashCommands,
  normalizeToolCallStatus,
} from './normalizers';
import type { AppAction } from './state';

function getTextContent(update: SessionUpdate): string | undefined {
  const content =
    'content' in update && update.content && typeof update.content === 'object'
      ? (update.content as { type?: string; text?: string })
      : undefined;
  return content?.type === 'text' && typeof content.text === 'string' ? content.text : undefined;
}

export function mapSessionUpdateToActions(update: SessionUpdate): AppAction[] {
  if (!update || typeof update !== 'object') {
    return [];
  }

  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const contentText = getTextContent(update);
      return contentText ? [{ type: 'appendAssistantChunk', text: contentText }] : [];
    }

    case 'user_message_chunk':
      return [];

    case 'agent_thought_chunk': {
      const contentText = getTextContent(update);
      return contentText ? [{ type: 'appendThoughtChunk', text: contentText }] : [];
    }

    case 'tool_call': {
      const toolCallId = 'toolCallId' in update && typeof update.toolCallId === 'string' ? update.toolCallId : 'unknown';
      const title = 'title' in update && typeof update.title === 'string' ? update.title : 'Tool Call';
      return [
        {
          type: 'appendToolCall',
          toolCallId,
          title,
          status: normalizeToolCallStatus('status' in update ? update.status : undefined),
        },
      ];
    }

    case 'tool_call_update': {
      const toolCallId = 'toolCallId' in update && typeof update.toolCallId === 'string' ? update.toolCallId : 'unknown';
      const title = 'title' in update && typeof update.title === 'string' ? update.title : undefined;
      return [
        {
          type: 'updateToolCall',
          toolCallId,
          title,
          status: normalizeToolCallStatus('status' in update ? update.status : 'completed'),
        },
      ];
    }

    case 'plan':
      return [
        {
          type: 'appendPlan',
          plan: normalizePlanUpdate(update),
        },
      ];

    case 'current_mode_update':
      return [
        {
          type: 'updateCurrentMode',
          modeId:
            ('currentModeId' in update && typeof update.currentModeId === 'string'
              ? update.currentModeId
              : 'modeId' in update && typeof update.modeId === 'string'
                ? update.modeId
                : null),
        },
      ];

    case 'available_commands_update':
      return [
        {
          type: 'updateAvailableCommands',
          commands: normalizeSlashCommands('availableCommands' in update ? update.availableCommands : undefined),
        },
      ];

    default:
      return [];
  }
}
