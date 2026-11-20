/**
 * 01 Navigation · K. Layout and theme (desktop) and L. Errors and empty states (NAV-090, NAV-093, NAV-095 … NAV-104).
 * The phone layout (NAV-101) is in layout.mobile.spec.ts.
 *
 * // Not covered: NAV-110 NAV-111 NAV-112 NAV-113 (starting the hub: closing other hubs, port fallback, Wi-Fi/tunnel
 * //   modes, opening the browser. The harness starts the app its own way on a free port; exercising the real start-up
 * //   would kill any Tutr the user is running and needs cloudflared/internet for tunnels)
 */
import * as fs from 'fs';
import { test, expect } from '../../fixtures/hub';
import { DEMO, SD1_HASH, addCourse, addDeck, seedWith, atSlide, blur, crumbs, main } from './helpers';

const err = (page) => page.locator('#main p.err');     // locator: markup hook (error page)

test.describe('NAV-090 empty library', () => {
  test.use({ seed: seedWith((hub) => fs.rmSync(hub.path(DEMO, 'course.json'))) });
  test('NAV-090 with no course.json anywhere: no next-test line, no Start session, an empty course list', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#main .courses')).toHaveCount(1);   // locator: markup hook (home rendered)
    await expect(page.locator('#main .courses a')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Start session/ })).toHaveCount(0);
    await expect(main(page)).not.toContainText('No upcoming tests');
  });
});

test.describe('NAV-093 missing slide image', () => {
  test.use({ seed: seedWith((hub) => fs.rmSync(hub.path(DEMO, 'decks', 'SD-1', 's002.jpg'))) });
  test('NAV-093 a missing image leaves an empty slide area (no broken icon); counter, arrows and text still work', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=2`);
    await atSlide(page, '2 / 3');
    const img = page.getByRole('img', { name: 'Slide 2: Demand and supply curves' });
    await expect(img).toBeAttached();
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete)).toBe(true);
    expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(0);
    expect(Number(await img.evaluate((i) => getComputedStyle(i).opacity))).toBeLessThan(0.01);
    await page.locator('#text-btn').click();                       // locator: markup hook
    await expect(page.locator('#transcript').getByRole('heading')).toHaveText('Slide 2 · Demand and supply curves');
    await page.getByRole('button', { name: 'Next slide (→)' }).click();
    await atSlide(page, '3 / 3');
    await expect(page.getByRole('img', { name: 'Slide 3: Price elasticity' })).toBeVisible();
  });
});

test.describe('NAV-095 caching', () => {
  test('NAV-095 slide images may be cached for up to an hour; every other reply is always fetched fresh', async ({ api }) => {
    const img = await api.get('/api/slide?course=Demo-Course&tag=S%26D-1&n=1');
    expect(img.headers()['cache-control']).toBe('max-age=3600');
    for (const u of ['/api/home', `/api/course?id=${DEMO}`, `/api/deck?course=${DEMO}&tag=S%26D-1`, '/api/search?q=elast',
      `/api/note?course=${DEMO}&path=me%2Fnotes%2FWeek1%2Fnotes.md`, '/']) {
      expect((await api.get(u)).headers()['cache-control'], u).toBe('no-store');
    }
  });
});

test.describe('NAV-096 NAV-097 unknown course or deck', () => {
  test('NAV-096 #c=<unknown> shows "Unknown course." for the course, deck and notes routes; header and sidebar still work', async ({ page }) => {
    for (const h of ['#c=Nope', '#c=Nope&d=S%26D-1&s=1', '#c=Nope&notes=me%2Fnotes%2FWeek1%2Fnotes.md']) {
      await page.goto('/#');
      await expect(page.getByRole('button', { name: /Start session/ })).toBeVisible();
      await page.goto(`/${h}`);
      // Pinned as-is, KNOWN DEFECT: on the deck route the page asks for the course and the deck at once and shows
      // whichever error lands last, so an unknown course sometimes reads "Unknown deck." (about 1 run in 10).
      // Intended: always "Unknown course." (docs/functional-spec/README.md, known defects).
      if (h.includes('&d=')) await expect(err(page)).toHaveText(/^Unknown (course|deck)\.$/);
      else await expect(err(page)).toHaveText('Unknown course.');
    }
    await page.getByRole('button', { name: 'Show or hide the topics sidebar' }).click();
    await expect(page.getByRole('complementary', { name: 'Topics' })).toBeVisible();
    await page.keyboard.press('Control+k');
    await page.getByRole('searchbox', { name: 'Search all slides' }).fill('elasticity');
    await page.locator('#search-results a').first().click();      // locator: markup hook
    await atSlide(page, '3 / 3');
  });

  test('NAV-097 #c=<course>&d=<unknown> shows "Unknown deck."', async ({ page }) => {
    await page.goto(`/#c=${DEMO}&d=NOPE&s=1`);
    await expect(err(page)).toHaveText('Unknown deck.');
    await page.getByRole('link', { name: 'Tutr home' }).click();
    await expect(page.getByRole('button', { name: /Start session/ })).toBeVisible();
  });
});

test.describe('NAV-098 deck with no slides', () => {
  test.use({
    seed: seedWith((hub) => {
      addDeck(hub, DEMO, 'ZERO', { tag: 'ZERO', title: 'No pages', topic: 'Supply and Demand', week: 4, pages: 0 }, { transcript: null });
      addDeck(hub, DEMO, 'NOPG', { tag: 'NOPG', title: 'Pages missing', topic: 'Supply and Demand', week: 5 }, { transcript: null });
    }),
  });
  test('NAV-098 a deck whose pages is 0 or missing opens on its end card, counter 0 / 0', async ({ page }) => {
    for (const tag of ['ZERO', 'NOPG']) {
      await page.goto('/#');
      await expect(page.getByRole('button', { name: /Start session/ })).toBeVisible();
      await page.goto(`/#c=${DEMO}&d=${tag}`);
      await expect(page.getByRole('heading', { name: `End of ${tag}` })).toBeVisible();
      await atSlide(page, '0 / 0');
    }
  });
});

