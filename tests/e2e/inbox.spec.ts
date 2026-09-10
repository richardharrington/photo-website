import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';

/**
 * The Inbox, against the local fixture server.
 *
 * The fake stands in for the two things a laptop cannot have: Cloudflare Email
 * Routing delivering a message, and a presigned R2 GET. Everything else is
 * real — the sniff, the caption proposal, the claim's conditional write, and
 * the browser pipeline itself, which is why these tests need a real engine and
 * a real photograph.
 *
 * `sample-photos/` is gitignored, so these skip when it is absent rather than
 * passing vacuously, exactly as `pipeline.spec.ts` does.
 */

const BASE = 'http://localhost:5174/dev-admin-path';
const API = `${BASE}/api`;
const DEV_INBOX = 'http://localhost:5174/__dev/inbox';

/** A real portrait HEIC with an embedded thumbnail and GPS. */
const PHOTO = 'sample-photos/classic-car.heic';
const havePhotos = existsSync(PHOTO);

/**
 * The address this file owns. Removed again after each test, and deliberately
 * not a substring of any address another spec uses: the specs run in parallel
 * against one shared fixture process, and a row filtered by `hasText` would
 * otherwise match two rows.
 */
const SENDER = 'submitter@example.test';

// Chromium only, and serial. The fixture's address list and object store are
// one shared process; running the same add-and-discard in two projects at once
// would be a race for no coverage. The pipeline itself is covered across
// engines by pipeline.spec.ts.
test.describe.configure({ mode: 'serial' });
test.skip(({ browserName }) => browserName !== 'chromium', 'chromium only');

/**
 * A tiny real PNG, standing in for the signature logo every mail client
 * attaches. It is a photograph by the sniff — only the bytes are believed —
 * and the point is that the Inbox lets it be unticked.
 */
const LOGO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A JPEG carrying a real EXIF thumbnail and `Orientation` 6.
 *
 * Constructed rather than taken from `sample-photos/`, because what is under
 * test is the preview path — an APP1 block holding IFD0 with an orientation
 * and IFD1 with an embedded JPEG — and a hand-built file pins that shape
 * exactly. The photographs in `sample-photos/` are HEIC, which has no EXIF
 * thumbnail at all; see the neutral-tile test below.
 */
const JPEG_WITH_THUMBNAIL = Buffer.from(
  '/9j/4QLDRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAABoAAwEDAAMAAAABAAYAAAIBAAQ' +
    'AAAABAAAARAICAAQAAAABAAACdwAAAAD/2P/gABBKRklGAAEBAQBgAGAAAP/bAEMACAYGBwYFCA' +
    'cHBwkJCAoMFA0MCwsMGRITDxQdGh8eHRocHCAkLicgIiwjHBwoNyksMDE0NDQfJzk9ODI8LjM0M' +
    'v/bAEMBCQkJDAsMGA0NGDIhHCEyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy' +
    'MjIyMjIyMjIyMjIyMv/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQI' +
    'DBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQr' +
    'HBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjQ1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzd' +
    'HV2d3h5eoOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX' +
    '2Nna4eLj5OXm5+jp6vHy8/T19vf4+fr/xAAfAQADAQEBAQEBAQEBAAAAAAAAAQIDBAUGBwgJCgv' +
    '/xAC1EQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVict' +
    'EKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg' +
    '4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl' +
    '5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/APf6KKKAP//Z/+AAEEpGSUYAAQEBAGAAYAAA/9s' +
    'AQwAIBgYHBgUIBwcHCQkICgwUDQwLCwwZEhMPFB0aHx4dGhwcICQuJyAiLCMcHCg3KSwwMTQ0NB' +
    '8nOT04MjwuMzQy/9sAQwEJCQkMCwwYDQ0YMiEcITIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyM' +
    'jIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEB' +
    'AAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQc' +
    'icRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWV' +
    'pjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFx' +
    'sfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAAB' +
    'AgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaG' +
    'hwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaW' +
    'pzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1' +
    'NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/aAAwDAQACEQMRAD8A9/ooooA//9k=',
  'base64',
);

async function allowSubmissions(page: Page): Promise<void> {
  await page.request.post(`${API}/emails/add`, { data: { email: SENDER } });
  await page.request.post(`${API}/emails/set-submit`, {
    data: { email: SENDER, canSubmit: true },
  });
}

async function removeSender(page: Page): Promise<void> {
  const listing = await (await page.request.get(`${API}/emails`)).json();
  const row = listing.recipients.find(
    (recipient: { email: string }) => recipient.email === SENDER,
  );
  if (row) await page.request.post(`${API}/emails/remove`, { data: { id: row.id } });
}

