/**
 * Build-time environment resolution shared by the display and admin Vite builds.
 *
 * Only the values listed here are ever inlined into a client bundle. Nothing
 * reads `process.env` wholesale and nothing relies on Vite's `VITE_` prefix
 * auto-inlining, so a secret cannot reach a browser bundle by being named
 * carelessly — it has to be added to `resolveBuildEnv` on purpose.
 */

export interface BuildEnv {
  /** Opaque secret base path for this app, without a trailing slash. */
  appBase: string;
  /** Public base URL of the Cloudflare asset Worker, without a trailing slash. */
  workerBaseUrl: string;
  /** Configurable site title shown in the viewer. */
  siteTitle: string;
  /** True when placeholder values were substituted for local development. */
  usingDevDefaults: boolean;
}

const DEV_DEFAULTS: Record<string, string> = {
  DISPLAY_PATH: 'dev-display-path',
  ADMIN_PATH: 'dev-admin-path',
  // Empty means same-origin, so the development fixture server answers the
  // /p/<id>/<rendition> capability URLs without a second process.
  WORKER_BASE_URL: '',
  SITE_TITLE: 'Family Photos',
};

/** A real Netlify build must never silently fall back to a guessable path. */
function isRealDeploy(): boolean {
  return process.env.NETLIFY === 'true';
}

function readVar(name: string, missing: string[]): string {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  missing.push(name);
  return DEV_DEFAULTS[name] ?? '';
}

export function resolveBuildEnv(app: 'display' | 'admin'): BuildEnv {
  const pathVar = app === 'display' ? 'DISPLAY_PATH' : 'ADMIN_PATH';
  const missing: string[] = [];

  const secretPath = readVar(pathVar, missing);
  const workerBaseUrl = readVar('WORKER_BASE_URL', missing);
  const siteTitle = readVar('SITE_TITLE', missing);

  if (missing.length > 0) {
    if (isRealDeploy()) {
      throw new Error(
        `Refusing to build the ${app} app: missing required environment ` +
          `variables ${missing.join(', ')}. Set them in the Netlify site ` +
          `configuration; see .env.example.`,
      );
    }
    console.warn(
      `\n  [${app}] Using development placeholders for: ${missing.join(', ')}.\n` +
        `  This build is for local testing only and its paths are not secret.\n`,
    );
  }

  if (secretPath.includes('/')) {
    throw new Error(`${pathVar} must be a single path segment, with no "/".`);
  }

  return {
    appBase: `/${secretPath}`,
    workerBaseUrl: workerBaseUrl.replace(/\/+$/, ''),
    siteTitle,
    usingDevDefaults: missing.length > 0,
  };
}

/** Values inlined into the client bundle. Keep this list minimal and explicit. */
export function clientDefines(env: BuildEnv): Record<string, string> {
  return {
    __APP_BASE__: JSON.stringify(env.appBase),
    __WORKER_BASE_URL__: JSON.stringify(env.workerBaseUrl),
    __SITE_TITLE__: JSON.stringify(env.siteTitle),
  };
}
