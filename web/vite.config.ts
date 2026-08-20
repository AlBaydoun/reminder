import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves a project site from /<repo>/, so the base has to be
  // set at build time. Defaults to '/' for the normal self-hosted build.
  base: process.env.VITE_BASE ?? '/',
  server: {
    port: 5173,
    // Proxying keeps the browser on one origin in development, so the
    // httpOnly refresh cookie behaves exactly as it does in production.
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Three.js is large and rarely changes — keeping it in its own chunk
        // means a UI tweak does not invalidate 600 KB of cached WebGL code.
        manualChunks: {
          three: ['three', '@react-three/fiber', '@react-three/drei'],
          motion: ['framer-motion'],
        },
      },
    },
  },
});
