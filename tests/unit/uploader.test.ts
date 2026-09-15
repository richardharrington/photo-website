import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hashUploaderToken,
  isOwnedBy,
  isUploaderToken,
} from '../../src/shared/uploader.ts';
import { generateUploaderToken } from '../../src/shared/ids.ts';
import { makePhoto } from '../../fixtures/photos.ts';
import {
  FIXTURE_UPLOADER_HASH,
  FIXTURE_UPLOADER_TOKEN,
} from '../../fixtures/catalog.ts';

/**
 * The rules that decide which browser added a photograph
 * (family-own-trash.md 6.1). The server tests show them enforced; these pin
 * the rules themselves.
 */

const TOKEN = '0123456789abcdef'.repeat(4);
/** `printf '%s' "$TOKEN" | shasum -a 256` */
const TOKEN_HASH = 'a8ae6e6ee929abea3afcfc5258c8ccd6f85273e0d4626d26c7279f3250f77c8e';

describe('isUploaderToken', () => {
  it('accepts 64 lowercase hex characters', () => {
    expect(isUploaderToken(TOKEN)).toBe(true);
    expect(isUploaderToken(generateUploaderToken())).toBe(true);
  });

  it.each([
    ['too short', TOKEN.slice(1)],
    ['too long', `${TOKEN}0`],
    ['upper case', TOKEN.toUpperCase()],
    ['not hex', 'g'.repeat(64)],
    ['empty', ''],
    ['padded', ` ${TOKEN.slice(1)}`],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_name, value) => {
    expect(isUploaderToken(value)).toBe(false);
  });
});

describe('generateUploaderToken', () => {
  it('is new every time', () => {
    expect(generateUploaderToken()).not.toBe(generateUploaderToken());
  });
});

describe('hashUploaderToken', () => {
  it('is the SHA-256 of the token, in lowercase hex', async () => {
    expect(await hashUploaderToken(TOKEN)).toBe(TOKEN_HASH);
  });

  it("matches the fixture's written-out hash of its token", async () => {
    expect(isUploaderToken(FIXTURE_UPLOADER_TOKEN)).toBe(true);
    expect(await hashUploaderToken(FIXTURE_UPLOADER_TOKEN)).toBe(FIXTURE_UPLOADER_HASH);
  });
});

describe('isOwnedBy', () => {
  const owned = makePhoto({ uploaderHash: TOKEN_HASH });

  it('is false for a request with no hash', () => {
    expect(isOwnedBy(owned, null)).toBe(false);
  });

  it('is false for a photograph without one', () => {
    expect(isOwnedBy(makePhoto(), TOKEN_HASH)).toBe(false);
    expect(isOwnedBy(makePhoto({ uploaderHash: null }), TOKEN_HASH)).toBe(false);
  });

  it('is false for a different hash', () => {
    expect(isOwnedBy(owned, 'f'.repeat(64))).toBe(false);
    expect(isOwnedBy(owned, TOKEN_HASH.slice(1))).toBe(false);
  });

  it('is true for the same hash', () => {
    expect(isOwnedBy(owned, TOKEN_HASH)).toBe(true);
  });
});

/**
 * Both apps share an origin, and so local storage. Only the family's entry
 * point may configure the uploader (family-own-trash.md 9): an admin that did
 * would record its uploads as added here and have the family link show Delete
 * on photographs the server refuses.
 */
describe('who configures the uploader', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? sources(join(dir, entry.name))
        : /\.tsx?$/.test(entry.name)
          ? [join(dir, entry.name)]
          : [],
    );
  }

  it('is the family entry point', () => {
    const main = readFileSync('src/display/main.tsx', 'utf8');
    expect(main).toContain('configureUploader(getUploader())');
  });

  it('is never anything in the admin app', () => {
    for (const file of sources('src/admin')) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/configureUploader|getUploader|ui\/uploader/);
    }
  });
});
