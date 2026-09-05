import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The Recently Uploaded view, in the viewer.
 *
 * Every photograph in the fixture catalog was created at the same instant, so
 * the whole live library is one upload sitting here — which is all this file
 * needs. The set rule, the grouping, and the wording are unit-tested against
 * catalogs built for them; what is worth an actual browser is the round trip:
 * toggle over, open a photograph, arrow through the recent order, close, and
 * land back on the tile that was left.
 */

const BASE = '/dev-display-path';

/** True when the element's box is inside the viewport, top and bottom. */
async function isInViewport(selector: string, page: Page) {
  return page.locator(selector).evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.top >= 0 && box.top < window.innerHeight && box.bottom > 0;
  });
}

test.describe('the recent view', () => {
  test('is reached by the toggle, and offers the way back', async ({ page }) => {
    await page.goto(`${BASE}/`);

    // On the library, "All photos" is plain text and the other is a link.
    await expect(page.locator('.layout__nav [aria-current="page"]')).toHaveText(
      'All photos',
    );

    await page.getByRole('link', { name: /Recently added/ }).click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/recent$`));

    await expect(page.locator('.layout__nav [aria-current="page"]')).toHaveText(
      'Recently added',
    );
    await expect(page.getByRole('link', { name: 'All photos' })).toBeVisible();

    // Every live photograph, in one sitting: the fixture shares one createdAt.
    await expect(page.locator('.recent__group')).toHaveCount(1);
    await expect(page.locator('.recent__heading')).toContainText('18 photos');
    await expect(page.locator('.photo-grid__item')).toHaveCount(18);
  });

  test('names the capture span the sitting covers', async ({ page }) => {
    await page.goto(`${BASE}/recent`);
    // The fixture spans December 2025 to August 2026 and holds two undated.
    await expect(page.locator('.recent__subtitle')).toHaveText(
      'photographs from December 2025 – August 2026, and 2 undated',
    );
  });

  test('opens a photo, arrows in recent order, and closes to its tile', async ({
    page,
  }) => {
    await page.goto(`${BASE}/recent`);

    const tiles = page.locator('.photo-grid__item .photo-grid__link');
    const firstHref = await tiles.first().getAttribute('href');
    expect(firstHref).toContain('/recent/photo/');

    await tiles.first().click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/recent/photo/[0-9a-f]{32}$`));
    await expect(page.locator('.lightbox__image')).toBeVisible();

    // Two steps forward, staying inside the recent view the whole way.
    await page.getByLabel('Next photo').click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/recent/photo/`));
    await page.getByLabel('Next photo').click();
    const thirdUrl = page.url();
    const thirdId = thirdUrl.split('/').pop()!;

    // Closing returns to the recent view, scrolled to the tile just left.
    await page.getByRole('link', { name: /Lightbox/ }).click();
    await expect(page).toHaveURL(new RegExp(`${BASE}/recent$`));
    await expect(page.locator('.lightbox')).toHaveCount(0);
    expect(await isInViewport(`#photo-${thirdId}`, page)).toBe(true);
  });

  test('a link into the recent view survives a reload', async ({ page }) => {
    await page.goto(`${BASE}/recent`);
    const href = await page
      .locator('.photo-grid__item .photo-grid__link')
      .first()
      .getAttribute('href');

    await page.goto(href!);
    await expect(page.locator('.lightbox__image')).toBeVisible();
    // The recent view is underneath, not the timeline.
    await expect(page.locator('.recent__group')).toHaveCount(1);
  });

  test('marks the toggle until the recent view has been opened', async ({ page }) => {
    // A browser with nothing stored has seen nothing, so the marker is up.
    await page.goto(`${BASE}/`);
    await expect(page.locator('.view-toggle__marker')).toBeVisible();

    await page.getByRole('link', { name: /Recently added/ }).click();
    await expect(page.locator('.recent__group')).toHaveCount(1);

    // Cleared by the visit, and it stays cleared back on the library.
    await page.getByRole('link', { name: 'All photos' }).click();
    await expect(page.locator('.view-toggle__marker')).toHaveCount(0);

    // And across a reload, because it is remembered in this browser.
    await page.reload();
    await expect(page.locator('.timeline__year-heading').first()).toBeVisible();
    await expect(page.locator('.view-toggle__marker')).toHaveCount(0);
  });

  test('refuses anything else under /recent with the site 404', async ({ page }) => {
    await page.goto(`${BASE}/recent/2026`);
    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
  });
});
