import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { FIXTURE_PHOTO_IDS } from '../../fixtures/catalog.ts';

/**
 * The viewer is responsive on current mobile Safari/Chrome. Admin workflows
 * are laptop-oriented and are deliberately not covered here.
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

  // The two buttons sit side by side in a footer row under the image rather
  // than floating over a photo that spans the whole width of the screen.
  const image = (await page.locator('.lightbox__image').boundingBox())!;
  const download = (await page
    .getByRole('button', { name: 'Download', exact: true })
    .boundingBox())!;
  const info = (await page.getByRole('button', { name: 'Photo info' }).boundingBox())!;

  expect(download.y).toBeGreaterThanOrEqual(image.y + image.height - 1);
  expect(Math.abs(download.y - info.y)).toBeLessThan(2);
  expect(info.x).toBeGreaterThan(download.x);

  await next.click();
  await expect(dialog).toBeVisible();
  expect(await overflows(page)).toBe(false);
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
