import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { redactSensitive, validatePath } from '../security/SecurityPolicy';

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

	test('validatePath allows creating a new file inside the workspace root', () => {
		const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-security-'));
		const newFilePath = path.join('nested', 'new-file.txt');

		try {
			assert.strictEqual(
				validatePath(newFilePath, workspaceRoot),
				path.join(workspaceRoot, newFilePath),
			);
		} finally {
			fs.rmSync(workspaceRoot, { recursive: true, force: true });
		}
	});

	test('redactSensitive redacts quoted secrets and GitHub tokens', () => {
		const input = '{"token":"super-secret","authorization":"Bearer abc","pat":"ghp_1234567890abcdef"}';
		const redacted = redactSensitive(input);

		assert.ok(!redacted.includes('super-secret'));
		assert.ok(!redacted.includes('ghp_1234567890abcdef'));
		assert.ok(redacted.includes('[REDACTED]'));
	});
});