test.describe('NAV-099 hub not reachable', () => {
  test('NAV-099 if the hub stops, the next navigation says so', async ({ page, hub }) => {
    await page.goto(`/#c=${DEMO}`);
    await expect(page.getByRole('heading', { level: 1, name: DEMO })).toBeVisible();
    await hub.stop();
    await crumbs(page).getByRole('link', { name: 'Home' }).click();
    await expect(err(page)).toHaveText("The hub isn't responding. Start it again with start.bat, then retry.");
  });
});

test.describe('NAV-100 theme', () => {
  test('NAV-100 colours follow the system light/dark setting', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start session/ })).toBeVisible();
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(await bg()).toBe('rgb(250, 249, 247)');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(bg).toBe('rgb(22, 21, 26)');
    await expect(page.getByRole('button', { name: /theme|dark|light/i })).toHaveCount(0);
  });

  test('NAV-100 reduced motion turns animations and transitions off', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/${SD1_HASH}&s=1`);
    await atSlide(page, '1 / 3');
    const durations = await page.evaluate(() => [...document.querySelectorAll('*')].map((e) => {
      const s = getComputedStyle(e);
      return [s.transitionDuration, s.animationDuration];
    }).flat().filter((d) => d.split(',').some((x) => parseFloat(x) > 0.01)));
    expect(durations).toEqual([]);
  });
});

test.describe('NAV-102 desktop layout', () => {
  test('NAV-102 side arrows, counter and Text under the slide; the tutor opens as a panel on the right; sidebar beside the page', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=1`);
    await atSlide(page, '1 / 3');
    await expect(page.getByRole('button', { name: 'Previous slide (←)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next slide (→)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next slide', exact: true })).toBeHidden();   // the phone footer arrows
    const img = (await page.getByRole('img', { name: /^Slide 1/ }).boundingBox())!;
    const counter = (await page.locator('#counter').boundingBox())!;
    expect(counter.y).toBeGreaterThan(img.y + img.height - 1);
    await expect(page.getByRole('link', { name: 'Tutr home' })).toBeVisible();
    await page.getByRole('button', { name: 'Open the tutor' }).click();
    const tutor = page.getByRole('complementary', { name: 'Tutor' });
    await expect(tutor.getByRole('heading', { name: 'Tutor' })).toBeVisible();
    const t = (await tutor.boundingBox())!;
    expect(t.x).toBeGreaterThan(img.x);
    await expect(page.getByRole('separator', { name: /Resize the tutor panel/ })).toBeVisible();
    // The sidebar sits beside the page: the page moves over, no dimmed backdrop.
    const before = (await page.locator('main').boundingBox())!.x;
    await page.getByRole('button', { name: 'Show or hide the topics sidebar' }).click();
    const nav = (await page.getByRole('complementary', { name: 'Topics' }).boundingBox())!;
    await expect.poll(async () => (await page.locator('main').boundingBox())!.x).toBeGreaterThan(before);
    expect((await page.locator('main').boundingBox())!.x).toBeGreaterThanOrEqual(nav.x + nav.width - 1);
    await expect(page.locator('#nav-scrim')).toBeHidden();         // locator: markup hook (phone backdrop)
  });
});

test.describe('NAV-103 title and icon', () => {
  test('NAV-103 the tab title is Tutr, with a blue rounded-square icon', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('Tutr');
    const icon = decodeURIComponent((await page.locator('link[rel="icon"]').getAttribute('href'))!);
    expect(icon).toMatch(/^data:image\/svg\+xml,/);
    expect(icon).toMatch(/<rect[^>]*rx="\d+"[^>]*fill="#2f5bb7"/);
  });
});

test.describe('NAV-104 course with no decks', () => {
  test.use({ seed: seedWith((hub) => addCourse(hub, 'Aaa-Empty', { code: 'EMPTY 1', title: 'No decks yet', topics: [{ name: 'Listed' }] })) });
  test('NAV-104 the course page shows its title and Start session only; home\'s resume line is just "Nothing due."', async ({ page }) => {
    await page.goto('/#c=Aaa-Empty');
    await expect(page.getByRole('heading', { level: 1, name: 'EMPTY 1' })).toBeVisible();
    await expect(main(page)).toContainText('No decks yet');
    await expect(page.getByRole('button', { name: 'Start session', exact: true })).toBeVisible();
    await expect(page.locator('.topics section')).toHaveCount(0);   // locator: markup hook
    await expect(page.getByRole('link', { name: /Continue reading/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Exam drill ›' })).toHaveCount(0);
    await expect(main(page)).toContainText('Nothing due.');
    await expect(page.getByRole('link', { name: /Pick up at/ })).toHaveCount(0);
    await page.goto('/');
    // The first course (by folder) is suggested when nothing is dated.
    await expect(page.getByRole('button', { name: 'Start session · EMPTY 1' })).toBeVisible();
    await expect(page.locator('#main p').nth(1)).toHaveText('Nothing due.');
  });
});

test.describe('NAV-047 NAV-079 keys outside the viewer', () => {
  test('NAV-079 "[" toggles the sidebar on any page; slide keys do nothing outside the viewer', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    await expect(page.getByRole('heading', { level: 1, name: DEMO })).toBeVisible();
    await blur(page);
    await page.keyboard.press('[');
    await expect(page.getByRole('complementary', { name: 'Topics' })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(/#c=Demo-Course$/);
  });
});
