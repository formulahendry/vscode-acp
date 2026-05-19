import type { JSX } from 'react';

export type ThoughtBlockProps = {
  text: string;
  durationSec: number | null;
  isStreaming: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
};

function getThoughtSummary(text: string, durationSec: number | null, isStreaming: boolean): JSX.Element | string {
  if (isStreaming) {
    return (
      <>
        <span className="thought-indicator" />
        Thinking...
      </>
    );
  }

  if (durationSec && durationSec > 0) {
    return `Thought for ${durationSec}s`;
  }

  return text.length > 0 ? 'Thought' : '';
}

export function ThoughtBlock({ text, durationSec, isStreaming, open, onToggle }: ThoughtBlockProps): JSX.Element {
  return (
    <details
      className={`thought-block${isStreaming ? ' streaming' : ''}`}
      {...(typeof open === 'boolean' ? { open } : {})}
      onToggle={onToggle ? (event) => onToggle(event.currentTarget.open) : undefined}
    >
      <summary>{getThoughtSummary(text, durationSec, isStreaming)}</summary>
      <div className="thought-content">{text}</div>
    </details>
  );
}
