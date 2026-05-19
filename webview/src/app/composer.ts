import type { SlashCommand } from '../chatTypes';
import type { HostToWebviewMessage } from '../vscode';

export type ParsedUserMessage = {
  badgeText: string;
  body?: string;
};

export function parseUserMessage(text: string): ParsedUserMessage | null {
  const newlineIndex = text.indexOf('\n');
  const firstLine = newlineIndex >= 0 ? text.slice(0, newlineIndex) : text;
  const parenOpen = firstLine.indexOf(' (');
  if (parenOpen <= 0) {
    return null;
  }

  const fileName = firstLine.slice(0, parenOpen);
  const cursorMatch = firstLine.match(/\[cursor (\d+:\d+)\]/);
  const cursorPos = cursorMatch?.[1];
  const rest = newlineIndex >= 0 ? text.slice(newlineIndex + 1).trimStart() : '';
  return {
    badgeText: cursorPos ? `${fileName} · ${cursorPos}` : fileName,
    body: rest || undefined,
  };
}

export function buildAttachedFilePrompt(
  message: Extract<HostToWebviewMessage, { type: 'file-attached' }>,
  promptText: string,
): string {
  const name = message.name || message.path || 'attached file';
  const selection = message.selection;
  const cursorLine = selection?.cursorLine ?? selection?.startLine;
  const cursorCharacter = selection?.cursorCharacter ?? selection?.startCharacter;
  const existingText = promptText || '';
  const existingSuffix = existingText.length > 0 ? existingText : '';

  if (selection?.text) {
    const rangeTag =
      selection.startLine &&
      selection.startCharacter &&
      selection.endLine &&
      selection.endCharacter
        ? ` [${selection.startLine}:${selection.startCharacter}-${selection.endLine}:${selection.endCharacter}]`
        : '';
    const cursorTag = cursorLine && cursorCharacter ? ` [cursor ${cursorLine}:${cursorCharacter}]` : '';
    return `${name}${rangeTag}${cursorTag}\n${selection.text}\n\n${existingSuffix}`;
  }

  if (selection && (cursorLine || cursorCharacter)) {
    const lineValue = cursorLine ?? '?';
    const characterValue = cursorCharacter ?? '?';
    return `${name} (${message.path}) [cursor ${lineValue}:${characterValue}]\n\n${existingSuffix}`;
  }

  return `${name} (${message.path})\n\n${existingSuffix}`;
}

export function getBasePlaceholder(commands: SlashCommand[]): string {
  return commands.length > 0 ? 'Type a message or / for commands...' : 'Type a message...';
}

export function getSlashFilteredCommands(promptText: string, commands: SlashCommand[]): SlashCommand[] {
  if (!promptText.startsWith('/')) {
    return [];
  }

  const firstSpace = promptText.indexOf(' ');
  if (firstSpace >= 0) {
    return [];
  }

  const query = promptText.slice(1).toLowerCase();
  return commands.filter((command) => command.name.toLowerCase().startsWith(query));
}
