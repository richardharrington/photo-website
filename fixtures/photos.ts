/**
 * Catalog record factories.
 *
 * Shared by the unit tests and by the local development fixture server, so
 * both reason about the same shape and adding a field to PhotoRecord fails to
 * compile here once rather than in every consumer.
 */

import { RENDITION_SPECS, RENDITIONS } from '../src/shared/constants.ts';
import type { Rendition } from '../src/shared/constants.ts';
import { CATALOG_SCHEMA_VERSION } from '../src/shared/catalog.ts';
import type {
  Catalog,
  DerivativeDescriptor,
  PhotoRecord,
} from '../src/shared/catalog.ts';

let counter = 0;

/** Deterministic, well-formed stand-in for a generated photo ID. */
export function testPhotoId(seed?: string): string {
  const base = seed ?? `auto${(counter += 1)}`;
  let hex = '';
  for (let i = 0; i < base.length; i += 1) {
    hex += base.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return (hex + '0'.repeat(32)).slice(0, 32);
}

function derivativesFor(width: number, height: number) {
  const out = {} as Record<Rendition, DerivativeDescriptor>;
  for (const rendition of RENDITIONS) {
    const spec = RENDITION_SPECS[rendition];
    const scale =
      spec.maxEdge === null ? 1 : Math.min(1, spec.maxEdge / Math.max(width, height));
    out[rendition] = {
      width: Math.round(width * scale),
      height: Math.round(height * scale),
      bytes: Math.round(width * height * scale * scale * 0.1),
    };
  }
  return out;
}

/**
 * `width`/`height` describe the full-resolution source; the four derivative
 * descriptors are scaled from them so aspect ratios stay self-consistent.
 */
export interface MakePhotoOptions extends Partial<PhotoRecord> {
  width?: number;
  height?: number;
}

export function makePhoto(overrides: MakePhotoOptions = {}): PhotoRecord {
  const { width = 4032, height = 3024, ...rest } = overrides;
  const id = rest.id ?? testPhotoId();
  return {
    id,
    contentHash: `hash-${id}`,
    originalFilename: 'IMG_0001.HEIC',
    downloadFilename: 'IMG_0001.jpg',
    sourceMimeType: 'image/heic',
    captureDate: '2026-08-02',
    captureTime: '17:48:50',
    captureUtcOffset: null,
    timestampSource: 'exif-datetimeoriginal',
    caption: null,
    batchSeq: 1,
    selectionIndex: 0,
    createdAt: '2026-08-03T10:00:00.000Z',
    updatedAt: '2026-08-03T10:00:00.000Z',
    trashedAt: null,
    derivatives: derivativesFor(width, height),
    createdAuditId: 'audit000',
    updatedAuditId: 'audit000',
    ...rest,
  };
}

export function makeCatalog(
  photos: readonly PhotoRecord[] = [],
  overrides: Partial<Catalog> = {},
): Catalog {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    batchCounter: photos.reduce((max, p) => Math.max(max, p.batchSeq), 0),
    updatedAt: '2026-08-03T10:00:00.000Z',
    photos: Object.fromEntries(photos.map((photo) => [photo.id, photo])),
    ...overrides,
  };
}
