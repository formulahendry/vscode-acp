import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: ['out/src/**/*.test.js', 'out/test/**/*.test.js'],
});
