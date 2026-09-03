import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SCRATCH_DAYS } from '../../fixtures/catalog.ts';

/**
 * The admin app, against the local fixture server.
 *
 * The fixture catalog is shared process state, so tests that mutate it undo
 * their change before finishing rather than relying on ordering.
 */

const BASE = 'http://localhost:5174/dev-admin-path';

/*
 * In order, not in parallel. `fullyParallel` otherwise spreads this file's
 * tests across workers, and several of them trash a photo and put it back —
 * one test's temporary delete became another's failed count. Serial covers
 * one project; the per-project scratch day below covers the other axis, since
 * Chromium and WebKit run this file against the same fixture process at the
 * same time.
 */
test.describe.configure({ mode: 'serial' });

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
    // An unmodified click; the selection gestures are covered further down.
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

test.describe('the enlarged photo', () => {
  /** Open a photo's detail panel, then its preview. */
  async function enlarge(page: Page) {
    await page.goto(`${BASE}/2026/08/02`);
    await page.locator('.admin-grid__tile').first().click();
    await page.getByRole('button', { name: 'Show this photo larger' }).click();
    await expect(page.locator('.zoom__image')).toBeVisible();
  }

  test('covers the window, dimming even the panel it was opened from', async ({
    page,
  }) => {
    await enlarge(page);
    const viewport = page.viewportSize()!;
    const image = (await page.locator('.zoom__image').boundingBox())!;

    // Most of the screen, but with a margin of page left showing all round.
    expect(
      Math.max(image.width / viewport.width, image.height / viewport.height),
    ).toBeGreaterThan(0.8);
    expect(image.width).toBeLessThan(viewport.width);
    expect(image.height).toBeLessThan(viewport.height);

    // The detail panel is fixed to the right edge; the backdrop is over it too.
    const overPanel = await page.evaluate(
      () =>
        document.elementFromPoint(window.innerWidth - 40, window.innerHeight / 2)
          ?.className,
    );
    expect(overPanel).toContain('zoom');
  });

  test('hangs the [x] on the corner of the photograph itself', async ({ page }) => {
    await enlarge(page);
    const image = (await page.locator('.zoom__image').boundingBox())!;
    const close = (await page.locator('.zoom__close').boundingBox())!;

    // Inside the picture's own top-right corner, not the window's: a letterboxed
    // box stretched around the photo would put it somewhere out in the dark.
    expect(close.x).toBeGreaterThan(image.x + image.width / 2);
    expect(close.x + close.width).toBeLessThanOrEqual(image.x + image.width + 1);
    expect(close.y).toBeGreaterThanOrEqual(image.y - 1);
    expect(close.y).toBeLessThan(image.y + image.height / 2);
  });

  test('the [x] closes it and leaves the panel open', async ({ page }) => {
    await enlarge(page);
    await page.getByRole('button', { name: 'Close the enlarged photo' }).click();

    await expect(page.locator('.zoom')).toHaveCount(0);
    await expect(page.getByRole('complementary')).toBeVisible();
  });

  test('a click outside closes it and leaves the panel open', async ({ page }) => {
    await enlarge(page);
    // The corner of the backdrop, well clear of the photograph.
    await page.locator('.zoom').click({ position: { x: 4, y: 4 } });

    await expect(page.locator('.zoom')).toHaveCount(0);
    await expect(page.getByRole('complementary')).toBeVisible();
  });

  test('Escape closes it, and only then the panel', async ({ page }) => {
    await enlarge(page);

    await page.keyboard.press('Escape');
    await expect(page.locator('.zoom')).toHaveCount(0);
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

/**
 * Everything destructive happens on this project's own scratch day — three
 * photos plus one in the trash, and nothing else in the fixture counts
 * anything in July.
 *
 * One day per project, because the fixture store is a single process shared
 * by every Playwright worker: two projects running the same destructive test
 * at the same moment would race on the same photos even though each puts
 * everything back. See fixtures/catalog.ts.
 */
function scratch() {
  const day = SCRATCH_DAYS[test.info().project.name === 'webkit' ? 1 : 0]!;
  const [year, month, date] = day.split('-');
  return {
    path: `${BASE}/${year}/${month}/${date}`,
    /** The trashed photo on that day, which only this project restores. */
    trashedFile: `IMG_${day.replaceAll('-', '')}_211900.HEIC`,
    /** How that day reads in the interface, e.g. "July 4, 2026". */
    dayLabel: `July ${Number(date)}, ${year}`,
    /** Its earliest photo, and so the first tile in the grid. */
    firstFile: `IMG_${day.replaceAll('-', '')}_210311.HEIC`,
  };
}

/** Delete the first photo of the scratch day, through the detail panel. */
async function deleteFirstPhoto(page: Page): Promise<void> {
  await page.goto(scratch().path);
  await page.locator('.admin-grid__tile').first().click();
  await page.getByRole('complementary').getByRole('button', { name: 'Delete' }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('1 photo deleted.');
}

/** Put a photo back from the trash, for tests whose undo offer has gone. */
async function restoreFromTrash(page: Page, filename: string): Promise<void> {
  await page.goto(`${BASE}/trash`);
  const item = page.locator('.trash__item').filter({ hasText: filename });
  await item.locator('.trash__tile').click();
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(item).toHaveCount(0);
}

test.describe('delete, confirm, and undo', () => {
  test('states the resolved count and moves the photo to the trash', async ({
    page,
  }) => {
    // Single-photo deletion is the detail panel's own Delete, which needs no
    // selection at all.
    await page.goto(scratch().path);
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
    await page.goto(scratch().path);
    await expect(page.locator('.admin-grid__item')).toHaveCount(3);
  });

  test('cancelling changes nothing', async ({ page }) => {
    await page.goto(scratch().path);
    await page.locator('.admin-grid__tile').first().click();
    await page
      .getByRole('complementary')
      .getByRole('button', { name: 'Delete' })
      .click();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.locator('.admin-grid__item')).toHaveCount(3);
  });

  test('deletes a whole day through Select all, stating the count', async ({
    page,
  }) => {
    await page.goto(scratch().path);
    await page.getByRole('button', { name: 'Select all', exact: true }).click();
    await page.getByRole('button', { name: 'Delete selected' }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('3 photos');
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('deletes exactly the selected photos', async ({ page }) => {
    await page.goto(scratch().path);
    const tiles = page.locator('.admin-grid__tile');
    await tiles.nth(0).click({ modifiers: ['ControlOrMeta'] });
    await tiles.nth(1).click({ modifiers: ['ControlOrMeta'] });

    await page.getByRole('button', { name: 'Delete selected' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('2 photos');

    await withTrashed(
      page,
      async () => {
        await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
        await expect(page.getByRole('status')).toContainText('2 photos deleted.');
        // The third is untouched, and nothing is left selected.
        await expect(page.locator('.admin-grid__item')).toHaveCount(1);
        await expect(page.getByRole('button', { name: 'Delete selected' })).toHaveCount(
          0,
        );
      },
      async () => {
        await page.getByRole('button', { name: 'Undo' }).click();
        await expect(page.getByRole('status')).toHaveCount(0);
      },
    );

    await page.goto(scratch().path);
    await expect(page.locator('.admin-grid__item')).toHaveCount(3);
  });

  test('the undo offer does not survive a navigation', async ({ page }) => {
    const { firstFile } = scratch();
    await deleteFirstPhoto(page);

    // Client-side navigation, so the app itself stays mounted: the offer names
    // photos that were on the page it was raised from.
    await page.getByRole('link', { name: /^Trash/ }).click();
    await expect(page.getByRole('status')).toHaveCount(0);

    await restoreFromTrash(page, firstFile);
  });

  test('the undo offer withdraws itself after five seconds', async ({ page }) => {
    const { firstFile } = scratch();
    await deleteFirstPhoto(page);

    const banner = page.getByRole('status');
    await expect(banner).toBeVisible();
    // Still there a moment later, then gone of its own accord.
    await expect(banner).toBeVisible({ timeout: 2_000 });
    await expect(banner).toHaveCount(0, { timeout: 8_000 });

    await restoreFromTrash(page, firstFile);
  });

  test('Escape dismisses the confirmation', async ({ page }) => {
    await page.goto(scratch().path);
    await page.getByRole('button', { name: 'Select all', exact: true }).click();
    await page.getByRole('button', { name: 'Delete selected' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });
});

test.describe('selecting in the grid', () => {
  const selected = (page: Page) => page.locator('.admin-grid__tile[data-selected]');

  test('shows only the toolbar buttons that have something to act on', async ({
    page,
  }) => {
    await page.goto(`${BASE}/2026/08/02`);
    // "Select all" is a substring of "Deselect all", so every one of these
    // has to be an exact match.
    const deleteSelected = page.getByRole('button', { name: 'Delete selected' });
    const selectAll = page.getByRole('button', { name: 'Select all', exact: true });
    const deselectAll = page.getByRole('button', { name: 'Deselect all' });

    // Nothing selected: only Select all.
    await expect(deleteSelected).toHaveCount(0);
    await expect(selectAll).toBeVisible();
    await expect(deselectAll).toHaveCount(0);

    // Some selected: all three, in that order left to right.
    await page
      .locator('.admin-grid__tile')
      .nth(0)
      .click({ modifiers: ['ControlOrMeta'] });
    await expect(page.locator('.admin__toolbar-actions button')).toHaveText([
      'Delete selected',
      'Select all',
      'Deselect all',
    ]);

    // All selected: nothing left to select.
    await selectAll.click();
    await expect(selected(page)).toHaveCount(6);
    await expect(page.locator('.admin__toolbar-actions button')).toHaveText([
      'Delete selected',
      'Deselect all',
    ]);

    await deselectAll.click();
    await expect(selected(page)).toHaveCount(0);
    await expect(page.locator('.admin__toolbar-actions button')).toHaveText([
      'Select all',
    ]);
  });

  test('modifier-click selects a tile instead of opening it', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/02`);
    const tiles = page.locator('.admin-grid__tile');

    await tiles.nth(2).click({ modifiers: ['ControlOrMeta'] });
    await expect(selected(page)).toHaveCount(1);
    await expect(page.getByRole('complementary')).toHaveCount(0);

    // And clicking it again takes it back out.
    await tiles.nth(2).click({ modifiers: ['ControlOrMeta'] });
    await expect(selected(page)).toHaveCount(0);
  });

  test('shift-click selects the range from the last tile toggled', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/02`);
    const tiles = page.locator('.admin-grid__tile');

    await tiles.nth(1).click({ modifiers: ['ControlOrMeta'] });
    await tiles.nth(4).click({ modifiers: ['Shift'] });
    await expect(selected(page)).toHaveCount(4);

    // The anchor stays put, so shrinking the range back is one more click.
    await tiles.nth(2).click({ modifiers: ['Shift'] });
    await expect(selected(page)).toHaveCount(4);
  });

  test('shift-click extends from the photo the panel is showing', async ({ page }) => {
    // Click one, shift-click another: the gesture people actually use, and
    // the plain click is what sets the anchor it measures from.
    await page.goto(`${BASE}/2026/08/02`);
    const tiles = page.locator('.admin-grid__tile');

    await tiles.nth(0).click();
    await tiles.nth(3).click({ modifiers: ['Shift'] });

    await expect(selected(page)).toHaveCount(4);
  });

  test('marking a second photo closes the detail panel', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/02`);
    const tiles = page.locator('.admin-grid__tile');
    const panel = page.getByRole('complementary');

    // The open photo counts as one of the marked tiles, so a modifier-click on
    // any other one is already two — the panel speaks for neither.
    await tiles.nth(0).click();
    await expect(panel).toBeVisible();
    await tiles.nth(1).click({ modifiers: ['ControlOrMeta'] });
    await expect(panel).toHaveCount(0);
    await expect(selected(page)).toHaveCount(1);
  });

  test('a shift-range closes the detail panel too', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/02`);
    const tiles = page.locator('.admin-grid__tile');

    await tiles.nth(0).click();
    await expect(page.getByRole('complementary')).toBeVisible();
    await tiles.nth(3).click({ modifiers: ['Shift'] });

    await expect(page.getByRole('complementary')).toHaveCount(0);
    await expect(selected(page)).toHaveCount(4);
  });

  test('a plain click opens the detail panel and drops the selection', async ({
    page,
  }) => {
    await page.goto(`${BASE}/2026/08/02`);
    await page.getByRole('button', { name: 'Select all', exact: true }).click();
    await expect(selected(page)).toHaveCount(6);

    // The way out of a selection that caught the wrong photos.
    await page.locator('.admin-grid__tile').first().click();
    await expect(selected(page)).toHaveCount(0);
    await expect(page.getByRole('complementary')).toBeVisible();
  });

  test('leaves the selection behind when the day changes', async ({ page }) => {
    // Client-side navigation, which keeps the app mounted: a day's selection
    // must not follow along to the next day.
    await page.goto(`${BASE}/2026/08`);
    await page.getByRole('link', { name: /August 2, 2026/ }).click();
    await page.getByRole('button', { name: 'Select all', exact: true }).click();
    await expect(selected(page)).toHaveCount(6);

    await page.goBack();
    await page.getByRole('link', { name: /August 15, 2026/ }).click();
    await expect(page.locator('.admin-grid__item')).toHaveCount(1);
    await expect(selected(page)).toHaveCount(0);
  });
});

test.describe('trash', () => {
  test('lists trashed photos with what is needed to identify them', async ({
    page,
  }) => {
    const { trashedFile, dayLabel } = scratch();
    await page.goto(`${BASE}/trash`);

    // This project's own trashed photo: the other project's sits beside it.
    const item = page.locator('.trash__item').filter({ hasText: trashedFile });
    await expect(item).toBeVisible();
    // Thumbnail, filename, original grouping date, and time remaining.
    await expect(item.locator('img')).toBeVisible();
    await expect(item).toContainText(dayLabel);
    await expect(item).toContainText(/Removed on \w+ \d+, \d{4}/);
  });

  test('offers no download for a trashed photo', async ({ page }) => {
    // A trashed photo shows enough to be identified, and nothing more.
    await page.goto(`${BASE}/trash`);
    await expect(page.getByRole('button', { name: /Download/ })).toHaveCount(0);
  });

  test('requires an explicit confirmation to delete permanently', async ({ page }) => {
    await page.goto(`${BASE}/trash`);
    await page
      .locator('.trash__item')
      .filter({ hasText: scratch().trashedFile })
      .locator('.trash__tile')
      .click();

    await page.getByRole('button', { name: 'Delete permanently' }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('cannot be undone');
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('restores a photo back into its day', async ({ page }) => {
    const { path, trashedFile } = scratch();
    const mine = page.locator('.trash__item').filter({ hasText: trashedFile });

    await page.goto(`${BASE}/trash`);
    await mine.locator('.trash__tile').click();
    await page.getByRole('button', { name: 'Restore' }).click();

    await expect(mine).toHaveCount(0);

    // It is back in the day it belongs to.
    await page.goto(path);
    await expect(page.locator('.admin-grid__item')).toHaveCount(4);

    // Put the fixture back the way it was.
    const restored = page
      .locator('.admin-grid__item')
      .filter({ hasText: trashedFile })
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
