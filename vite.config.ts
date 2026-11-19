import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: { popup: 'index.html', background: 'src/background.ts' },
      output: { entryFileNames: '[name].js' },
    },
  },
});
