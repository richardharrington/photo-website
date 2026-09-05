import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The Notifications page, against the local fixture server.
 *
 * The fake stands in for Cloudflare's destination-address list, and fakes the
 * one step a test cannot perform — clicking a link in somebody's real mailbox.
 * An address whose local part begins with `pending` never verifies; every other
 * address verifies the moment it is added. Both states have to be reachable
 * from here, and that convention is what makes them so.
 *
 * Nothing in this file sends mail. `/notifications/test` reaches the fixture's
 * stand-in for the Worker's `POST /notify/test`, which computes the same count
 * and sends nothing.
 */

const BASE = 'http://localhost:5174/dev-admin-path';

// Chromium only. The page is a form and a table with no engine-specific
// behaviour, and the fixture's address list is one shared process — running the
// same add-and-remove in two projects at once would be a race for no coverage.
test.describe.configure({ mode: 'serial' });
test.skip(({ browserName }) => browserName !== 'chromium', 'chromium only');

/** Addresses this file owns. Removed again at the end of each test. */
const VERIFIED = 'aunt@example.test';
const PENDING = 'pending-uncle@example.test';

const row = (page: Page, email: string) =>
  page.locator('.notifications tbody tr').filter({ hasText: email });

async function add(page: Page, email: string) {
  await page.getByLabel('Add an address').fill(email);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(row(page, email)).toHaveCount(1);
}

async function remove(page: Page, email: string) {
  const target = row(page, email);
  if ((await target.count()) === 0) return;
  await target.getByRole('button', { name: 'Remove' }).click();
  const dialog = page.getByRole('alertdialog');
  // The confirmation names the address, not a count of things.
  await expect(dialog).toContainText(email);
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(target).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.goto(`${BASE}/notifications`);
  await expect(page.getByLabel('Add an address')).toBeVisible();
});

test.afterEach(async ({ page }) => {
  // The fixture's list is shared process state; leave it as it was found.
  await page.goto(`${BASE}/notifications`);
  await remove(page, VERIFIED);
  await remove(page, PENDING);
});

test('is reachable from the header of every other admin page', async ({ page }) => {
  await page.goto(`${BASE}/`);
  const link = page.getByRole('link', { name: 'Notifications' });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(`${BASE}/notifications`);
  await expect(page.getByLabel('Add an address')).toBeVisible();
});

test('shows a newly added address as verified, and a pending one as not', async ({
  page,
}) => {
  await add(page, VERIFIED);
  await expect(row(page, VERIFIED)).toContainText('Verified');
  // The note that explains what happens next, and why nothing has been sent.
  await expect(page.getByText(/link to confirm/)).toBeVisible();

  await add(page, PENDING);
  await expect(row(page, PENDING)).toContainText('Awaiting verification');

  // Neither control does anything for an address nobody has confirmed.
  await expect(row(page, PENDING).getByRole('switch')).toBeDisabled();
  await expect(
    row(page, PENDING).getByRole('button', { name: 'Send test' }),
  ).toBeDisabled();
});

test('starts a new address switched on, and has never sent to it', async ({ page }) => {
  await add(page, VERIFIED);
  await expect(row(page, VERIFIED).getByRole('switch')).toBeChecked();
  await expect(row(page, VERIFIED)).toContainText('Never');
});

test('switches an address off and on again', async ({ page }) => {
  await add(page, VERIFIED);
  const toggle = row(page, VERIFIED).getByRole('switch');

  // A click, not `uncheck()`: the switch is controlled by the refetched list
  // rather than by the click, so a helper that clicks until the box agrees
  // would click twice and land back where it started.
  await toggle.click();
  await expect(row(page, VERIFIED)).toContainText('Off');
  await expect(toggle).not.toBeChecked();

  await toggle.click();
  await expect(row(page, VERIFIED)).toContainText('On');
  await expect(toggle).toBeChecked();
});

test('sends a test and reports the result on the row', async ({ page }) => {
  await add(page, VERIFIED);
  await row(page, VERIFIED).getByRole('button', { name: 'Send test' }).click();

  // Enabling starts the clock at that moment, so a library that was already
  // there is not new to this address — which is exactly the point.
  await expect(row(page, VERIFIED)).toContainText('Sent: no new photos');
  // It reports in place; it never navigates.
  await expect(page).toHaveURL(`${BASE}/notifications`);
});

test('removes an address after naming it in the confirmation', async ({ page }) => {
  await add(page, VERIFIED);
  await remove(page, VERIFIED);
  await expect(row(page, VERIFIED)).toHaveCount(0);
});

test('refuses an address that is not one, and says why', async ({ page }) => {
  // A dotless domain: the browser's own `type="email"` check accepts it, so
  // this reaches the API and exercises the server's validation rather than
  // the field's.
  await page.getByLabel('Add an address').fill('aunt@localhost');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  await expect(page.getByRole('alert')).toContainText('not an email address');
  // Refused before it reached Cloudflare: no row, and no confirmation email.
  await expect(row(page, 'aunt@localhost')).toHaveCount(0);
  await expect(page.getByText(/link to confirm/)).toHaveCount(0);
});

test('is a 404 under the display path', async ({ page }) => {
  // `notifications` is admin vocabulary. The viewer's parser is never given
  // it, so the page cannot exist there — nor can its code be in that bundle.
  await page.goto('http://localhost:5173/dev-display-path/notifications');
  await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();

  const response = await page.goto('http://localhost:5173/dev-display-path/');
  expect((await response?.text()) ?? '').not.toContain('Notifications');
});
