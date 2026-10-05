# vscode-acp

VS Code extension (`acp-client`) that speaks the Agent Client Protocol to external coding agents — Copilot, Claude Code, Gemini CLI, Codex, OpenCode, Hermes, and any ACP-compatible agent.

## Commands

```bash
npm run compile        # webpack dev build -> dist/
npm run lint           # eslint src --max-warnings 0
npm run check:completion
npm test               # vscode-test (extension.test.ts)
npx vsce package       # VSIX
```

`pretest` runs `compile-tests → compile → lint → check:completion` in that order. `npm test` alone skips nothing, but running a step directly does not run the earlier ones — run `npm run pretest` after touching `src/`.

`src/test/completion.e2e.mjs` and `acp.probe.mjs` are standalone, not wired into `npm test`:

```bash
node src/test/completion.e2e.mjs   # inline completion against a live agent
node src/test/acp.probe.mjs        # does a candidate command actually serve ACP?
```

Both need a real agent binary on the machine. They are the only check that exercises the wire protocol.

## Layout

| Path | Holds |
| --- | --- |
| `src/core/` | `AcpClientImpl` transport, `AgentManager` process lifecycle, `SessionManager` + `SessionHistoryStore`, `ConnectionManager` |
| `src/handlers/` | ACP client-side callbacks: filesystem, permission, terminal, session-update |
| `src/config/` | `AgentConfig` parsing, `RegistryClient` for remote agent lists |
| `src/utils/` | `CompletionService` + `InlineCompletionProvider` (ghost text), `StreamAdapter`, `TelemetryManager`, `Logger` |
| `src/ui/` | `ChatWebviewProvider`, `SessionTreeProvider`, `StatusBarManager` |
| `src/test/` | the four test/probe files above |

`package.json` `main` is `./dist/extension.js`; webpack owns the bundle, so `out/` (tsc) and `dist/` (webpack) are both present and neither is committed. `tsconfig.json` sets `outDir: dist`, but `compile-tests` overrides it to `out` — don't assume one directory.

## Invariants

**Never pin an agent install path.** Hermes and friends live in per-install, per-update environment directories whose ids are regenerated on `hermes pm repair`, so a hardcoded venv path goes stale and the spawn fails. `src/test/*.mjs` resolve the binary at runtime: `HERMES_BIN` env var, then newest committed environment, then `PATH`. Follow the same order anywhere a test spawns an agent. Two commits already fixed this class of bug; a third is the same mistake.

**Spawn agents by bin name, not package name.** The command in `acp.agents` is what goes on `PATH` (`hermes`, not `hermes-agent`).

**Lint is a hard gate.** `--max-warnings 0` promotes the `warn`-level rules — `semi`, `curly`, `eqeqeq`, `no-throw-literal` — to build failures. Unused variables are `error`, with a `^_` prefix escape.

**CI is cross-platform.** `ci.yml` runs on macOS, Ubuntu, and Windows; Ubuntu wraps tests in `xvfb-run -a` because VS Code needs a display. A change that only works on Windows will fail two of the three legs.

`tsconfig.json` is `strict` with `noImplicitAny` in force, but eslint's `no-explicit-any` is off — `any` at the ACP protocol boundary is expected, since payloads are agent-defined and the SDK types them loosely.

## Ship state

Branch `feat/ghost-text-completion`, published as `acp-client-0.2.0.vsix`. Changes go to a fork, so CI on an open PR sits at `action_required` until a maintainer approves the first run. Verify locally with `npm run pretest` and the e2e before assuming a red check is CI-only.
