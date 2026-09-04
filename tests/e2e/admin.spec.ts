import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SCRATCH_DAYS, FIXTURE_PHOTO_IDS } from '../../fixtures/catalog.ts';
import { tinyPng } from '../../fixtures/tiny-png.ts';

/**
 * The admin app, against the local fixture server.
 *
 * The admin is the viewer plus curation, so what is worth testing here is the
 * curation: the selection, the edit form in the photo view, delete and undo,
 * and the trash. That the timeline and the photo view work at all is
 * display.spec.ts's job, and they are the same components.
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
  const project = test.info().project.name;
  const index = project === 'webkit' ? 1 : 0;
  const day = SCRATCH_DAYS[index]!;
  const [year, month, date] = day.split('-');
  return {
    day,
    /** The URL of the day's section of the one page. */
    path: `${BASE}/${year}/${month}/${date}`,
    anchor: `#d-${day}`,
    /** The trashed photo on that day, which only this project restores. */
    trashedFile: `IMG_${day.replaceAll('-', '')}_211900.HEIC`,
    /** How that day reads in the interface, e.g. "July 4". */
    dayHeading: `July ${Number(date)}`,
    /** Its three live photos, earliest first, as the grid orders them. */
    files: ['210311', '210745', '211402'].map(
      (time) => `IMG_${day.replaceAll('-', '')}_${time}.HEIC`,
    ),
    ids: ['a', 'b', 'c'].map(
      (letter) => FIXTURE_PHOTO_IDS[`scratch-${index}-${letter}`]!,
    ),
    /** A day of this project's own to upload into, and then empty again. */
    uploadDay: `2026-07-2${index}`,
    uploadFile: `dropped-${project}.png`,
  };
}

const selected = (page: Page) => page.locator('.photo-grid__link[data-selected]');
const tiles = (page: Page, anchor: string) =>
  page.locator(`${anchor} .photo-grid__link`);

/** Confirm the dialog that is up, whatever its button is called. */
async function confirmDelete(page: Page, label = 'Delete') {
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: label, exact: true })
    .click();
}

/** Put a photo back from the trash, for tests whose undo offer has gone. */
async function restoreFromTrash(page: Page, filename: string): Promise<void> {
  await page.goto(`${BASE}/trash`);
  const item = page.locator('.photo-grid__item').filter({ hasText: filename });
  await item.locator('.photo-grid__link').click({ modifiers: ['ControlOrMeta'] });
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(item).toHaveCount(0);
}

