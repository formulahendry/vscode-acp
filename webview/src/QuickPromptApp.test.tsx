import { act } from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { QuickPromptApp } from './QuickPromptApp';
import { dispatchHostMessage, vscodeApiMock } from './test/setup';

describe('QuickPromptApp', () => {
  it('requests its initial state and shows the connect CTA without a session', async () => {
    render(<QuickPromptApp />);

    await waitFor(() => {
      expect(vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'quickPromptReady' });
    });

    act(() => {
      dispatchHostMessage({
        type: 'state',
        editorSnapshot: {
          name: 'app.ts',
          uriPath: '/workspace/app.ts',
          cursorLine: 12,
          cursorCharacter: 4,
        },
        session: null,
      });
    });

    expect(screen.getByText('app.ts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Agent' })).toBeInTheDocument();
  });

  it('submits the prompt to the host when a session is active', async () => {
    render(<QuickPromptApp />);

    act(() => {
      dispatchHostMessage({
        type: 'state',
        editorSnapshot: {
          name: 'service.ts',
          uriPath: '/workspace/service.ts',
          cursorLine: 7,
          cursorCharacter: 3,
          selection: {
            startLine: 4,
            startCharacter: 1,
            endLine: 6,
            endCharacter: 10,
            text: 'const value = 42;',
          },
        },
        session: {
          agentName: 'Codex',
          cwd: '/workspace',
          availableCommands: [],
        },
      });
    });

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Refactor this flow' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Chat' }));

    expect(vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'quickPromptSubmit',
      text: 'Refactor this flow',
    });
    expect(screen.getByText('Sending will hand off to Codex.')).toBeInTheDocument();
  });
});
