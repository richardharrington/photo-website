import { describe, it, expect, afterEach } from 'vitest';
import { resolveBuildEnv, clientDefines } from '../../config/build-env.ts';

const TOUCHED = [
  'NETLIFY',
  'DISPLAY_PATH',
  'ADMIN_PATH',
  'WORKER_BASE_URL',
  'SITE_TITLE',
] as const;

const saved = new Map<string, string | undefined>();
for (const key of TOUCHED) saved.set(key, process.env[key]);

afterEach(() => {
  for (const key of TOUCHED) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setEnv(values: Partial<Record<(typeof TOUCHED)[number], string>>) {
  for (const key of TOUCHED) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

describe('resolveBuildEnv', () => {
  it('reads each app from its own path variable', () => {
    setEnv({
      DISPLAY_PATH: 'aaaa1111',
      ADMIN_PATH: 'bbbb2222',
      WORKER_BASE_URL: 'https://assets.example.workers.dev',
      SITE_TITLE: 'Family Photos',
    });

    expect(resolveBuildEnv('display').appBase).toBe('/aaaa1111');
    expect(resolveBuildEnv('admin').appBase).toBe('/bbbb2222');
  });

  it('strips a trailing slash from the worker base URL', () => {
    setEnv({
      DISPLAY_PATH: 'aaaa1111',
      WORKER_BASE_URL: 'https://assets.example.workers.dev/',
      SITE_TITLE: 'Family Photos',
    });

    expect(resolveBuildEnv('display').workerBaseUrl).toBe(
      'https://assets.example.workers.dev',
    );
  });

  it('falls back to development placeholders when not deploying', () => {
    setEnv({});
    const env = resolveBuildEnv('display');

    expect(env.usingDevDefaults).toBe(true);
    expect(env.appBase).toBe('/dev-display-path');
  });

  it('refuses to build on Netlify with a missing secret path', () => {
    setEnv({
      NETLIFY: 'true',
      WORKER_BASE_URL: 'https://assets.example.workers.dev',
      SITE_TITLE: 'Family Photos',
    });

    expect(() => resolveBuildEnv('admin')).toThrow(/ADMIN_PATH/);
  });

  it('treats an empty string as missing', () => {
    setEnv({
      NETLIFY: 'true',
      DISPLAY_PATH: '',
      WORKER_BASE_URL: 'https://assets.example.workers.dev',
      SITE_TITLE: 'Family Photos',
    });

    expect(() => resolveBuildEnv('display')).toThrow(/DISPLAY_PATH/);
  });

  it('rejects a path that is not a single segment', () => {
    setEnv({
      DISPLAY_PATH: 'nested/path',
      WORKER_BASE_URL: 'https://assets.example.workers.dev',
      SITE_TITLE: 'Family Photos',
    });

    expect(() => resolveBuildEnv('display')).toThrow(/single path segment/);
  });
});

describe('clientDefines', () => {
  it('inlines only the three public values, never a secret', () => {
    setEnv({
      DISPLAY_PATH: 'aaaa1111',
      ADMIN_PATH: 'bbbb2222',
      WORKER_BASE_URL: 'https://assets.example.workers.dev',
      SITE_TITLE: 'Family Photos',
    });

    const defines = clientDefines(resolveBuildEnv('display'));

    expect(Object.keys(defines).sort()).toEqual([
      '__APP_BASE__',
      '__SITE_TITLE__',
      '__WORKER_BASE_URL__',
    ]);
    // The display bundle must never learn the admin path.
    expect(JSON.stringify(defines)).not.toContain('bbbb2222');
  });
});
