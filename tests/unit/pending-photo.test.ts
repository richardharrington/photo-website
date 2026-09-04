import { describe, expect, it } from 'vitest';
import { PENDING_IMAGE, pendingPhoto } from '../../src/admin/upload/pending.ts';
import type { QueueItem } from '../../src/admin/upload/queue.ts';
import { RENDITIONS } from '../../src/shared/constants.ts';
import type { Rendition } from '../../src/shared/constants.ts';
import type { DerivativeDescriptor } from '../../src/shared/catalog.ts';

/**
 * A queued file projected into the photo the shared grid and photo view take.
 *
 * The projection is what lets a photograph be curated before it has been
 * uploaded, so what matters is that it never claims to know something it does
 * not: an unread file has no date, a typed date is used exactly as typed —
 * cleared included — and a file that has not been encoded still has a shape
 * for its tile to reserve.
 */

const REAL_DERIVATIVES = Object.fromEntries(
  RENDITIONS.map((rendition) => [rendition, { width: 60, height: 40, bytes: 500 }]),
) as Record<Rendition, DerivativeDescriptor>;

function item(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'item-1',
    file: { name: 'IMG_0042.HEIC' } as File,
    selectionIndex: 0,
    state: 'processing',
    progress: 0,
    source: null,
    edit: null,
    preview: null,
    ...overrides,
  };
}

const source = {
  timestamp: {
    date: '2026-08-02' as never,
    time: '12:00:00' as never,
    utcOffset: '+01:00',
    source: 'exif-datetimeoriginal' as const,
  },
  orientation: 1 as const,
  colorProfile: null,
  hadGpsData: false,
};

describe('pendingPhoto', () => {
  it('is a photograph with a filename and nothing else, before the file is read', () => {
    const photo = pendingPhoto(item());

    expect(photo.originalFilename).toBe('IMG_0042.HEIC');
    expect(photo.captureDate).toBeNull();
    expect(photo.captureTime).toBeNull();
    expect(photo.caption).toBeNull();
  });

  it('takes the identity of the queue item, which is not a photo ID', () => {
    // There is no catalog record and no address until the commit lands, which
    // is why these tiles open in place rather than linking anywhere.
    expect(pendingPhoto(item()).id).toBe('item-1');
  });

  it('shows what the photograph says about itself, once that has been read', () => {
    const photo = pendingPhoto(item({ source }));

    expect(photo.captureDate).toBe('2026-08-02');
    expect(photo.captureTime).toBe('12:00:00');
    expect(photo.captureUtcOffset).toBe('+01:00');
  });

  it('prefers what was typed, as a whole', () => {
    // A cleared date is a cleared date. Falling back to EXIF field by field
    // would make the one correction that cannot be made "this has no date".
    const photo = pendingPhoto(
      item({ source, edit: { date: null, time: null, caption: 'On the beach' } }),
    );

    expect(photo.captureDate).toBeNull();
    expect(photo.captureTime).toBeNull();
    expect(photo.caption).toBe('On the beach');
    // Never typed, and never a field: it is the camera's own offset.
    expect(photo.captureUtcOffset).toBe('+01:00');
  });

  it('reserves a shape for a tile with no picture in it yet', () => {
    const { thumb, full } = pendingPhoto(item()).derivatives;

    expect(thumb.width).toBe(400);
    expect(thumb.height).toBe(Math.round(400 / (3 / 2)));
    // The one rendition with no maximum edge still needs a number.
    expect(full.width).toBeGreaterThan(0);
  });

  it('takes the true shapes once the encoders have produced them', () => {
    const photo = pendingPhoto(
      item({
        preview: {
          thumbUrl: 'blob:thumb',
          displayUrl: 'blob:display',
          derivatives: REAL_DERIVATIVES,
        },
      }),
    );

    expect(photo.derivatives).toEqual(REAL_DERIVATIVES);
  });
});

describe('the stand-in picture', () => {
  it('is a self-contained image rather than a source the browser cannot fetch', () => {
    // An `img` with no usable source shows the browser's broken-image mark,
    // which reads as a failed upload rather than one that has not started.
    expect(PENDING_IMAGE.startsWith('data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(PENDING_IMAGE)).toContain('<svg');
  });
});
