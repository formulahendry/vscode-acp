import * as assert from 'assert';

import { SessionManager } from '../core/SessionManager';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';

function manager(): any {
	return new SessionManager({} as any, {} as any, new SessionUpdateHandler()) as any;
}

suite('Continue the last session', () => {
	test('resumes the most recently updated session of the folder', async () => {
		const m = manager();
		const asked: string[] = [];
		m.capabilities.set('Agent', { list: true, load: false, resume: true });
		m.listSessions = async (_agent: string, opts: { cwd?: string }) => {
			asked.push(opts.cwd ?? '');
			return {
				sessions: [
					{ sessionId: 'older', updatedAt: '2026-08-31T20:47:29Z' },
					{ sessionId: 'newest', updatedAt: '2026-09-01T04:35:25Z' },
				],
			};
		};
		m.resumeSession = async (_agent: string, sessionId: string) => ({ sessionId });
		m.loadSession = async () => assert.fail('load is not advertised');

		const restored = await m.restoreLatestSession('Agent', '/work/project');

		assert.strictEqual(restored.sessionId, 'newest');
		assert.deepStrictEqual(asked, ['/work/project'], 'the folder is passed as the filter');
	});

	test('prefers load when the agent replays that way', async () => {
		const m = manager();
		m.capabilities.set('Agent', { list: true, load: true, resume: true });
		m.listSessions = async () => ({ sessions: [{ sessionId: 'only', updatedAt: '2026-09-01T04:35:25Z' }] });
		m.loadSession = async (_agent: string, sessionId: string) => ({ sessionId, via: 'load' });
		m.resumeSession = async () => assert.fail('load wins over resume');

		assert.strictEqual((await m.restoreLatestSession('Agent', '/work')).via, 'load');
	});

	test('starts fresh when the folder has no session, the agent cannot replay, or the call fails', async () => {
		const empty = manager();
		empty.capabilities.set('Agent', { list: true, load: false, resume: true });
		empty.listSessions = async () => ({ sessions: [] });
		assert.strictEqual(await empty.restoreLatestSession('Agent', '/work'), null);

		const noReplay = manager();
		noReplay.capabilities.set('Agent', { list: true, load: false, resume: false });
		noReplay.listSessions = async () => assert.fail('nothing to replay into');
		assert.strictEqual(await noReplay.restoreLatestSession('Agent', '/work'), null);

		const broken = manager();
		broken.capabilities.set('Agent', { list: true, load: false, resume: true });
		broken.listSessions = async () => { throw new Error('agent said no'); };
		assert.strictEqual(await broken.restoreLatestSession('Agent', '/work'), null);
	});
});
