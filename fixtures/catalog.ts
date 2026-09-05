/**
 * A development and test catalog.
 *
 * Deliberately awkward rather than tidy: it mixes timed and date-only photos
 * on the same day, spans a year boundary, includes captions with line breaks,
 * an undated group, and a trashed record that must be invisible to every
 * display route. Building the viewer against a well-behaved fixture would hide
 * exactly the cases the ordering and trash rules exist for.
 */

import { makeCatalog, makePhoto, testPhotoId } from './photos.ts';
import type { Catalog, PhotoRecord } from '../src/shared/catalog.ts';

interface Spec {
  seed: string;
  date: string | null;
  time: string | null;
  caption?: string | null;
  filename: string;
  batch: number;
  index: number;
  landscape?: boolean;
  trashed?: string | null;
  source?: PhotoRecord['timestampSource'];
}

/**
 * The scratch days: July 4th and 5th, 2026 exist to be broken.
 *
 * Every end-to-end test that trashes, restores, or permanently deletes
 * something works on one of these, and nothing else in the fixture asserts a
 * count in July. There is one day per browser project because the fixture
 * store is a single process shared by every Playwright worker: two projects
 * running the same destructive test at the same moment is a race, and it was
 * one — a temporary delete failed a count assertion two projects away.
 *
 * Three live photos each, so a bulk delete can take some and leave some, plus
 * a trashed one, so each project has something in the trash to restore that no
 * other project will restore out from under it.
 */
export const SCRATCH_DAYS = ['2026-07-04', '2026-07-05'] as const;

const SCRATCH_SPECS: Spec[] = SCRATCH_DAYS.flatMap((date, day) =>
  ['21:03:11', '21:07:45', '21:14:02', '21:19:00'].map((time, index) => ({
    seed: index === 3 ? `deleted-${day}` : `scratch-${day}-${'abc'[index]}`,
    date,
    time,
    filename: `IMG_${date.replaceAll('-', '')}_${time.replaceAll(':', '')}.HEIC`,
    batch: 7 + day,
    index,
    landscape: index % 2 === 0,
    caption: index === 0 ? 'First rocket up.' : null,
    // The fourth is trashed: in the catalog, out of every display route.
    trashed: index === 3 ? '2026-08-20T12:00:00.000Z' : null,
  })),
);

const SPECS: Spec[] = [
  ...SCRATCH_SPECS,
  // A busy day, out of chronological order in the source list on purpose.
  {
    seed: 'beach-late',
    date: '2026-08-02',
    time: '17:48:50.943',
    caption: 'Low tide, everyone finally out of the water.',
    filename: 'IMG_20260802_174850943_HDR.HEIC',
    batch: 1,
    index: 2,
  },
  {
    seed: 'beach-early',
    date: '2026-08-02',
    time: '08:15:02',
    caption: 'First one down to the beach.',
    filename: 'IMG_20260802_081502.HEIC',
    batch: 1,
    index: 0,
  },
  {
    seed: 'beach-burst-a',
    date: '2026-08-02',
    time: '12:30:11.100',
    filename: 'IMG_20260802_123011100.HEIC',
    batch: 1,
    index: 3,
    landscape: true,
  },
  {
    seed: 'beach-burst-b',
    date: '2026-08-02',
    // Same second as the previous photo: only the fraction orders them.
    time: '12:30:11.850',
    filename: 'IMG_20260802_123011850.HEIC',
    batch: 1,
    index: 4,
    landscape: true,
  },
  {
    // Date but no time: sorts after every timed photo on the same day.
    seed: 'beach-scan',
    date: '2026-08-02',
    time: null,
    caption: 'Scanned from a print.\n\nNobody remembers who took it.',
    filename: 'scan-0042.png',
    batch: 2,
    index: 0,
    source: 'filename',
  },
  {
    seed: 'beach-scan-2',
    date: '2026-08-02',
    time: null,
    filename: 'scan-0043.png',
    batch: 2,
    index: 1,
    source: 'filename',
  },
  // A second day in the same month.
  {
    seed: 'market',
    date: '2026-08-15',
    time: '10:05:00',
    caption: 'Saturday market.',
    filename: 'IMG_20260815_100500.HEIC',
    batch: 3,
    index: 0,
    landscape: true,
  },
  // An earlier month in the same year.
  {
    seed: 'snowdrops',
    date: '2026-03-01',
    time: '14:22:19',
    caption: 'Snowdrops out already.',
    filename: 'IMG_20260301_142219.HEIC',
    batch: 4,
    index: 0,
  },
  // The previous year, so the year index has more than one entry.
  {
    seed: 'christmas',
    date: '2025-12-25',
    time: '09:00:00',
    caption: 'Christmas morning.',
    filename: 'IMG_20251225_090000.HEIC',
    batch: 5,
    index: 0,
    landscape: true,
  },
  {
    // An early-morning photo: the case that a timezone bug would misfile.
    seed: 'early-start',
    date: '2025-12-26',
    time: '00:30:00',
    caption: 'Awake far too early.',
    filename: 'IMG_20251226_003000.HEIC',
    batch: 5,
    index: 1,
  },
  // Undated, ordered only by batch and selection index.
  {
    seed: 'undated-b',
    date: null,
    time: null,
    caption: 'No idea when this was.',
    filename: 'DSC_0042.JPG',
    batch: 6,
    index: 1,
    source: 'none',
    landscape: true,
  },
  {
    seed: 'undated-a',
    date: null,
    time: null,
    filename: 'DSC_0041.JPG',
    batch: 6,
    index: 0,
    source: 'none',
  },
];

/**
 * When the fixture library arrived: one sitting, comfortably inside the
 * recency window, and relative because that window is relative. A literal
 * here is a test suite with an expiry date (decisions.md #67).
 *
 * `makePhoto`'s own default deliberately stays a literal — it is the unit
 * tests' factory, and several of them pin a fixed `NOW_MS`.
 */
const FIXTURE_UPLOADED_AT = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();

function toRecord(spec: Spec): PhotoRecord {
  const id = testPhotoId(spec.seed);
  const width = spec.landscape ? 4032 : 3024;
  const height = spec.landscape ? 3024 : 4032;

  return makePhoto({
    id,
    contentHash: `sha256-${spec.seed}`,
    originalFilename: spec.filename,
    downloadFilename: `${spec.filename.replace(/\.[^.]+$/, '')}.jpg`,
    sourceMimeType: spec.filename.toLowerCase().endsWith('.png')
      ? 'image/png'
      : spec.filename.toLowerCase().endsWith('.jpg')
        ? 'image/jpeg'
        : 'image/heic',
    captureDate: spec.date,
    captureTime: spec.time,
    caption: spec.caption ?? null,
    timestampSource: spec.source ?? 'exif-datetimeoriginal',
    batchSeq: spec.batch,
    selectionIndex: spec.index,
    trashedAt: spec.trashed ?? null,
    createdAt: FIXTURE_UPLOADED_AT,
    updatedAt: FIXTURE_UPLOADED_AT,
    width,
    height,
  });
}

export function fixtureCatalog(): Catalog {
  return makeCatalog(SPECS.map(toRecord), { batchCounter: 8 });
}

export const FIXTURE_PHOTO_IDS = Object.fromEntries(
  SPECS.map((spec) => [spec.seed, testPhotoId(spec.seed)]),
) as Record<string, string>;
