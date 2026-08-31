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

test.describe('selection', () => {
  test('modifier-click adds and removes photos', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/02`);
    const tiles = page.locator('.admin-grid__tile');
    await expect(tiles).toHaveCount(6);

    await tiles.nth(0).click({ modifiers: ['ControlOrMeta'] });
    await expect(page.getByText('1 selected')).toBeVisible();

    await tiles.nth(1).click({ modifiers: ['ControlOrMeta'] });
    await expect(page.getByText('2 selected')).toBeVisible();

    // Clicking again removes it.
    await tiles.nth(0).click({ modifiers: ['ControlOrMeta'] });
    await expect(page.getByText('1 selected')).toBeVisible();
  });

  test('a plain click opens the detail panel instead of selecting', async ({
    page,
  }) => {
    await page.goto(`${BASE}/2026/08/02`);
    await page.locator('.admin-grid__tile').first().click();

    await expect(page.getByRole('complementary')).toBeVisible();
    await expect(page.getByText('0 selected')).toBeVisible();
  });

  test('dragging on empty grid area marquee-selects', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/02`);
    await expect(page.locator('.admin-grid__tile')).toHaveCount(6);

    const grid = page.locator('.admin-grid');
    const box = (await grid.boundingBox())!;

    // Start below the tiles, in empty grid space, and drag up across them.
    await page.mouse.move(box.x + 4, box.y + box.height - 4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 20, { steps: 10 });
    await page.mouse.up();

    await expect(page.getByText(/[1-9]\d* selected/)).toBeVisible();
  });

  test('clicking empty grid area clears the selection', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/02`);
    const tiles = page.locator('.admin-grid__tile');
    await expect(tiles).toHaveCount(6);
    await tiles.nth(0).click({ modifiers: ['ControlOrMeta'] });
    await expect(page.getByText('1 selected')).toBeVisible();

    const box = (await page.locator('.admin-grid').boundingBox())!;
    await page.mouse.click(box.x + 4, box.y + box.height - 4);

    await expect(page.getByText('0 selected')).toBeVisible();
  });

  test('a drag too short to be a marquee selects nothing', async ({ page }) => {
    // Without a movement threshold, a click that wobbled by a pixel would
    // hit-test and select whatever happened to be under the cursor.
    await page.goto(`${BASE}/2026/08/02`);
    await expect(page.locator('.admin-grid__tile')).toHaveCount(6);

    const box = (await page.locator('.admin-grid').boundingBox())!;
    await page.mouse.move(box.x + 4, box.y + 4);
    await page.mouse.down();
    await page.mouse.move(box.x + 6, box.y + 5);
    await page.mouse.up();

    await expect(page.getByText('0 selected')).toBeVisible();
    await expect(page.locator('.admin-grid__tile--selected')).toHaveCount(0);
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
    await page.goto(`${BASE}/2026/08/15`);
    await page
      .locator('.admin-grid__tile')
      .first()
      .click({
        modifiers: ['ControlOrMeta'],
      });
    await expect(page.getByText('1 selected')).toBeVisible();

    await page.getByRole('button', { name: 'Delete selected' }).click();

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
    await page
      .locator('.admin-grid__tile')
      .first()
      .click({
        modifiers: ['ControlOrMeta'],
      });
    await page.getByRole('button', { name: 'Delete selected' }).click();

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
    await restored.click({ modifiers: ['ControlOrMeta'] });
    await page.getByRole('button', { name: 'Delete selected' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('status')).toContainText('1 photo deleted.');
  });
});
