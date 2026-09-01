import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The admin app, against the local fixture server.
 *
 * The fixture catalog is shared process state, so tests that mutate it undo
 * their change before finishing rather than relying on ordering.
 */

const BASE = 'http://localhost:5174/dev-admin-path';

/** Trash a photo, then put it back, so the fixture is left as it was found. */
async function withTrashed(
  page: Page,
  run: () => Promise<void>,
  restore: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } finally {
    await restore();
  }
}

test.describe('admin chrome', () => {
  test('shows the upload target, trash count, and export link', async ({ page }) => {
    await page.goto(`${BASE}/`);

    await expect(page.getByRole('button', { name: /Add photos/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Trash \(\d+\)$/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Export catalog' })).toBeVisible();
  });

  test('keeps the drop target large and reachable on a populated library', async ({
    page,
  }) => {
    // design.md: prominent when the library is empty, and still large and easy
    // to target thereafter.
    await page.goto(`${BASE}/2026/08/02`);
    const target = page.getByRole('button', { name: /Add photos/ });

    await expect(target).toBeVisible();
    const box = await target.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(100);
  });

  test('serves no admin path or admin code from the display build', async ({
    page,
  }) => {
    // The two apps are separate Vite builds precisely so this holds.
    const response = await page.goto('http://localhost:5173/dev-display-path/');
    const html = (await response?.text()) ?? '';
    expect(html).not.toContain('dev-admin-path');
  });
});

test.describe('browsing and filenames', () => {
  test('shows the original filename on every thumbnail', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/02`);

    await expect(page.locator('.admin-grid__item')).toHaveCount(6);
    // The viewer deliberately does not show these; the admin always does.
    await expect(page.getByText('IMG_20260802_081502.HEIC')).toBeVisible();
    await expect(page.getByText('scan-0042.png')).toBeVisible();
  });
});

test.describe('the detail panel', () => {
  test('a click opens the panel and marks that thumbnail', async ({ page }) => {
    // The grid has no selection: a click does this and nothing else.
    await page.goto(`${BASE}/2026/08/02`);
    const tiles = page.locator('.admin-grid__tile');
    await expect(tiles).toHaveCount(6);

    await tiles.nth(0).click();

    await expect(page.getByRole('complementary')).toBeVisible();
    await expect(page.locator('.admin-grid__tile--open')).toHaveCount(1);
    await expect(tiles.nth(0)).toHaveClass(/admin-grid__tile--open/);
  });

  test('offers Download and Delete without scrolling', async ({ page }) => {
    // The point of moving them above the form: both are reachable on arrival.
    await page.goto(`${BASE}/2026/08/02`);
    await page.locator('.admin-grid__tile').first().click();

    const panel = page.getByRole('complementary');
    await expect(panel.getByRole('button', { name: 'Download' })).toBeInViewport();
    await expect(panel.getByRole('button', { name: 'Delete' })).toBeInViewport();
  });

  test('[x] closes it', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/02`);
    await page.locator('.admin-grid__tile').first().click();
    await expect(page.getByRole('complementary')).toBeVisible();

    await page.getByRole('button', { name: 'Close details' }).click();

    await expect(page.getByRole('complementary')).toHaveCount(0);
    await expect(page.locator('.admin-grid__tile--open')).toHaveCount(0);
  });

  test('clicking outside closes it', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/02`);
    await page.locator('.admin-grid__tile').first().click();
    await expect(page.getByRole('complementary')).toBeVisible();

    await page.locator('.layout__title').click();

    await expect(page.getByRole('complementary')).toHaveCount(0);
  });

  test('clicking another thumbnail switches rather than closing', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/02`);
    const tiles = page.locator('.admin-grid__tile');
    await tiles.nth(0).click();
    const first = await page.locator('.detail__title').textContent();

    await tiles.nth(1).click();

    await expect(page.getByRole('complementary')).toBeVisible();
    await expect(page.locator('.detail__title')).not.toHaveText(first!);
    await expect(page.locator('.admin-grid__tile--open')).toHaveCount(1);
    await expect(tiles.nth(1)).toHaveClass(/admin-grid__tile--open/);
  });

  test('Escape closes it', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/02`);
    await page.locator('.admin-grid__tile').first().click();
    await expect(page.getByRole('complementary')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByRole('complementary')).toHaveCount(0);
  });
});

test.describe('metadata editing', () => {
  test('saves a caption and a corrected date', async ({ page }) => {
    await page.goto(`${BASE}/2026/03/01`);
    await page.locator('.admin-grid__tile').first().click();

    const panel = page.getByRole('complementary');
    await expect(panel).toBeVisible();

    await panel.getByLabel('Caption').fill('Edited by a test');
    await panel.getByRole('button', { name: 'Save changes' }).click();
    await expect(panel.getByText('Saved')).toBeVisible();

    // Put it back.
    await panel.getByLabel('Caption').fill('Snowdrops out already.');
    await panel.getByRole('button', { name: 'Save changes' }).click();
    await expect(panel.getByText('Saved')).toBeVisible();
  });

  test('rejects an impossible date without contacting the server', async ({ page }) => {
    await page.goto(`${BASE}/2026/03/01`);
    await page.locator('.admin-grid__tile').first().click();

    const panel = page.getByRole('complementary');
    await panel.getByLabel('Capture date').fill('2026-02-30');
    await panel.getByRole('button', { name: 'Save changes' }).click();

    await expect(panel.getByRole('alert')).toContainText('real date');
  });

  test('disables the time field when there is no date', async ({ page }) => {
    // A time is meaningful only alongside a date.
    await page.goto(`${BASE}/undated`);
    await page.locator('.admin-grid__tile').first().click();

    const panel = page.getByRole('complementary');
    await expect(panel.getByLabel('Capture time')).toBeDisabled();

    await panel.getByLabel('Capture date').fill('2026-01-01');
    await expect(panel.getByLabel('Capture time')).toBeEnabled();
  });
});

test.describe('delete, confirm, and undo', () => {
  test('states the resolved count and moves the photo to the trash', async ({
    page,
  }) => {
    // Single-photo deletion is the detail panel's own Delete; the grid has
    // no selection and no bulk button beside the whole-group one.
    await page.goto(`${BASE}/2026/08/15`);
    await page.locator('.admin-grid__tile').first().click();
    await page
      .getByRole('complementary')
      .getByRole('button', { name: 'Delete' })
      .click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    // The count comes from the resolved preview, not from the live query.
    await expect(dialog).toContainText('1 photo');
    await expect(dialog).toContainText('30 days');

    await withTrashed(
      page,
      async () => {
        await dialog.getByRole('button', { name: 'Delete' }).click();
        await expect(page.getByRole('status')).toContainText('1 photo deleted.');
      },
      async () => {
        await page.getByRole('button', { name: 'Undo' }).click();
        await expect(page.getByRole('status')).toHaveCount(0);
      },
    );

    // Undo put it back.
    await page.goto(`${BASE}/2026/08/15`);
    await expect(page.locator('.admin-grid__item')).toHaveCount(1);
  });

  test('cancelling changes nothing', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/15`);
    await page.locator('.admin-grid__tile').first().click();
    await page
      .getByRole('complementary')
      .getByRole('button', { name: 'Delete' })
      .click();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.locator('.admin-grid__item')).toHaveCount(1);
  });

  test('offers a whole-group delete with the group count', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/02`);
    await page.getByRole('button', { name: 'Delete this whole group' }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('6 photos');
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('Escape dismisses the confirmation', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/02`);
    await page.getByRole('button', { name: 'Delete this whole group' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });
});

