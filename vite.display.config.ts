import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveBuildEnv, clientDefines } from './config/build-env.ts';
import { fixtureServer } from './config/fixture-server.ts';

const env = resolveBuildEnv('display');

// The display and admin apps are deliberately separate Vite builds. Nothing in
// this build's module graph may reach src/admin, so no admin code — and no
// admin path — can be emitted under the display base.
export default defineConfig({
  root: 'src/display',
  base: `${env.appBase}/`,
  publicDir: false,
  define: clientDefines(env),
  plugins: [react(), fixtureServer()],
  build: {
    outDir: `../../dist${env.appBase}`,
    emptyOutDir: true,
    sourcemap: false,
  },
  server: { port: 5173 },
});
