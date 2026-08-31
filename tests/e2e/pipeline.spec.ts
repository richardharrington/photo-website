import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';

/**
 * The browser image pipeline, exercised in real engines.
 *
 * The fixtures are real photographs kept out of the repository, so these tests
 * skip when `sample-photos/` is absent rather than passing vacuously.
 */

const HARNESS = 'http://localhost:5175/';

const FIXTURES = {
  /** Portrait iPhone HEIC: stored landscape, EXIF Orientation 6, with GPS. */
  portraitWithGps: 'classic-car.heic',
  /** A second portrait HEIC with GPS, from a different capture. */
  portraitWithGps2: 'old-safe-wall.heic',
  /** Landscape HEIC, EXIF Orientation 1. */
  landscape: 'childrens-show-theater.heic',
  /** Landscape HEIC with no Orientation tag at all. */
  noOrientationTag: 'chef-with-trumpet.heic',
};

const havePhotos = existsSync('sample-photos');

test.beforeEach(async ({ page }) => {
  test.skip(!havePhotos, 'sample-photos/ fixtures are not present');
  await page.goto(HARNESS);
  await expect(page.locator('#status')).toHaveText('ready');
});

/**
 * The eight dihedral rearrangements of an 8x8 fingerprint.
 *
 * Comparing against all of them turns the orientation check into a relative
 * one: the output must match the known-good rendering more closely than any
 * rotation or mirror of it. That is immune to the resampling noise an absolute
 * threshold would have to be tuned around, and it fails loudly on exactly the
 * defect being guarded against.
 */
const DIHEDRAL: Record<string, (f: number[], x: number, y: number) => number> = {
  identity: (f, x, y) => f[y * 8 + x]!,
  rotate90: (f, x, y) => f[(7 - x) * 8 + y]!,
  rotate180: (f, x, y) => f[(7 - y) * 8 + (7 - x)]!,
  rotate270: (f, x, y) => f[x * 8 + (7 - y)]!,
  mirrorHorizontal: (f, x, y) => f[y * 8 + (7 - x)]!,
  mirrorVertical: (f, x, y) => f[(7 - y) * 8 + x]!,
  transpose: (f, x, y) => f[x * 8 + y]!,
  transverse: (f, x, y) => f[(7 - x) * 8 + (7 - y)]!,
};

/** Mean absolute difference between an artifact and one variant of the reference. */
function distance(
  artifact: number[],
  reference: number[],
  variant: (f: number[], x: number, y: number) => number,
): number {
  let total = 0;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      total += Math.abs(artifact[y * 8 + x]! - variant(reference, x, y));
    }
  }
  return total / 64;
}

function distances(artifact: number[], reference: number[]): Record<string, number> {
  return Object.fromEntries(
    Object.entries(DIHEDRAL).map(([name, variant]) => [
      name,
      distance(artifact, reference, variant),
    ]),
  );
}

/**
 * The mandatory orientation regression test (implementation-plan.md).
 *
 * The double-rotation defect from decisions.md #17 emits four artifacts that
 * are mutually consistent and dimensionally plausible, so any dimensions-only
 * check passes while every portrait photo ships sideways.
 *
 * The oracle is libheif's own decode with no EXIF orientation applied:
 * libheif has already honoured the HEIF `irot` property, so that rendering is
 * upright by construction, and it is independent of the pipeline's
 * orientation decision, which is the thing under test.
 */
