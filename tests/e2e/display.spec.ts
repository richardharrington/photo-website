import { test, expect } from '@playwright/test';
import { FIXTURE_PHOTO_IDS } from '../../fixtures/catalog.ts';

const BASE = '/dev-display-path';

test.describe('browsing the hierarchy', () => {
  test('navigates year to month to day to photo', async ({ page }) => {
    await page.goto(`${BASE}/`);

    await expect(page.getByRole('heading', { name: 'Family Photos' })).toBeVisible();
    // Newest year first.
    const groups = page.locator('.group-list__link');
    await expect(groups.first()).toContainText('2026');

    await page.getByRole('link', { name: /^2026/ }).click();
    await expect(page).toHaveURL(`${BASE}/2026`);
    await expect(page.getByRole('heading', { name: '2026' })).toBeVisible();

    await page.getByRole('link', { name: /^August/ }).click();
    await expect(page).toHaveURL(`${BASE}/2026/08`);
    await expect(page.getByRole('heading', { name: 'August 2026' })).toBeVisible();

    await page.getByRole('link', { name: /^August 2, 2026/ }).click();
    await expect(page).toHaveURL(`${BASE}/2026/08/02`);

    const thumbnails = page.locator('.photo-grid__item');
    await expect(thumbnails).toHaveCount(6);
  });

  test('shows counts on index pages and no photos', async ({ page }) => {
    await page.goto(`${BASE}/2026/08`);

    await expect(page.getByText('6 photos')).toBeVisible();
    await expect(page.getByText('1 photo', { exact: true })).toBeVisible();
    // Index pages never carry representative thumbnails.
    await expect(page.locator('.photo-grid')).toHaveCount(0);
  });

  test('lists Undated alongside the years', async ({ page }) => {
    await page.goto(`${BASE}/`);
    await page.getByRole('link', { name: /^Undated/ }).click();

    await expect(page).toHaveURL(`${BASE}/undated`);
    await expect(page.locator('.photo-grid__item')).toHaveCount(2);
  });
});

test.describe('the lightbox', () => {
  test('opens a photo, navigates within the day, and closes', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/02`);
    await page.locator('.photo-grid__link').first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('1 of 6');
    await expect(dialog).toContainText('First one down to the beach.');

    // Previous is unavailable at the start of the group; navigation does not
    // wrap around.
    await expect(page.getByRole('button', { name: 'Previous photo' })).toBeDisabled();

    await page.getByRole('button', { name: 'Next photo' }).click();
    await expect(dialog).toContainText('2 of 6');

    await page.getByRole('link', { name: /Back to August 2, 2026/ }).click();
    await expect(page).toHaveURL(`${BASE}/2026/08/02`);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('is keyboard navigable', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/02`);
    await page.locator('.photo-grid__link').first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('1 of 6');

    await page.keyboard.press('ArrowRight');
    await expect(dialog).toContainText('2 of 6');

    await page.keyboard.press('ArrowRight');
    await expect(dialog).toContainText('3 of 6');

    await page.keyboard.press('ArrowLeft');
    await expect(dialog).toContainText('2 of 6');

    // Consecutive presses with no wait between them: each must advance one
    // photo. Deriving neighbours from an in-flight detail response made a
    // fast second press navigate to the photo already shown, so holding the
    // key moved one step and stopped.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(dialog).toContainText('5 of 6');

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(`${BASE}/2026/08/02`);
  });

  test('opens directly from a deep link and shows its group behind it', async ({
    page,
  }) => {
    // A photo URL carries no date, so it survives a capture-date correction.
    await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['market']}`);

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Saturday market.');
    await expect(dialog).toContainText('August 15, 2026');
    await expect(dialog).toContainText('1 of 1');

    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(`${BASE}/2026/08/15`);
    await expect(page.locator('.photo-grid__item')).toHaveCount(1);
  });

  test('shows the filename only in the photo information view', async ({ page }) => {
    await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['market']}`);

    await expect(page.getByText('IMG_20260815_100500.HEIC')).toHaveCount(0);

    await page.getByRole('button', { name: 'Photo information' }).click();
    await expect(page.getByText('IMG_20260815_100500.HEIC')).toBeVisible();
  });

  test('preserves line breaks in a caption without interpreting markup', async ({
    page,
  }) => {
    await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['beach-scan']}`);

    const caption = page.locator('.lightbox__caption');
    await expect(caption).toContainText('Scanned from a print.');
    await expect(caption).toContainText('Nobody remembers who took it.');
  });
});

test.describe('ordering', () => {
  test('places timed photos in clock order, then date-only photos', async ({
    page,
  }) => {
    await page.goto(`${BASE}/2026/08/02`);

    await expect(page.locator('.photo-grid__item')).toHaveCount(6);
    const alts = await page
      .locator('.photo-grid__image')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLImageElement).alt));

    expect(alts[0]).toBe('First one down to the beach.');
    expect(alts[3]).toBe('Low tide, everyone finally out of the water.');
    // The two date-only scans come last, in upload order.
    expect(alts[4]).toBe('Scanned from a print.\n\nNobody remembers who took it.');
    expect(alts[5]).toBe('Photo from August 2, 2026');
  });
});

test.describe('trashed and unknown resources', () => {
  test('a trashed photo is a generic 404, not a tombstone', async ({ page }) => {
    await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['deleted']}`);

    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
    // Nothing hints that this ID ever existed.
    await expect(page.getByText(/deleted|trash|removed/i)).toHaveCount(0);
  });

  test('an unknown photo ID looks exactly the same', async ({ page }) => {
    await page.goto(`${BASE}/photo/${'f'.repeat(32)}`);
    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
  });

  test('a malformed route 404s rather than showing an empty group', async ({
    page,
  }) => {
    for (const path of [
      `${BASE}/2026/13`,
      `${BASE}/2026/02/30`,
      `${BASE}/photo/not-a-valid-id`,
      `${BASE}/undated/extra`,
    ]) {
      await page.goto(path);
      await expect(
        page.getByRole('heading', { name: 'Not found' }),
        path,
      ).toBeVisible();
    }
  });

  test('a real but empty day 404s', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/03`);
    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
  });
});

test.describe('images', () => {
  test('requests thumbnails in the grid and larger renditions in the lightbox', async ({
    page,
  }) => {
    const requested: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/p/')) requested.push(request.url());
    });

    await page.goto(`${BASE}/2026/08/15`);
    // Poll rather than assert once: "visible" can resolve before the image
    // request has actually been issued and recorded.
    await expect.poll(() => requested.some((url) => url.endsWith('/thumb'))).toBe(true);
    // The grid asks for thumbnails only; larger renditions wait for a click.
    expect(requested.some((url) => url.includes('display-'))).toBe(false);

    await page.locator('.photo-grid__link').first().click();
    await expect(page.locator('.lightbox__image')).toBeVisible();
    await expect
      .poll(() => requested.some((url) => url.includes('display-')))
      .toBe(true);
  });

  test('never requests a trashed photo derivative', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (request) => requested.push(request.url()));

    await page.goto(`${BASE}/2026/08/02`);
    await expect(page.locator('.photo-grid__item')).toHaveCount(6);

    expect(requested.some((url) => url.includes(FIXTURE_PHOTO_IDS['deleted']!))).toBe(
      false,
    );
  });
});
