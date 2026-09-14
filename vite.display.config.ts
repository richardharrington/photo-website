import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { resolveBuildEnv, clientDefines } from './config/build-env.ts';
import { fixtureServer } from './config/fixture-server.ts';

const env = resolveBuildEnv('display');

/*
 * `npm run dev:display:lan`: the dev server over HTTPS on the local network,
 * so a phone on the same Wi-Fi can add photographs.
 *
 * The pipeline hashes each file with `crypto.subtle`, which browsers offer only
 * in a secure context — HTTPS, or localhost on the same machine. A phone
 * reaching the Mac at http://192.168.x.x is neither, and fails before it
 * decodes anything. The certificate is self-signed and generated locally, so
 * the phone shows a warning once. Development only: never set for a build.
 */
const lanHttps = Boolean(process.env.DEV_HTTPS);

// The display and admin apps are deliberately separate Vite builds. Nothing in
// this build's module graph may reach src/admin, so no admin code — and no
// admin path — can be emitted under the display base.
export default defineConfig({
  root: 'src/display',
  base: `${env.appBase}/`,
  publicDir: false,
  define: clientDefines(env),
  plugins: [react(), fixtureServer(), ...(lanHttps ? [basicSsl()] : [])],
  build: {
    outDir: `../../dist${env.appBase}`,
    emptyOutDir: true,
    sourcemap: false,
    // libheif-js and the jSquash codecs inline their WebAssembly, and the family
    // app uploads too (family-tier.md), so this bundle is legitimately large.
    // Raise the warning threshold rather than splitting the pipeline out of the
    // graph that needs it. The codecs load lazily, on first use.
    chunkSizeWarningLimit: 8000,
  },
  worker: { format: 'es' },
  optimizeDeps: {
    exclude: ['libheif-js'],
  },
  server: { port: 5173, host: lanHttps },
});