test.describe('orientation', () => {
  for (const fixture of [FIXTURES.portraitWithGps, FIXTURES.portraitWithGps2]) {
    test(`${fixture} is upright by pixel comparison, not just dimensions`, async ({
      page,
    }) => {
      const reference = await page.evaluate(
        (name) => window.pipelineHarness.decodeReference(name),
        fixture,
      );
      const result = await page.evaluate(
        (name) => window.pipelineHarness.process(name),
        fixture,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // libheif honoured irot, so the known-good rendering is portrait.
      expect(reference.height).toBeGreaterThan(reference.width);

      for (const artifact of result.artifacts) {
        // Dimensions first: necessary, and cheap to state.
        expect(artifact.height, artifact.rendition).toBeGreaterThan(artifact.width);

        // Then the part dimensions cannot tell you. Every artifact must match
        // the known-good rendering more closely than any rotation or mirror
        // of it — by a wide margin, not a hair.
        const measured = distances(artifact.fingerprint, reference.fingerprint);
        const others = Object.entries(measured).filter(([name]) => name !== 'identity');
        const nearestWrong = Math.min(...others.map(([, value]) => value));

        expect(
          measured['identity'],
          `${artifact.rendition}: ${JSON.stringify(measured)}`,
        ).toBeLessThan(nearestWrong / 3);
      }
    });
  }

  test('the fixture is asymmetric enough for that comparison to mean something', async ({
    page,
  }) => {
    // If the image were symmetric, every variant would score alike and the
    // margin assertion above would prove nothing.
    const reference = await page.evaluate(
      (name) => window.pipelineHarness.decodeReference(name),
      FIXTURES.portraitWithGps,
    );

    const measured = distances(reference.fingerprint, reference.fingerprint);
    expect(measured['identity']).toBe(0);
    for (const [name, value] of Object.entries(measured)) {
      if (name === 'identity') continue;
      expect(value, name).toBeGreaterThan(10);
    }
  });

  test('a landscape fixture stays landscape', async ({ page }) => {
    const result = await page.evaluate(
      (name) => window.pipelineHarness.process(name),
      FIXTURES.landscape,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const full = result.artifacts.find((a) => a.rendition === 'full')!;
    expect(full.width).toBeGreaterThan(full.height);
  });

  test('a HEIC with no Orientation tag is handled', async ({ page }) => {
    const result = await page.evaluate(
      (name) => window.pipelineHarness.process(name),
      FIXTURES.noOrientationTag,
    );

    expect(result.ok).toBe(true);
  });
});

test.describe('metadata and GPS', () => {
  test('reads camera-local time without reviving it into a Date', async ({ page }) => {
    const { metadata } = await page.evaluate(
      (name) => window.pipelineHarness.metadata(name),
      FIXTURES.portraitWithGps,
    );

    // Exactly the wall clock the camera wrote, unshifted.
    expect(metadata.timestamp.date).toBe('2023-10-22');
    expect(metadata.timestamp.time).toBe('09:39:48.445');
    expect(metadata.timestamp.source).toBe('exif-datetimeoriginal');
    // The offset is recorded but never applied.
    expect(metadata.timestamp.utcOffset).toBe('+02:00');
  });

  test('reads Orientation as a number, not a translated string', async ({ page }) => {
    // Without translateValues: false this arrives as "Rotate 90 CW" and the
    // numeric test silently skips rotation (decisions.md #18).
    const { metadata } = await page.evaluate(
      (name) => window.pipelineHarness.metadata(name),
      FIXTURES.portraitWithGps,
    );

    expect(metadata.orientation).toBe(6);
  });

  test('notices the source GPS and keeps it out of every artifact', async ({
    page,
  }) => {
    const result = await page.evaluate(
      (name) => window.pipelineHarness.process(name),
      FIXTURES.portraitWithGps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The source genuinely carried coordinates...
    expect(result.hadGpsData).toBe(true);
    // ...and none of the stored bytes do. This inspects the encoded output
    // rather than trusting that re-encoding drops metadata.
    for (const artifact of result.artifacts) {
      expect(artifact.containsExifMarker, artifact.rendition).toBe(false);
    }
  });

  test('detects the Display P3 profile the fixtures actually carry', async ({
    page,
  }) => {
    const { metadata } = await page.evaluate(
      (name) => window.pipelineHarness.metadata(name),
      FIXTURES.landscape,
    );

    expect(metadata.colorProfile).toBe('Display P3');
  });
});

test.describe('artifacts', () => {
  test('produces four artifacts at the specified sizes and formats', async ({
    page,
  }) => {
    const result = await page.evaluate(
      (name) => window.pipelineHarness.process(name),
      FIXTURES.landscape,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.artifacts.map((a) => a.rendition)).toEqual([
      'full',
      'thumb',
      'display-1280',
      'display-2560',
    ]);

    const byRendition = Object.fromEntries(
      result.artifacts.map((a) => [a.rendition, a]),
    );

    // The full artifact is a JPEG at source resolution.
    expect(byRendition['full']!.magic.startsWith('ffd8ff')).toBe(true);
    expect(Math.max(byRendition['full']!.width, byRendition['full']!.height)).toBe(
      4032,
    );

    // The derivatives are WebP, capped on the longest edge.
    for (const rendition of ['thumb', 'display-1280', 'display-2560'] as const) {
      const artifact = byRendition[rendition]!;
      // RIFF....WEBP
      expect(artifact.magic.startsWith('52494646'), rendition).toBe(true);
      expect(artifact.magic.slice(16, 24), rendition).toBe('57454250');
    }

    expect(Math.max(byRendition['thumb']!.width, byRendition['thumb']!.height)).toBe(
      400,
    );
    expect(
      Math.max(byRendition['display-1280']!.width, byRendition['display-1280']!.height),
    ).toBe(1280);
    expect(
      Math.max(byRendition['display-2560']!.width, byRendition['display-2560']!.height),
    ).toBe(2560);
  });

  test('keeps every artifact at the source aspect ratio', async ({ page }) => {
    const result = await page.evaluate(
      (name) => window.pipelineHarness.process(name),
      FIXTURES.portraitWithGps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ratios = result.artifacts.map((a) => a.width / a.height);
    for (const ratio of ratios) {
      expect(Math.abs(ratio - ratios[0]!)).toBeLessThan(0.01);
    }
  });

  test('hashes the source bytes, identically across runs', async ({ page }) => {
    const [first, second] = await Promise.all([
      page.evaluate((name) => window.pipelineHarness.process(name), FIXTURES.landscape),
      page.evaluate((name) => window.pipelineHarness.process(name), FIXTURES.landscape),
    ]);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.contentHash).toBe(second.contentHash);
  });

  test('gives different photos different hashes', async ({ page }) => {
    const a = await page.evaluate(
      (name) => window.pipelineHarness.process(name),
      FIXTURES.landscape,
    );
    const b = await page.evaluate(
      (name) => window.pipelineHarness.process(name),
      FIXTURES.portraitWithGps,
    );

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});

test.describe('rejecting bad input', () => {
  test('rejects a file that is not an image, without crashing the tab', async ({
    page,
  }) => {
    const result = await page.evaluate(() =>
      window.pipelineHarness.processBytes(
        [...new TextEncoder().encode('this is not an image at all')],
        'notes.txt',
        'text/plain',
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unsupported-format');
  });

  test('rejects a truncated image rather than throwing', async ({ page }) => {
    const result = await page.evaluate(() =>
      window.pipelineHarness.processBytes(
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0, 0, 0, 0],
        'truncated.png',
        'image/png',
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).not.toBe('threw');
  });

  test('rejects video by container, not by extension', async ({ page }) => {
    const result = await page.evaluate(() => {
      const bytes = new Uint8Array(32);
      bytes.set([0x66, 0x74, 0x79, 0x70], 4);
      bytes.set([0x69, 0x73, 0x6f, 0x6d], 8);
      // Named .heic on purpose: the check must look at the bytes.
      return window.pipelineHarness.processBytes(
        [...bytes],
        'movie.heic',
        'image/heic',
      );
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/video/i);
  });

  test('survives a batch without the page falling over', async ({ page }) => {
    // Firefox crashed on a fourth consecutive file (decisions.md #20), which
    // is why it is unsupported for admin. Chromium and WebKit must not.
    const names = [
      FIXTURES.landscape,
      FIXTURES.portraitWithGps,
      FIXTURES.noOrientationTag,
      FIXTURES.portraitWithGps2,
      FIXTURES.landscape,
    ];

    for (const name of names) {
      const result = await page.evaluate(
        (fixture) => window.pipelineHarness.process(fixture),
        name,
      );
      expect(result.ok, name).toBe(true);
    }

    await expect(page.locator('#status')).toHaveText('ready');
  });
});
