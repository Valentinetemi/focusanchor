import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    emptyOutDir: false,
    outDir: 'dist',
    rollupOptions: {
      input: resolve('src/refocus.ts'),
      output: {
        format: 'iife',
        entryFileNames: 'refocus.js',
      },
    },
  },
});
