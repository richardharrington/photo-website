import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { FIXTURE_PHOTO_IDS, FIXTURE_UPLOADER_TOKEN } from '../../fixtures/catalog.ts';
import { tinyPng } from '../../fixtures/tiny-png.ts';

const BASE = '/dev-display-path';

/**
 * Where the picture itself starts, in pixels. `object-fit: contain` centres the
 * picture inside the img element's box, so the visible left edge is derived
 * from the element's box and its aspect ratio.
 */
function pictureLeftOf(page: Page) {
  return page.locator('.lightbox__image').evaluate((node) => {
    const img = node as HTMLImageElement;
    const box = img.getBoundingClientRect();
    const ratio =
      Number(img.getAttribute('width')) / Number(img.getAttribute('height'));
    return box.left + (box.width - Math.min(box.width, box.height * ratio)) / 2;
  });
}

const rightOf = (box: { x: number; width: number }) => box.x + box.width;

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
    // The photo view opens to read (read-first-photo-view.md), so the date is
    // text.
    await expect(page.locator('.lightbox__date')).toHaveText('August 15, 2026');

    await page.getByRole('button', { name: 'Next photo' }).click();
    await expect(page.locator('.lightbox__date')).toHaveText('August 2, 2026');
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

    // As text, with no field to be had on a photograph this browser did not
    // add; the filename stays out of the view until Photo info
    // (family-tier.md #7).
    await expect(page.locator('.lightbox__caption')).toHaveText('Saturday market.');
    await expect(page.getByRole('dialog').getByRole('textbox')).toHaveCount(0);
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

    const box = async (locator: Locator) => (await locator.boundingBox())!;
    const caption = await box(page.locator('.lightbox__caption'));
    const date = await box(page.locator('.lightbox__date'));
    const download = await box(
      page.getByRole('button', { name: 'Download', exact: true }),
    );
    const info = await box(page.getByRole('button', { name: 'Photo info' }));

    // The read view's corner stack: caption above date, then the buttons, with
    // Photo info lowest, all sharing one right edge.
    expect(caption.y).toBeLessThan(date.y);
    expect(date.y).toBeLessThan(download.y);
    expect(download.y).toBeLessThan(info.y);
    const edges = [caption, date, download, info].map(rightOf);
    for (const edge of edges) expect(Math.abs(edge - edges[0]!)).toBeLessThan(2);

    // And that edge ends short of the picture.
    expect((await pictureLeftOf(page)) - Math.max(...edges)).toBeGreaterThanOrEqual(15);
  });

  test('lets a click through the empty part of the corner stack to the previous-photo button', async ({
    page,
  }) => {
    // Short enough that the stack's box, which spans the whole margin, reaches
    // up past the button beside the picture.
    await page.setViewportSize({ width: 1280, height: 400 });
    await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['beach-burst-a']}`);

    const previous = page.getByRole('button', { name: 'Previous photo' });
    await expect(previous).toBeEnabled();
    const arrow = (await previous.boundingBox())!;
    const foot = (await page.locator('.lightbox__foot').boundingBox())!;
    expect(foot.y).toBeLessThan(arrow.y + arrow.height);
    expect(foot.x).toBeLessThan(arrow.x + arrow.width);

    // A covered button would fail Playwright's own check that it receives
    // the click.
    const before = page.url();
    await previous.click();
    await expect(page).not.toHaveURL(before);
  });

  test('makes room beside the photo for the form in the edit view', async ({
    page,
  }) => {
    // A photograph this browser added, so it has Edit.
    const id = FIXTURE_PHOTO_IDS['scratch-0-a']!;
    await page.addInitScript(
      ({ token, ids }) => {
        window.localStorage.setItem('photo-uploader-token', token);
        window.localStorage.setItem('photo-uploaded-ids', JSON.stringify(ids));
      },
      { token: FIXTURE_UPLOADER_TOKEN, ids: [id] },
    );
    // The picture slides over when Edit opens; measure where it lands.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${BASE}/photo/${id}`);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.locator('.edit-form')).toBeVisible();

    const back = (await page.locator('.lightbox__back').boundingBox())!;
    const form = (await page.locator('.edit-form').boundingBox())!;
    const remove = (await page
      .getByRole('button', { name: 'Delete', exact: true })
      .boundingBox())!;
    const info = (await page
      .getByRole('button', { name: 'Photo info' })
      .boundingBox())!;

    // The stage clears a fixed gutter for the form, so the picture starts to
    // the right of the way back rather than under it. (It can reach the top:
    // with no arrows beside it, a landscape picture grows to the stage's
    // height.)
    expect(await pictureLeftOf(page)).toBeGreaterThanOrEqual(back.x + back.width);

    // The form, then Delete and Photo info across one row beneath it, and no
    // Download.
    expect(form.y + form.height).toBeLessThanOrEqual(remove.y + 1);
    expect(Math.abs(remove.y - info.y)).toBeLessThan(2);
    expect(info.x).toBeGreaterThan(remove.x);
    await expect(page.getByRole('button', { name: 'Download' })).toHaveCount(0);

    // And the whole stack sits clear of the picture.
    expect(
      (await pictureLeftOf(page)) - Math.max(rightOf(form), rightOf(info)),
    ).toBeGreaterThanOrEqual(15);
  });

  test('preserves line breaks in a caption without interpreting markup', async ({
    page,
  }) => {
    await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['beach-scan']}`);

    const shown = await page.locator('.lightbox__caption').evaluate((node) => ({
      text: (node as HTMLElement).innerText,
      elements: node.children.length,
    }));
    expect(shown.text).toMatch(
      /Scanned from a print\.\n\s*\nNobody remembers who took it\./,
    );
    expect(shown.elements).toBe(0);
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
    // link, where there is one, is this browser's and says nothing about it.
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
 * can add a photograph and correct one, and can move to the trash and restore
 * what its own browser added (family-own-trash.md 11.3), and nothing only the
 * administrator does.
 *
 * Against a family dev server of this project's own (playwright.config.ts),
 * because these change the library and the tests above count it exactly.
 * Serial, because each builds on the library the one before left behind.
 * The upload is the same generated PNG the admin's upload test uses, so it
 * needs no `sample-photos/` and never skips.
 *
 * Each page starts as the browser that added the scratch days: the fixture
 * uploader's token, whose hash every scratch-day photograph carries, and
 * those photographs' IDs as added here. Only a test that opens a context of
 * its own starts as a stranger.
 */
test.describe('the family can curate', () => {
  test.describe.configure({ mode: 'serial' });

  function familyBase(): string {
    const port = test.info().project.name === 'webkit' ? 5177 : 5176;
    return `http://localhost:${port}/dev-display-path`;
  }

  /** The admin base of the same fixture process, for arranging what a family cannot. */
  function adminApi(): string {
    return familyBase().replace('/dev-display-path', '/dev-admin-path/api');
  }

  /** This project's scratch day, which only this project's tests change. */
  function scratch() {
    const index = test.info().project.name === 'webkit' ? 1 : 0;
    return {
      path: `2026/07/0${4 + index}`,
      live: ['a', 'b', 'c'].map(
        (letter) => FIXTURE_PHOTO_IDS[`scratch-${index}-${letter}`]!,
      ),
    };
  }

  /** Every photograph the fixture uploader added, on both scratch days. */
  const SCRATCH_IDS = Object.entries(FIXTURE_PHOTO_IDS)
    .filter(([seed]) => seed.startsWith('scratch-') || seed.startsWith('deleted-'))
    .map(([, id]) => id);

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ token, ids }) => {
        // Only into an empty storage, so what this page itself remembers
        // survives a reload.
        if (window.localStorage.getItem('photo-uploader-token') === null) {
          window.localStorage.setItem('photo-uploader-token', token);
          window.localStorage.setItem('photo-uploaded-ids', JSON.stringify(ids));
        }
      },
      { token: FIXTURE_UPLOADER_TOKEN, ids: SCRATCH_IDS },
    );
  });

  /** The library's own tiles, not the files still on their way in. */
  const library = (page: Page) =>
    page.locator('.timeline:not(.upload__pending) .photo-grid__item');

  test('adds a photograph from the add bar, which it can then delete', async ({
    page,
  }) => {
    const base = familyBase();
    await page.goto(`${base}/`);
    await expect(library(page)).toHaveCount(18);

    const committed = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/commit') &&
        response.request().method() === 'POST',
      { timeout: 30_000 },
    );

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

    // The commit carried this browser's token, and the photograph it made is
    // one this browser can delete — after a reload, too.
    const response = await committed;
    expect(response.request().headers()['x-photo-uploader']).toBe(
      FIXTURE_UPLOADER_TOKEN,
    );
    const { photo } = (await response.json()) as { photo: { id: string } };

    await page.goto(`${base}/photo/${photo.id}`);
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Delete', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Photo info' }).click();
    const info = page.locator('#photo-information');
    await expect(info.locator('dt', { hasText: 'Added from' })).toHaveCount(1);
    await expect(info.locator('dd', { hasText: 'This device' })).toHaveCount(1);
  });

  test('a photograph that lands after switching views is in the new view', async ({
    page,
  }) => {
    const base = familyBase();
    await page.goto(`${base}/`);
    await expect(library(page).first()).toBeVisible();

    const committed = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/commit') &&
        response.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await page.locator('.drop-target__input').setInputFiles({
      name: 'switched-views.png',
      mimeType: 'image/png',
      // Not the first test's bytes, or it would be skipped as a duplicate.
      buffer: tinyPng(40, 30),
    });

    // Away to the other view while it is still on its way in.
    await page.getByRole('link', { name: 'Recently added' }).click();
    await expect(page).toHaveURL(`${base}/recent`);

    const { photo } = (await (await committed).json()) as { photo: { id: string } };
    // A library tile's id: tiles still on their way in carry a queue item's id
    // instead, and Recently added lays its grid out in `.recent`, not
    // `.timeline`.
    const listed = (id: string) => page.locator(`#photo-${id}`);

    // In the view the reader is on, and in the one they left, with no reload.
    await expect(listed(photo.id)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('link', { name: 'All photos' }).click();
    await expect(listed(photo.id)).toBeVisible();
  });

  test('corrects a caption, and it stays corrected', async ({ page }) => {
    const base = familyBase();
    await page.goto(`${base}/photo/${scratch().live[0]}`);

    const shown = page.locator('.lightbox__caption');
    const field = page.getByRole('textbox', { name: 'Caption', exact: true });
    await expect(shown).toHaveText('First rocket up.');

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await field.fill('First rocket up, in the rain.');
    await page.getByRole('button', { name: 'Save changes' }).click();

    // Back to reading, with the new words and a word to say so.
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await expect(field).toHaveCount(0);
    await expect(shown).toHaveText('First rocket up, in the rain.');

    await page.reload();
    await expect(shown).toHaveText('First rocket up, in the rain.');

    // Put the fixture back.
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await field.fill('First rocket up.');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(shown).toHaveText('First rocket up.');
  });

  test('offers no Edit on a photograph it did not add, and is refused one', async ({
    page,
  }) => {
    const base = familyBase();
    const id = FIXTURE_PHOTO_IDS['market']!;
    await page.goto(`${base}/photo/${id}`);

    await expect(page.getByRole('button', { name: 'Download' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(
      0,
    );

    // The server refuses it regardless of what the page shows
    // (read-first-photo-view.md #24).
    const refused = await page.request.post(`${base}/api/edit`, {
      headers: { 'x-photo-uploader': FIXTURE_UPLOADER_TOKEN },
      data: { photoId: id, caption: 'Not mine to change.' },
    });
    expect(refused.status()).toBe(404);
  });

  test('clamps a long caption, with More to read it all and Less to put it back', async ({
    page,
  }) => {
    const base = familyBase();
    const id = scratch().live[1]!;
    const long = Array.from(
      { length: 30 },
      (_, index) => `Line ${index + 1} of a caption that goes on and on.`,
    ).join('\n');

    await page.goto(`${base}/photo/${id}`);
    const shown = page.locator('.lightbox__caption');
    const more = page.locator('.lightbox__more');
    const overflows = () =>
      shown.evaluate((node) => node.scrollHeight > node.clientHeight + 1);

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('textbox', { name: 'Caption', exact: true }).fill(long);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();

    try {
      // Clamped, and More, because the clamp has cut something off.
      await expect(more).toHaveText('More');
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      expect(await overflows()).toBe(true);

      // Expanded in place, capped at half the viewport, and scrolling there.
      await more.click();
      await expect(more).toHaveText('Less');
      await expect(more).toHaveAttribute('aria-expanded', 'true');
      const { height, viewport } = await shown.evaluate((node) => ({
        height: node.getBoundingClientRect().height,
        viewport: window.innerHeight,
      }));
      expect(height).toBeLessThanOrEqual(viewport / 2 + 1);
      expect(await overflows()).toBe(true);

      // Expansion belongs to one photograph: away and back, it is collapsed.
      await page.keyboard.press('ArrowRight');
      await expect(page).not.toHaveURL(new RegExp(id));
      await page.keyboard.press('ArrowLeft');
      await expect(page).toHaveURL(new RegExp(id));
      await expect(more).toHaveText('More');
    } finally {
      const response = await page.request.post(`${base}/api/edit`, {
        headers: { 'x-photo-uploader': FIXTURE_UPLOADER_TOKEN },
        data: {
          photoId: id,
          date: scratch().path.replaceAll('/', '-'),
          time: '21:07:45',
          caption: null,
        },
      });
      expect(response.status()).toBe(200);
    }
  });

  test('unwinds Escape one layer at a time, and never over unsaved typing', async ({
    page,
  }) => {
    const base = familyBase();
    await page.goto(`${base}/photo/${scratch().live[0]}`);

    const form = page.locator('.edit-form');
    const edit = page.getByRole('button', { name: 'Edit', exact: true });
    const field = page.getByRole('textbox', { name: 'Caption', exact: true });
    const info = page.locator('#photo-information');

    // Nothing typed: Escape leaves Edit, and the photograph stays open.
    await edit.click();
    await expect(form).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(form).toHaveCount(0);
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(edit).toBeFocused();

    // Photo info is a layer of its own, over either view.
    await edit.click();
    await page.getByRole('button', { name: 'Photo info' }).click();
    await expect(info).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(info).toHaveCount(0);
    await expect(form).toBeVisible();

    // Typed and unsaved: the field lets go of Escape, and then Escape refuses.
    await field.fill('Never saved');
    await field.press('Escape');
    await expect(field).not.toBeFocused();
    await page.keyboard.press('Escape');
    await expect(form).toBeVisible();
    await expect(field).toHaveValue('Never saved');
    await expect(page.getByText('Unsaved changes')).toBeVisible();

    // Cancel discards without asking, and then Escape closes the photograph.
    await form.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.lightbox__caption')).toHaveText('First rocket up.');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('moves a photograph it added to the trash, and restores it from there', async ({
    page,
  }) => {
    const base = familyBase();
    const id = scratch().live[2]!;

    // Something in the trash that this browser did not add, which its trash
    // must not show. Put there through the admin base, and put back after.
    const stranger = FIXTURE_PHOTO_IDS['undated-a']!;
    const preview = await page.request.post(`${adminApi()}/trash/preview`, {
      data: { selection: { kind: 'ids', photoIds: [stranger] } },
    });
    await page.request.post(`${adminApi()}/trash/confirm`, {
      data: await preview.json(),
    });

    try {
      await page.goto(`${base}/photo/${id}`);

      // Both scratch days' trashed photographs are this browser's; the one
      // nobody added is not counted.
      const trashLink = page.getByRole('link', { name: /^Trash/ });
      await expect(trashLink).toHaveText('Trash (2)');

      await page.getByRole('button', { name: 'Photo info' }).click();
      await expect(
        page.locator('#photo-information dt', { hasText: 'Added from' }),
      ).toHaveCount(1);

      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(page.getByRole('alertdialog')).toContainText('1 photo');
      await page.keyboard.press('Enter');

      // The photo view advances rather than closing.
      await expect(page).not.toHaveURL(new RegExp(id));
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(trashLink).toHaveText('Trash (3)');

      // Close the photo view to reach the header, as anyone would.
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await trashLink.click();
      await expect(page).toHaveURL(`${base}/trash`);
      await expect(page.locator('.trash__intro')).toContainText(
        'Photos added from this device that have been deleted are kept here for 30 days',
      );

      // Only this browser's photographs: every tile is a scratch-day one, and
      // the photograph nobody added is not among them.
      const tiles = page.locator('.photo-grid__item img');
      await expect(tiles).toHaveCount(3);
      for (const src of await tiles.evaluateAll((images) =>
        images.map((image) => image.getAttribute('src') ?? ''),
      )) {
        expect(
          SCRATCH_IDS.some((scratchId) => src.includes(scratchId)),
          src,
        ).toBe(true);
        expect(src).not.toContain(stranger);
      }

      // No filename on a family tile, so it is found by the photo its thumbnail is.
      const trashed = page
        .locator('.photo-grid__item')
        .filter({ has: page.locator(`img[src*="${id}"]`) });
      await expect(trashed).toHaveCount(1);
      await trashed.locator('.photo-grid__link').click();

      // One tap opens it, and Restore is the only thing it offers.
      const view = page.getByRole('dialog');
      await expect(view).toBeVisible();
      // Everything in this browser's trash was added from this browser.
      await page.getByRole('button', { name: 'Photo info' }).click();
      await expect(
        page.locator('#photo-information dd', { hasText: 'This device' }),
      ).toHaveCount(1);
      await expect(
        page.getByRole('button', { name: 'Delete', exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Download' })).toHaveCount(0);
      // Restore, and Delete permanently, which the last test in this group uses.
      await expect(
        page.getByRole('button', { name: 'Delete permanently' }),
      ).toHaveCount(1);
      await page.getByRole('button', { name: 'Restore' }).click();

      await expect(view).toHaveCount(0);
      await expect(trashed).toHaveCount(0);
      await expect(trashLink).toHaveText('Trash (2)');

      // Back in the library without a reload: the header's link, not a goto.
      await page.getByRole('link', { name: 'All photos' }).click();
      await expect(page).toHaveURL(`${base}/`);
      await expect(page.locator(`#photo-${id}`)).toBeVisible();
    } finally {
      await page.request.post(`${adminApi()}/restore`, {
        data: { photoIds: [stranger] },
      });
    }
  });

  test('an Undo pressed on the Trash page takes the photograph out of its listing', async ({
    page,
  }) => {
    const base = familyBase();
    const id = scratch().live[1]!;
    await page.goto(`${base}/photo/${id}`);

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toContainText('1 photo');
    await page.keyboard.press('Enter');
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeVisible();

    // Over to the trash while the offer still stands; the photograph is there.
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: /^Trash/ }).click();
    const trashed = page
      .locator('.photo-grid__item')
      .filter({ has: page.locator(`img[src*="${id}"]`) });
    await expect(trashed).toHaveCount(1);

    // Undo from here: gone from the listing and back in the library, no reload.
    await undo.click();
    await expect(trashed).toHaveCount(0);
    await page.getByRole('link', { name: 'All photos' }).click();
    await expect(page.locator(`#photo-${id}`)).toBeVisible();
  });

  test('offers no Delete on a photograph it did not add', async ({ page }) => {
    const base = familyBase();
    await page.goto(`${base}/photo/${FIXTURE_PHOTO_IDS['beach-early']}`);

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(
      0,
    );

    await page.getByRole('button', { name: 'Photo info' }).click();
    const info = page.locator('#photo-information');
    await expect(info).toBeVisible();
    await expect(info.locator('dt', { hasText: 'Added from' })).toHaveCount(1);
    await expect(info.locator('dd', { hasText: 'Another device' })).toHaveCount(1);

    // The key does nothing either: no confirmation to answer.
    await page.keyboard.press('Delete');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });

  test('a fresh browser has no Trash link, and is refused a trash', async ({
    browser,
  }) => {
    const base = familyBase();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const counted = page.waitForResponse((response) =>
        response.url().endsWith('/api/trash/count'),
      );
      await page.goto(`${base}/photo/${scratch().live[0]}`);

      // Its trash is empty, so there is no link to it.
      expect(await (await counted).json()).toEqual({ count: 0 });
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByRole('link', { name: /^Trash/ })).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Delete', exact: true }),
      ).toHaveCount(0);

      // And the server refuses it regardless of what the page shows.
      const refused = await page.request.post(`${base}/api/trash/preview`, {
        data: { selection: { kind: 'ids', photoIds: [scratch().live[0]] } },
      });
      expect(refused.status()).toBe(404);
    } finally {
      await context.close();
    }
  });

  test('is refused what only the administrator does', async ({ page }) => {
    const base = familyBase();

    expect((await page.request.get(`${base}/api/emails`)).status()).toBe(404);
    expect(
      (
        await page.request.post(`${base}/api/captions`, { data: { changes: [] } })
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

  test('deletes a photograph it added permanently from its trash, and nothing else', async ({
    page,
  }) => {
    const base = familyBase();
    const index = test.info().project.name === 'webkit' ? 1 : 0;
    const id = FIXTURE_PHOTO_IDS[`deleted-${index}`]!;

    // In the trash, but not this browser's: refused whatever the request says.
    const stranger = FIXTURE_PHOTO_IDS['undated-b']!;
    const trash = await page.request.post(`${adminApi()}/trash/preview`, {
      data: { selection: { kind: 'ids', photoIds: [stranger] } },
    });
    await page.request.post(`${adminApi()}/trash/confirm`, {
      data: await trash.json(),
    });

    try {
      const refused = await page.request.post(`${base}/api/permanent-delete/preview`, {
        headers: { 'x-photo-uploader': FIXTURE_UPLOADER_TOKEN },
        data: { selection: { kind: 'ids', photoIds: [stranger] } },
      });
      expect(refused.status()).toBe(404);

      await page.goto(`${base}/trash`);
      const tile = page
        .locator('.photo-grid__item')
        .filter({ has: page.locator(`img[src*="${id}"]`) });
      await tile.locator('.photo-grid__link').click();

      await page.getByRole('button', { name: 'Delete permanently' }).click();
      const confirm = page.getByRole('alertdialog');
      await expect(confirm).toContainText('cannot be undone');
      await confirm.getByRole('button', { name: 'Delete permanently' }).click();

      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(tile).toHaveCount(0);

      // Gone for good: there is nothing left for even the administrator to restore.
      const restore = await page.request.post(`${adminApi()}/restore`, {
        data: { photoIds: [id] },
      });
      expect(((await restore.json()) as { count: number }).count).toBe(0);
    } finally {
      await page.request.post(`${adminApi()}/restore`, {
        data: { photoIds: [stranger] },
      });
    }
  });
});
