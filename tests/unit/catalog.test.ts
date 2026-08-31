import { describe, it, expect } from 'vitest';
import {
  emptyCatalog,
  findByContentHash,
  getLivePhoto,
  isTrashed,
  livePhotos,
  trashedAgeMs,
  trashedPhotos,
  CATALOG_SCHEMA_VERSION,
} from '../../src/shared/catalog.ts';
import {
  generateAuditId,
  generateConfirmationToken,
  generatePhotoId,
  isValidPhotoId,
} from '../../src/shared/ids.ts';
import {
  MAX_CAPTION_LENGTH,
  altTextFor,
  normalizeCaption,
  validatePhotoEdit,
} from '../../src/shared/validation.ts';
import { makeCatalog, makePhoto, testPhotoId } from '../support/photos.ts';

describe('emptyCatalog', () => {
  it('starts at schema version 1 with no photos and no batches', () => {
    const catalog = emptyCatalog('2026-08-31T00:00:00.000Z');
    expect(catalog).toEqual({
      schemaVersion: CATALOG_SCHEMA_VERSION,
      batchCounter: 0,
      updatedAt: '2026-08-31T00:00:00.000Z',
      photos: {},
    });
  });
});

describe('trash state', () => {
  const live = makePhoto({ id: testPhotoId('live') });
  const trashed = makePhoto({
    id: testPhotoId('trash'),
    trashedAt: '2026-08-20T12:00:00.000Z',
  });
  const catalog = makeCatalog([live, trashed]);

  it('classifies records by trashedAt', () => {
    expect(isTrashed(live)).toBe(false);
    expect(isTrashed(trashed)).toBe(true);
    expect(livePhotos(catalog).map((p) => p.id)).toEqual([live.id]);
    expect(trashedPhotos(catalog).map((p) => p.id)).toEqual([trashed.id]);
  });

  it('measures how long a record has been trashed', () => {
    const now = Date.parse('2026-08-21T12:00:00.000Z');
    expect(trashedAgeMs(trashed, now)).toBe(24 * 60 * 60 * 1000);
    expect(trashedAgeMs(live, now)).toBeNull();
  });
});

describe('getLivePhoto', () => {
  const live = makePhoto({ id: testPhotoId('live') });
  const trashed = makePhoto({
    id: testPhotoId('trash'),
    trashedAt: '2026-08-20T12:00:00.000Z',
  });
  const catalog = makeCatalog([live, trashed]);

  it('returns a live record', () => {
    expect(getLivePhoto(catalog, live.id)?.id).toBe(live.id);
  });

  it('makes a trashed photo indistinguishable from an unknown one', () => {
    // Both must produce a generic 404; a caller must not be able to tell that
    // a trashed ID once existed.
    expect(getLivePhoto(catalog, trashed.id)).toBeNull();
    expect(getLivePhoto(catalog, testPhotoId('nope'))).toBeNull();
  });
});

describe('findByContentHash', () => {
  it('finds an existing photo by source hash', () => {
    const photo = makePhoto({ id: testPhotoId('dup'), contentHash: 'abc123' });
    expect(findByContentHash(makeCatalog([photo]), 'abc123')?.id).toBe(photo.id);
  });

  it('still matches a trashed photo, so re-upload does not duplicate bytes', () => {
    const photo = makePhoto({
      id: testPhotoId('dup'),
      contentHash: 'abc123',
      trashedAt: '2026-08-20T12:00:00.000Z',
    });
    expect(findByContentHash(makeCatalog([photo]), 'abc123')?.id).toBe(photo.id);
  });

  it('returns null when nothing matches', () => {
    expect(findByContentHash(makeCatalog([makePhoto()]), 'nothing')).toBeNull();
  });
});

