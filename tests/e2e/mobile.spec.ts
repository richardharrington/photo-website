import { test, expect } from '@playwright/test';

/**
 * The viewer is responsive on current mobile Safari/Chrome. Admin workflows
 * are laptop-oriented and are deliberately not covered here.
 */

const BASE = '/dev-display-path';

test('the day grid fits the viewport without horizontal scrolling', async ({
  page,
}) => {
  await page.goto(`${BASE}/2026/08/02`);
  await expect(page.locator('.photo-grid__item')).toHaveCount(6);

  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflows).toBe(false);
});

test('the lightbox is usable on a phone', async ({ page }) => {
  await page.goto(`${BASE}/2026/08/02`);
  await page.locator('.photo-grid__link').first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('1 of 6');

  // Touch targets stay reachable at phone width.
  const next = page.getByRole('button', { name: 'Next photo' });
  await expect(next).toBeVisible();
  const box = await next.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(40);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);

  await next.click();
  await expect(dialog).toContainText('2 of 6');

  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflows).toBe(false);
});

test('navigation works at phone width', async ({ page }) => {
  await page.goto(`${BASE}/`);

  await page.getByRole('link', { name: /^2026/ }).click();
  await page.getByRole('link', { name: /^August/ }).click();
  await page.getByRole('link', { name: /^August 2, 2026/ }).click();

  await expect(page).toHaveURL(`${BASE}/2026/08/02`);
  await expect(page.locator('.photo-grid__item')).toHaveCount(6);
});
