import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

const parentSrc = resolve(__dirname, '../src');
const localSrc = resolve(__dirname, 'src');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Real components from parent app
      '@/components': resolve(parentSrc, 'components'),
      // Local shims
      '@/lib': resolve(localSrc, 'lib'),
      'next/link': resolve(localSrc, 'shims/next-link.tsx'),
    },
  },
  server: {
    fs: {
      allow: ['..'], // allow serving files from parent src/
    },
  },
});
