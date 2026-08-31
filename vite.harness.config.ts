import { defineConfig } from 'vite';

/**
 * Development-only harness for the browser image pipeline.
 *
 * The pipeline needs createImageBitmap, OffscreenCanvas, and WebAssembly, so
 * it cannot be exercised meaningfully under a DOM shim — it has to run in a
 * real engine. This serves a page that exposes the pipeline to Playwright,
 * with the local HEIC fixtures as static files.
 *
 * Never part of a production build: neither app references it.
 */
export default defineConfig({
  root: 'tests/e2e/harness',
  // Real photos, gitignored. Tests that need them skip when they are absent.
  publicDir: '../../../sample-photos',
  server: { port: 5175 },
  optimizeDeps: { exclude: ['libheif-js'] },
});
