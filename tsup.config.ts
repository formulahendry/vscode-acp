import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['src/extension.ts'],
  platform: 'node',
  target: 'node18',
  format: ['cjs'],
  outDir: 'dist',
  bundle: true,
  clean: !options.watch,
  sourcemap: !options.minify,
  dts: true,
  splitting: false,
  minify: options.minify ?? false,
  external: ['vscode'],
}));
