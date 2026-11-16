import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue2';
import path from 'path'
import commonjs from 'vite-plugin-commonjs'

// To move to Electron 19+ we need to stop using node libraries
// in the renderer.
// This includes: node side libs, and stuff we've imported ourselves


// Imported libs to stop using
// There are mote too (eg pg), these are just the native ones

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue(), commonjs()],
  // Relative so assets load from app://./renderer/assets/ (the app:// handler
  // serves dist/, and index.html lives in dist/renderer/). '/' broke packaged builds.
  base: './',
  optimizeDeps: {
    exclude: []
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "./src/shared"),
      "assets": path.resolve(__dirname, './src/assets'),
    },
  },
  build: {
    outDir: 'dist/renderer', // Output directory for the renderer process
    emptyOutDir: true, // Clears the directory before building
    rollupOptions: {
      external: [],
      input: './index.html', // Entry point for the renderer process
      output: {
        format: 'cjs'
      },
    }
  },
  server: {
    port: 3003, // Development server port
    // open: './src/index.html'
  }
});
