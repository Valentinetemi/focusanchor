import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const configFile = existsSync(resolve('firebase-config.js'))
  ? resolve('firebase-config.js')
  : resolve('firebase-config.example.js');

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@firebase-config': configFile,
    },
  },
  build: {
    rollupOptions: {
      input: {
        popup: resolve('index.html'),
        background: resolve('src/background.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
