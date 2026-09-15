import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { FIXTURE_PHOTO_IDS, FIXTURE_UPLOADER_TOKEN } from '../../fixtures/catalog.ts';

/**
 * The family app on a phone: responsive on current mobile Safari/Chrome, and
 * able to add photographs, which is what the family does from a phone
 * (family-tier.md). The admin's selection is laptop-oriented and deliberately
 * not covered here.
 */

const BASE = '/dev-display-path';

function overflows(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
}

test('the timeline fits the viewport without horizontal scrolling', async ({
  page,
}) => {
  await page.goto(`${BASE}/2026/08/02`);
  await expect(page.locator('#d-2026-08-02 .photo-grid__item')).toHaveCount(6);

  expect(await overflows(page)).toBe(false);
});

test('a deep URL still lands on its section at phone width', async ({ page }) => {
  await page.goto(`${BASE}/2025/12/25`);

  const day = page.locator('#d-2025-12-25');
  const onScreen = await day.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.top >= 0 && box.top < window.innerHeight;
  });
  expect(onScreen).toBe(true);
});

test('the photo view puts its controls below the photo, not over it', async ({
  page,
}) => {
  // This spec also runs under the two desktop projects, which get the corner
  // layout instead; that one is asserted in display.spec.ts.
  test.skip(
    (page.viewportSize()?.width ?? 0) >= 640,
    'the stacked layout is below the 40rem breakpoint',
  );

  await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['beach-early']}`);

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // Touch targets stay reachable at phone width.
  const next = page.getByRole('button', { name: 'Next photo' });
  const box = await next.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);

  // Held upright, previous and next sit together right under the picture,
  // centred beneath it and well apart for a thumb, so the picture can take the
  // whole width.
  const back = (await page.locator('.lightbox__back').boundingBox())!;
  const image = (await page.locator('.lightbox__image').boundingBox())!;
  const previous = (await page
    .getByRole('button', { name: 'Previous photo' })
    .boundingBox())!;
  const nextBox = box!;
  expect(previous.y).toBeGreaterThanOrEqual(image.y + image.height - 1);
  expect(previous.y - (image.y + image.height)).toBeLessThan(24);
  expect(Math.abs(previous.y - nextBox.y)).toBeLessThan(2);
  expect(nextBox.x - (previous.x + previous.width)).toBeGreaterThanOrEqual(48);
  const pairMiddle = (previous.x + nextBox.x + nextBox.width) / 2;
  expect(Math.abs(pairMiddle - (image.x + image.width / 2))).toBeLessThan(2);
  // This photograph is portrait, so it needs the height: it reaches up to
  // just under the way back.
  expect(image.y - (back.y + back.height)).toBeLessThanOrEqual(12);

  // Download and Photo info sit side by side in a footer row under the arrows
  // rather than floating over a photo that spans the whole width of the screen.
  const download = (await page
    .getByRole('button', { name: 'Download', exact: true })
    .boundingBox())!;
  const info = (await page.getByRole('button', { name: 'Photo info' }).boundingBox())!;

  expect(download.y).toBeGreaterThanOrEqual(nextBox.y + nextBox.height - 1);
  expect(Math.abs(download.y - info.y)).toBeLessThan(2);
  expect(info.x).toBeGreaterThan(download.x);
  // Not a photograph this browser added, so nothing to edit or delete.
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);

  await next.click();
  await expect(dialog).toBeVisible();
  expect(await overflows(page)).toBe(false);
});

/**
 * Held sideways a phone's picture is bound by the screen's height, so a line of
 * arrows under it would make it smaller: they stay beside it, even on a phone
 * still narrower than 40rem (decisions.md #98).
 */
test('a phone held sideways keeps the arrows beside the photo', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 340 });
  await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['beach-early']}`);
  await expect(page.locator('.lightbox__image')).toBeVisible();

  const image = (await page.locator('.lightbox__image').boundingBox())!;
  const previous = (await page
    .getByRole('button', { name: 'Previous photo' })
    .boundingBox())!;
  const next = (await page.getByRole('button', { name: 'Next photo' }).boundingBox())!;

  expect(previous.x + previous.width).toBeLessThanOrEqual(image.x + 1);
  expect(next.x).toBeGreaterThanOrEqual(image.x + image.width - 1);
  expect(Math.abs(previous.y - next.y)).toBeLessThan(2);
});

