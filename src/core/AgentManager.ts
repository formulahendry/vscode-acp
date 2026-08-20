import { spawn, ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { delimiter, isAbsolute, join } from 'node:path';
import { log, logError } from '../utils/Logger';
import { sendEvent, sendError } from '../utils/TelemetryManager';
import type { AgentConfigEntry } from '../config/AgentConfig';

/**
 * Escape a single argument for safe inclusion in a shell command string.
 * Wraps in single quotes, escaping any embedded single quotes.
 */
function shellEscape(arg: string): string {
  // Replace ' with '\'' (end quote, escaped quote, start quote)
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Resolve a bare executable name using the supplied environment's PATH.
 *
 * VS Code can be launched with a different environment from the user's
 * terminal, so relying on the child shell to find a preset CLI is not enough.
 * Keep unresolved names unchanged so login-shell startup files still get a
 * chance to add tools such as nvm-managed binaries to PATH.
 */
export function resolveCommandFromPath(command: string, env: NodeJS.ProcessEnv): string {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return command;
  }

  const pathValue = env.PATH || env.Path;
  if (!pathValue) {
    return command;
  }

  const candidates = process.platform === 'win32'
    ? windowsCommandCandidates(command, env.PATHEXT)
    : [command];
  const accessMode = process.platform === 'win32' ? constants.F_OK : constants.X_OK;

  for (const directory of pathValue.split(delimiter)) {
    for (const candidate of candidates) {
      const resolved = join(directory || '.', candidate);
      try {
        accessSync(resolved, accessMode);
        return resolved;
      } catch {
        // Try the next PATH entry.
      }
    }
  }

  return command;
}

function windowsCommandCandidates(command: string, pathExtValue?: string): string[] {
  const pathExt = pathExtValue || '.COM;.EXE;.BAT;.CMD';
  const hasExtension = pathExt
    .split(';')
    .some(ext => command.toLowerCase().endsWith(ext.toLowerCase()));
  return hasExtension ? [command] : [command, ...pathExt.split(';').map(ext => `${command}${ext}`)];
}

/**
 * Keep the extension's PATH available after a login shell loads its profile.
 * Some CLI launchers use `/usr/bin/env` in their shebang, so resolving the
 * launcher itself is not enough if the login profile removes its interpreter.
 */
function buildPathPrefix(shell: string, pathValue?: string): string {
  if (!pathValue) {
    return '';
  }

  const shellName = shell.split('/').pop() || shell;
  if (shellName === 'fish') {
    return `set -lx PATH ${shellEscape(pathValue)} $PATH; `;
  }
  return `export PATH=${shellEscape(pathValue)}:$PATH; `;
}

/**
 * Determine the appropriate shell and whether it supports the -l (login) flag
 * on macOS/Linux. A login shell sources the user's profile (~/.zshrc,
 * ~/.bash_profile, etc.) so that PATH includes nvm, Homebrew, and other
 * user-installed tool directories.
 *
 * Shell support:
 *   zsh, bash, ksh  →  -l supported
 *   fish, sh, dash  →  use as-is without -l (fish auto-loads config;
 *                      sh/dash don't support -l reliably)
 *   csh, tcsh, etc. →  not POSIX-compatible; fall back to bash or /bin/sh
 */
function resolveUnixShell(): { shell: string; useLoginFlag: boolean } {
  const userShell = process.env.SHELL;

  if (userShell) {
    const base = userShell.split('/').pop() || '';

    // POSIX-compatible shells that support -l (login) flag
    if (['zsh', 'bash', 'ksh'].includes(base)) {
      return { shell: userShell, useLoginFlag: true };
    }

    // fish auto-loads config without -l; sh/dash are POSIX-compatible but
    // don't support -l reliably
    if (['fish', 'sh', 'dash'].includes(base)) {
      return { shell: userShell, useLoginFlag: false };
    }

    // Non-POSIX shells (csh, tcsh, etc.) — fall back to a known POSIX shell
    log(`User shell "${userShell}" is not POSIX-compatible, falling back to bash/sh`);
  }

  // $SHELL not set or not POSIX-compatible — probe for common shells
  if (existsSync('/bin/bash')) {
    return { shell: '/bin/bash', useLoginFlag: true };
  }
  if (existsSync('/usr/bin/bash')) {
    return { shell: '/usr/bin/bash', useLoginFlag: true };
  }
  // Ultimate fallback
  return { shell: '/bin/sh', useLoginFlag: false };
}

export interface AgentInstance {
  id: string;
  name: string;
  process: ChildProcess;
  config: AgentConfigEntry;
}

/**
 * Manages spawning and killing ACP agent child processes.
 */
export class AgentManager extends EventEmitter {
  private agents: Map<string, AgentInstance> = new Map();
  private nextId = 1;

  /**
   * Spawn an agent as a child process with stdin/stdout piped.
   */
  spawnAgent(name: string, config: AgentConfigEntry, cwd?: string): AgentInstance {
    const id = `agent_${this.nextId++}`;
    log(`Spawning agent "${name}" (${id}): ${config.command} ${(config.args || []).join(' ')}`);
    const env = { ...process.env, ...(config.env || {}) };
    const command = resolveCommandFromPath(config.command, env);
    if (command !== config.command) {
      log(`Resolved agent command from PATH: ${config.command} -> ${command}`);
    }

    const child = (() => {
      if (process.platform === 'win32') {
        // On Windows, commands like npx are batch scripts (.cmd) that require
        // shell resolution via cmd.exe.
        return spawn(command, config.args || [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
          cwd: cwd || undefined,
          shell: true,
        });
      }

      // On macOS/Linux, use the user's login shell so that PATH includes
      // nvm, Homebrew, and other user-installed tool directories.
      const { shell, useLoginFlag } = resolveUnixShell();
      const pathPrefix = buildPathPrefix(shell, env.PATH || env.Path);
      const commandStr = pathPrefix + [command, ...(config.args || [])].map(shellEscape).join(' ');
      const shellArgs = useLoginFlag ? ['-l', '-c', commandStr] : ['-c', commandStr];

      log(`Using shell: ${shell} ${shellArgs.join(' ')}`);
      const shellName = shell.split('/').pop() || shell;
      sendEvent('agent/spawn/shell', { shell: shellName, useLoginFlag: String(useLoginFlag) });
      return spawn(shell, shellArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        cwd: cwd || undefined,
      });
    })();

    const instance: AgentInstance = { id, name, process: child, config };
    this.agents.set(id, instance);

    // Forward stderr for debugging
    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        log(`[${name} stderr] ${line}`);
        this.emit('agent-stderr', { agentId: id, line });
      }
    });

    child.on('error', (err) => {
      logError(`Agent "${name}" process error`, err);
      sendError('agent/error', { agentName: name, errorType: err.message });
      this.emit('agent-error', { agentId: id, error: err });
    });

    child.on('close', (code, signal) => {
      log(`Agent "${name}" exited (code=${code}, signal=${signal})`);
      this.agents.delete(id);
      this.emit('agent-closed', { agentId: id, code, signal });
    });

    return instance;
  }

  /**
   * Kill an agent process.
   */
  killAgent(agentId: string): boolean {
    const instance = this.agents.get(agentId);
    if (!instance) {
      return false;
    }

    log(`Killing agent "${instance.name}" (${agentId})`);

    try {
      instance.process.kill('SIGTERM');
      // Force kill after 5s if still running
      setTimeout(() => {
        if (instance.process.exitCode === null) {
          instance.process.kill('SIGKILL');
        }
      }, 5000);
    } catch (e) {
      logError(`Failed to kill agent ${agentId}`, e);
    }

    this.agents.delete(agentId);
    return true;
  }

  /**
   * Get a running agent by ID.
   */
  getAgent(agentId: string): AgentInstance | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get all running agents.
   */
  getRunningAgents(): AgentInstance[] {
    return Array.from(this.agents.values());
  }

  /**
   * Kill all running agents. Called on extension deactivate.
   */
  killAll(): void {
    for (const [id] of this.agents) {
      this.killAgent(id);
    }
  }

  dispose(): void {
    this.killAll();
    this.removeAllListeners();
  }
}
