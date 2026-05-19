import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';

import { buildResearchSubagentMcpServer } from '../subagents/ResearchSubagent';
import { resolveSessionWorkingDirectory } from '../config/AgentConfig';
import { log, logError } from '../utils/Logger';

export const TOOL_ID = 'acp_call_research_subagent';

const TIMEOUT_MS = 120_000;

interface ResearchInput {
  query: string;
  depth?: 'quick' | 'thorough';
}

export class ResearchSubagentTool implements vscode.LanguageModelTool<ResearchInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ResearchInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { query, depth } = options.input;

    if (!query?.trim()) {
      throw new Error('call_research_subagent requires a non-empty query.');
    }

    log(`ResearchSubagentTool: invoking with query="${query}", depth=${depth || 'quick'}`);

    const cwd = resolveSessionWorkingDirectory();
    const mcpConfig = buildResearchSubagentMcpServer(cwd);

    // Build env from the MCP server config
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const { name, value } of mcpConfig.env) {
      env[name] = value;
    }

    const child = spawn(mcpConfig.command, mcpConfig.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    try {
      const text = await this.callMcpTool(child, query, depth || 'quick', token);
      log('ResearchSubagentTool: completed successfully');
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
    } catch (e: any) {
      logError('ResearchSubagentTool failed', e);
      throw e;
    } finally {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    }
  }

  /**
   * Spawn the MCP server, run initialize + tools/call, return the text result.
   */
  private callMcpTool(
    child: ChildProcess,
    query: string,
    depth: string,
    token: vscode.CancellationToken,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let nextId = 1;
      const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
      let buffer = '';
      let stderr = '';
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        cancelDisposable.dispose();
        fn();
      };

      const kill = () => {
        if (!child.killed) { child.kill('SIGTERM'); }
      };

      // Cancellation
      const cancelDisposable = token.onCancellationRequested(() => {
        kill();
        settle(() => reject(new Error('Research sub-agent cancelled.')));
      });

      // Timeout
      const timer = setTimeout(() => {
        kill();
        settle(() => reject(new Error(`Research sub-agent timed out after ${TIMEOUT_MS}ms.`)));
      }, TIMEOUT_MS);

      // JSON-RPC send helper
      const send = (method: string, params: unknown): Promise<any> => {
        return new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { resolve: res, reject: rej });
          child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
      };

      // Process stdout (JSON-RPC responses)
      child.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('{')) { continue; }
          try {
            const msg = JSON.parse(trimmed);
            if (msg.id !== undefined) {
              const p = pending.get(msg.id);
              if (p) {
                pending.delete(msg.id);
                if (msg.error) {
                  p.reject(new Error(msg.error.message || 'MCP request failed'));
                } else {
                  p.resolve(msg.result);
                }
              }
            }
          } catch { /* ignore parse errors */ }
        }
      });

      child.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (error: Error) => {
        for (const p of pending.values()) { p.reject(error); }
        pending.clear();
        settle(() => reject(error));
      });

      child.on('close', (code: number | null) => {
        if (pending.size > 0) {
          const err = new Error(`MCP server exited with code ${code}. ${stderr.trim()}`);
          for (const p of pending.values()) { p.reject(err); }
          pending.clear();
        }
      });

      // Run the MCP protocol sequence
      (async () => {
        await send('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'acp-client-vscode', version: '0.1.0' },
        });

        const result = await send('tools/call', {
          name: 'call_research_subagent',
          arguments: { query, depth },
        });

        kill();

        if (result?.isError) {
          settle(() => reject(new Error(result.content?.[0]?.text || 'Research sub-agent failed.')));
          return;
        }

        const text = result?.content
          ?.filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n') || '';

        if (!text) {
          settle(() => reject(new Error('Research sub-agent returned no content.')));
          return;
        }

        settle(() => resolve(text));
      })().catch((e) => {
        kill();
        settle(() => reject(e instanceof Error ? e : new Error(String(e))));
      });
    });
  }
}
