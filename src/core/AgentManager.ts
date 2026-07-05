import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
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

function expandHome(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/**
 * Build the `ssh` command + args that tunnel an agent's stdio to a remote host.
 *
 * No `-t` flag is passed: ssh must NOT allocate a pty here, or the JSON-RPC
 * stream on stdio would get mangled by terminal line-discipline processing.
 * The remote command runs through `bash -lc` so the remote user's login
 * profile (nvm, pyenv, venvs, etc.) is sourced — mirroring the local-spawn
 * behavior below.
 */
function buildRemoteSshInvocation(config: AgentConfigEntry): { command: string; args: string[] } {
  const remote = config.remote!;
  const sshArgs: string[] = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];

  if (remote.port) {
    sshArgs.push('-p', String(remote.port));
  }
  if (remote.identityFile) {
    sshArgs.push('-i', expandHome(remote.identityFile));
  }

  const target = remote.user ? `${remote.user}@${remote.host}` : remote.host;
  sshArgs.push(target);

  const remoteCommandStr = [config.command, ...(config.args || [])].map(shellEscape).join(' ');
  sshArgs.push(`bash -lc ${shellEscape(remoteCommandStr)}`);

  return { command: 'ssh', args: sshArgs };
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

    const child = (() => {
      if (config.remote) {
        const { command, args } = buildRemoteSshInvocation(config);
        log(`Spawning agent "${name}" (${id}) over SSH to ${config.remote.host}: ${config.command} ${(config.args || []).join(' ')}`);
        sendEvent('agent/spawn/remote', { transport: 'ssh' });

        // `cwd` (the local workspace folder) doesn't apply to a remote process —
        // the remote command runs in the remote login shell's default directory.
        // Note: this only tunnels the agent's stdio. If the agent calls back into
        // the editor's fs/terminal capabilities with remote-side paths, those
        // calls are still resolved against the *local* filesystem, so remote
        // agents work best for conversation/execution that doesn't depend on
        // client-side file access to remote-only paths.
        return spawn(command, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...(config.env || {}) },
        });
      }

      log(`Spawning agent "${name}" (${id}): ${config.command} ${(config.args || []).join(' ')}`);

      if (process.platform === 'win32') {
        // On Windows, commands like npx are batch scripts (.cmd) that require
        // shell resolution via cmd.exe.
        return spawn(config.command, config.args || [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...(config.env || {}) },
          cwd: cwd || undefined,
          shell: true,
        });
      }

      // On macOS/Linux, use the user's login shell so that PATH includes
      // nvm, Homebrew, and other user-installed tool directories.
      const { shell, useLoginFlag } = resolveUnixShell();
      const commandStr = [config.command, ...(config.args || [])].map(shellEscape).join(' ');
      const shellArgs = useLoginFlag ? ['-l', '-c', commandStr] : ['-c', commandStr];

      log(`Using shell: ${shell} ${shellArgs.join(' ')}`);
      const shellName = shell.split('/').pop() || shell;
      sendEvent('agent/spawn/shell', { shell: shellName, useLoginFlag: String(useLoginFlag) });
      return spawn(shell, shellArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(config.env || {}) },
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