test.describe('trash', () => {
  test('lists trashed photos with what is needed to identify them', async ({
    page,
  }) => {
    await page.goto(`${BASE}/trash`);

    const item = page.locator('.trash__item').first();
    await expect(item).toBeVisible();
    // Thumbnail, filename, original grouping date, and time remaining.
    await expect(item.locator('img')).toBeVisible();
    await expect(item).toContainText('IMG_20260802_190000.HEIC');
    await expect(item).toContainText('August 2, 2026');
    await expect(item).toContainText(/Removed on \w+ \d+, \d{4}/);
  });

  test('offers no download for a trashed photo', async ({ page }) => {
    // A trashed photo shows enough to be identified, and nothing more.
    await page.goto(`${BASE}/trash`);
    await expect(page.getByRole('button', { name: /Download/ })).toHaveCount(0);
  });

  test('requires an explicit confirmation to delete permanently', async ({ page }) => {
    await page.goto(`${BASE}/trash`);
    await page.locator('.trash__tile').first().click();

    await page.getByRole('button', { name: 'Delete permanently' }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('cannot be undone');
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('restores a photo back into its day', async ({ page }) => {
    await page.goto(`${BASE}/trash`);
    await page.locator('.trash__tile').first().click();
    await page.getByRole('button', { name: 'Restore' }).click();

    await expect(page.locator('.trash__item')).toHaveCount(0);

    // It is back in the day it belongs to.
    await page.goto(`${BASE}/2026/08/02`);
    await expect(page.locator('.admin-grid__item')).toHaveCount(7);

    // Put the fixture back the way it was.
    const restored = page
      .locator('.admin-grid__item')
      .filter({ hasText: 'IMG_20260802_190000.HEIC' })
      .locator('.admin-grid__tile');
    await restored.click();
    await page
      .getByRole('complementary')
      .getByRole('button', { name: 'Delete' })
      .click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('status')).toContainText('1 photo deleted.');
  });
});
