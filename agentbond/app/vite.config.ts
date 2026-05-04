import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'buffer-polyfill',
      transformIndexHtml() {
        return [
          {
            tag: 'script',
            attrs: { type: 'module' },
            children: `
              import { Buffer } from '/node_modules/buffer/index.js';
              globalThis.Buffer = Buffer;
            `,
            injectTo: 'head-prepend',
          },
        ]
      },
    },
  ],
  define: {
    'process.env': {},
    global: 'globalThis',
  },
  resolve: {
    alias: {
      buffer: 'buffer',
      stream: 'stream-browserify',
      crypto: 'crypto-browserify',
      events: 'events',
      util: 'util',
      '@x402/fetch': new URL('./node_modules/@x402/fetch/dist/esm/index.mjs', import.meta.url).pathname,
      '@x402/svm/exact/client': new URL('./node_modules/@x402/svm/dist/esm/exact/client/index.mjs', import.meta.url).pathname,
    },
  },
  optimizeDeps: {
    include: ['buffer', 'events', 'stream-browserify', 'crypto-browserify', 'util'],
    exclude: ['@x402/fetch', '@x402/svm'],
  },
})
