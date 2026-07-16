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

function sessionUpdate(dom: JSDOM, update: Record<string, unknown>): void {
	sendToWebview(dom, { type: 'sessionUpdate', update });
}

function textContents(dom: JSDOM, selector: string): Array<string | null> {
	return Array.from(dom.window.document.querySelectorAll(selector), (element) => element.textContent);
}

suite('Chat webview message grouping', () => {
	test('reconciles a live user message and separates agent message IDs', () => {
		const harness = createWebviewHarness();
		try {
			sendToWebview(harness.dom, {
				type: 'state',
				session: { agentName: 'RunWield', cwd: '/tmp/project' },
			});
			const input = harness.dom.window.document.getElementById('promptInput') as HTMLTextAreaElement;
			input.value = 'hi there';
			input.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
				key: 'Enter',
				bubbles: true,
			}));
			assert.ok(harness.postedMessages.some((message) => message.type === 'sendPrompt'));

			sendToWebview(harness.dom, { type: 'promptStart' });
			sessionUpdate(harness.dom, {
				sessionUpdate: 'user_message_chunk',
				messageId: 'user-1',
				content: { type: 'text', text: 'hi there' },
			});
			sessionUpdate(harness.dom, {
				sessionUpdate: 'tool_call',
				toolCallId: 'triage-1',
				title: 'triage_report',
				status: 'in_progress',
			});
			sessionUpdate(harness.dom, {
				sessionUpdate: 'agent_message_chunk',
				messageId: 'status-1',
				content: { type: 'text', text: 'Routing Intent: INQUIRY' },
			});
			sessionUpdate(harness.dom, {
				sessionUpdate: 'tool_call_update',
				toolCallId: 'triage-1',
				status: 'completed',
			});
			sessionUpdate(harness.dom, {
				sessionUpdate: 'agent_message_chunk',
				messageId: 'agent-change-1',
				content: { type: 'text', text: 'Active agent: guide' },
			});
			sessionUpdate(harness.dom, {
				sessionUpdate: 'agent_message_chunk',
				messageId: 'guide-reply-1',
				content: { type: 'text', text: 'Hi! What can I help you with?' },
			});
			sendToWebview(harness.dom, { type: 'promptEnd', stopReason: 'end_turn' });

			assert.deepStrictEqual(textContents(harness.dom, '.message.user'), ['hi there']);
			assert.deepStrictEqual(textContents(harness.dom, '.message.assistant'), [
				'Routing Intent: INQUIRY',
				'Active agent: guide',
				'Hi! What can I help you with?',
			]);
		} finally {
			harness.dispose();
		}
	});

	test('keeps replayed user messages and thought segments separate by message ID', () => {
		const harness = createWebviewHarness();
		try {
			sendToWebview(harness.dom, { type: 'loadSessionStart' });
			sessionUpdate(harness.dom, {
				sessionUpdate: 'user_message_chunk',
				messageId: 'user-1',
				content: { type: 'text', text: 'first ' },
			});
			sessionUpdate(harness.dom, {
				sessionUpdate: 'user_message_chunk',
				messageId: 'user-1',
				content: { type: 'text', text: 'message' },
			});
			sessionUpdate(harness.dom, {
				sessionUpdate: 'user_message_chunk',
				messageId: 'user-2',
				content: { type: 'text', text: 'second message' },
			});
			sessionUpdate(harness.dom, {
				sessionUpdate: 'agent_thought_chunk',
				messageId: 'thought-1',
				content: { type: 'text', text: 'first thought' },
			});
			sessionUpdate(harness.dom, {
				sessionUpdate: 'agent_message_chunk',
				messageId: 'answer-1',
				content: { type: 'text', text: 'interim answer' },
			});
			sessionUpdate(harness.dom, {
				sessionUpdate: 'agent_thought_chunk',
				messageId: 'thought-2',
				content: { type: 'text', text: 'second thought' },
			});
			sendToWebview(harness.dom, { type: 'loadSessionEnd', ok: true });

			assert.deepStrictEqual(textContents(harness.dom, '.message.user'), [
				'first message',
				'second message',
			]);
			assert.deepStrictEqual(textContents(harness.dom, '.thought-content'), [
				'first thought',
				'second thought',
			]);
			assert.deepStrictEqual(textContents(harness.dom, '.message.assistant'), ['interim answer']);
		} finally {
			harness.dispose();
		}
	});
});
