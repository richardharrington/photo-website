import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveBuildEnv, clientDefines } from './config/build-env.ts';
import { fixtureServer } from './config/fixture-server.ts';

const env = resolveBuildEnv('admin');

// Separate build from the display app; see vite.display.config.ts.
export default defineConfig({
  root: 'src/admin',
  base: `${env.appBase}/`,
  publicDir: false,
  define: clientDefines(env),
  plugins: [react(), fixtureServer()],
  build: {
    outDir: `../../dist${env.appBase}`,
    emptyOutDir: true,
    sourcemap: false,
    // libheif-js and the jSquash codecs inline their WebAssembly, so the admin
    // bundle is legitimately large. Raise the warning threshold rather than
    // splitting the pipeline out of the graph that needs it.
    chunkSizeWarningLimit: 8000,
  },
  worker: { format: 'es' },
  optimizeDeps: {
    exclude: ['libheif-js'],
  },
  server: { port: 5174 },
});
