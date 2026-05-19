import {
  useEffect,
  useReducer,
  useRef,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import type { ModelOption, ModeOption, PersistedWebviewState, SlashCommand } from './chatTypes';
import { buildAttachedFilePrompt, getBasePlaceholder, getSlashFilteredCommands } from './app/composer';
import { buildHistoryBlocks, getPromptEndMarkdownItem, getRestoreMarkdownItems, getToolCollapseState } from './app/history';
import {
  normalizeFileSelection,
  normalizeMarkdownRenderedItems,
  normalizeModelsState,
  normalizeModesState,
  normalizeSessionSnapshot,
  normalizeSessionUpdate,
} from './app/normalizers';
import { mapSessionUpdateToActions } from './app/sessionUpdates';
import { appReducer, createInitialState } from './app/state';
import { MessageBubble } from './components/MessageBubble';
import InputArea from './components/InputArea';
import { PlanBlock } from './components/PlanBlock';
import { TurnBlock } from './components/TurnBlock';
import { getState, onMessage, postMessage, setState } from './vscode';

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(appReducer, getState<PersistedWebviewState>(), createInitialState);
  const stateRef = useRef(state);
  const restoreMarkdownItemsRef = useRef(getRestoreMarkdownItems(state.persisted.chatHistory));
  const turnCounterRef = useRef(0);
  const messagesRef = useRef<HTMLDivElement | null>(null);
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
  const disabledBySession = !state.persisted.hasActiveSession && !state.composerUnlocked;
  const excludedToolIndexes = new Set(state.currentTurn?.historyToolCallIndexes ?? []);
  const historyBlocks = buildHistoryBlocks(state.persisted.chatHistory, excludedToolIndexes);
  const currentMode = sessionState?.modes?.availableModes.find(
    (mode) => mode.id === sessionState.modes?.currentModeId,
  );
  const currentModel = sessionState?.models?.availableModels.find(
    (model) => model.modelId === sessionState.models?.currentModelId,
  );

  useEffect(() => {
    setState(state.persisted);
  }, [state.persisted]);

  useEffect(() => {
    if (restoreMarkdownItemsRef.current.length > 0) {
      postMessage({ type: 'renderMarkdown', items: restoreMarkdownItemsRef.current });
      restoreMarkdownItemsRef.current = [];
    }

    postMessage({ type: 'ready' });

    return onMessage((message) => {
      switch (message.type) {
        case 'state':
          if (message.session) {
            dispatch({
              type: 'showSessionConnected',
              session: normalizeSessionSnapshot(message.session) ?? {},
            });
          } else {
            dispatch({ type: 'showNoSession' });
          }
          break;

        case 'externalUserMessage':
          if (typeof message.text === 'string') {
            dispatch({ type: 'appendUserMessage', text: message.text });
          }
          break;

        case 'file-attached':
          dispatch({
            type: 'attachFile',
            text: buildAttachedFilePrompt(
              {
                type: 'file-attached',
                path: typeof message.path === 'string' ? message.path : undefined,
                name: typeof message.name === 'string' ? message.name : undefined,
                selection: normalizeFileSelection(message.selection),
              },
              stateRef.current.promptText,
            ),
          });
          requestAnimationFrame(() => {
            promptInputRef.current?.focus();
          });
          break;

        case 'promptStart':
          turnCounterRef.current += 1;
          dispatch({
            type: 'promptStart',
            turnId: `turn-${Date.now()}-${turnCounterRef.current}`,
          });
          break;

        case 'promptEnd': {
          const markdownItem = getPromptEndMarkdownItem(stateRef.current);
          dispatch({ type: 'promptEnd' });
          if (markdownItem) {
            postMessage({ type: 'renderMarkdown', items: [markdownItem] });
          }
          break;
        }

        case 'clearChat':
          dispatch({ type: 'clearChat' });
          break;

        case 'error':
          dispatch({
            type: 'appendErrorMessage',
            text: typeof message.message === 'string' ? message.message : 'An error occurred',
          });
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

        case 'markdownRendered':
          dispatch({
            type: 'setRenderedMarkdown',
            items: normalizeMarkdownRenderedItems(message.items),
          });
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
    const container = messagesRef.current;
    if (!container) {
      return;
    }

    container.scrollTop = container.scrollHeight;
  }, [historyBlocks, state.currentTurn, state.renderedMarkdown]);

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
    if (!text || state.isProcessing) {
      return;
    }

    dispatch({ type: 'appendUserMessage', text });
    dispatch({ type: 'setPromptText', text: '' });
    dispatch({ type: 'setPlaceholderOverride', placeholder: null });
    dispatch({ type: 'suppressSlashPopup', promptText: null });
    postMessage({ type: 'sendPrompt', text });
  }

  function handleCancel(): void {
    postMessage({ type: 'cancelTurn' });
  }

  function handleWelcomeCommand(command: string): void {
    postMessage({ type: 'executeCommand', command });
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

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (state.isProcessing) {
        handleCancel();
      } else {
        handleSend();
      }
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

  const emptyStateVisible =
    !state.persisted.hasActiveSession &&
    state.persisted.chatHistory.length === 0 &&
    !state.currentTurn;

  return (
    <>
      <div className={`session-banner${state.persisted.hasActiveSession ? ' visible' : ''}`}>
        <span className="dot" />
        <div className="info">
          <div className="agent">{sessionState?.agentName || 'Agent'}</div>
          <div className="cwd">{sessionState?.cwd || ''}</div>
        </div>
        <span className="status">{state.isProcessing ? <span className="spinner" /> : null}</span>
      </div>

      <div className="messages" id="messages" ref={messagesRef}>
        {emptyStateVisible ? (
          <div className="empty-state" id="emptyState">
            <div className="icon">🤖</div>
            <div className="title">ACP Chat</div>
            <div className="subtitle">Connect to an AI coding agent to start chatting.</div>
            <div className="actions">
              <button
                className="action-btn primary"
                id="welcomeConnectAgent"
                type="button"
                onClick={() => handleWelcomeCommand('acp.connectAgent')}
              >
                🔌 Connect to Agent
              </button>
              <button
                className="action-btn secondary"
                id="welcomeAddAgent"
                type="button"
                onClick={() => handleWelcomeCommand('acp.addAgent')}
              >
                ⚙ Add Agent
              </button>
            </div>
            <div className="hint">
              or press <kbd>Ctrl+Shift+A</kbd> anytime
            </div>
          </div>
        ) : null}

        {historyBlocks.map((block) => {
          if (block.kind === 'message') {
            return (
              <MessageBubble
                item={block.item}
                key={`message-${block.historyIndex}`}
                renderedHtml={state.renderedMarkdown[block.historyIndex]}
              />
            );
          }

          if (block.kind === 'plan') {
            return <PlanBlock item={block.item} key={`plan-${block.historyIndex}`} />;
          }

          const assistantHtml = block.assistant
            ? state.renderedMarkdown[block.assistant.historyIndex]
            : undefined;
          const collapsed = getToolCollapseState(block.key, block.toolCalls.length, state.collapsedTools);
          return (
            <TurnBlock
              assistantHtml={assistantHtml}
              assistantText={block.assistant?.item.text}
              collapsed={collapsed}
              key={block.key}
              onToggleTools={() =>
                dispatch({
                  type: 'setCollapsedTools',
                  key: block.key,
                  collapsed: !collapsed,
                })
              }
              thought={
                block.thought
                  ? {
                      text: block.thought.item.text,
                      durationSec: block.thought.item.durationSec,
                      isStreaming: false,
                    }
                  : null
              }
              toolCalls={block.toolCalls}
              turnKey={block.key}
            />
          );
        })}

        {state.currentTurn ? (
          <TurnBlock
            assistantText={state.currentTurn.assistantText.trim().length > 0 ? state.currentTurn.assistantText : undefined}
            collapsed={getToolCollapseState('current-turn', state.currentTurn.toolCalls.length, state.collapsedTools)}
            onToggleTools={() =>
              dispatch({
                type: 'setCollapsedTools',
                key: 'current-turn',
                collapsed: !getToolCollapseState('current-turn', state.currentTurn?.toolCalls.length ?? 0, state.collapsedTools),
              })
            }
            thought={
              state.currentTurn.thought
                ? {
                    text: state.currentTurn.thought.text,
                    durationSec: null,
                    isStreaming: state.currentTurn.thought.finishedAt === null,
                    open: state.currentTurn.thought.isOpen,
                    onToggle: (open) => dispatch({ type: 'setCurrentThoughtOpen', isOpen: open }),
                  }
                : null
            }
            toolCalls={state.currentTurn.toolCalls}
            turnKey="current-turn"
          />
        ) : null}
      </div>

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
        handleCancel={handleCancel}
        handleSend={handleSend}
      />
    </>
  );
}
