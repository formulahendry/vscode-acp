/**
 * Regression tests for the fd-3 stdin-protection fix in AgentManager.
 *
 * Background: on Linux/macOS, agents are spawned via `bash -l -c cmd` so that
 * PATH includes nvm, Homebrew, etc.  Profile scripts sourced during that -l
 * phase can read or close fd 0, stealing the ACP pipe before the agent starts.
 *
 * Confirmed case: /etc/profile.d/distrobox_profile.sh calls `host-spawn` which
 * inherits fd 0 and passes it to a host process.  When the host process exits
 * it closes its copy of the pipe fd, racing the agent's first read.
 *
 * The fix: pass the ACP pipe as fd 3, set fd 0 to /dev/null for the profile
 * phase, and wrap the command as `exec cmd <&3`.  Profile scripts can no longer
 * touch the ACP stream.
 *
 * These tests exercise that pattern directly using a small helper script
 * (written to a temp dir) that simulates a "poison" profile consuming fd 0.
 */

import * as assert from 'assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SENTINEL = 'ACP_PIPE_INTACT';
const TIMEOUT_MS = 8000;

/** Collect all data from a readable stream into a string. */
function collect(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`collect() timed out after ${timeoutMs}ms`)), timeoutMs);
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => { buf += chunk; });
    stream.on('end', () => { clearTimeout(timer); resolve(buf); });
    stream.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** Create a temp directory with helper scripts, return cleanup fn. */
function makeFixtures(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'acp-test-'));

  // reader.sh: read one line from stdin (fd 0 after exec restores <&3) and echo it.
  // Used as the "agent" command in the fixed-pattern test.
  const readerSh = join(dir, 'reader.sh');
  writeFileSync(readerSh, '#!/bin/bash\nread line\necho "$line"\n');
  chmodSync(readerSh, 0o755);

  // poison.sh: reads and discards one line from fd 0, simulating a profile
  // script (e.g. distrobox_profile.sh -> host-spawn) that inherits fd 0 and
  // consumes data from it.  Uses bash `read` directly so it operates on the
  // inherited fd 0, not a reopened /dev/stdin path.  `|| true` ensures the
  // script exits cleanly when fd 0 is /dev/null (immediate EOF).
  const poisonSh = join(dir, 'poison.sh');
  writeFileSync(poisonSh, '#!/bin/bash\nread -r _poison_line 2>/dev/null || true\n');
  chmodSync(poisonSh, 0o755);

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

suite('Spawn stdin-protection (Unix only)', function () {
  this.timeout(TIMEOUT_MS);

  // Skip the whole suite on Windows — bash -l is not applicable there.
  suiteSetup(function () {
    if (process.platform === 'win32') {
      this.skip();
    }
  });

  /**
   * Fixed pattern: ACP pipe on fd 3, fd 0 = /dev/null.
   *
   * The profile-phase poison reads from fd 0 (gets EOF immediately from
   * /dev/null).  The agent command receives the sentinel via fd 3.
   */
  test('fixed pattern: poison profile cannot steal ACP pipe data', async () => {
    const { dir, cleanup } = makeFixtures();
    const readerSh = join(dir, 'reader.sh');
    const poisonSh  = join(dir, 'poison.sh');
    try {
      // Mimic AgentManager's fixed spawn:
      //   bash -l -c 'exec reader.sh <&3'
      //   stdio: ['ignore', 'pipe', 'pipe', 'pipe']   (fd 0 = /dev/null)
      //   child.stdin re-pointed to child.stdio[3]
      //
      // In a real login shell the profile runs first.  We simulate that by
      // prepending the poison call in the -c script (no actual -l here so
      // HOME/.bash_profile differences don't affect the test):
      const poisonAndExec = `${poisonSh}; exec ${readerSh} <&3`;
      const child = spawn(
        '/bin/bash',
        ['-c', poisonAndExec],
        {
          stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        }
      );

      const fd3 = child.stdio[3] as NodeJS.WritableStream;
      assert.ok(fd3, 'stdio[3] must be a writable stream');

      const stdoutDone = collect(child.stdout!, TIMEOUT_MS - 1000);

      // Write sentinel to the ACP pipe (fd 3).
      fd3.write(SENTINEL + '\n');
      // No fd3.end() needed: reader.sh exits after one line.

      const output = await stdoutDone;
      assert.strictEqual(
        output.trim(), SENTINEL,
        'sentinel written to fd 3 must reach reader.sh — poison must not have stolen it'
      );
    } finally {
      cleanup();
    }
  });

  /**
   * Regression / broken pattern: ACP pipe on fd 0.
   *
   * The profile-phase poison reads from fd 0 (the ACP pipe) and discards the
   * sentinel.  The agent command then reads from fd 0 and gets nothing.
   *
   * This test documents the pre-fix failure mode so that any future regression
   * (accidentally reverting to fd 0 for the ACP pipe) is immediately visible.
   */
  test('broken pattern: poison profile steals ACP pipe data from fd 0', async () => {
    const { dir, cleanup } = makeFixtures();
    const readerSh = join(dir, 'reader.sh');
    const poisonSh  = join(dir, 'poison.sh');
    try {
      // Mimic the old (unfixed) spawn:
      //   bash -c 'poison.sh; exec reader.sh'
      //   stdio: ['pipe', 'pipe', 'pipe']   (fd 0 = ACP pipe)
      const poisonAndExec = `${poisonSh}; exec ${readerSh}`;
      const child = spawn(
        '/bin/bash',
        ['-c', poisonAndExec],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );

      // Write sentinel to fd 0 (the ACP pipe in the old pattern).
      child.stdin!.write(SENTINEL + '\n');
      // Close stdin so reader.sh doesn't block waiting for a second line.
      child.stdin!.end();

      const stdoutDone = collect(child.stdout!, TIMEOUT_MS - 1000);
      const output = await stdoutDone;

      // The poison consumed the sentinel; reader.sh read an empty string.
      assert.notStrictEqual(
        output.trim(), SENTINEL,
        'sentinel should have been stolen by the poison profile — this is the pre-fix regression'
      );
    } finally {
      cleanup();
    }
  });
});
