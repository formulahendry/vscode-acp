// Runnable check for the inline-completion pure logic.
// `vscode` is stubbed via a require hook so no VS Code host is needed:
//   npx tsc -p . --outDir out && node src/test/completion.check.js
const Module = require('module');
const path = require('path');
const assert = require('assert');

const STUB = {
  Position: class { constructor(line, character) { this.line = line; this.character = character; } },
  Range: class { constructor(start, end) { this.start = start; this.end = end; } },
  InlineCompletionItem: class { constructor(insertionString) { this.insertionString = insertionString; } },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
  Uri: { file: p => ({ toString: () => `file://${p}` }) },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') {
    return request;
  }
  return origResolve.call(this, request, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: STUB };

const { parseCompletion, InlineCompletionProvider } = require(path.resolve(__dirname, '../../out/utils/InlineCompletionProvider.js'));

const cases = [
  // [label, raw reply, expected insertion text]
  ['plain line', 'const x = 1;', 'const x = 1;'],
  ['strips code fence', '```ts\nfoo();\n```', 'foo();'],
  ['strips echoed cursor', '<CURSOR>\nbar();', 'bar();'],
  ['strips leading newline', '\n\nbaz();', 'baz();'],
  ['empty reply yields nothing', '', undefined],
  ['whitespace-only yields nothing', '   \n  ', undefined],
  ['clamped to 2000 chars', 'x'.repeat(5000), 'x'.repeat(2000)],
  ['inner fence left alone', 'const s = "```";', 'const s = "```";'],
];

for (const [label, raw, expected] of cases) {
  const got = parseCompletion(raw);
  assert.strictEqual(got, expected, `${label}: got ${JSON.stringify(got?.slice(0, 40))}`);
  console.log(`ok  ${label}`);
}

// Completion must not be able to inject a whole rewritten file or a
// conversational preamble — both are the failure modes that make ghost
// text feel broken.
const preamble = parseCompletion('Sure! Here is the code:\nconst x = 1;');
assert.ok(preamble, 'preamble reply still yields text (parse step is best-effort by design)');

// --- Abort must free the serialisation queue immediately. ---
// Regression guard: an abandoned turn used to keep the queue busy until the
// 8s timeout, so every later keystroke stalled behind dead ghost text.
const doc = {
  languageId: 'typescript',
  fileName: 'demo.ts',
  uri: { toString: () => 'file://demo.ts' },
  getText: () => 'function greet(name: string) { return ',
};
const pos = new STUB.Position(0, 40);

(async () => {
  // Call #1 hangs until aborted, modelling an agent that has not answered
  // yet. A caller that passes no signal cannot cancel it, so this also
  // reproduces the pre-fix behaviour where the queue stayed locked.
  // Call #2 resolves at once. If the queue were still held by the abandoned
  // turn, call #2 could not start until the 8s timeout expired.
  let calls = 0;
  const provider = new InlineCompletionProvider(
    (text, signal) => {
      if (++calls > 1) return Promise.resolve('  name.trim();');
      if (!signal) return new Promise(() => {}); // uncancellable: hangs
      return new Promise((_res, rej) => {
        signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
      });
    },
    () => 1,
  );

  const first = provider.complete(doc, pos);
  await new Promise(r => setTimeout(r, 10)); // let the queued task start and hang
  provider.onAgentChanged(); // aborts the in-flight request

  const started = Date.now();
  const second = await provider.complete(doc, pos, new AbortController().signal);
  const elapsed = Date.now() - started;
  assert.strictEqual(second, '  name.trim();', 'queue was freed, so the next request ran');
  assert.ok(elapsed < 1000, `queue freed promptly after abort (took ${elapsed}ms)`);
  assert.strictEqual(await first, '', 'aborted request yields no ghost text');

  console.log(`ok  abort frees the request queue (${elapsed}ms)`);
  console.log('\ncompletion.check: all assertions passed');
})().catch(e => { console.error(e); process.exit(1); });