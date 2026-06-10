import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  buildEditorContextSection,
  buildPromptWithEditorContext,
  captureEditorContext,
  captureOpenEditorPaths,
  formatEditorContextPath,
  getFilePathsFromTabInput,
  getSafeFenceMarker,
  MAX_CONTEXT_LENGTH,
  MAX_CONTEXT_PATH_LENGTH,
  MAX_OPEN_EDITORS,
  normalizeOpenEditorPaths,
  truncateText,
  type EditorContext,
  type OpenEditorFile,
} from '../ui/EditorContext';

suite('EditorContext', () => {
  const workspaceRoot = path.join(path.parse(process.cwd()).root, 'workspace');
  const workspacePath = (...segments: string[]) => path.join(workspaceRoot, ...segments);
  const formatPathForTest = (filePath: string) => filePath;

  test('truncateText strictly respects max length including suffix', () => {
    assert.strictEqual(truncateText('abcdef', 0), '');
    assert.strictEqual(truncateText('abcdef', 3), 'abc');
    assert.strictEqual(truncateText('abcdef', 6), 'abcdef');

    const result = truncateText('a'.repeat(100), 20);
    assert.strictEqual(result.length, 20);
    assert.ok(result.endsWith('… [truncated]'));
  });

  test('formats selection context with file section', () => {
    const examplePath = workspacePath('src', 'example.ts');
    const context: EditorContext = {
      filePath: examplePath,
      cursorLine: 42,
      cursorCharacter: 7,
      language: 'ts',
      selection: {
        startLine: 40,
        startCharacter: 1,
        endLine: 43,
        endCharacter: 12,
        text: 'const value = 1;',
      },
      currentLine: null,
      openEditors: [],
    };

    assert.strictEqual(
      buildEditorContextSection(context, formatPathForTest),
      [
        'VS Code context:',
        `File: ${examplePath}`,
        'Cursor: 42:7',
        'Selection: 40:1-43:12',
        '',
        '```ts',
        'const value = 1;',
        '```',
      ].join('\n'),
    );
  });

  test('formats current line context when there is no selection', () => {
    const examplePath = workspacePath('src', 'example.ts');
    const context: EditorContext = {
      filePath: examplePath,
      cursorLine: 42,
      cursorCharacter: 7,
      language: 'ts',
      selection: null,
      currentLine: {
        line: 42,
        text: 'return value;',
      },
      openEditors: [],
    };

    assert.strictEqual(
      buildEditorContextSection(context, formatPathForTest),
      [
        'VS Code context:',
        `File: ${examplePath}`,
        'Cursor: 42:7',
        'Line: 42',
        '',
        '```ts',
        'return value;',
        '```',
      ].join('\n'),
    );
  });

  test('does not prefix a prompt when context is null', () => {
    assert.strictEqual(buildPromptWithEditorContext('hello', null), 'hello');
  });

  test('formats open editors after active editor context', () => {
    const packagePath = workspacePath('package.json');
    const barPath = workspacePath('src', 'bar.ts');
    const fooPath = workspacePath('src', 'foo.ts');
    // Files must be sorted by openedAt DESC to simulate normalizeOpenEditorPaths result
    const openEditors: OpenEditorFile[] = [
      { path: packagePath, openedAt: 3000 },
      { path: barPath, openedAt: 2000 },
      { path: fooPath, openedAt: 1000 },
    ];
    const context: EditorContext = {
      filePath: fooPath,
      cursorLine: 42,
      cursorCharacter: 7,
      language: 'ts',
      selection: null,
      currentLine: {
        line: 42,
        text: 'const value = computeTotal(items);',
      },
      openEditors,
    };

    assert.strictEqual(
      buildEditorContextSection(context, formatPathForTest),
      [
        'VS Code context:',
        `File: ${fooPath}`,
        'Cursor: 42:7',
        'Line: 42',
        '',
        '```ts',
        'const value = computeTotal(items);',
        '```',
        '',
        'Open editors:',
        `- ${packagePath}`,
        `- ${barPath}`,
        `- ${fooPath}`,
      ].join('\n'),
    );
  });

  test('deduplicates open editor paths by normalized path and keeps max openedAt', () => {
    const fooPath = workspacePath('src', 'foo.ts');
    const barPath = workspacePath('src', 'bar.ts');
    const bazPath = workspacePath('src', 'baz.ts');
    const packagePath = workspacePath('package.json');
    const upperFooPath = workspacePath('src', 'FOO.ts');
    const input: OpenEditorFile[] = [
      { path: fooPath, openedAt: 1000 },
      { path: barPath, openedAt: 3000 },
      { path: fooPath, openedAt: 1500 }, // duplicate
      { path: '', openedAt: 2000 },
      { path: packagePath, openedAt: 4000 },
      { path: barPath, openedAt: 2500 }, // duplicate
      { path: `${workspacePath('src')}${path.sep}..${path.sep}src${path.sep}baz.ts`, openedAt: 3500 },
      { path: upperFooPath, openedAt: 500 },
    ];
    
    const result = normalizeOpenEditorPaths(input);
    
    assert.strictEqual(result.length, 5);
    assert.strictEqual(result[0].path, packagePath);
    assert.strictEqual(result[1].path, bazPath);
    assert.strictEqual(result[1].openedAt, 3500);
    assert.strictEqual(result[2].path, barPath);
    assert.strictEqual(result[2].openedAt, 3000);
    assert.strictEqual(result[3].path, fooPath);
    assert.strictEqual(result[3].openedAt, 1500);
    assert.strictEqual(result[4].path, upperFooPath);
    assert.strictEqual(result[4].openedAt, 500);
  });

  test('limits to MAX_OPEN_EDITORS when more files are provided', () => {
    const input: OpenEditorFile[] = [
      { path: workspacePath('file1.ts'), openedAt: 1000 },
      { path: workspacePath('file2.ts'), openedAt: 2000 },
      { path: workspacePath('file3.ts'), openedAt: 3000 },
      { path: workspacePath('file4.ts'), openedAt: 4000 },
      { path: workspacePath('file5.ts'), openedAt: 5000 },
      { path: workspacePath('file6.ts'), openedAt: 6000 },
      { path: workspacePath('file7.ts'), openedAt: 7000 },
    ];
    
    const result = normalizeOpenEditorPaths(input);
    
    assert.strictEqual(result.length, MAX_OPEN_EDITORS);
    // Should be sorted by openedAt DESC
    assert.strictEqual(result[0].path, workspacePath('file7.ts'));
    assert.strictEqual(result[1].path, workspacePath('file6.ts'));
    assert.strictEqual(result[2].path, workspacePath('file5.ts'));
    assert.strictEqual(result[3].path, workspacePath('file4.ts'));
    assert.strictEqual(result[4].path, workspacePath('file3.ts'));
    // file1.ts and file2.ts should be excluded as oldest
    assert.strictEqual(result.find(f => f.path === workspacePath('file1.ts')), undefined);
    assert.strictEqual(result.find(f => f.path === workspacePath('file2.ts')), undefined);
  });

  test('reuses initialized timestamps across repeated open editor captures', () => {
    const uri = vscode.Uri.file(workspacePath('stable-timestamp.ts'));
    const tabGroups = [
      {
        tabs: [
          {
            input: new vscode.TabInputText(uri),
          },
        ],
      },
    ];

    const first = captureOpenEditorPaths(tabGroups as any, () => 1000);
    const second = captureOpenEditorPaths(tabGroups as any, () => 2000);

    assert.strictEqual(first.length, 1);
    assert.strictEqual(second.length, 1);
    assert.strictEqual(first[0].openedAt, 1000);
    assert.strictEqual(second[0].openedAt, 1000);
  });

  test('captures file paths from text and diff tabs', () => {
    const originalUri = vscode.Uri.file(workspacePath('src', 'before.ts'));
    const modifiedUri = vscode.Uri.file(workspacePath('src', 'after.ts'));
    const textUri = vscode.Uri.file(workspacePath('src', 'current.ts'));

    assert.deepStrictEqual(
      getFilePathsFromTabInput(new vscode.TabInputText(textUri)),
      [textUri.fsPath],
    );
    assert.deepStrictEqual(
      getFilePathsFromTabInput(new vscode.TabInputTextDiff(originalUri, modifiedUri)),
      [originalUri.fsPath, modifiedUri.fsPath],
    );
  });

  test('prunes closed tabs from the open editor tracker', () => {
    const firstUri = vscode.Uri.file(workspacePath('src', 'first.ts'));
    const secondUri = vscode.Uri.file(workspacePath('src', 'second.ts'));
    const firstCapture = [
      {
        tabs: [
          { input: new vscode.TabInputText(firstUri) },
          { input: new vscode.TabInputText(secondUri) },
        ],
      },
    ];
    const secondCapture = [
      {
        tabs: [
          { input: new vscode.TabInputText(secondUri) },
        ],
      },
    ];

    assert.deepStrictEqual(
      captureOpenEditorPaths(firstCapture as any, () => 1000).map(file => file.path).sort(),
      [firstUri.fsPath, secondUri.fsPath].sort(),
    );

    const result = captureOpenEditorPaths(secondCapture as any, () => 2000);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].path, secondUri.fsPath);
    assert.strictEqual(result[0].openedAt, 1000);
  });

  test('formats workspace paths as relative and non-workspace paths as basename', () => {
    const workspaceFolder = {
      uri: vscode.Uri.file(workspaceRoot),
      name: 'workspace',
      index: 0,
    };

    assert.strictEqual(
      formatEditorContextPath(workspacePath('src', 'example.ts'), [workspaceFolder]),
      path.join('src', 'example.ts'),
    );
    assert.strictEqual(
      formatEditorContextPath(path.join(path.parse(process.cwd()).root, 'outside', 'secret.ts'), [workspaceFolder]),
      'secret.ts',
    );
    assert.strictEqual(
      formatEditorContextPath(workspacePath('src', 'example.ts'), []),
      'example.ts',
    );
  });

  test('truncates formatted paths to MAX_CONTEXT_PATH_LENGTH', () => {
    const longFileName = `${'a'.repeat(MAX_CONTEXT_PATH_LENGTH + 100)}.ts`;
    const result = formatEditorContextPath(workspacePath(longFileName), []);

    assert.strictEqual(result.length, MAX_CONTEXT_PATH_LENGTH);
    assert.ok(result.endsWith('… [truncated]'));
  });

  test('truncates large selections without reading the full selection text', () => {
    const selectedText = 'a'.repeat(MAX_CONTEXT_LENGTH + 1000);
    const editor = {
      document: {
        uri: { fsPath: workspacePath('src', 'large-selection.ts') },
        languageId: 'typescript',
        lineAt: () => ({ text: selectedText }),
        getText: () => {
          throw new Error('selection should be read through bounded line extraction');
        },
      },
      selection: {
        active: { line: 0, character: 0 },
        isEmpty: false,
        start: { line: 0, character: 0 },
        end: { line: 0, character: selectedText.length },
      },
    };

    const context = captureEditorContext(editor as any);

    assert.ok(context?.selection);
    assert.strictEqual(context.selection.text.length, MAX_CONTEXT_LENGTH);
    assert.ok(context.selection.text.endsWith('… [truncated]'));
  });

  test('truncates long current lines', () => {
    const currentLineText = 'a'.repeat(MAX_CONTEXT_LENGTH + 1000);
    const editor = {
      document: {
        uri: { fsPath: workspacePath('src', 'large-line.ts') },
        languageId: 'typescript',
        lineAt: () => ({ text: currentLineText }),
      },
      selection: {
        active: { line: 0, character: 0 },
        isEmpty: true,
      },
    };

    const context = captureEditorContext(editor as any);

    assert.ok(context?.currentLine);
    assert.strictEqual(context.currentLine.text.length, MAX_CONTEXT_LENGTH);
    assert.ok(context.currentLine.text.endsWith('… [truncated]'));
  });

  test('uses file extension as markdown language when capturing context', () => {
    const editor = {
      document: {
        uri: { fsPath: workspacePath('src', 'example.ts') },
        languageId: 'typescript',
        lineAt: () => ({ text: 'type Example = string;' }),
      },
      selection: {
        active: { line: 0, character: 0 },
        isEmpty: true,
      },
    };

    const context = captureEditorContext(editor as any);

    assert.ok(context);
    assert.strictEqual(context.language, 'ts');
    assert.deepStrictEqual(context.openEditors, []);
    assert.ok(buildEditorContextSection(context, formatPathForTest).includes('```ts\n'));
  });

  test('escapes fence markers in context text containing backticks', () => {
    const context: EditorContext = {
      filePath: workspacePath('src', 'example.ts'),
      cursorLine: 10,
      cursorCharacter: 0,
      language: 'md',
      selection: {
        startLine: 10,
        startCharacter: 0,
        endLine: 10,
        endCharacter: 15,
        text: 'Code with ``` backticks',
      },
      currentLine: null,
      openEditors: [],
    };

    const result = buildEditorContextSection(context, formatPathForTest);
    
    // Should use a longer fence (````) when context contains ```
    assert.ok(result.includes('````md'));
    assert.ok(result.includes('Code with ``` backticks'));
    assert.ok(result.includes('````'));
    // Verify the closing fence matches the opening fence length
    const lines = result.split('\n');
    const codeBlockStart = lines.findIndex(l => l.startsWith('```') || l.startsWith('````'));
    const codeBlockEnd = lines.findIndex((l, i) => i > codeBlockStart && (l === '```' || l === '````'));
    
    assert.ok(codeBlockStart !== -1, 'Code block start fence found');
    assert.ok(codeBlockEnd !== -1, 'Code block end fence found');
    // Both should have 4 backticks
    assert.ok(lines[codeBlockStart].startsWith('````'), 'Opening fence uses 4 backticks');
    assert.strictEqual(lines[codeBlockEnd], '````', 'Closing fence uses 4 backticks');
  });

  test('getSafeFenceMarker increases fence length when context contains backticks', () => {
    // Context with no backticks should use default ```
    assert.strictEqual(getSafeFenceMarker('normal text'), '```');
    
    // Context with ``` should use ````
    assert.strictEqual(getSafeFenceMarker('text with ``` code'), '````');
    
    // Context with ```` should use `````
    assert.strictEqual(getSafeFenceMarker('text with ```` code'), '`````');
    
    // Context with multiple levels should use longest + 1
    assert.strictEqual(getSafeFenceMarker('``` and ````'), '`````');
    
    // Empty context should use default ```
    assert.strictEqual(getSafeFenceMarker(''), '```');
  });

  test('buildEditorContextSection with backticks in context produces valid fenced block', () => {
    const context: EditorContext = {
      filePath: workspacePath('src', 'example.md'),
      cursorLine: 5,
      cursorCharacter: 0,
      language: 'md',
      selection: {
        startLine: 5,
        startCharacter: 0,
        endLine: 5,
        endCharacter: 10,
        text: 'Some ``` code',
      },
      currentLine: null,
      openEditors: [],
    };

    const result = buildEditorContextSection(context, formatPathForTest);
    const lines = result.split('\n');
    
    // Find the fence lines
    const openingFenceIndex = lines.findIndex(l => l.startsWith('```') || l.startsWith('````'));
    const closingFenceIndex = lines.findIndex((l, i) => i > openingFenceIndex && (l === '```' || l === '````'));
    
    assert.ok(openingFenceIndex !== -1, 'Opening fence found');
    assert.ok(closingFenceIndex !== -1, 'Closing fence found');
    
    const openingFence = lines[openingFenceIndex];
    const closingFence = lines[closingFenceIndex];
    
    // Both should be ```` (4 backticks)
    assert.strictEqual(openingFence, '````md', 'Opening fence is 4 backticks with language');
    assert.strictEqual(closingFence, '````', 'Closing fence is 4 backticks');
    
    // Verify content is preserved
    assert.ok(result.includes('Some ``` code'));
  });
});