/** Post a submission the way the Worker would have written one. */
async function submit(
  page: Page,
  options: { subject: string; withLogo?: boolean },
): Promise<string> {
  const response = await page.request.post(DEV_INBOX, {
    multipart: {
      from: SENDER,
      subject: options.subject,
      body: 'Here they are',
      // Labelled application/octet-stream, as a real mail client routinely
      // labels a HEIC. Only the bytes are believed.
      file0: {
        name: 'classic-car.heic',
        mimeType: 'application/octet-stream',
        buffer: readFileSync(PHOTO),
      },
      ...(options.withLogo
        ? {
            file1: {
              name: 'signature-logo.png',
              mimeType: 'image/png',
              buffer: LOGO_PNG,
            },
          }
        : {}),
    },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).id;
}

/**
 * Discard this file's own submissions, through the real routes.
 *
 * Filtered by sender, not "everything in the inbox": the fixture is one shared
 * process and `inbox-decode.spec.ts` has submissions waiting in the same
 * prefix at the same time.
 */
async function emptyInbox(page: Page): Promise<void> {
  const listing = await (await page.request.get(`${API}/inbox`)).json();
  const mine = listing.submissions.filter(
    (submission: { from: string | null }) => submission.from === SENDER,
  );
  for (const submission of mine) {
    const token = 'cleanup-token-0123456789';
    await page.request.post(`${API}/inbox/claim`, {
      data: { submissionId: submission.id, claimToken: token },
    });
    await page.request.post(`${API}/inbox/discard`, {
      data: { submissionId: submission.id, claimToken: token },
    });
  }
}

/**
 * Take a committed photograph back out of the library entirely.
 *
 * This is the only spec that adds to the catalog and then leaves it, and the
 * catalog is one shared process state that other specs count rows in. Trash
 * then permanent delete, through the real routes.
 */
async function removeFromLibrary(page: Page, photoId: string): Promise<void> {
  const preview = await (
    await page.request.post(`${API}/trash/preview`, {
      data: { selection: { kind: 'ids', photoIds: [photoId] } },
    })
  ).json();
  await page.request.post(`${API}/trash/confirm`, { data: preview });

  const permanent = await (
    await page.request.post(`${API}/permanent-delete/preview`, {
      data: { selection: { kind: 'ids', photoIds: [photoId] } },
    })
  ).json();
  await page.request.post(`${API}/permanent-delete/confirm`, { data: permanent });
}

test.beforeEach(async ({ page }) => {
  test.skip(!havePhotos, 'sample-photos/ fixtures are not present');
  await allowSubmissions(page);
});

test.afterEach(async ({ page }) => {
  // The fixture's list and store are shared process state; leave them as found.
  await emptyInbox(page);
  await removeSender(page);
});

const card = (page: Page) => page.locator('.inbox__card');

test('is reachable from the header, with the count on it', async ({ page }) => {
  await submit(page, { subject: 'Beach day' });
  await page.goto(`${BASE}/`);

  const link = page.getByRole('link', { name: /^Inbox/ });
  await expect(link).toHaveText('Inbox (1)');
  await link.click();
  await expect(page).toHaveURL(`${BASE}/inbox`);
});

test('shows the sender, the subject, and the caption it proposes', async ({ page }) => {
  await submit(page, { subject: 'Fwd: Fwd: Beach day', withLogo: true });
  await page.goto(`${BASE}/inbox`);

  await expect(card(page)).toContainText(SENDER);
  // Both: the subject as sent, beside the proposal it produced.
  await expect(card(page)).toContainText('Subject: Fwd: Fwd: Beach day');
  await expect(page.getByLabel('Caption')).toHaveValue('Beach day');
  await expect(card(page)).toContainText('2 files');
});

test('starts a photograph ticked and a signature logo unticked', async ({ page }) => {
  await submit(page, { subject: 'Beach day', withLogo: true });
  await page.goto(`${BASE}/inbox`);

  const rows = page.locator('.inbox__part');
  await expect(rows).toHaveCount(2);

  await expect(
    rows.filter({ hasText: 'classic-car.heic' }).getByRole('checkbox'),
  ).toBeChecked();
  // Under the small-part threshold, which is what a logo is and a photograph
  // never is.
  await expect(
    rows.filter({ hasText: 'signature-logo.png' }).getByRole('checkbox'),
  ).not.toBeChecked();

  await expect(page.getByRole('button', { name: 'Add 1 photo' })).toBeEnabled();
});

/**
 * The two preview outcomes, both of them real.
 *
 * A JPEG's embedded thumbnail is read from the first 128 KB by a Range request
 * and shown, rotated by its `Orientation` tag with a CSS transform. Everything
 * else — a PNG, and **every HEIC**, which keeps its thumbnail as an HEVC item
 * in the ISO container rather than in EXIF — gets the neutral tile with its
 * filename and size, which is what separates a photograph from a logo.
 */
test('shows the embedded thumbnail of a JPEG, rotated by its orientation tag', async ({
  page,
}) => {
  await page.request.post(DEV_INBOX, {
    multipart: {
      from: SENDER,
      subject: 'Beach day',
      file0: {
        name: 'IMG_4021.JPG',
        mimeType: 'application/octet-stream',
        buffer: JPEG_WITH_THUMBNAIL,
      },
    },
  });
  await page.goto(`${BASE}/inbox`);

  const thumbnail = page
    .locator('.inbox__part')
    .filter({ hasText: 'IMG_4021.JPG' })
    .locator('img.inbox__thumb');

  await expect(thumbnail).toBeVisible();
  // Orientation 6 is a quarter turn. The stored thumbnail is unrotated, and
  // the pipeline's orientation code is deliberately not run on it — that code
  // compares a decoded shape against a tagged one, and this is not decoded.
  await expect(thumbnail).toHaveCSS('transform', /matrix\(0, 1, -1, 0/);
});

test('shows a neutral tile for a PNG and for a HEIC', async ({ page }) => {
  await submit(page, { subject: 'Beach day', withLogo: true });
  await page.goto(`${BASE}/inbox`);

  const rows = page.locator('.inbox__part');
  for (const name of ['classic-car.heic', 'signature-logo.png']) {
    await expect(
      rows.filter({ hasText: name }).locator('.inbox__thumb--none'),
    ).toBeVisible();
    // The tile is not nothing: the filename and the size are what a decision
    // between a 1.9 MB photograph and a 70-byte logo actually turns on.
    await expect(rows.filter({ hasText: name })).toContainText(name);
  }
  await expect(rows.filter({ hasText: 'signature-logo.png' })).toContainText('70 B');
});

/**
 * The way out of the HEIC preview limit, and the reason it is a button.
 *
 * A decode is the expensive, memory-risky, strictly serial thing the rest of
 * this page is arranged to avoid doing unasked, so it happens on request. What
 * the decode itself produces — upright pixels, at the preview size, in every
 * supported engine — is pinned in `pipeline.spec.ts`, which runs in more than
 * one browser; this is the control that reaches it.
 */
test('decodes a HEIC on request, behind an explicit Show', async ({ page }) => {
  await submit(page, { subject: 'Beach day', withLogo: true });
  await page.goto(`${BASE}/inbox`);

  const row = page.locator('.inbox__part').filter({ hasText: 'classic-car.heic' });
  // Nothing to look at until it is asked for: a HEIC has no EXIF thumbnail.
  await expect(row.locator('.inbox__thumb--none')).toBeVisible();

  await row.getByRole('button', { name: 'Show' }).click();

  const decoded = row.locator('img.inbox__thumb--decoded');
  await expect(decoded).toBeVisible({ timeout: 90_000 });
  await expect(row.locator('.inbox__thumb--none')).toHaveCount(0);
  // The button has done its job and is gone; the picture is the state now.
  await expect(row.getByRole('button', { name: 'Show' })).toHaveCount(0);

  // Upright *in the pixels*, so unlike an EXIF thumbnail it needs no CSS
  // transform: this went through the pipeline's own decode path.
  const shape = await decoded.evaluate((image) => {
    const element = image as HTMLImageElement;
    return {
      width: element.naturalWidth,
      height: element.naturalHeight,
      transform: getComputedStyle(element).transform,
    };
  });
  expect(shape.height).toBeGreaterThan(shape.width);
  expect(shape.transform).toBe('none');

  // Nothing was committed by looking.
  const listing = await (await page.request.get(`${API}/inbox`)).json();
  expect(listing.submissions).toHaveLength(1);
});

test('offers Show all while more than one part is still hidden', async ({ page }) => {
  await submit(page, { subject: 'Beach day', withLogo: true });
  await page.goto(`${BASE}/inbox`);

  const showAll = page.getByRole('button', { name: /^Show all/ });
  await expect(showAll).toHaveText('Show all 2 photos');
  await showAll.click();

  await expect(page.locator('img.inbox__thumb--decoded')).toHaveCount(2, {
    timeout: 120_000,
  });
  // Nothing left hidden, so the control retires itself.
  await expect(showAll).toHaveCount(0);
});

test('adds the ticked photo with the edited caption, and empties the inbox', async ({
  page,
}) => {
  // The crafted JPEG rather than the HEIC, and deliberately: it carries no
  // capture date, so the photograph lands in **Undated**, a group the fixture
  // catalog already has. The HEIC's own date is 2023 and committing it would
  // raise a year heading that exists for a second and then does not, under
  // other spec files measuring heading positions in parallel.
  await page.request.post(DEV_INBOX, {
    multipart: {
      from: SENDER,
      subject: '4 images',
      body: 'Here they are',
      file0: {
        name: 'IMG_4021.JPG',
        mimeType: 'application/octet-stream',
        buffer: JPEG_WITH_THUMBNAIL,
      },
      file1: {
        name: 'signature-logo.png',
        mimeType: 'image/png',
        buffer: LOGO_PNG,
      },
    },
  });
  await page.goto(`${BASE}/inbox`);

  // A mail client's default subject proposes nothing; the body's first line is
  // the fallback, and the administrator corrects it either way.
  const caption = page.getByLabel('Caption');
  await expect(caption).toHaveValue('Here they are');
  await caption.fill('Sent in by post');

  // Both rows start unticked here — the crafted JPEG is small enough to look
  // like a logo — so ticking one is the administrator's own correction, which
  // is exactly what the default is there to invite.
  await page
    .locator('.inbox__part')
    .filter({ hasText: 'IMG_4021.JPG' })
    .getByRole('checkbox')
    .check();

  await page.getByRole('button', { name: 'Add 1 photo' }).click();

  // The whole pipeline runs here: decode, orient, convert, resize, encode.
  await expect(card(page)).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByRole('link', { name: /^Inbox/ })).toHaveText('Inbox (0)');
  await expect(page.locator('.state--empty')).toContainText('Nothing is waiting.');

  // The raw parts are gone from the store: the fake presigned GET 404s.
  const listing = await (await page.request.get(`${API}/inbox`)).json();
  expect(listing.submissions).toEqual([]);

  // In the library, indistinguishable from a dropped file — and carrying the
  // caption that was typed here rather than the subject line that proposed it.
  const timeline = await (await page.request.get(`${API}/timeline`)).json();
  const added = timeline.recent[0];
  expect(added.count).toBe(1);
  const photos = [
    ...timeline.years.flatMap((year: { months: { days: { photos: unknown[] }[] }[] }) =>
      year.months.flatMap((month) => month.days.flatMap((day) => day.photos)),
    ),
    ...timeline.undated.photos,
  ] as { id: string; caption: string | null }[];
  const committed = photos.find((photo) => photo.id === added.photoIds[0]);
  expect(committed?.caption).toBe('Sent in by post');
  // The projection is a whitelist: an address id never reaches a viewer.
  expect(JSON.stringify(committed)).not.toContain('submittedBy');

  // The admin's own photo view says who sent it — resolved to an address on
  // the server, so the browser never holds an address id either.
  await page.goto(`${BASE}/photo/${added.photoIds[0]}`);
  await page.getByRole('button', { name: 'Photo info' }).click();
  const info = page.locator('.photo-info');
  await expect(info).toContainText('Emailed by');
  await expect(info).toContainText(SENDER);

  // The catalog is shared process state, and other specs count what is in it.
  await removeFromLibrary(page, added.photoIds[0]);
});

test('discards a submission without committing anything', async ({ page }) => {
  await submit(page, { subject: 'Not for the site' });
  await page.goto(`${BASE}/inbox`);

  await page.getByRole('button', { name: 'Discard' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(SENDER);
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click();

  await expect(card(page)).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Inbox/ })).toHaveText('Inbox (0)');
});

