import * as assert from 'assert';
import * as vscode from 'vscode';
import { JSDOM } from 'jsdom';

import { SessionManager } from '../core/SessionManager';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { ChatWebviewProvider } from '../ui/ChatWebviewProvider';

function seededManager() {
	const killed: string[] = [];
	let created = 1;
	const connection = {
		newSession: async () => ({ sessionId: `session-${++created}` }),
	};
	const connectionManager = {
		getConnection: (agentId: string) =>
			agentId === 'agent-1' ? { connection, initResponse: {} } : undefined,
		removeConnection: () => undefined,
	} as any;
	const agentManager = {
		killAgent: (agentId: string) => killed.push(agentId),
	} as any;

	const manager = new SessionManager(agentManager, connectionManager, new SessionUpdateHandler());
	const seed = {
		sessionId: 'session-1',
		agentId: 'agent-1',
		agentName: 'Agent',
		agentDisplayName: 'Agent',
		cwd: '/tmp',
		createdAt: new Date().toISOString(),
		initResponse: {} as any,
		modes: null,
		models: null,
		configOptions: null,
		availableCommands: [],
	};
	(manager as any).sessions.set('session-1', seed);
	(manager as any).agentSessions.set('Agent', 'session-1');
	(manager as any).activeSessionId = 'session-1';

	return { manager, killed };
}

suite('Live sessions', () => {
	test('a new conversation leaves the running session alive', async () => {
		const { manager, killed } = seededManager();

		const created = await manager.newConversation();

		assert.strictEqual(created?.sessionId, 'session-2');
		assert.deepStrictEqual(killed, [], 'the agent process is not killed');
		assert.strictEqual(manager.getActiveSessionId(), 'session-2');
		assert.deepStrictEqual(
			manager.listLiveSessions().map((session) => session.sessionId),
			['session-1', 'session-2'],
		);
	});

	test('switching back to a live session needs no replay from the agent', async () => {
		const { manager } = seededManager();
		await manager.newConversation();

		const back = manager.activateSession('session-1');

		assert.strictEqual(back?.sessionId, 'session-1');
		assert.strictEqual(manager.getActiveSessionId(), 'session-1');
		assert.strictEqual(manager.activateSession('session-404'), undefined);
	});

	test('disconnecting drops every session of that agent', async () => {
		const { manager, killed } = seededManager();
		await manager.newConversation();

		await manager.disconnectAgent('Agent');

		assert.deepStrictEqual(killed, ['agent-1']);
		assert.deepStrictEqual(manager.listLiveSessions(), []);
		assert.strictEqual(manager.getActiveSessionId(), null);
	});
});

suite('Session tabs', () => {
	test('renders one tab per session and reports the clicked one', () => {
		const updateHandler = new SessionUpdateHandler();
		const provider = new ChatWebviewProvider(
			vscode.Uri.file('/tmp/acp-client-test'),
			{} as any,
			updateHandler,
		);
		const html = (provider as any).getHtmlContent({
			cspSource: 'test-source',
			asWebviewUri: (uri: vscode.Uri) => uri,
		} as unknown as vscode.Webview) as string;
		const posted: any[] = [];
		const dom = new JSDOM(html, {
			runScripts: 'dangerously',
			beforeParse(window) {
				(window as any).acquireVsCodeApi = () => ({
					postMessage: (message: any) => posted.push(message),
					getState: () => undefined,
					setState: (next: unknown) => next,
				});
			},
		});

		try {
			dom.window.dispatchEvent(
				new dom.window.MessageEvent('message', {
					data: {
						type: 'sessions',
						sessions: [
							{ sessionId: 'session-1', label: 'Chat 1', agentName: 'Agent', active: false, busy: true },
							{ sessionId: 'session-2', label: 'Chat 2', agentName: 'Agent', active: true, busy: false },
						],
					},
				}),
			);

			const tabs = dom.window.document.querySelectorAll('.session-tab');
			assert.strictEqual(tabs.length, 2);
			assert.ok(tabs[1].classList.contains('active'), 'the second tab is on screen');
			assert.strictEqual(tabs[0].querySelectorAll('.busy').length, 1, 'the running tab is marked');
			assert.strictEqual(tabs[1].querySelectorAll('.busy').length, 0);

			(tabs[1] as HTMLElement).click();
			assert.strictEqual(
				posted.filter((m) => m.type === 'selectSession').length,
				0,
				'clicking the visible tab does nothing',
			);

			(tabs[0] as HTMLElement).click();
			assert.deepStrictEqual(JSON.parse(JSON.stringify(posted[posted.length - 1])), {
				type: 'selectSession',
				sessionId: 'session-1',
			});
		} finally {
			dom.window.close();
			provider.dispose();
		}
	});
});
