import * as assert from 'assert';

import { SessionManager } from '../core/SessionManager';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';

suite('SessionManager', () => {
	test('replays early available_commands_update after the session is registered', () => {
		const sessionUpdateHandler = new SessionUpdateHandler();
		const sessionManager = new SessionManager({} as any, {} as any, sessionUpdateHandler);

		sessionUpdateHandler.handleUpdate({
			sessionId: 'session-1',
			update: {
				sessionUpdate: 'available_commands_update',
				availableCommands: [{ name: 'fix', description: 'Fix code' }],
			},
		} as any);

		(sessionManager as any).sessions.set('session-1', {
			sessionId: 'session-1',
			availableCommands: [],
			modes: null,
		});
		(sessionManager as any).replayPendingSessionUpdates('session-1');

		assert.deepStrictEqual((sessionManager as any).sessions.get('session-1').availableCommands, [
			{ name: 'fix', description: 'Fix code' },
		]);
	});
});
