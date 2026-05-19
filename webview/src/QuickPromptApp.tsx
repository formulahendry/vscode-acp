import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import type { EditorSnapshot, ModelOption, ModeOption, SlashCommand } from './chatTypes';
import { getBasePlaceholder, getSlashFilteredCommands } from './app/composer';
import {
  normalizeEditorSnapshot,
  normalizeModelsState,
  normalizeModesState,
  normalizeSessionSnapshot,
  normalizeSessionUpdate,
} from './app/normalizers';
import { mapSessionUpdateToActions } from './app/sessionUpdates';
import { appReducer, createInitialState } from './app/state';
import InputArea from './components/InputArea';
import { onMessage, postMessage } from './vscode';

function formatSnapshotMeta(snapshot: EditorSnapshot | null): string {
  if (!snapshot) {
    return 'Capture the current editor context and hand off to the active chat.';
  }

  const cursor = snapshot.cursorLine && snapshot.cursorCharacter
    ? `cursor ${snapshot.cursorLine}:${snapshot.cursorCharacter}`
    : 'cursor unavailable';

  if (snapshot.selection) {
    return `${snapshot.name ?? 'Selection'} · ${cursor} · lines ${snapshot.selection.startLine}:${snapshot.selection.startCharacter}-${snapshot.selection.endLine}:${snapshot.selection.endCharacter}`;
  }

  return `${snapshot.uriPath ?? snapshot.name ?? 'Current file'} · ${cursor}`;
}

