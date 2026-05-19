import type {
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  RefObject,
} from 'react';

import { Picker } from './Picker';
import type { AppAction, AppState } from '../app/state';
import type { ModelOption, ModeOption, SessionSnapshot, SlashCommand } from '../chatTypes';

interface InputAreaProps {
  state: AppState;
  disabledBySession: boolean;
  slashFilteredCommands: SlashCommand[];
  isSlashPopupOpen: boolean;
  slashPopupRef: RefObject<HTMLDivElement | null>;
  selectSlashCommand: (command?: SlashCommand) => void;
  dispatch: (action: AppAction) => void;
  handleResizeStart: (e: ReactMouseEvent<HTMLDivElement>) => void;
  sessionState?: SessionSnapshot | null;
  currentMode?: ModeOption;
  currentModel?: ModelOption;
  handleModeSelect: (mode: ModeOption, e: ReactMouseEvent<HTMLDivElement>) => void;
  handleModelSelect: (model: ModelOption, e: ReactMouseEvent<HTMLDivElement>) => void;
  promptInputRef: RefObject<HTMLTextAreaElement | null>;
  handlePromptKeyDown: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string | null;
  handleCancel: () => void;
  handleSend: (explicitText?: string) => void;
  sendLabel?: string;
}

export default function InputArea({
  state,
  disabledBySession,
  slashFilteredCommands,
  isSlashPopupOpen,
  slashPopupRef,
  selectSlashCommand,
  dispatch,
  handleResizeStart,
  sessionState,
  currentMode,
  currentModel,
  handleModeSelect,
  handleModelSelect,
  promptInputRef,
  handlePromptKeyDown,
  placeholder,
  handleCancel,
  handleSend,
  sendLabel = 'Send',
}: InputAreaProps): JSX.Element {
  return (
    <div
      className={`input-area${disabledBySession ? ' disabled' : ''}`}
      id="inputArea"
      style={{ height: state.inputAreaHeight }}
    >
      <div
        className={`slash-popup${isSlashPopupOpen ? ' open' : ''}`}
        id="slashPopup"
        ref={slashPopupRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="slash-popup-header">Commands</div>
        {slashFilteredCommands.map((command, index) => (
          <div
            className={`slash-popup-item${index === state.slashSelectedIdx ? ' active' : ''}`}
            data-index={index}
            key={command.name}
            onClick={() => selectSlashCommand(command)}
            onMouseEnter={() => dispatch({ type: 'setSlashSelectedIdx', index })}
          >
            <span className="cmd-name">/{command.name}</span>
            <span className="cmd-desc">{command.description}</span>
          </div>
        ))}
      </div>

      <div className="input-resize-handle" id="resizeHandle" onMouseDown={handleResizeStart} />

      <div className="input-toolbar">
        {sessionState?.modes?.availableModes.length ? (
          <Picker
            currentValue={sessionState.modes.currentModeId ?? null}
            icon="⚡"
            isOpen={state.isModeDropdownOpen}
            itemDescription={(mode) => mode.description}
            itemKey={(mode) => mode.id}
            itemLabel={(mode) => mode.name}
            items={sessionState.modes.availableModes}
            label={currentMode?.name ?? 'Mode'}
            onSelect={handleModeSelect}
            onToggle={(event) => {
              event.stopPropagation();
              dispatch({ type: 'toggleModeDropdown' });
            }}
            title={currentMode?.description ?? 'Select mode'}
          />
        ) : (
          <div className="picker-wrap hidden" />
        )}

        {sessionState?.models?.availableModels.length ? (
          <Picker
            currentValue={sessionState.models.currentModelId ?? null}
            icon="🧠"
            isOpen={state.isModelDropdownOpen}
            itemDescription={(model) => model.description}
            itemKey={(model) => model.modelId}
            itemLabel={(model) => model.name}
            items={sessionState.models.availableModels}
            label={currentModel?.name ?? 'Model'}
            onSelect={handleModelSelect}
            onToggle={(event) => {
              event.stopPropagation();
              dispatch({ type: 'toggleModelDropdown' });
            }}
            title={currentModel?.description ?? 'Select model'}
          />
        ) : (
          <div className="picker-wrap hidden" />
        )}
        <span className="toolbar-spacer" />
      </div>

      <div className="input-editor-wrap">
        <textarea
          disabled={disabledBySession || state.isProcessing}
          id="promptInput"
          onChange={(event) => {
            dispatch({ type: 'setPromptText', text: event.target.value });
            if (state.slashPopupSuppressedFor && state.slashPopupSuppressedFor !== event.target.value) {
              dispatch({ type: 'suppressSlashPopup', promptText: null });
            }
          }}
          onKeyDown={handlePromptKeyDown}
          placeholder={placeholder}
          ref={promptInputRef}
          rows={2}
          value={state.promptText}
        />
      </div>

      <div className="input-send-row">
        <button
          className={`send-stop-btn ${state.isProcessing ? 'stop' : 'send'}`}
          disabled={!state.isProcessing && (disabledBySession || state.promptText.trim().length === 0)}
          id="sendStopBtn"
          type="button"
          onClick={() => {
            if (state.isProcessing) {
              handleCancel();
            } else {
              handleSend();
            }
          }}
        >
          {state.isProcessing ? '■ Stop' : sendLabel}
        </button>
      </div>
    </div>
  );
}
