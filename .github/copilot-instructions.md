# vscode-acp — Copilot instructions

VS Code extension (`acp-client`) that speaks the Agent Client Protocol to external coding agents: Copilot, Claude Code, Gemini CLI, Codex, OpenCode, Hermes, and any ACP-compatible agent. TypeScript, webpack-bundled, VS Code engine `^1.85.0`.

## Build and test

```bash
npm run compile         # webpack dev build -> dist/
npm run lint            # eslint src --max-warnings 0
npm run check:completion
npm test                # vscode-test, runs compiled JS from out/test/**.test.js
npx vsce package        # VSIX
```

`pretest` runs `compile-tests → compile → lint → check:completion`. Those steps are not implicit in `npm test` — run `npm run pretest` after editing `src/`.

Two additional checks are **not** wired into `npm test` and must be run by hand:

```bash
node src/test/completion.e2e.mjs   # inline completion against a live agent
node src/test/acp.probe.mjs        # does a candidate command actually serve ACP?
```

They need a real agent binary installed, and they are the only coverage of the actual wire protocol.

## Source layout

- `src/core/` — `AcpClientImpl` transport, `AgentManager` process lifecycle, `SessionManager` + `SessionHistoryStore`, `ConnectionManager`
- `src/handlers/` — ACP client-side callbacks: filesystem, permission, terminal, session-update
- `src/config/` — `AgentConfig` parsing, `RegistryClient` for remote agent lists
- `src/utils/` — `CompletionService` + `InlineCompletionProvider` (ghost text), `StreamAdapter`, `TelemetryManager`, `Logger`
- `src/ui/` — `ChatWebviewProvider`, `SessionTreeProvider`, `StatusBarManager`
- `src/test/` — mocha test plus the two standalone probe/e2e scripts

`package.json` `main` is `./dist/extension.js`. Two build outputs exist and both are gitignored: `dist/` from webpack, `out/` from tsc. `tsconfig.json` declares `outDir: dist`, but the `compile-tests` script overrides it to `out` — do not assume a single output directory.

## Rules

**Never hardcode an agent install path.** Agents such as Hermes live in per-install, per-update environment directories, and the environment ids are regenerated on repair operations, so any pinned path goes stale and the spawn fails. Resolve at runtime in this order: `HERMES_BIN` env var, then the newest committed environment under the agent's install tree, then the bare name on `PATH`. `src/test/completion.e2e.mjs` and `src/test/acp.probe.mjs` both implement this and are the reference.

**Spawn agents by executable name, not package name.** The `command` in `acp.agents` is what has to resolve on `PATH`.

**Lint warnings are build failures.** `eslint src --max-warnings 0` escalates the `warn`-level rules (`semi`, `curly`, `eqeqeq`, `no-throw-literal`, and the `naming-convention` import check) into errors. Unused variables are already `error`; prefix with `_` to silence one intentionally.

**Keep changes cross-platform.** CI runs on macOS, Ubuntu, and Windows. On Linux, tests are wrapped in `xvfb-run -a` because VS Code needs a display. Windows-only assumptions break two of the three legs.

**`any` is acceptable at the ACP boundary.** `tsconfig.json` is `strict`, but eslint's `no-explicit-any` is deliberately disabled because agent-defined payloads are loosely typed by the SDK. Do not tighten this without a reason; do not spread `any` into `src/core` or `src/ui` beyond that boundary.
