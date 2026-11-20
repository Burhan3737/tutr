/**
 * 01 Navigation · phone layout (≤ 760 px): NAV-101, and the phone parts of NAV-046, NAV-047, NAV-050, NAV-076, NAV-077.
 * Runs in the "mobile" project (Pixel 7, touch).
 *
 * // Not covered: NAV-047 "taps are ignored while the page is pinch-zoomed" (browser pinch-zoom can't be driven reliably)
 * // Not covered: NAV-101 the tutor as a bar at the bottom / chat below the slide when open (tutor area)
 */
import { test, expect } from '../../fixtures/hub';
import { DEMO, SD1_HASH, seedWith, addSD2, main } from './helpers';

const counter = (page) => page.locator('#counter-m');            // locator: markup hook (the phone counter)
const phonePrev = (page) => page.getByRole('button', { name: 'Previous slide', exact: true });
const phoneNext = (page) => page.getByRole('button', { name: 'Next slide', exact: true });
const sidebar = (page) => page.getByRole('complementary', { name: 'Topics' });
const scrim = (page) => page.locator('#nav-scrim');              // locator: markup hook (the dimmed backdrop)

async function swipe(page, dx: number) {
  await page.evaluate((dx) => {
    const el = document.querySelector('#stage-main')!;
    const t = (x: number, y: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [t(200, 300)], changedTouches: [t(200, 300)], bubbles: true }));
    el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t(200 + dx, 305)], bubbles: true }));
  }, dx);
}

test.describe('NAV-101 phone viewer', () => {
  test('NAV-101 NAV-076 brand hidden; the slide on top, a footer with ‹ n / N › and Text; side arrows hidden', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=2`);
    await expect(counter(page)).toHaveText('2 / 3');
    await expect(page.getByRole('link', { name: 'Tutr home' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Show or hide the topics sidebar' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Previous slide (←)' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Next slide (→)' })).toBeHidden();
    await expect(phonePrev(page)).toBeVisible();
    await expect(phoneNext(page)).toBeVisible();
    await expect(page.locator('#text-btn')).toBeVisible();          // locator: markup hook
    const img = (await page.getByRole('img', { name: /^Slide 2/ }).boundingBox())!;
    const foot = (await counter(page).boundingBox())!;
    expect(foot.y).toBeGreaterThanOrEqual(img.y + img.height - 1);
    await phoneNext(page).click();
    await expect(counter(page)).toHaveText('3 / 3');
    await phonePrev(page).click();
    await expect(counter(page)).toHaveText('2 / 3');
  });

  test('NAV-047 a tap on the right half goes forward, on the left half back', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=2`);
    const img = page.getByRole('img', { name: /^Slide 2/ });
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(900);
    const box = (await img.boundingBox())!;
    await img.tap({ position: { x: box.width - 10, y: box.height / 2 } });
    await expect(counter(page)).toHaveText('3 / 3');
    const img3 = page.getByRole('img', { name: /^Slide 3/ });
    await img3.tap({ position: { x: 10, y: box.height / 2 } });
    await expect(counter(page)).toHaveText('2 / 3');
  });

  test('NAV-047 a left swipe goes forward, a right swipe back; short or vertical swipes do nothing', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=1`);
    await expect(counter(page)).toHaveText('1 / 3');
    await swipe(page, -120);
    await expect(counter(page)).toHaveText('2 / 3');
    await swipe(page, 120);
    await expect(counter(page)).toHaveText('1 / 3');
    await swipe(page, -30);
    await expect(counter(page)).toHaveText('1 / 3');
    await expect(page).toHaveURL(/s=1$/);
  });

  test('NAV-050 on phones double-tapping does not toggle the 2x view (the browser\'s pinch-zoom is used)', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=1`);
    const img = page.getByRole('img', { name: /^Slide 1/ });
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(900);
    await page.locator('#stage-main').dispatchEvent('dblclick');
    await expect(page.locator('#stage-main')).not.toHaveClass(/zoomed/);
  });

  test('NAV-046 NAV-101 on phones the Text panel is a bottom sheet over about 70% of the screen', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=2`);
    await page.locator('#text-btn').click();
    const sheet = page.locator('#transcript');                     // locator: markup hook
    await expect(sheet.getByRole('heading')).toHaveText('Slide 2 · Demand and supply curves');
    const vp = page.viewportSize()!;
    const b = (await sheet.boundingBox())!;
    expect(b.y + b.height).toBeGreaterThanOrEqual(vp.height - 2);
    expect(b.height / vp.height).toBeGreaterThan(0.6);
    expect(b.height / vp.height).toBeLessThan(0.8);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });
});

test.describe('NAV-077 phone sidebar', () => {
  test.use({ seed: seedWith((hub) => addSD2(hub)) });

  test('NAV-077 starts closed (even if left open on desktop); opens over the page with a backdrop; backdrop, link or Escape closes it', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('navOpen', 'true'));
    await page.goto(`/#c=${DEMO}`);
    await expect(page.getByRole('heading', { level: 1, name: DEMO })).toBeVisible();
    await expect(sidebar(page)).toBeHidden();
    const nav = page.getByRole('button', { name: 'Show or hide the topics sidebar' });
    await nav.click();
    await expect(sidebar(page)).toBeVisible();
    await expect(scrim(page)).toBeVisible();
    // Over the page: the page does not move aside.
    expect((await main(page).boundingBox())!.x).toBeLessThan((await sidebar(page).boundingBox())!.width);
    const vp = page.viewportSize()!;
    await page.mouse.click(vp.width - 8, vp.height / 2);            // the backdrop, right of the sidebar
    await expect(sidebar(page)).toBeHidden();
    await nav.click();
    await page.keyboard.press('Escape');
    await expect(sidebar(page)).toBeHidden();
    await nav.click();
    await sidebar(page).getByRole('link', { name: /S&D-2/ }).click();
    await expect(sidebar(page)).toBeHidden();
    await expect(counter(page)).toHaveText('1 / 3');
    // Not remembered on phones.
    await nav.click();
    await page.reload();
    await expect(counter(page)).toHaveText('1 / 3');
    await expect(sidebar(page)).toBeHidden();
  });
});