export function QuickPromptApp(): JSX.Element {
  const [state, dispatch] = useReducer(appReducer, undefined, createInitialState);
  const [editorSnapshot, setEditorSnapshot] = useState<EditorSnapshot | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const stateRef = useRef(state);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const slashPopupRef = useRef<HTMLDivElement | null>(null);

  stateRef.current = state;

  const sessionState = state.persisted.sessionState;
  const availableCommands = sessionState?.availableCommands ?? [];
  const basePlaceholder = getBasePlaceholder(availableCommands);
  const slashFilteredCommands = getSlashFilteredCommands(state.promptText, availableCommands);
  const isSlashPopupOpen =
    slashFilteredCommands.length > 0 &&
    state.slashPopupSuppressedFor !== state.promptText;
  const placeholder =
    state.promptText.startsWith('/') && state.placeholderOverride
      ? state.placeholderOverride
      : basePlaceholder;
  const disabledBySession = !state.persisted.hasActiveSession;
  const currentMode = sessionState?.modes?.availableModes.find(
    (mode) => mode.id === sessionState.modes?.currentModeId,
  );
  const currentModel = sessionState?.models?.availableModels.find(
    (model) => model.modelId === sessionState.models?.currentModelId,
  );

  useEffect(() => {
    requestAnimationFrame(() => {
      promptInputRef.current?.focus();
    });

    postMessage({ type: 'quickPromptReady' });

    return onMessage((message) => {
      switch (message.type) {
        case 'state':
          setEditorSnapshot(normalizeEditorSnapshot(message.editorSnapshot));
          if (message.session) {
            dispatch({
              type: 'showSessionConnected',
              session: normalizeSessionSnapshot(message.session) ?? {},
            });
            setErrorMessage(null);
          } else {
            dispatch({ type: 'showNoSession' });
          }
          break;

        case 'sessionUpdate':
          for (const action of mapSessionUpdateToActions(normalizeSessionUpdate(message.update))) {
            dispatch(action);
          }
          break;

        case 'modesUpdate': {
          const modes = normalizeModesState(message.modes);
          if (modes) {
            dispatch({ type: 'updateModes', modes });
          }
          break;
        }

        case 'modelsUpdate': {
          const models = normalizeModelsState(message.models);
          if (models) {
            dispatch({ type: 'updateModels', models });
          }
          break;
        }

        case 'error':
          setErrorMessage(typeof message.message === 'string' ? message.message : 'An error occurred');
          break;
      }
    });
  }, []);

  useEffect(() => {
    if (!state.promptText.startsWith('/')) {
      if (state.placeholderOverride !== null) {
        dispatch({ type: 'setPlaceholderOverride', placeholder: null });
      }
      if (state.slashPopupSuppressedFor !== null) {
        dispatch({ type: 'suppressSlashPopup', promptText: null });
      }
    }
  }, [state.placeholderOverride, state.promptText, state.slashPopupSuppressedFor]);

  useEffect(() => {
    const maxIndex = Math.max(slashFilteredCommands.length - 1, 0);
    const nextIndex = slashFilteredCommands.length === 0 ? 0 : Math.min(state.slashSelectedIdx, maxIndex);
    if (nextIndex !== state.slashSelectedIdx) {
      dispatch({ type: 'setSlashSelectedIdx', index: nextIndex });
    }
  }, [slashFilteredCommands.length, state.slashSelectedIdx]);

  useEffect(() => {
    const selectedItem = slashPopupRef.current?.querySelector<HTMLElement>(
      `.slash-popup-item[data-index="${state.slashSelectedIdx}"]`,
    );
    selectedItem?.scrollIntoView({ block: 'nearest' });
  }, [state.slashSelectedIdx, isSlashPopupOpen]);

  useEffect(() => {
    const closePickers = () => {
      dispatch({ type: 'closePickers' });
    };

    document.addEventListener('click', closePickers);
    return () => {
      document.removeEventListener('click', closePickers);
    };
  }, []);

  function focusPromptInput(): void {
    requestAnimationFrame(() => {
      promptInputRef.current?.focus();
    });
  }

  function handleSend(explicitText?: string): void {
    const text = (explicitText ?? state.promptText).trim();
    if (!text || disabledBySession) {
      return;
    }

    setErrorMessage(null);
    postMessage({ type: 'quickPromptSubmit', text });
  }

  function handleDismiss(): void {
    postMessage({ type: 'quickPromptDismiss' });
  }

  function handleResizeStart(event: ReactMouseEvent<HTMLDivElement>): void {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = stateRef.current.inputAreaHeight;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = startY - moveEvent.clientY;
      dispatch({ type: 'setInputAreaHeight', height: startHeight + delta });
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function selectSlashCommand(command: SlashCommand | undefined): void {
    if (!command) {
      return;
    }

    dispatch({ type: 'suppressSlashPopup', promptText: state.promptText });
    if (command.input) {
      dispatch({ type: 'setPromptText', text: `/${command.name} ` });
      dispatch({
        type: 'setPlaceholderOverride',
        placeholder: command.input.hint || 'Type input...',
      });
      focusPromptInput();
      return;
    }

    dispatch({ type: 'setPromptText', text: `/${command.name}` });
    dispatch({ type: 'setPlaceholderOverride', placeholder: null });
    handleSend(`/${command.name}`);
  }

  function handlePromptKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (isSlashPopupOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        dispatch({
          type: 'setSlashSelectedIdx',
          index: Math.min(state.slashSelectedIdx + 1, slashFilteredCommands.length - 1),
        });
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        dispatch({
          type: 'setSlashSelectedIdx',
          index: Math.max(state.slashSelectedIdx - 1, 0),
        });
        return;
      }

      if (event.key === 'Tab') {
        event.preventDefault();
        selectSlashCommand(slashFilteredCommands[state.slashSelectedIdx]);
        return;
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        selectSlashCommand(slashFilteredCommands[state.slashSelectedIdx]);
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        dispatch({ type: 'suppressSlashPopup', promptText: state.promptText });
        return;
      }
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      handleDismiss();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }

  function handleModeSelect(mode: ModeOption, event: ReactMouseEvent<HTMLDivElement>): void {
    event.stopPropagation();
    dispatch({ type: 'closePickers' });
    if (sessionState?.modes?.currentModeId === mode.id) {
      return;
    }
    dispatch({ type: 'updateCurrentMode', modeId: mode.id });
    postMessage({ type: 'setMode', modeId: mode.id });
  }

  function handleModelSelect(model: ModelOption, event: ReactMouseEvent<HTMLDivElement>): void {
    event.stopPropagation();
    dispatch({ type: 'closePickers' });
    if (sessionState?.models?.currentModelId === model.modelId) {
      return;
    }
    dispatch({ type: 'updateCurrentModel', modelId: model.modelId });
    postMessage({ type: 'setModel', modelId: model.modelId });
  }

  return (
    <div className="quick-prompt-shell">
      <div className="quick-prompt-modal">
        <div className="quick-prompt-header">
          <div>
            <div className="quick-prompt-eyebrow">ACP Quick Prompt</div>
            <div className="quick-prompt-title">
              {editorSnapshot?.name ?? 'Current editor context'}
            </div>
            <div className="quick-prompt-subtitle">{formatSnapshotMeta(editorSnapshot)}</div>
          </div>
          <button className="quick-prompt-close" type="button" onClick={handleDismiss}>
            Close
          </button>
        </div>

        <div className="quick-prompt-card">
          <div className="quick-prompt-card-title">Context sent with the prompt</div>
          {editorSnapshot?.selection?.text ? (
            <pre className="quick-prompt-selection">{editorSnapshot.selection.text}</pre>
          ) : (
            <div className="quick-prompt-selection quick-prompt-selection-empty">
              The active file path and cursor position will be prefixed automatically.
            </div>
          )}
        </div>

        <div className={`quick-prompt-status${disabledBySession ? ' disconnected' : ''}`}>
          <div>
            {disabledBySession
              ? 'No active agent. Connect one to enable send.'
              : `Sending will hand off to ${sessionState?.agentName ?? 'the active chat'}.`}
          </div>
          {disabledBySession ? (
            <button
              className="quick-prompt-connect"
              type="button"
              onClick={() => postMessage({ type: 'quickPromptConnect' })}
            >
              Connect Agent
            </button>
          ) : null}
        </div>

        {errorMessage ? <div className="quick-prompt-error">{errorMessage}</div> : null}

        <InputArea
          state={state}
          disabledBySession={disabledBySession}
          slashFilteredCommands={slashFilteredCommands}
          isSlashPopupOpen={isSlashPopupOpen}
          slashPopupRef={slashPopupRef}
          selectSlashCommand={selectSlashCommand}
          dispatch={dispatch}
          handleResizeStart={handleResizeStart}
          sessionState={sessionState}
          currentMode={currentMode}
          currentModel={currentModel}
          handleModeSelect={handleModeSelect}
          handleModelSelect={handleModelSelect}
          promptInputRef={promptInputRef}
          handlePromptKeyDown={handlePromptKeyDown}
          placeholder={placeholder}
          handleCancel={handleDismiss}
          handleSend={handleSend}
          sendLabel="Send to Chat"
        />
      </div>
    </div>
  );
}
