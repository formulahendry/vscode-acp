import * as assert from 'assert';
import * as vscode from 'vscode';
import { getCurrentModeId, resolvePreferredModeId } from '../config/ModeResolver';

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

	test('Default mode configuration defaults', () => {
		const config = vscode.workspace.getConfiguration('acp');
		assert.strictEqual(config.get('defaultMode'), 'auto');
		assert.strictEqual(config.get('rememberMode'), true);
	});

	test('resolvePreferredModeId handles flat and grouped configOptions', () => {
		const flatConfigOptions: any[] = [
			{
				id: 'mode',
				name: 'Mode',
				category: 'mode',
				type: 'select',
				currentValue: 'default',
				options: [
					{ value: 'default', name: 'Default' },
					{ value: 'auto', name: 'Auto' },
				],
			},
		];
		assert.strictEqual(getCurrentModeId(null, flatConfigOptions), 'default');
		assert.strictEqual(resolvePreferredModeId('auto', null, flatConfigOptions), 'auto');
		assert.strictEqual(resolvePreferredModeId('AUTO', null, flatConfigOptions), 'auto');
		assert.strictEqual(resolvePreferredModeId('unknown', null, flatConfigOptions), null);

		const groupedConfigOptions: any[] = [
			{
				id: 'mode',
				name: 'Mode',
				category: 'mode',
				type: 'select',
				currentValue: 'ask',
				options: [
					{
						group: 'Standard',
						options: [
							{ value: 'ask', name: 'Ask' },
							{ value: 'accept-edits', name: 'Accept Edits' },
						],
					},
				],
			},
		];
		assert.strictEqual(resolvePreferredModeId('Accept Edits', null, groupedConfigOptions), 'accept-edits');
	});

	test('resolvePreferredModeId handles legacy modes', () => {
		const modes: any = {
			currentModeId: 'default',
			availableModes: [
				{ id: 'default', name: 'Default' },
				{ id: 'plan', name: 'Plan Mode' },
			],
		};
		assert.strictEqual(getCurrentModeId(modes, null), 'default');
		assert.strictEqual(resolvePreferredModeId('plan', modes, null), 'plan');
		assert.strictEqual(resolvePreferredModeId('plan mode', modes, null), 'plan');
		assert.strictEqual(resolvePreferredModeId('missing', modes, null), null);
	});
});
