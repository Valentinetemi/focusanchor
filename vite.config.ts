import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      input: { popup: 'index.html', background: 'src/background.ts', aiCore: 'src/ai/core.ts' },
      output: { entryFileNames: '[name].js' },
    },
  },
});
