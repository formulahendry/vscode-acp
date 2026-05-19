import { act } from 'react';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from './App';
import { dispatchHostMessage, vscodeApiMock } from './test/setup';

describe('App', () => {
  it('renders the empty state when there is no active session', async () => {
    render(<App />);

    expect(screen.getByText('ACP Chat')).toBeInTheDocument();
    expect(screen.getByText('Connect to an AI coding agent to start chatting.')).toBeInTheDocument();

    await waitFor(() => {
      expect(vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'ready' });
    });
  });

  it('updates the UI when the host sends state', async () => {
    render(<App />);

    act(() => {
      dispatchHostMessage({
        type: 'state',
        session: {
          agentName: 'Codex',
          cwd: '/workspace/project',
          availableCommands: [],
        },
      });
    });

    expect(await screen.findByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('/workspace/project')).toBeInTheDocument();
  });

  it('sends a prompt from the composer', async () => {
    vscodeApiMock.getState.mockReturnValue({
      chatHistory: [],
      sessionState: { availableCommands: [] },
      hasActiveSession: true,
    });

    render(<App />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Refactor this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(vscodeApiMock.postMessage).toHaveBeenCalledWith({
      type: 'sendPrompt',
      text: 'Refactor this',
    });
    expect(await screen.findByText('Refactor this')).toBeInTheDocument();
  });

  it('shows stop while processing and sends cancel', async () => {
    vscodeApiMock.getState.mockReturnValue({
      chatHistory: [],
      sessionState: { availableCommands: [] },
      hasActiveSession: true,
    });

    render(<App />);

    act(() => {
      dispatchHostMessage({ type: 'promptStart' });
    });

    const stopButton = await screen.findByRole('button', { name: '■ Stop' });
    fireEvent.click(stopButton);

    expect(vscodeApiMock.postMessage).toHaveBeenCalledWith({ type: 'cancelTurn' });
  });
});
