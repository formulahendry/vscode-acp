import type { JSX } from 'react';

import type { CurrentToolCall, ToolCallHistoryItem, ToolCallStatus } from '../chatTypes';

type TurnToolHistoryItem = {
  item: ToolCallHistoryItem;
  historyIndex: number;
};

export type TurnToolsProps = {
  turnKey: string;
  toolCalls: CurrentToolCall[] | TurnToolHistoryItem[];
  collapsed: boolean;
  onToggle: () => void;
};

function getStatusIcon(status: ToolCallStatus): string {
  switch (status) {
    case 'running':
      return '⟳';
    case 'completed':
      return '✓';
    case 'failed':
      return '✗';
    default:
      return '…';
  }
}

export function TurnTools({ turnKey, toolCalls, collapsed, onToggle }: TurnToolsProps): JSX.Element | null {
  if (toolCalls.length === 0) {
    return null;
  }

  const items = toolCalls.map((toolCall) =>
    'item' in toolCall
      ? {
          key: `${turnKey}-tool-${toolCall.historyIndex}`,
          toolCallId: toolCall.item.toolCallId,
          title: toolCall.item.title,
          status: toolCall.item.status,
        }
      : {
          key: `${turnKey}-tool-${toolCall.toolCallId}`,
          toolCallId: toolCall.toolCallId,
          title: toolCall.title,
          status: toolCall.status,
        },
  );

  const count = items.length;
  const summaryLabel = `${collapsed ? '▸' : '▾'} ${count} tool call${count !== 1 ? 's' : ''}`;

  return (
    <div className="turn-tools">
      <div className="turn-tools-summary" data-count={count} onClick={onToggle} onKeyDown={undefined} role="button" tabIndex={0}>
        {summaryLabel}
      </div>
      <div className={`turn-tools-list${collapsed ? ' collapsed' : ''}`}>
        {items.map((toolCall) => (
          <div className="tool-call-inline" id={`tc-${toolCall.toolCallId}`} key={toolCall.key}>
            <span className={`tc-icon ${toolCall.status}`}>{getStatusIcon(toolCall.status)}</span>
            <span className="tc-title">{toolCall.title || 'Tool Call'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
