import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { FIXTURE_PHOTO_IDS } from '../../fixtures/catalog.ts';
import { tinyPng } from '../../fixtures/tiny-png.ts';

const BASE = '/dev-display-path';

/** True when the element's box is inside the viewport, top and bottom. */
async function isInViewport(locator: Locator) {
  return locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.top >= 0 && box.top < window.innerHeight && box.bottom > 0;
  });
}

test.describe('the timeline', () => {
  test('shows years, months, days, and their photos on one page', async ({ page }) => {
    await page.goto(`${BASE}/`);

    await expect(page.getByRole('heading', { name: 'Family Photos' })).toBeVisible();

    // Newest first, with no click needed to reach any of it.
    await expect(page.locator('.timeline__year-heading')).toHaveText([
      /2026/,
      /2025/,
      /Undated/,
    ]);
    await expect(page.locator('.timeline__month-heading')).toHaveText([
      /August/,
      /July/,
      /March/,
      /December/,
    ]);
    await expect(page.locator('.timeline__day-heading')).toHaveText([
      /August 15/,
      /August 2/,
      /July 5/,
      /July 4/,
      /March 1/,
      /December 26/,
      /December 25/,
    ]);

    // Every live photo in the library is on the page: 18 of the 20 fixtures,
    // the other two being trashed.
    await expect(page.locator('.photo-grid__item')).toHaveCount(18);
  });

  test('counts the months and the years, but not the days', async ({ page }) => {
    await page.goto(`${BASE}/`);

    const august = page.locator('#m-2026-08 .timeline__month-heading');
    await expect(august).toContainText('7 photos');
    await expect(
      page.locator('#y-2026 .timeline__year-heading .timeline__count'),
    ).toHaveCount(1);

    // A day's photographs are all on screen beneath its heading, so the
    // number would only clutter the smallest heading of the three.
    await expect(page.locator('#d-2026-08-15 .timeline__count')).toHaveCount(0);
  });

  test('separates the three heading levels by size, and rules only the year', async ({
    page,
  }) => {
    await page.goto(`${BASE}/`);

    const sizeOf = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((node) => {
          const style = getComputedStyle(node);
          return {
            font: parseFloat(style.fontSize),
            rule: parseFloat(style.borderBottomWidth),
          };
        });

    const year = await sizeOf('.timeline__year-heading');
    const month = await sizeOf('.timeline__month-heading');
    const day = await sizeOf('.timeline__day-heading');

    // Each level is decisively smaller than the one above, not a shade.
    expect(year.font).toBeGreaterThan(month.font * 1.4);
    expect(month.font).toBeGreaterThan(day.font * 1.3);

    // Only the year draws a line; a month and a day are bounded by their own
    // photographs.
    expect(year.rule).toBeGreaterThan(1);
    expect(month.rule).toBe(0);
    expect(day.rule).toBe(0);
  });

  test('lands scrolled to the section a deep URL names', async ({ page }) => {
    await page.goto(`${BASE}/2026/03/01`);

    const day = page.locator('#d-2026-03-01');
    await expect(day).toBeVisible();
    expect(await isInViewport(day)).toBe(true);

    // It is the same page, not a filtered one: August is still above it.
    await expect(page.locator('#d-2026-08-02')).toHaveCount(1);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  test('anchors the undated group at the end', async ({ page }) => {
    await page.goto(`${BASE}/undated`);

    const undated = page.locator('#undated');
    expect(await isInViewport(undated)).toBe(true);
    await expect(undated.locator('.photo-grid__item')).toHaveCount(2);
  });

  test('the site name goes back to the plain address and the top', async ({ page }) => {
    await page.goto(`${BASE}/2026/03/01`);
    await expect(page.locator('#d-2026-03-01')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    await page.getByRole('link', { name: 'Family Photos' }).click();

    // No section in the address any more, and back at the top of the library.
    await expect(page).toHaveURL(`${BASE}/`);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    // Still the same one page, not a navigation to somewhere else.
    await expect(page.locator('#d-2026-03-01')).toHaveCount(1);
  });

  test('the base path starts at the top', async ({ page }) => {
    await page.goto(`${BASE}/`);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test('clicking a heading rewrites the URL without adding history', async ({
    page,
  }) => {
    await page.goto(`${BASE}/`);
    const before = await page.evaluate(() => window.history.length);

    await page.locator('#d-2026-03-01 .timeline__anchor').click();
    await expect(page).toHaveURL(`${BASE}/2026/03/01`);

    // replaceState, so scrolling around the page does not fill up the history.
    expect(await page.evaluate(() => window.history.length)).toBe(before);
  });

  test('the year and month headings stay pinned while scrolling', async ({ page }) => {
    await page.goto(`${BASE}/2025/12/25`);

    /*
     * Directly under the header and the add bar, which both pin above them at
     * this width: the header so the toggle between the two views stays
     * reachable in a page years long, and the add bar because the family can
     * add photographs (family-tier.md 5.1). The header's height is a declared
     * constant and the add bar publishes its own, and the same two numbers move
     * the headings down and give the anchored section its scroll-margin — so
     * the heading landing at exactly that offset is the whole arrangement
     * agreeing.
     */
    const header = await page
      .locator('.layout__header')
      .evaluate((node) => node.getBoundingClientRect().height);
    expect(header).toBeGreaterThan(0);
    const addBar = await page
      .locator('.drop-target')
      .evaluate((node) => node.getBoundingClientRect().height);
    expect(addBar).toBeGreaterThan(0);

    const year = page.locator('#y-2025 .timeline__year-heading');
    const top = await year.evaluate((node) => node.getBoundingClientRect().top);
    expect(Math.abs(top - (header + addBar))).toBeLessThan(4);

    // The header is above both of them, not the other way round.
    const headerTop = await page
      .locator('.layout__header')
      .evaluate((node) => node.getBoundingClientRect().top);
    expect(headerTop).toBeLessThan(4);

    // A month heading slides up behind its year as the month runs out; both
    // are opaque, so the year has to be the one that stays legible.
    const layer = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((node) => Number(getComputedStyle(node).zIndex));
    expect(await layer('.timeline__year-heading')).toBeGreaterThan(
      await layer('.timeline__month-heading'),
    );
  });
});

test.describe('the photo view', () => {
  test('arrows across day, month, and year boundaries', async ({ page }) => {
    // The last photo of August 15th; the next one in display order is the
    // first of August 2nd — a different day.
    await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['market']}`);

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // The family's photo view is the editing view (family-tier.md 5.3), so the
    // date is the value of its field.
    await expect(page.getByLabel('Capture date')).toHaveValue('2026-08-15');

    await page.getByRole('button', { name: 'Next photo' }).click();
    await expect(page.getByLabel('Capture date')).toHaveValue('2026-08-02');
  });

  test('closes the info panel on the way to the next photo', async ({ page }) => {
    await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['market']}`);
    const info = page.locator('.lightbox__info');

    await page.getByRole('button', { name: 'Photo info' }).click();
    await expect(info).toBeVisible();

    // It names one photograph's file and dimensions; it must not follow the
    // arrows onto another.
    await page.getByRole('button', { name: 'Next photo' }).click();
    await expect(info).toHaveCount(0);

    // Same for the keyboard.
    await page.getByRole('button', { name: 'Photo info' }).click();
    await expect(info).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(info).toHaveCount(0);
  });

  test('dismisses the info panel by itself, then the photograph', async ({ page }) => {
    // The panel is a layer: Escape unwinds it before the view, and a pointer
    // outside it closes it. Only a browser can show both, because both are
    // about a real event reaching a real window listener.
    await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['market']}`);
    const info = page.locator('.lightbox__info');

    await page.getByRole('button', { name: 'Photo info' }).click();
    await expect(info).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(info).toHaveCount(0);
    await expect(page.locator('.lightbox__image')).toBeVisible();

    await page.getByRole('button', { name: 'Photo info' }).click();
    await expect(info).toBeVisible();
    await page.locator('.lightbox__image').click();
    await expect(info).toHaveCount(0);
    await expect(page.locator('.lightbox__image')).toBeVisible();

    // Nothing open over it now, so Escape leaves for the listing.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.timeline__year-heading').first()).toBeVisible();
  });

  test('disables the arrows only at the two ends of the library', async ({ page }) => {
    const previous = page.getByRole('button', { name: 'Previous photo' });
    const next = page.getByRole('button', { name: 'Next photo' });

    // Newest photo in the library.
    await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['market']}`);
    await expect(previous).toBeDisabled();
    await expect(next).toBeEnabled();

    // Last of the undated group, which sits after every dated photo.
    await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['undated-b']}`);
    await expect(next).toBeDisabled();
    await expect(previous).toBeEnabled();

    // A day boundary is not an end.
    await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['snowdrops']}`);
    await expect(previous).toBeEnabled();
    await expect(next).toBeEnabled();
  });

  test('is keyboard navigable, and each press advances one photo', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/02`);
    await page.locator('#d-2026-08-02 .photo-grid__link').first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveAttribute('aria-label', 'First one down to the beach.');

    await page.keyboard.press('ArrowRight');
    await expect(dialog).toHaveAttribute('aria-label', 'Photo from August 2, 2026');

    // Consecutive presses with no wait between them. Deriving neighbours from
    // an in-flight detail response made a fast second press navigate to the
    // photo already shown, so holding the key moved one step and stopped.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(dialog).toHaveAttribute(
      'aria-label',
      'Scanned from a print.\n\nNobody remembers who took it.',
    );
  });

  test('closing returns to the timeline with the photo tile in view', async ({
    page,
  }) => {
    const id = FIXTURE_PHOTO_IDS['christmas']!;
    await page.goto(`${BASE}/photo/${id}`);
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(`${BASE}/2025/12/25`);

    const tile = page.locator(`#photo-${id}`);
    expect(await isInViewport(tile)).toBe(true);
  });

  test('has no header bar, no position count, and no capture-time line', async ({
    page,
  }) => {
    await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['market']}`);

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toContainText(/\d+ of \d+/);
    // The day is named, the clock time is not: it belongs to the info panel.
    await expect(dialog).not.toContainText('10:05 AM');
    // The way back does not name the day either — it would rewrite itself
    // under the cursor on every arrow press.
    await expect(page.locator('.lightbox__back')).toHaveText(/^←?\s*Lightbox$/);
    await expect(page.locator('.lightbox__bar')).toHaveCount(0);
    await expect(page.locator('.lightbox__capture')).toHaveCount(0);
  });

  test('keeps the caption visible and moves the details into the info panel', async ({
    page,
  }) => {
    await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['market']}`);

    // In its field, which is where the family reads and corrects it; the
    // filename stays out of the view until Photo info (family-tier.md #7).
    await expect(
      page.getByRole('textbox', { name: 'Caption', exact: true }),
    ).toHaveValue('Saturday market.');
    await expect(page.getByText('IMG_20260815_100500.HEIC')).toHaveCount(0);
    await expect(page.locator('.lightbox__filename')).toHaveCount(0);

    await page.getByRole('button', { name: 'Photo info' }).click();
    const info = page.locator('#photo-information');
    await expect(info).toContainText('IMG_20260815_100500.HEIC');
    await expect(info).toContainText('August 15, 2026 at 10:05 AM');
    await expect(info).toContainText('4032 × 3024');
  });

  test('offers a download without saying what size', async ({ page }) => {
    await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['market']}`);
    await expect(
      page.getByRole('button', { name: 'Download', exact: true }),
    ).toBeVisible();
  });

  test('puts the chrome in the corners and the photo between them', async ({
    page,
  }) => {
    await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['market']}`);
    await expect(page.locator('.lightbox__image')).toBeVisible();

    const back = (await page.locator('.lightbox__back').boundingBox())!;
    const image = (await page.locator('.lightbox__image').boundingBox())!;
    const form = (await page.locator('.edit-form').boundingBox())!;
    const download = (await page
      .getByRole('button', { name: 'Download', exact: true })
      .boundingBox())!;
    const info = (await page
      .getByRole('button', { name: 'Photo info' })
      .boundingBox())!;

    // The picture starts below the way back rather than beside it: in the
    // editing view the stage clears a fixed gutter for the form, exactly as
    // the admin's photo view does, and nothing overlaps the picture.
    expect(image.y).toBeGreaterThanOrEqual(back.y + back.height);

    // The family's photo view is the editing view (family-tier.md 5.3): the
    // form, then Download, Delete, and Photo info across one row beneath it.
    expect(form.y + form.height).toBeLessThanOrEqual(download.y + 1);
    expect(Math.abs(download.y - info.y)).toBeLessThan(2);
    expect(info.x).toBeGreaterThan(download.x);

    // And the whole stack sits clear of the picture. `object-fit: contain`
    // centres the picture inside the img element's box, so the visible left
    // edge is derived from the element's box and its aspect ratio.
    const right = (box: { x: number; width: number }) => box.x + box.width;
    const pictureLeft = await page.locator('.lightbox__image').evaluate((node) => {
      const img = node as HTMLImageElement;
      const box = img.getBoundingClientRect();
      const ratio =
        Number(img.getAttribute('width')) / Number(img.getAttribute('height'));
      return box.left + (box.width - Math.min(box.width, box.height * ratio)) / 2;
    });
    expect(pictureLeft - Math.max(right(form), right(info))).toBeGreaterThanOrEqual(15);
  });

  test('preserves line breaks in a caption without interpreting markup', async ({
    page,
  }) => {
    await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['beach-scan']}`);

    // A field's value is text by construction, line breaks and all.
    const caption = page.getByRole('textbox', { name: 'Caption', exact: true });
    await expect(caption).toHaveValue(
      /Scanned from a print\.[\s\S]*\n[\s\S]*Nobody remembers who took it\./,
    );
  });
});

test.describe('ordering', () => {
  test('places timed photos in clock order, then date-only photos', async ({
    page,
  }) => {
    await page.goto(`${BASE}/2026/08/02`);

    const day = page.locator('#d-2026-08-02');
    await expect(day.locator('.photo-grid__item')).toHaveCount(6);
    const alts = await day
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
    await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['deleted-0']}`);

    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
    // Nothing on the page hints that this ID ever existed. The header's Trash
    // link is the family's, on every page, and says nothing about this one.
    await expect(
      page.getByRole('main').getByText(/deleted|trash|removed/i),
    ).toHaveCount(0);
  });

  test('an unknown photo ID looks exactly the same', async ({ page }) => {
    await page.goto(`${BASE}/photo/${'f'.repeat(32)}`);
    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
  });

  test('a malformed route 404s rather than showing an empty section', async ({
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

  test('a well-formed route for a section with no photos 404s', async ({ page }) => {
    for (const path of [`${BASE}/2026/08/03`, `${BASE}/2026/01`, `${BASE}/2019`]) {
      await page.goto(path);
      await expect(
        page.getByRole('heading', { name: 'Not found' }),
        path,
      ).toBeVisible();
      // And it shows the 404 alone, not the timeline with a 404 on top.
      await expect(page.locator('.photo-grid__item')).toHaveCount(0);
    }
  });
});

test.describe('images', () => {
  test('requests thumbnails in the grid and larger renditions in the photo view', async ({
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
    // The timeline asks for thumbnails only; larger renditions wait for a click.
    expect(requested.some((url) => url.includes('display-'))).toBe(false);

    await page.locator('#d-2026-08-15 .photo-grid__link').first().click();
    await expect(page.locator('.lightbox__image')).toBeVisible();
    await expect
      .poll(() => requested.some((url) => url.includes('display-')))
      .toBe(true);
  });

  test('preloads the neighbouring photos once the current one has rendered', async ({
    page,
  }) => {
    const requested: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/p/')) requested.push(request.url());
    });

    // Mid-library, so it has a neighbour on each side.
    await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['snowdrops']}`);
    await expect(page.locator('.lightbox__image')).toBeVisible();

    // The photo before it is the last of July 4th; the one after is the
    // first of the previous year — both across section boundaries.
    for (const seed of ['scratch-0-c', 'early-start']) {
      await expect
        .poll(() =>
          requested.some(
            (url) =>
              url.includes(FIXTURE_PHOTO_IDS[seed]!) && url.endsWith('/display-1280'),
          ),
        )
        .toBe(true);
    }
  });

  test('never requests a trashed photo derivative', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (request) => requested.push(request.url()));

    await page.goto(`${BASE}/`);
    await expect(page.locator('.photo-grid__item')).toHaveCount(18);

    for (const seed of ['deleted-0', 'deleted-1']) {
      expect(requested.some((url) => url.includes(FIXTURE_PHOTO_IDS[seed]!))).toBe(
        false,
      );
    }
  });
});

/**
 * The display link is the family link (family-tier.md 11.3): anyone holding it
 * can add a photograph, correct one, move one to the trash, and restore it,
 * and nothing only the administrator does.
 *
 * Against a family dev server of this project's own (playwright.config.ts),
 * because these change the library and the tests above count it exactly.
 * Serial, because each builds on the library the one before left behind.
 * The upload is the same generated PNG the admin's upload test uses, so it
 * needs no `sample-photos/` and never skips.
 */
test.describe('the family can curate', () => {
  test.describe.configure({ mode: 'serial' });

  function familyBase(): string {
    const port = test.info().project.name === 'webkit' ? 5177 : 5176;
    return `http://localhost:${port}/dev-display-path`;
  }

  /** The library's own tiles, not the files still on their way in. */
  const library = (page: Page) =>
    page.locator('.timeline:not(.upload__pending) .photo-grid__item');

  test('adds a photograph from the add bar', async ({ page }) => {
    const base = familyBase();
    await page.goto(`${base}/`);
    await expect(library(page)).toHaveCount(18);

    const name = 'family-upload.png';
    await page.locator('.drop-target__input').setInputFiles({
      name,
      mimeType: 'image/png',
      buffer: tinyPng(),
    });

    // A tile of its own at once, named after the file: the one place the
    // family sees a filename (family-tier.md #12).
    const tile = page
      .locator('.upload__pending .photo-grid__item')
      .filter({ hasText: name });
    await expect(tile).toHaveCount(1);
    await expect(tile.locator('.photo-grid__filename')).toHaveText(name);

    // Once it has landed and the library has reloaded, it is in the library and
    // its tile has gone.
    await expect(library(page)).toHaveCount(19, { timeout: 30_000 });
    await expect(page.locator('.upload__pending')).toHaveCount(0);
  });

  test('corrects a caption, and it stays corrected', async ({ page }) => {
    const base = familyBase();
    await page.goto(`${base}/photo/${FIXTURE_PHOTO_IDS['market']}`);

    const caption = page.getByRole('textbox', { name: 'Caption', exact: true });
    await expect(caption).toHaveValue('Saturday market.');
    await caption.fill('Saturday market, in the rain.');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();

    await page.reload();
    await expect(caption).toHaveValue('Saturday market, in the rain.');
  });

  test('moves a photograph to the trash, and restores it from there', async ({
    page,
  }) => {
    const base = familyBase();
    const id = FIXTURE_PHOTO_IDS['market']!;
    await page.goto(`${base}/photo/${id}`);

    const trashLink = page.getByRole('link', { name: /^Trash/ });
    await expect(trashLink).toHaveText('Trash (2)');

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toContainText('1 photo');
    await page.keyboard.press('Enter');

    // The photo view advances rather than closing: August 15th's only photo
    // gives way to the next in the library, on August 2nd.
    await expect(page).not.toHaveURL(new RegExp(id));
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel('Capture date')).toHaveValue('2026-08-02');
    await expect(trashLink).toHaveText('Trash (3)');

    // Close the photo view to reach the header, as anyone would.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await trashLink.click();
    await expect(page).toHaveURL(`${base}/trash`);
    await expect(page.locator('.trash__intro')).toContainText(
      'Only the administrator can delete a photo permanently.',
    );

    // No filename on a family tile, so it is found by the photo its thumbnail is.
    const trashed = page
      .locator('.photo-grid__item')
      .filter({ has: page.locator(`img[src*="${id}"]`) });
    await expect(trashed).toHaveCount(1);
    await trashed.locator('.photo-grid__link').click();

    // One tap opens it, and Restore is the only thing it offers.
    const view = page.getByRole('dialog');
    await expect(view).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole('button', { name: 'Download' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete permanently' })).toHaveCount(
      0,
    );
    await page.getByRole('button', { name: 'Restore' }).click();

    await expect(view).toHaveCount(0);
    await expect(trashed).toHaveCount(0);
    await expect(trashLink).toHaveText('Trash (2)');

    await page.goto(`${base}/2026/08/15`);
    await expect(page.locator(`#photo-${id}`)).toBeVisible();
  });

  test('is refused what only the administrator does', async ({ page }) => {
    const base = familyBase();

    expect((await page.request.get(`${base}/api/emails`)).status()).toBe(404);
    expect(
      (
        await page.request.post(`${base}/api/permanent-delete/preview`, {
          data: {
            selection: { kind: 'ids', photoIds: [FIXTURE_PHOTO_IDS['deleted-0']] },
          },
        })
      ).status(),
    ).toBe(404);

    // While a curation route on the very same link answers.
    expect((await page.request.get(`${base}/api/trash/count`)).status()).toBe(200);
  });

  test("shows none of the administrator's controls", async ({ page }) => {
    const base = familyBase();
    await page.goto(`${base}/2026/08/02`);

    // A plain click opens, as it always did (family-tier.md #5), and selects
    // nothing.
    await page.locator('#d-2026-08-02 .photo-grid__link').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await expect(page.locator('.selection-bar')).toHaveCount(0);
    await expect(page.locator('[data-selected]')).toHaveCount(0);
    await expect(page.locator('.selection-help')).toHaveCount(0);
    await expect(page.locator('.timeline__select-all')).toHaveCount(0);
    await expect(page.locator('.photo-grid__filename')).toHaveCount(0);
    for (const name of ['Emails', /^Inbox/, 'Export catalog']) {
      await expect(page.getByRole('link', { name })).toHaveCount(0);
    }
  });
});