describe('id generation', () => {
  it('produces 32 lowercase hex characters', () => {
    const id = generatePhotoId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(isValidPhotoId(id)).toBe(true);
  });

  it('does not repeat across many draws', () => {
    const ids = new Set(Array.from({ length: 2000 }, generatePhotoId));
    expect(ids.size).toBe(2000);
  });

  it('rejects malformed IDs before any I/O happens', () => {
    for (const bad of [
      '',
      'not-hex',
      'A'.repeat(32),
      'a'.repeat(31),
      'a'.repeat(33),
      '../../etc/passwd',
      'a'.repeat(32) + '/full.jpg',
    ]) {
      expect(isValidPhotoId(bad), bad).toBe(false);
    }
  });

  it('produces distinct audit IDs and confirmation tokens', () => {
    expect(generateAuditId()).toMatch(/^[0-9a-f]{16}$/);
    expect(generateConfirmationToken()).toMatch(/^[0-9a-f]{48}$/);
    expect(generateConfirmationToken()).not.toBe(generateConfirmationToken());
  });
});

describe('normalizeCaption', () => {
  it('keeps line breaks but normalizes their form', () => {
    expect(normalizeCaption('one\r\ntwo\rthree')).toBe('one\ntwo\nthree');
  });

  it('treats an empty or whitespace-only caption as absent', () => {
    expect(normalizeCaption('')).toBeNull();
    expect(normalizeCaption('   \n  ')).toBeNull();
    expect(normalizeCaption(null)).toBeNull();
    expect(normalizeCaption(undefined)).toBeNull();
  });

  it('collapses runs of blank lines to a single paragraph break', () => {
    expect(normalizeCaption('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('strips control characters while keeping the surrounding text', () => {
    expect(normalizeCaption('a\u0000b\u0007c')).toBe('abc');
    expect(normalizeCaption('tab\there')).toBe('tabhere');
  });

  it('stores markup as the literal text it is', () => {
    // Captions are plain text; nothing interprets HTML or Markdown, so the
    // stored value is exactly what the viewer sees.
    expect(normalizeCaption('<b>not bold</b> **not bold**')).toBe(
      '<b>not bold</b> **not bold**',
    );
  });
});

describe('validatePhotoEdit', () => {
  it('accepts a full edit', () => {
    const result = validatePhotoEdit({
      date: '2026-08-02',
      time: '17:48',
      caption: '  Beach day  ',
    });

    expect(result).toEqual({
      ok: true,
      value: {
        moment: { date: '2026-08-02', time: '17:48:00' },
        caption: 'Beach day',
      },
    });
  });

  it('clears the time along with the date', () => {
    const result = validatePhotoEdit({ date: '', time: '17:48', caption: 'x' });
    expect(result.ok && result.value.moment).toEqual({ date: null, time: null });
  });

  it('rejects an over-long caption', () => {
    const result = validatePhotoEdit({
      date: null,
      time: null,
      caption: 'x'.repeat(MAX_CAPTION_LENGTH + 1),
    });

    expect(result.ok).toBe(false);
  });

  it('accepts a caption at exactly the limit', () => {
    const result = validatePhotoEdit({
      caption: 'x'.repeat(MAX_CAPTION_LENGTH),
    });

    expect(result.ok).toBe(true);
  });

  it('reports the date error rather than silently dropping the time', () => {
    const result = validatePhotoEdit({ date: '2026-02-30', time: '17:48' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/date/i);
  });
});

describe('altTextFor', () => {
  it('uses the caption when there is one', () => {
    expect(altTextFor(makePhoto({ caption: 'Nana blowing out candles' }))).toBe(
      'Nana blowing out candles',
    );
  });

  it('falls back to the capture date', () => {
    expect(altTextFor(makePhoto({ caption: null, captureDate: '2026-08-02' }))).toBe(
      'Photo from August 2, 2026',
    );
  });

  it('falls back again for an undated photo', () => {
    expect(
      altTextFor(makePhoto({ caption: null, captureDate: null, captureTime: null })),
    ).toBe('Undated photo');
  });

  it('never falls back to the original filename', () => {
    const photo = makePhoto({
      caption: null,
      captureDate: null,
      captureTime: null,
      originalFilename: 'IMG_4432.HEIC',
    });

    expect(altTextFor(photo)).not.toContain('IMG_4432');
  });
});
