import type { JSX } from 'react';

import type { CurrentToolCall, ToolCallHistoryItem } from '../chatTypes';
import { ThoughtBlock, type ThoughtBlockProps } from './ThoughtBlock';
import { TurnTools } from './TurnTools';

type TurnToolHistoryItem = {
  item: ToolCallHistoryItem;
  historyIndex: number;
};

export type TurnBlockProps = {
  turnKey: string;
  thought: ThoughtBlockProps | null;
  assistantText?: string;
  assistantHtml?: string;
  toolCalls: CurrentToolCall[] | TurnToolHistoryItem[];
  collapsed: boolean;
  onToggleTools: () => void;
};

export function TurnBlock({
  turnKey,
  thought,
  assistantText,
  assistantHtml,
  toolCalls,
  collapsed,
  onToggleTools,
}: TurnBlockProps): JSX.Element | null {
  const hasAssistantContent = typeof assistantText === 'string' && assistantText.trim().length > 0;
  const hasAssistant = Boolean(assistantHtml) || assistantText !== undefined;
  const hasVisibleContent = Boolean(thought) || hasAssistant || toolCalls.length > 0;

  if (!hasVisibleContent) {
    return null;
  }

  return (
    <div className="turn" key={turnKey}>
      {thought ? <ThoughtBlock {...thought} /> : null}
      {hasAssistant ? (
        <div
          className={`message assistant${assistantHtml ? ' md-rendered' : ''}`}
          {...(assistantHtml ? { dangerouslySetInnerHTML: { __html: assistantHtml } } : {})}
        >
          {!assistantHtml && hasAssistantContent ? assistantText : !assistantHtml ? assistantText : null}
        </div>
      ) : null}
      <TurnTools turnKey={turnKey} toolCalls={toolCalls} collapsed={collapsed} onToggle={onToggleTools} />
    </div>
  );
}
