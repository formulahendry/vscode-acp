# Change Log

All notable changes to the "vscode-acp" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.1] - 2026-02-10

### Added
- Login shell resolution on macOS/Linux to fix `spawn npx ENOENT` errors

### Fixed
- Fixed `autoApprovePermissions` setting: the `allowAll` option was not working due to a value mismatch
- Removed unimplemented `allowRead` option from `autoApprovePermissions` enum

## [0.1.0] - 2026-02-08

### Added
- Initial release of ACP Client for VS Code
- **8 pre-configured agents**: GitHub Copilot, Claude Code, Gemini CLI, Qwen Code, Auggie CLI, Qoder CLI, Codex CLI, OpenCode
- Interactive chat panel with webview UI
- Markdown rendering in assistant messages (via `marked`)
- Inline tool call display with collapsible sections per turn
- Mode and model picker dropdowns in the chat input toolbar
- Single-agent model — one agent active at a time with auto-disconnect
- New conversation confirmation dialog to prevent accidental history loss
- Session management with tree view (connect/disconnect inline icons)
- File system handler for agent file operations
- Terminal handler for agent command execution
- Permission management with configurable auto-approve policies
- ACP protocol traffic logging (enabled by default) with message classification (request/response/notification)
- Client log output channel for debugging
- ACP agent registry browser
- Custom ACP logo for activity bar and extension icon
- Chat state persistence with `retainContextWhenHidden`
- Keyboard shortcuts: `Ctrl+Shift+A` to open chat, `Escape` to cancel turn