/** Open a portrait photograph this browser added, so it has Edit. */
async function openOwned(page: Page) {
  const id = FIXTURE_PHOTO_IDS['scratch-0-b']!;
  await page.addInitScript(
    ({ token, ids }) => {
      window.localStorage.setItem('photo-uploader-token', token);
      window.localStorage.setItem('photo-uploaded-ids', JSON.stringify(ids));
    },
    { token: FIXTURE_UPLOADER_TOKEN, ids: [id] },
  );
  await page.goto(`${BASE}/photo/${id}`);
  await expect(page.locator('.lightbox__image')).toBeVisible();
}

/** The picture's own height, inside the img element's `object-fit: contain` box. */
function pictureHeight(page: Page) {
  return page.locator('.lightbox__image').evaluate((node) => {
    const img = node as HTMLImageElement;
    const box = img.getBoundingClientRect();
    const ratio =
      Number(img.getAttribute('width')) / Number(img.getAttribute('height'));
    return Math.min(box.height, box.width / ratio);
  });
}

/**
 * The point of opening to read (read-first-photo-view.md): on a phone the form
 * takes its height straight out of the picture's, so the picture is bigger
 * without it.
 */
test('the picture is taller in the read view than in the edit view', async ({
  page,
}) => {
  test.skip(
    (page.viewportSize()?.width ?? 0) >= 640,
    'the stacked layout is below the 40rem breakpoint',
  );

  await openOwned(page);
  const reading = await pictureHeight(page);

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('.edit-form')).toBeVisible();
  const editing = await pictureHeight(page);

  expect(reading).toBeGreaterThan(editing);
});

test('opening Edit focuses no field, so no keyboard comes up over the form', async ({
  page,
}) => {
  await openOwned(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('.edit-form')).toBeVisible();

  const focused = await page.evaluate(() => document.activeElement?.tagName ?? '');
  expect(['INPUT', 'TEXTAREA', 'BODY']).not.toContain(focused);
});

/**
 * Typing must not move the form. "Unsaved changes" appears with the first
 * keystroke, and it once widened the stack sideways and, by taking a line of
 * its own, lifted the bottom-anchored form. Runs at both layouts: the phone's
 * column under the picture, and the desktop projects' gutter beside it.
 */
test('the edit form stays where it is while it is typed in', async ({ page }) => {
  await openOwned(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const form = page.locator('.edit-form');
  await expect(form).toBeVisible();
  const before = (await form.boundingBox())!;

  await page
    .getByRole('textbox', { name: 'Caption', exact: true })
    .fill('A caption long enough to be worth typing, and then some more of it.');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  const after = (await form.boundingBox())!;

  expect(Math.abs(after.x - before.x)).toBeLessThan(1);
  expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  expect(Math.abs(after.width - before.width)).toBeLessThan(1);
  expect(Math.abs(after.height - before.height)).toBeLessThan(1);
});

test('closing the photo view returns to its tile at phone width', async ({ page }) => {
  const id = FIXTURE_PHOTO_IDS['snowdrops']!;
  await page.goto(`${BASE}/photo/${id}`);
  await page.getByRole('link', { name: /Lightbox/ }).click();

  await expect(page).toHaveURL(`${BASE}/2026/03/01`);
  const inView = await page.locator(`#photo-${id}`).evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.top >= 0 && box.top < window.innerHeight;
  });
  expect(inView).toBe(true);
});

/**
 * The recent view at phone width, where its heading and subtitle are in normal
 * flow rather than pinned — the subtitle is prose of no fixed length, so a
 * fixed-height band would clip it exactly where the screen is narrowest.
 * Nothing is above a tile, so nothing may be subtracted when scrolling to one.
 */
