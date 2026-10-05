// Probe: does the ACP client agent config's likely command actually serve ACP?
// Checks the exact path we are about to write into settings.json acp.agents.
// Run: node src/test/acp.probe.mjs
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Locate hermes: HERMES_BIN wins, else the newest committed environment, else
// PATH. Never pin an environment id — ids are regenerated on every update and
// `hermes pm repair`, so a hardcoded venv path goes stale and the spawn fails.
function findHermes() {
  if (process.env.HERMES_BIN) return process.env.HERMES_BIN;
  const base = path.join(os.homedir(), 'AppData', 'Local', 'hermes');
  try {
    const candidates = [];
    // envs/*/venv/Scripts/hermes.exe — the committed-environment binary
    for (const install of fs.readdirSync(path.join(base, 'installs'))) {
      const envs = path.join(base, 'installs', install, 'environments');
      for (const env of fs.readdirSync(envs)) {
        const exe = path.join(envs, env, 'venv', 'Scripts', 'hermes.exe');
        if (fs.existsSync(exe)) candidates.push({ exe, mtime: fs.statSync(exe).mtimeMs });
      }
    }
    // bin/hermes.exe — the always-current launcher
    const launcher = path.join(base, 'bin', 'hermes.exe');
    if (fs.existsSync(launcher)) candidates.push({ exe: launcher, mtime: fs.statSync(launcher).mtimeMs });
    candidates.sort((a, b) => b.mtime - a.mtime);
    if (candidates.length) return candidates[0].exe;
  } catch {
    // No installs tree (non-Windows, or Hermes not installed) — fall through.
  }
  return 'hermes';
}

const HERMES = findHermes();

const child = spawn(HERMES, ['acp'], { stdio: ['pipe', 'pipe', 'pipe'] });
let err = '';
child.stderr.on('data', d => { err += d.toString(); });

let nextId = 1;
const pending = new Map();

createInterface({ input: child.stdout }).on('line', line => {
  if (!line.trim().startsWith('{')) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result ?? msg.error);
    pending.delete(msg.id);
  }
});

const call = (method, params) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, r => (r && r.error ? rej(new Error(JSON.stringify(r.error))) : res(r)));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

const timer = setTimeout(() => {
  console.error('FAIL: timed out\n' + err.slice(-500));
  child.kill();
  process.exit(1);
}, 300000);

try {
  const init = await call('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  console.log('ok  initialize -> protocolVersion', init?.protocolVersion, '| agents:',
    (init?.agentCapabilities ? 'yes' : 'n/a'));

  const { sessionId } = await call('session/new', {
    cwd: REPO,
    mcpServers: [],
  });
  if (!sessionId) throw new Error('no sessionId from session/new');
  console.log('ok  session/new ->', sessionId.slice(0, 8) + '...');

  clearTimeout(timer);
  child.kill();
  console.log('acp.probe: PASS (' + HERMES + ' acp)');
  process.exit(0);
} catch (e) {
  console.error('acp.probe: FAIL', e.message, '\n' + err.slice(-500));
  child.kill();
  process.exit(1);
}