test.describe('the admin timeline', () => {
  test('is the viewer, with an upload target, filenames, and Trash', async ({
    page,
  }) => {
    await page.goto(`${BASE}/`);

    // The same one page, headings and all.
    await expect(page.locator('.timeline__year-heading')).toHaveText([
      /2026/,
      /2025/,
      /Undated/,
    ]);
    // Not a fixed number: this file also uploads a photograph, and the other
    // browser project may be part-way through doing so. display.spec.ts pins
    // the library's size against the same projection.
    const counts = await page.evaluate(() => ({
      tiles: document.querySelectorAll('.photo-grid__item').length,
      filenames: document.querySelectorAll('.photo-grid__filename').length,
    }));
    expect(counts.tiles).toBeGreaterThanOrEqual(18);

    // Above it, the upload target; in the header, what the viewer never has.
    await expect(page.getByRole('button', { name: /Add photos/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Trash \(\d+\)$/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Export catalog' })).toBeVisible();

    // Every thumbnail says which file it is; the viewer's never do.
    await expect(page.getByText('IMG_20260802_081502.HEIC')).toBeVisible();
    expect(counts.filenames).toBe(counts.tiles);
  });

  test('keeps the drop target under the cursor wherever the page is', async ({
    page,
  }) => {
    // design.md: pinned to the top. The library is one page years long, so a
    // target at the head of it is a target you have to scroll back to — with a
    // file already held over the window.
    await page.goto(`${BASE}/`);
    const target = page.getByRole('button', { name: /Add photos/ });
    await expect(target).toBeVisible();

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(target).toBeInViewport();

    const { dropBottom, overlapping } = await page.evaluate(() => {
      const drop = document.querySelector('.drop-target')!.getBoundingClientRect();
      const headings = document.querySelectorAll(
        '.timeline__year-heading, .timeline__month-heading',
      );
      return {
        dropBottom: drop.bottom,
        overlapping: [...headings].filter((heading) => {
          const box = heading.getBoundingClientRect();
          return box.bottom > drop.top + 1 && box.top < drop.bottom - 1;
        }).length,
      };
    });

    // Pinned at the very top, and the headings that pin there too sit below
    // it rather than underneath it — which is what the published height is for.
    expect(dropBottom).toBeLessThan(120);
    expect(overlapping).toBe(0);
  });

  test('stands down while the photo view is open', async ({ page }) => {
    await page.goto(`${BASE}/`);
    const target = page.getByRole('button', { name: /Add photos/ });
    await expect(target).toBeVisible();

    // One photograph fills the screen; a drop target pinned over it would be
    // inviting a drop onto a view that is not the library.
    await page.locator('.photo-grid__link').first().click();
    await expect(page.locator('.lightbox')).toBeVisible();
    await expect(target).toBeHidden();

    await page.keyboard.press('Escape');
    await expect(target).toBeVisible();
  });

  test('lands scrolled to the section a deep URL names', async ({ page }) => {
    await page.goto(`${BASE}/2026/03/01`);

    const onScreen = await page.locator('#d-2026-03-01').evaluate((node) => {
      const box = node.getBoundingClientRect();
      return box.top >= 0 && box.top < window.innerHeight;
    });
    expect(onScreen).toBe(true);
    // The same page, not a filtered one.
    await expect(page.locator('#d-2026-08-02')).toHaveCount(1);
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

test.describe('selecting', () => {
  test('modifier-click selects without opening the photo', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/02`);
    const grid = tiles(page, '#d-2026-08-02');

    await grid.nth(2).click({ modifiers: ['ControlOrMeta'] });
    await expect(selected(page)).toHaveCount(1);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(`${BASE}/2026/08/02`);

    // And clicking it again takes it back out.
    await grid.nth(2).click({ modifiers: ['ControlOrMeta'] });
    await expect(selected(page)).toHaveCount(0);
  });

  test('shift-click extends across a day boundary', async ({ page }) => {
    // One selection covers the library, not one day: the range runs from the
    // last photo of August 15th into August 2nd.
    await page.goto(`${BASE}/`);
    await tiles(page, '#d-2026-08-15')
      .first()
      .click({ modifiers: ['ControlOrMeta'] });
    await tiles(page, '#d-2026-08-02')
      .nth(1)
      .click({ modifiers: ['Shift'] });

    await expect(selected(page)).toHaveCount(3);
    await expect(
      page.locator('#d-2026-08-15 .photo-grid__link[data-selected]'),
    ).toHaveCount(1);
  });

  test('the sticky bar appears with the count and goes at zero', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/02`);
    const bar = page.getByRole('toolbar', { name: 'Selection' });
    await expect(bar).toHaveCount(0);

    const grid = tiles(page, '#d-2026-08-02');
    await grid.nth(0).click({ modifiers: ['ControlOrMeta'] });
    await expect(bar).toContainText('1 selected');
    await grid.nth(1).click({ modifiers: ['ControlOrMeta'] });
    await expect(bar).toContainText('2 selected');

    // It sits above the pinned headings rather than over them.
    await page.locator('#d-2026-08-02 .timeline__anchor').click();
    const barBox = (await bar.boundingBox())!;
    const yearBox = (await page
      .locator('#y-2026 .timeline__year-heading')
      .boundingBox())!;
    expect(yearBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1);

    await bar.getByRole('button', { name: 'Deselect all' }).click();
    await expect(bar).toHaveCount(0);
    await expect(selected(page)).toHaveCount(0);
  });

  test('a plain click clears the selection and opens the photo', async ({ page }) => {
    await page.goto(`${BASE}/2026/08/02`);
    const grid = tiles(page, '#d-2026-08-02');
    await grid.nth(3).click({ modifiers: ['ControlOrMeta'] });
    await expect(selected(page)).toHaveCount(1);

    // The way out of a selection that caught the wrong photos.
    await grid.nth(0).click();

    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page).toHaveURL(`${BASE}/photo/${FIXTURE_PHOTO_IDS['beach-early']}`);
    await page.keyboard.press('Escape');
    await expect(selected(page)).toHaveCount(0);
  });
});

test.describe("a day heading's Select all", () => {
  const selectAll = (page: Page, anchor: string) =>
    page.locator(`${anchor} .timeline__select-all`);

  test('takes that day and only that day, and adds to what is selected', async ({
    page,
  }) => {
    await page.goto(`${BASE}/`);
    // Something selected elsewhere first, which Select all must not replace.
    await tiles(page, '#d-2026-08-15')
      .first()
      .click({ modifiers: ['ControlOrMeta'] });

    await selectAll(page, '#d-2026-08-02').click();

    await expect(selected(page)).toHaveCount(7);
    await expect(
      page.locator('#d-2026-08-02 .photo-grid__link[data-selected]'),
    ).toHaveCount(6);
    await expect(page.getByRole('toolbar', { name: 'Selection' })).toContainText(
      '7 selected',
    );
  });

  test('is absent once the day is whole, and returns when one is dropped', async ({
    page,
  }) => {
    // Never a disabled button: a control that can do nothing is not shown.
    await page.goto(`${BASE}/2026/08/02`);
    const control = selectAll(page, '#d-2026-08-02');
    await expect(control).toBeVisible();

    await control.click();
    await expect(control).toHaveCount(0);

    await tiles(page, '#d-2026-08-02')
      .nth(0)
      .click({ modifiers: ['ControlOrMeta'] });
    await expect(control).toBeVisible();
  });

  test('is nowhere to be seen in the viewer', async ({ page }) => {
    await page.goto('http://localhost:5173/dev-display-path/');
    await expect(page.locator('.timeline__select-all')).toHaveCount(0);
    await expect(page.locator('.photo-grid__filename')).toHaveCount(0);
  });
});

test.describe('deleting a selection', () => {
  test('states the count, clears the page, and offers Undo', async ({ page }) => {
    const { anchor, path } = scratch();
    await page.goto(path);
    const grid = tiles(page, anchor);
    await grid.nth(0).click({ modifiers: ['ControlOrMeta'] });
    await grid.nth(1).click({ modifiers: ['ControlOrMeta'] });

    await page.getByRole('button', { name: 'Delete selected' }).click();
    const dialog = page.getByRole('alertdialog');
    // The count comes from the resolved preview, not from the live query.
    await expect(dialog).toContainText('2 photos');
    await expect(dialog).toContainText('30 days');

    await confirmDelete(page);

    // Patched in place: no reload, and the third photo is untouched.
    await expect(page.getByRole('status')).toContainText('2 photos deleted.');
    await expect(page.locator(`${anchor} .photo-grid__item`)).toHaveCount(1);
    await expect(page.getByRole('toolbar', { name: 'Selection' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('status')).toHaveCount(0);
    await page.goto(path);
    await expect(page.locator(`${anchor} .photo-grid__item`)).toHaveCount(3);
  });

  test('cancelling changes nothing', async ({ page }) => {
    const { anchor, path } = scratch();
    await page.goto(path);
    await page.locator(`${anchor} .timeline__select-all`).click();
    await page.getByRole('button', { name: 'Delete selected' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('3 photos');

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.locator(`${anchor} .photo-grid__item`)).toHaveCount(3);
  });

  test('Escape dismisses the confirmation without closing anything else', async ({
    page,
  }) => {
    const { anchor, path } = scratch();
    await page.goto(path);
    await page.locator(`${anchor} .timeline__select-all`).click();
    await page.getByRole('button', { name: 'Delete selected' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(selected(page)).toHaveCount(3);
  });
});

test.describe('the admin photo view', () => {
  /** Open the first photo of the scratch day. */
  async function openFirst(page: Page) {
    const { anchor, path } = scratch();
    await page.goto(path);
    await tiles(page, anchor).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
  }

  test('names the file and carries the edit form in place of the caption', async ({
    page,
  }) => {
    await openFirst(page);
    const { files } = scratch();

    await expect(page.locator('.lightbox__filename')).toHaveText(files[0]!);
    // The viewer's caption and date text is not there; the fields are.
    await expect(page.locator('.lightbox__caption')).toHaveCount(0);
    await expect(page.getByLabel('Capture date')).toHaveValue(scratch().day);
    await expect(page.getByLabel('Capture time')).toHaveValue('21:03:11');
    await expect(page.getByLabel('Caption')).toHaveValue('First rocket up.');

    // And the actions beneath it.
    for (const name of ['Download', 'Delete', 'Photo info']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    }
  });

  test('arrows across the library, resetting the form each step', async ({ page }) => {
    await openFirst(page);
    const { files } = scratch();

    await page.getByRole('button', { name: 'Next photo' }).click();
    await expect(page.locator('.lightbox__filename')).toHaveText(files[1]!);
    await expect(page.getByLabel('Caption')).toHaveValue('');
    await expect(page.getByLabel('Capture time')).toHaveValue('21:07:45');

    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.lightbox__filename')).toHaveText(files[0]!);
    await expect(page.getByLabel('Caption')).toHaveValue('First rocket up.');
  });

  test('will not step away from an edit that has not been saved', async ({ page }) => {
    await openFirst(page);
    const { files } = scratch();

    await page.getByLabel('Caption').fill('Never saved');
    await expect(page.getByText('Unsaved changes')).toBeVisible();

    // Stepping is what would discard it, so both ways of stepping stop.
    await expect(page.getByRole('button', { name: 'Next photo' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Previous photo' })).toBeDisabled();
    await page.locator('.lightbox').click();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.lightbox__filename')).toHaveText(files[0]!);

    // Put back what was there, and the view moves again — no flag to get
    // stuck on, just a comparison against what is stored.
    await page.getByLabel('Caption').fill('First rocket up.');
    await expect(page.getByText('Unsaved changes')).toBeHidden();
    await page.getByRole('button', { name: 'Next photo' }).click();
    await expect(page.locator('.lightbox__filename')).toHaveText(files[1]!);
  });

  test('still lets an unsaved edit be abandoned deliberately', async ({ page }) => {
    // Escape and the way back are asking to leave, and always have been.
    await openFirst(page);
    await page.getByLabel('Caption').fill('Never saved');

    await page.locator('.lightbox').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.lightbox')).toBeHidden();

    await openFirst(page);
    await expect(page.getByLabel('Caption')).toHaveValue('First rocket up.');
  });

  test('disables the time field when there is no date', async ({ page }) => {
    // A time is meaningful only alongside a date.
    await page.goto(`${BASE}/photo/${FIXTURE_PHOTO_IDS['undated-a']}`);
    await expect(page.getByLabel('Capture time')).toBeDisabled();

    await page.getByLabel('Capture date').fill('2026-01-01');
    await expect(page.getByLabel('Capture time')).toBeEnabled();
  });

  test('rejects an impossible date without contacting the server', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') requests.push(request.url());
    });

    await openFirst(page);
    await page.getByLabel('Capture date').fill('2026-02-30');
    await page.getByRole('button', { name: 'Save changes' }).click();

    await expect(page.getByRole('alert')).toContainText('real date');
    expect(requests).toEqual([]);
  });

  test('a saved date moves the photo on the page, and it stays moved', async ({
    page,
  }) => {
    const { anchor, day, files, path } = scratch();
    const moved = `${day.slice(0, 7)}-20`;

    await openFirst(page);
    await page.getByLabel('Caption').fill('Edited by a test');
    await page.getByLabel('Capture date').fill(moved);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved')).toBeVisible();

    // Patched in place from the reply: the new day exists behind the photo
    // view, and the old one is one photo lighter. No reload.
    await page.keyboard.press('Escape');
    await expect(page.locator(`#d-${moved} .photo-grid__item`)).toHaveCount(1);
    await expect(page.locator(`${anchor} .photo-grid__item`)).toHaveCount(2);

    // And it really was stored.
    await page.goto(`${BASE}/${moved.replaceAll('-', '/')}`);
    await expect(page.locator(`#d-${moved}`)).toContainText(files[0]!);

    // Put the fixture back.
    await tiles(page, `#d-${moved}`).first().click();
    await page.getByLabel('Capture date').fill(day);
    await page.getByLabel('Capture time').fill('21:03:11');
    await page.getByLabel('Caption').fill('First rocket up.');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved')).toBeVisible();
    await page.goto(path);
    await expect(page.locator(`${anchor} .photo-grid__item`)).toHaveCount(3);
  });

  test('a field owns the keyboard while it has focus', async ({ page }) => {
    await openFirst(page);
    const { files } = scratch();
    const caption = page.getByLabel('Caption');

    await caption.fill('abcd');
    // Arrows move the caret and Backspace deletes a character: neither
    // changes photo, and neither trashes anything.
    await caption.press('ArrowLeft');
    await caption.press('ArrowLeft');
    await caption.press('Backspace');
    await expect(caption).toHaveValue('acd');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.locator('.lightbox__filename')).toHaveText(files[0]!);

    // Escape leaves the field; only a second Escape closes the view.
    await caption.press('Escape');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('Delete confirms, then trashes and advances to the next photo', async ({
    page,
  }) => {
    const { anchor, files, ids, path } = scratch();
    await openFirst(page);

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toContainText('1 photo');
    await confirmDelete(page);

    // The view moves on rather than dropping back to the timeline.
    await expect(page).toHaveURL(`${BASE}/photo/${ids[1]}`);
    await expect(page.locator('.lightbox__filename')).toHaveText(files[1]!);
    await expect(page.getByRole('status')).toContainText('1 photo deleted.');

    // Back does not land on the photo just trashed, which is a 404 now.
    await page.goBack();
    await expect(page).toHaveURL(path);

    await restoreFromTrash(page, files[0]!);
    await page.goto(path);
    await expect(page.locator(`${anchor} .photo-grid__item`)).toHaveCount(3);
  });

  test('the Delete key is the Delete button, and Cancel changes nothing', async ({
    page,
  }) => {
    const { anchor, files, path } = scratch();
    await openFirst(page);

    await page.keyboard.press('Backspace');
    await expect(page.getByRole('alertdialog')).toContainText('1 photo');
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Still on the same photo, and still in the library.
    await expect(page.locator('.lightbox__filename')).toHaveText(files[0]!);
    await page.goto(path);
    await expect(page.locator(`${anchor} .photo-grid__item`)).toHaveCount(3);
  });

  test('the confirmation owns the keyboard while it is up', async ({ page }) => {
    // Both handlers are on `window`, so without the photo view standing down
    // while something over it holds focus, Escape would cancel the dialog and
    // close the view behind it, and an arrow would move to a photo the
    // pending token is not for.
    const { files } = scratch();
    await openFirst(page);
    await page.keyboard.press('Backspace');
    await expect(page.getByRole('alertdialog')).toBeVisible();

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.lightbox__filename')).toHaveText(files[0]!);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('the undo offer outlives a navigation and then withdraws itself', async ({
    page,
  }) => {
    const { files } = scratch();
    await openFirst(page);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await confirmDelete(page);

    const banner = page.getByRole('status');
    await expect(banner).toBeVisible();

    // Advancing after a delete is itself a navigation, so nothing a
    // navigation does may retire the offer.
    await page.keyboard.press('ArrowRight');
    await expect(banner).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(banner).toBeVisible();

    // Only its own clock does.
    await expect(banner).toHaveCount(0, { timeout: 8_000 });

    await restoreFromTrash(page, files[0]!);
  });
});

/**
 * Adding photographs, through the real pipeline.
 *
 * The file dropped here is a genuine PNG and everything that happens to it is
 * genuine: the browser decodes it, converts it, encodes four artifacts with
 * the WebAssembly codecs, PUTs them, and commits. What is being tested is not
 * the pipeline — pipeline.spec.ts owns that, against real photographs — but
 * that a file becomes a curatable photograph the moment it is dropped rather
 * than when it lands.
 *
 * The photograph is deleted and purged at the end, so the fixture is left as
 * it was found.
 */
test.describe('adding photographs', () => {
  test('is a photograph on the page before it is a photograph on the server', async ({
    page,
  }) => {
    const { uploadDay, uploadFile } = scratch();
    await page.goto(`${BASE}/`);

    await page.locator('.drop-target__input').setInputFiles({
      name: uploadFile,
      mimeType: 'image/png',
      buffer: tinyPng(),
    });

    // A tile of its own, above the library, named after the file — with no
    // capture date, because a file with no EXIF has nothing to say about when
    // it was taken. Which is the photograph whose date most needs typing in.
    const pending = page.locator('.upload__pending');
    const tile = pending.locator('.photo-grid__item').filter({ hasText: uploadFile });
    await expect(tile).toHaveCount(1);

    // It opens into the library's own photo view and the library's own form.
    await tile.locator('.photo-grid__link').click();
    await expect(page.locator('.lightbox')).toBeVisible();
    await expect(page.locator('.lightbox__filename')).toHaveText(uploadFile);
    await expect(page.getByLabel('Capture date')).toHaveValue('');

    // Editing is all it offers: there are no stored bytes to download and no
    // catalog record to delete.
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(
      0,
    );

    await page.getByLabel('Capture date').fill(uploadDay);
    await page.getByLabel('Caption').fill('Typed on the way up.');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved')).toBeVisible();

    await page.keyboard.press('Escape');

    // Whether that landed in the commit or as an edit just after it is not
    // something the page ever says, and is not something to depend on: what
    // has to hold is that the photograph is in the library, on the day it was
    // given, with the caption it was given.
    const [year, month, date] = uploadDay.split('-');
    await page.goto(`${BASE}/${year}/${month}/${date}`);
    const landed = page
      .locator(`#d-${uploadDay} .photo-grid__item`)
      .filter({ hasText: uploadFile });
    await expect(landed).toHaveCount(1);

    await landed.locator('.photo-grid__link').click();
    await expect(page.getByLabel('Caption')).toHaveValue('Typed on the way up.');

    // Put the fixture back the way it was found: out of the library, and out
    // of the trash behind it.
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await confirmDelete(page);
    await expect(page.getByRole('status')).toContainText('1 photo deleted.');

    await page.goto(`${BASE}/trash`);
    const trashed = page.locator('.photo-grid__item').filter({ hasText: uploadFile });
    await trashed.locator('.photo-grid__link').click({ modifiers: ['ControlOrMeta'] });
    await page.getByRole('button', { name: 'Delete permanently' }).click();
    await confirmDelete(page, 'Delete permanently');
    await expect(trashed).toHaveCount(0);
  });
});

test.describe('the trash', () => {
  test('shows what is needed to identify a photo, and no download', async ({
    page,
  }) => {
    const { trashedFile, dayHeading } = scratch();
    await page.goto(`${BASE}/trash`);

    // This project's own trashed photo; the other project's sits beside it.
    const item = page.locator('.photo-grid__item').filter({ hasText: trashedFile });
    await expect(item).toBeVisible();
    await expect(item.locator('img')).toBeVisible();
    await expect(item).toContainText(`${dayHeading}, 2026`);
    await expect(item).toContainText(/Deleted \w+ \d+, \d{4}, purged \w+ \d+, \d{4}/);

    // A trashed photo shows enough to be identified, and nothing more.
    await expect(page.getByRole('button', { name: /Download/ })).toHaveCount(0);
  });

  test('opens a photo on the signed preview, with no way to edit it', async ({
    page,
  }) => {
    const { trashedFile } = scratch();
    await page.goto(`${BASE}/trash`);
    await page
      .locator('.photo-grid__item')
      .filter({ hasText: trashedFile })
      .locator('.photo-grid__link')
      .click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // The route does not change: a trashed photo's own URL is a 404.
    await expect(page).toHaveURL(`${BASE}/trash`);
    await expect(page.locator('.lightbox__image')).toHaveAttribute(
      'src',
      /\/d\/[0-9a-f]{32}\/display-1280/,
    );

    await expect(page.getByRole('button', { name: 'Photo info' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByLabel('Caption')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('requires an explicit confirmation to delete permanently', async ({ page }) => {
    await page.goto(`${BASE}/trash`);
    await page
      .locator('.photo-grid__item')
      .filter({ hasText: scratch().trashedFile })
      .locator('.photo-grid__link')
      .click({ modifiers: ['ControlOrMeta'] });

    await page.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('cannot be undone');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });

  test('restores a photo back into its day', async ({ page }) => {
    const { anchor, path, trashedFile } = scratch();
    const mine = page.locator('.photo-grid__item').filter({ hasText: trashedFile });

    await page.goto(`${BASE}/trash`);
    await mine.locator('.photo-grid__link').click({ modifiers: ['ControlOrMeta'] });
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(mine).toHaveCount(0);

    // It is back in the day it belongs to.
    await page.goto(path);
    await expect(page.locator(`${anchor} .photo-grid__item`)).toHaveCount(4);

    // Put the fixture back the way it was found.
    await page
      .locator(`${anchor} .photo-grid__item`)
      .filter({ hasText: trashedFile })
      .locator('.photo-grid__link')
      .click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await confirmDelete(page);
    await expect(page.getByRole('status')).toContainText('1 photo deleted.');
  });
});
