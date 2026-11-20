/**
 * 01 Navigation · C. Routes / deep links (NAV-031 … NAV-033, and the route table).
 */
import { test, expect } from '../../fixtures/hub';
import { DEMO, SD1_HASH, addSD2, hubState, seedWith, atSlide, blur, crumbs, main } from './helpers';

const NOTES = 'me%2Fnotes%2FWeek1%2Fnotes.md';

test.describe('route table', () => {
  test('NAV-031 every route can be opened directly and reloaded: home, course, topic, deck, notes', async ({ page }) => {
    await page.goto('/#');
    await expect(page.getByRole('button', { name: 'Start session · Demo-Course' })).toBeVisible();
    await page.goto(`/#c=${DEMO}`);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: DEMO })).toBeVisible();
    await page.goto(`/${SD1_HASH}&s=2`);
    await page.reload();
    await atSlide(page, '2 / 3');
    await page.goto(`/#c=${DEMO}&notes=${NOTES}`);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Week 1 notes' })).toBeVisible();
  });

  test('NAV-031 NAV-062 #c=<course>&t=<topic> opens the course page with that topic expanded; t=Practice the practice list', async ({ page }) => {
    await page.goto(`/#c=${DEMO}&t=Supply+and+Demand`);
    await expect(page.getByRole('button', { name: /Supply and Demand/ })).toHaveAttribute('aria-expanded', 'true');
    await page.goto(`/#c=${DEMO}&t=Practice`);
    await page.reload();
    const practice = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Practice' }) });
    await expect(practice).toHaveClass(/open/);            // locator: markup hook (the practice list has no toggle)
    await expect(practice.getByRole('link', { name: /HW-1 · Homework 1/ })).toBeInViewport();
  });
});

test.describe('NAV-031 route precedence', () => {
  test('NAV-031 upload wins over everything', async ({ page }) => {
    await page.goto(`/#upload=ask-${DEMO}&chat=x&review=${DEMO}&c=${DEMO}&d=S%26D-1&notes=${NOTES}`);
    await expect(main(page)).toContainText('Take a photo of your page.');
    await expect(crumbs(page)).toHaveText('Send a photo');
  });

  test('NAV-031 chat wins over review, viewer, notes and course', async ({ page }) => {
    await page.goto(`/#chat=no-such-chat&review=${DEMO}&c=${DEMO}&d=S%26D-1&notes=${NOTES}`);
    await expect(page.locator('#main p.err')).toBeVisible();     // locator: markup hook (error page); the chat route ran
    await expect(page.locator('#counter')).toHaveCount(0);
    await expect(crumbs(page)).not.toContainText('Reviews');
  });

  test('NAV-031 review wins over the viewer', async ({ page }) => {
    await page.goto(`/#review=${DEMO}&c=${DEMO}&d=S%26D-1&s=2`);
    await expect(crumbs(page)).toHaveText(/Home›Demo-Course›Reviews/);
    await expect(page.locator('#counter')).toHaveCount(0);
  });

  test('NAV-031 viewer wins over notes; notes over course page; course page over step=note', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=2&notes=${NOTES}&step=note`);
    await atSlide(page, '2 / 3');
    await page.goto(`/#c=${DEMO}&notes=${NOTES}&step=note`);
    await expect(page.getByRole('heading', { level: 1, name: 'Week 1 notes' })).toBeVisible();
    await page.goto(`/#c=${DEMO}&step=note`);
    await expect(page.getByRole('heading', { level: 1, name: DEMO })).toBeVisible();
  });
});

test.describe('NAV-032 slide number normalisation', () => {
  test.use({ seed: seedWith((hub) => hubState(hub, DEMO, { decks: { 'S&D-1': { seen: [2], last: 2, read: false, solved: false } } })) });

  test('NAV-032 s is clamped to 1…pages+1 and the address bar shows the slide actually shown', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=99`);
    await expect(page.getByRole('heading', { name: 'End of S&D-1' })).toBeVisible();
    await expect(page).toHaveURL(/#c=Demo-Course&d=S%26D-1&s=4$/);
    await page.goto(`/${SD1_HASH}&s=-3`);
    await atSlide(page, '1 / 3');
    await expect(page).toHaveURL(/&s=1$/);
  });

  test('NAV-032 a missing, zero or non-numeric s opens the deck at its last viewed slide', async ({ page }) => {
    for (const s of ['', '&s=0', '&s=abc']) {
      await page.goto('/#');
      await expect(page.getByRole('button', { name: /Start session/ })).toBeVisible();
      await page.goto(`/${SD1_HASH}${s}`);
      await atSlide(page, '2 / 3');
      await expect(page).toHaveURL(/#c=Demo-Course&d=S%26D-1&s=2$/);
    }
  });
});

test.describe('NAV-033 back and forward', () => {
  test.use({ seed: seedWith((hub) => addSD2(hub)) });

  test('NAV-033 pages add history entries; slides within a deck do not', async ({ page }) => {
    await page.goto('/#');
    await page.getByRole('link', { name: /Demo-Course Introductory Economics/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: DEMO })).toBeVisible();
    await page.getByRole('link', { name: /S&D-1 · Supply and demand 1/ }).click();
    await atSlide(page, '1 / 3');
    await blur(page);
    await page.keyboard.press('ArrowRight');
    await page.getByRole('button', { name: 'Next slide (→)' }).click();
    await atSlide(page, '3 / 3');
    await expect(page).toHaveURL(/s=3$/);
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: DEMO })).toBeVisible();
    await page.goForward();
    await atSlide(page, '3 / 3');
    await expect(page).toHaveURL(/S%26D-1&s=3$/);
  });

  test('NAV-033 moving to the next deck adds an entry; Back returns to the previous deck', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=3`);
    await atSlide(page, '3 / 3');
    await blur(page);
    await page.keyboard.press('ArrowRight');                       // end card (no entry)
    await expect(page.getByRole('heading', { name: 'End of S&D-1' })).toBeVisible();
    await page.keyboard.press('ArrowRight');                       // next deck (an entry)
    await expect(page).toHaveURL(/S%26D-2&s=1$/);
    await atSlide(page, '1 / 3');
    await page.goBack();
    await expect(page).toHaveURL(/S%26D-1&s=4$/);
    await expect(page.getByRole('heading', { name: 'End of S&D-1' })).toBeVisible();
  });

  test('NAV-033 a search result, a notes page and the sidebar slide list: entries vs in-place', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    await page.getByRole('link', { name: 'W1', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Week 1 notes' })).toBeVisible();
    await page.keyboard.press('Control+k');
    await page.getByRole('searchbox', { name: 'Search all slides' }).fill('elasticity');
    await page.getByRole('link', { name: /S&D-1 s3/ }).click();
    await atSlide(page, '3 / 3');
    // The sidebar's slide list changes slide in place.
    await page.getByRole('button', { name: 'Show or hide the topics sidebar' }).click();
    await page.getByRole('complementary', { name: 'Topics' }).getByRole('link', { name: /^1\s*Supply and demand 1$/ }).click();
    await atSlide(page, '1 / 3');
    await expect(page).toHaveURL(/S%26D-1&s=1$/);
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: 'Week 1 notes' })).toBeVisible();
  });
});
