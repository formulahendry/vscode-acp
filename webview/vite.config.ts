import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: path.resolve(__dirname, '../resources/webview/dist'),
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: false,
    target: 'es2022',
    lib: {
      entry: path.resolve(__dirname, 'src/main.tsx'),
      formats: ['es'],
      fileName: () => 'chat.js',
      cssFileName: 'chat',
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === 'style.css' || assetInfo.name === 'chat.css') {
            return 'chat.css';
          }
          return '[name][extname]';
        },
      },
    },
  },
});
