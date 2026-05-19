import { describe, expect, it } from 'vitest';

import { buildAttachedFilePrompt, getBasePlaceholder, getSlashFilteredCommands } from './composer';

describe('buildAttachedFilePrompt', () => {
  it('formats a selected file range and preserves the existing draft', () => {
    const prompt = buildAttachedFilePrompt(
      {
        type: 'file-attached',
        path: '/tmp/example.ts',
        name: 'example.ts',
        selection: {
          startLine: 4,
          startCharacter: 2,
          endLine: 6,
          endCharacter: 8,
          cursorLine: 6,
          cursorCharacter: 8,
          text: 'const x = 1;',
        },
      },
      'existing draft',
    );

    expect(prompt).toBe(
      'example.ts [4:2-6:8] [cursor 6:8]\nconst x = 1;\n\nexisting draft',
    );
  });
});

describe('composer helpers', () => {
  it('returns a command-aware placeholder only when commands exist', () => {
    expect(getBasePlaceholder([])).toBe('Type a message...');
    expect(getBasePlaceholder([{ name: 'fix', description: 'Fix code' }])).toBe(
      'Type a message or / for commands...',
    );
  });

  it('filters slash commands only while editing the first token', () => {
    const commands = [
      { name: 'fix', description: 'Fix code' },
      { name: 'format', description: 'Format code' },
    ];

    expect(getSlashFilteredCommands('/f', commands).map((command) => command.name)).toEqual([
      'fix',
      'format',
    ]);
    expect(getSlashFilteredCommands('/fix extra', commands)).toEqual([]);
    expect(getSlashFilteredCommands('plain text', commands)).toEqual([]);
  });
});
