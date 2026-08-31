import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_BASE__: JSON.stringify('/test-base'),
    __WORKER_BASE_URL__: JSON.stringify('https://worker.test'),
    __SITE_TITLE__: JSON.stringify('Family Photos'),
  },
  test: {
    globals: true,
    // Node by default. Component tests opt in per file with a
    // `@vitest-environment happy-dom` docblock.
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
  },
});