test('says so when another tab holds the claim', async ({ page, context }) => {
  const submissionId = await submit(page, { subject: 'Beach day' });

  // The other tab takes the claim first, through the same route the page uses.
  await page.request.post(`${API}/inbox/claim`, {
    data: { submissionId, claimToken: 'the-other-tabs-token' },
  });

  const second = await context.newPage();
  await second.goto(`${BASE}/inbox`);

  await expect(second.locator('.inbox__claimed')).toContainText(
    'Being added in another tab',
  );
  // Its controls stand down, and a fresh claim is not offered: the other tab
  // is working right now.
  await expect(second.getByRole('button', { name: /^Add/ })).toBeDisabled();
  await expect(second.getByRole('button', { name: 'Take over' })).toHaveCount(0);

  await second.close();
  // Cleanup runs with a different token, so release the claim first by
  // discarding through the one that holds it.
  await page.request.post(`${API}/inbox/discard`, {
    data: { submissionId, claimToken: 'the-other-tabs-token' },
  });
});

test('is a 404 under the display path', async ({ page }) => {
  // `inbox` is admin vocabulary. The viewer's parser is never given it, so the
  // page cannot exist there — nor can its code be in that bundle.
  await page.goto('http://localhost:5173/dev-display-path/inbox');
  await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
});
