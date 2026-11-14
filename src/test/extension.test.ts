import * as assert from 'assert';
import * as vscode from 'vscode';
import type { AgentConfigEntry } from '../config/AgentConfig';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Extension should be present', () => {
		assert.ok(vscode.extensions.getExtension('formulahendry.acp-client'));
	});

	test('Should activate extension', async () => {
		const ext = vscode.extensions.getExtension('formulahendry.acp-client');
		assert.ok(ext);
		await ext.activate();
		assert.strictEqual(ext.isActive, true);
	});

	test('Should register ACP commands', async () => {
		const commands = await vscode.commands.getCommands(true);
		const acpCommands = commands.filter(c => c.startsWith('acp.'));
		assert.ok(acpCommands.length > 0, 'ACP commands should be registered');
		assert.ok(acpCommands.includes('acp.connectAgent'), 'connectAgent command should exist');
		assert.ok(acpCommands.includes('acp.newConversation'), 'newConversation command should exist');
		assert.ok(acpCommands.includes('acp.openChat'), 'openChat command should exist');
	});

	test('Default agents should include Antigravity and exclude obsolete Gemini CLI', () => {
		const inspected = vscode.workspace.getConfiguration('acp').inspect<Record<string, AgentConfigEntry>>('agents');
		const defaults = inspected?.defaultValue;
		assert.ok(defaults, 'Default acp.agents should be defined');
		assert.strictEqual(defaults['Gemini CLI'], undefined, 'Obsolete Gemini CLI should be removed');
		assert.deepStrictEqual(defaults['Antigravity'], {
			command: 'agy',
			args: ['acp'],
			env: {},
		});
	});
});
