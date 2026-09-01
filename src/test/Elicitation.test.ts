import * as assert from 'assert';
import * as vscode from 'vscode';
import { JSDOM } from 'jsdom';

import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { ChatWebviewProvider } from '../ui/ChatWebviewProvider';

interface WebviewHarness {
	dom: JSDOM;
	postedMessages: any[];
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
	const postedMessages: any[] = [];
	let state: unknown;
	const dom = new JSDOM(html, {
		runScripts: 'dangerously',
		beforeParse(window) {
			(window as any).acquireVsCodeApi = () => ({
				postMessage: (message: any) => postedMessages.push(message),
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
		postedMessages,
		dispose: () => {
			dom.window.close();
			provider.dispose();
		},
	};
}

function sendToWebview(dom: JSDOM, data: Record<string, unknown>): void {
	dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
}

function lastResult(postedMessages: any[]): unknown {
	return JSON.parse(JSON.stringify(postedMessages[postedMessages.length - 1]));
}

function buttonLabels(dom: JSDOM): Array<string | null> {
	return Array.from(dom.window.document.querySelectorAll('.elicitation-actions button')).map(
		(el) => el.textContent,
	);
}

function clickButton(dom: JSDOM, label: string): void {
	const button = Array.from(
		dom.window.document.querySelectorAll('.elicitation-actions button'),
	).find((el) => el.textContent === label);
	assert.ok(button, `button ${label} exists`);
	(button as HTMLElement).click();
}

suite('Elicitation', () => {
	test('answers a single choice question with one click', () => {
		const harness = createWebviewHarness();
		try {
			sendToWebview(harness.dom, {
				type: 'elicitation',
				id: 'elicitation-1',
				message: 'Which database should I use?',
				schema: {
					type: 'object',
					properties: {
						database: {
							type: 'string',
							oneOf: [
								{ const: 'postgres', title: 'PostgreSQL' },
								{ const: 'sqlite', title: 'SQLite' },
							],
						},
					},
					required: ['database'],
				},
			});

			assert.deepStrictEqual(buttonLabels(harness.dom), ['PostgreSQL', 'SQLite', 'Decline']);
			clickButton(harness.dom, 'SQLite');

			assert.deepStrictEqual(lastResult(harness.postedMessages), {
				type: 'elicitationResult',
				id: 'elicitation-1',
				action: 'accept',
				content: { database: 'sqlite' },
			});
		} finally {
			harness.dispose();
		}
	});

	test('holds the send button until every required field is filled', () => {
		const harness = createWebviewHarness();
		try {
			sendToWebview(harness.dom, {
				type: 'elicitation',
				id: 'elicitation-2',
				message: 'Where should the service run?',
				schema: {
					type: 'object',
					properties: {
						host: { type: 'string', title: 'Host' },
						port: { type: 'integer', title: 'Port', default: 8080 },
						tls: { type: 'boolean', title: 'Enable TLS' },
					},
					required: ['host', 'port'],
				},
			});

			const document = harness.dom.window.document;
			const send = Array.from(document.querySelectorAll('.elicitation-actions button')).find(
				(el) => el.textContent === 'Send',
			) as HTMLButtonElement;
			assert.strictEqual(send.disabled, true, 'send starts disabled');

			const host = document.querySelector('input[type="text"]') as HTMLInputElement;
			host.value = 'db-1';
			host.dispatchEvent(new harness.dom.window.Event('input'));
			assert.strictEqual(send.disabled, false, 'send unlocks once host is set');

			(document.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
			send.click();

			assert.deepStrictEqual(lastResult(harness.postedMessages), {
				type: 'elicitationResult',
				id: 'elicitation-2',
				action: 'accept',
				content: { host: 'db-1', port: 8080, tls: true },
			});
		} finally {
			harness.dispose();
		}
	});

	test('reports a declined question and locks the card', () => {
		const harness = createWebviewHarness();
		try {
			sendToWebview(harness.dom, {
				type: 'elicitation',
				id: 'elicitation-3',
				message: 'Should I delete the branch?',
				schema: {
					type: 'object',
					properties: {
						answer: { type: 'string', enum: ['yes', 'no'] },
					},
				},
			});

			clickButton(harness.dom, 'Decline');

			assert.deepStrictEqual(lastResult(harness.postedMessages), {
				type: 'elicitationResult',
				id: 'elicitation-3',
				action: 'decline',
				content: null,
			});
			const card = harness.dom.window.document.querySelector('.elicitation');
			assert.ok(card!.classList.contains('answered'));

			clickButton(harness.dom, 'yes');
			assert.strictEqual(
				harness.postedMessages.filter((m) => m.type === 'elicitationResult').length,
				1,
				'an answered question ignores further clicks',
			);
		} finally {
			harness.dispose();
		}
	});
});
