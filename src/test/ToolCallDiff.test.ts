import * as assert from 'assert';
import * as vscode from 'vscode';
import { JSDOM } from 'jsdom';

import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { ChatWebviewProvider } from '../ui/ChatWebviewProvider';

interface WebviewHarness {
	dom: JSDOM;
	dispose: () => void;
}

function createWebviewHarness(): WebviewHarness {
	const updateHandler = new SessionUpdateHandler();
	const provider = new ChatWebviewProvider(
		vscode.Uri.file('/tmp/acp-client-test'),
		{} as any,
		updateHandler,
	);
	const webview = {
		cspSource: 'test-source',
		asWebviewUri: (uri: vscode.Uri) => uri,
	} as unknown as vscode.Webview;
	const html = (provider as any).getHtmlContent(webview) as string;
	let state: unknown;
	const dom = new JSDOM(html, {
		runScripts: 'dangerously',
		beforeParse(window) {
			(window as any).acquireVsCodeApi = () => ({
				postMessage: () => undefined,
				getState: () => state,
				setState: (nextState: unknown) => {
					state = nextState;
					return nextState;
				},
			});
		},
	});

	return {
		dom,
		dispose: () => {
			dom.window.close();
			provider.dispose();
		},
	};
}

function sendToWebview(dom: JSDOM, data: Record<string, unknown>): void {
	dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
}

function sessionUpdate(dom: JSDOM, update: Record<string, unknown>): void {
	sendToWebview(dom, { type: 'sessionUpdate', update });
}

function textContents(dom: JSDOM, selector: string): Array<string | null> {
	return Array.from(dom.window.document.querySelectorAll(selector)).map((el) => el.textContent);
}

suite('Tool call diffs', () => {
	test('renders a collapsed diff for a file edit and expands it on click', () => {
		const harness = createWebviewHarness();
		try {
			sendToWebview(harness.dom, { type: 'promptStart' });
			sessionUpdate(harness.dom, {
				sessionUpdate: 'tool_call',
				toolCallId: 'call-1',
				title: 'edit: notes.md',
				status: 'pending',
				content: [
					{
						type: 'diff',
						path: 'notes.md',
						oldText: 'alpha\nbeta',
						newText: 'alpha\ngamma\ndelta',
					},
				],
			});

			const row = harness.dom.window.document.querySelector('.tool-call-inline');
			const box = harness.dom.window.document.querySelector('.tc-diff');
			assert.ok(row, 'tool call row exists');
			assert.ok(box, 'diff container exists');
			assert.ok(box!.classList.contains('collapsed'), 'diff starts collapsed');
			assert.deepStrictEqual(textContents(harness.dom, '.tc-diff .line'), [
				'-alpha',
				'-beta',
				'+alpha',
				'+gamma',
				'+delta',
			]);
			assert.strictEqual(
				harness.dom.window.document.querySelector('.tc-diffstat')?.textContent,
				'+3 -2',
			);

			(row as HTMLElement).click();
			assert.ok(
				!harness.dom.window.document.querySelector('.tc-diff')!.classList.contains('collapsed'),
				'click expands the diff',
			);
		} finally {
			harness.dispose();
		}
	});

	test('keeps a single diff when the completed tool call repeats it', () => {
		const harness = createWebviewHarness();
		try {
			sendToWebview(harness.dom, { type: 'promptStart' });
			const content = [
				{ type: 'diff', path: 'notes.md', oldText: 'alpha', newText: 'beta' },
			];
			sessionUpdate(harness.dom, {
				sessionUpdate: 'tool_call',
				toolCallId: 'call-1',
				title: 'edit: notes.md',
				status: 'pending',
				content,
			});
			sessionUpdate(harness.dom, {
				sessionUpdate: 'tool_call_update',
				toolCallId: 'call-1',
				status: 'completed',
				content,
			});

			assert.strictEqual(harness.dom.window.document.querySelectorAll('.tc-diff').length, 1);
			assert.strictEqual(
				harness.dom.window.document.querySelector('.tc-icon')?.className,
				'tc-icon completed',
			);
		} finally {
			harness.dispose();
		}
	});

	test('leaves a tool call without diff content untouched', () => {
		const harness = createWebviewHarness();
		try {
			sendToWebview(harness.dom, { type: 'promptStart' });
			sessionUpdate(harness.dom, {
				sessionUpdate: 'tool_call',
				toolCallId: 'call-1',
				title: 'read: notes.md',
				status: 'pending',
				content: [{ type: 'content', content: { type: 'text', text: 'file body' } }],
			});

			assert.strictEqual(harness.dom.window.document.querySelectorAll('.tc-diff').length, 0);
			assert.strictEqual(harness.dom.window.document.querySelectorAll('.tc-diffstat').length, 0);
		} finally {
			harness.dispose();
		}
	});
});