test('the recent view fits the viewport and closes to its tile', async ({ page }) => {
  await page.goto(`${BASE}/recent`);
  await expect(page.locator('.recent__group')).toHaveCount(1);
  expect(await overflows(page)).toBe(false);

  // The subtitle wraps rather than being cut off.
  const subtitle = page.locator('.recent__subtitle');
  await expect(subtitle).toContainText('and 2 undated');
  const clipped = await subtitle.evaluate(
    (node) => node.scrollHeight > node.clientHeight + 1,
  );
  expect(clipped).toBe(false);

  const tiles = page.locator('.photo-grid__item .photo-grid__link');
  const href = (await tiles.nth(4).getAttribute('href'))!;
  const id = href.split('/').pop()!;

  await page.goto(href);
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await overflows(page)).toBe(false);

  await page.getByRole('link', { name: /Lightbox/ }).click();
  await expect(page).toHaveURL(`${BASE}/recent`);
  const inView = await page.locator(`#photo-${id}`).evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.top >= 0 && box.top < window.innerHeight;
  });
  expect(inView).toBe(true);
});

/**
 * One element, one input; only the words follow the 40rem breakpoint
 * (family-tier.md #13). At phone width there is nothing to drop from.
 */
test("the add bar's words follow the breakpoint, and it opens the picker", async ({
  page,
}) => {
  await page.goto(`${BASE}/`);

  const bar = page.getByRole('button', { name: /Add photos/ });
  await expect(bar).toBeVisible();

  const narrow = (page.viewportSize()?.width ?? 0) < 640;
  const shown = page.locator(
    narrow ? '.drop-target__headline--narrow' : '.drop-target__headline--wide',
  );
  const hidden = page.locator(
    narrow ? '.drop-target__headline--wide' : '.drop-target__headline--narrow',
  );
  await expect(shown).toBeVisible();
  await expect(shown).toHaveText(narrow ? 'Add photos' : 'Drop photos here');
  await expect(hidden).toBeHidden();

  const chooser = page.waitForEvent('filechooser');
  await bar.click();
  expect((await chooser).isMultiple()).toBe(true);
  expect(await overflows(page)).toBe(false);
});

test('the trash fits the viewport', async ({ page }) => {
  // The family's trash lists only what this browser added
  // (family-own-trash.md #6), so this browser is the one that added the two
  // trashed scratch-day photographs.
  await page.addInitScript((token) => {
    window.localStorage.setItem('photo-uploader-token', token);
  }, FIXTURE_UPLOADER_TOKEN);
  await page.goto(`${BASE}/trash`);
  await expect(page.locator('.trash__intro')).toBeVisible();
  await expect(page.locator('.photo-grid__item')).toHaveCount(2);
  expect(await overflows(page)).toBe(false);
});

/**
 * decisions.md #91. A phone's page is killed processing a 48 MP photograph, so
 * a phone refuses one before the decode and says where it will work.
 *
 * Only the header is read before the refusal, so a PNG signature and an IHDR
 * claiming 8064 × 6048 is a whole test file: nothing reaches the decoder, and
 * nothing reaches the server.
 */
test('a photo too large for a phone is refused on its tile, saying where it will work', async ({
  page,
}) => {
  test.skip(
    test.info().project.name !== 'mobile-safari',
    'the limit applies to phones',
  );

  await page.goto(`${BASE}/`);

  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(8064, 16);
  header.writeUInt32BE(6048, 20);
  header[24] = 8;
  header[25] = 2;

  await page.locator('.drop-target__input').setInputFiles({
    name: 'too-big.png',
    mimeType: 'image/png',
    buffer: header,
  });

  const tile = page
    .locator('.upload__pending .photo-grid__item')
    .filter({ hasText: 'too-big.png' });
  await expect(tile).toContainText('Failed');
  await expect(tile).toContainText(
    'This photo is 48.8 MP, too large to add from a phone. It will work if you ' +
      'add it from a laptop, or email it in (ask the site admin how).',
  );

  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(tile).toHaveCount(0);
});
