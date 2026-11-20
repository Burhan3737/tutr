/**
 * 01 Navigation · H. Header, sidebar and search, keyboard summary (NAV-076 … NAV-079). Desktop; the phone sidebar is in
 * chrome.mobile.spec.ts.
 */
import { test, expect } from '../../fixtures/hub';
import { DEMO, SD1_HASH, addCourse, addDeck, transcript, seedWith, atSlide, blur, crumbs, main } from './helpers';

const sidebar = (page) => page.getByRole('complementary', { name: 'Topics' });
const navBtn = (page) => page.getByRole('button', { name: 'Show or hide the topics sidebar' });
const searchBox = (page) => page.getByRole('searchbox', { name: 'Search all slides' });
const results = (page) => page.locator('#search-results a');   // locator: markup hook (search results list)
const stage = (page) => page.locator('#stage-main');           // locator: markup hook

test.describe('NAV-076 header', () => {
  test('NAV-076 sidebar toggle, Tutr brand linking home, crumbs (empty on home), search and ⋯ buttons', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    await expect(navBtn(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Search all slides (Ctrl K)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'More' })).toBeVisible();
    const brand = page.getByRole('link', { name: 'Tutr home' });
    await expect(brand).toHaveText('Tutr');
    await brand.click();
    await expect(page.getByRole('button', { name: /Start session/ })).toBeVisible();
    await expect(crumbs(page)).toBeEmpty();
  });
});

test.describe('NAV-077 topics sidebar (desktop)', () => {
  test.use({
    seed: seedWith((hub) => {
      addDeck(hub, DEMO, 'EL-1', { tag: 'EL-1', title: 'Elasticity deck', topic: 'Elasticity', week: 3, order: 1, pages: 2 });
    }),
  });

  test('NAV-077 toggled by ☰ and "[" (not while typing); open/closed is remembered across reloads', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    await expect(sidebar(page)).toBeHidden();
    await expect(navBtn(page)).toHaveAttribute('aria-expanded', 'false');
    await navBtn(page).click();
    await expect(sidebar(page)).toBeVisible();
    await expect(navBtn(page)).toHaveAttribute('aria-expanded', 'true');
    await page.reload();
    await expect(sidebar(page)).toBeVisible();
    await blur(page);
    await page.keyboard.press('[');
    await expect(sidebar(page)).toBeHidden();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: DEMO })).toBeVisible();
    await expect(sidebar(page)).toBeHidden();
    // Not while typing.
    await page.keyboard.press('Control+k');
    await searchBox(page).press('[');
    await expect(searchBox(page)).toHaveValue('[');
    await expect(sidebar(page)).toBeHidden();
  });

  test('NAV-077 inside a course: the course, its topics with solved/total, deck links to their last slide, then Practice', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    await navBtn(page).click();
    const nav = sidebar(page);
    await expect(nav.getByRole('link', { name: /Demo-Course\s*Introductory Economics \(demo\)/ })).toHaveAttribute('href', `#c=${DEMO}`);
    const groups = nav.locator('details');                         // locator: markup hook (collapsible topic groups)
    await expect(groups.locator('summary')).toHaveText([/Supply and Demand\s*0\/1/, /Elasticity\s*0\/1/]);
    // One course shown and no deck open: every group starts expanded.
    for (const g of await groups.all()) await expect(g).toHaveAttribute('open', '');
    const deck = nav.getByRole('link', { name: /S&D-1\s*Supply and demand 1\s*W1/ });
    await expect(deck).toHaveAttribute('href', '#c=Demo-Course&d=S%26D-1&s=1');
    await expect(nav.getByText('Practice', { exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: /HW-1\s*Homework 1\s*W1/ })).toBeVisible();
    await deck.click();
    await atSlide(page, '1 / 3');
  });

  test('NAV-077 the open deck lists its slides, the current one highlighted as the user steps; clicking one changes slide', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=2`);
    await navBtn(page).click();
    const nav = sidebar(page);
    const slides = nav.getByRole('listitem');
    await expect(slides).toHaveText([/^1\s*Supply and demand 1$/, /^2\s*Demand and supply curves$/, /^3\s*Price elasticity$/]);
    const current = nav.locator('.sn-slide.here');                  // locator: markup hook (highlighted slide)
    await expect(current).toHaveText(/^2/);
    // Only the open deck's topic is expanded.
    const group = (name: string) => nav.locator('details').filter({ has: page.locator('summary', { hasText: new RegExp(`^${name}`) }) });
    await expect(group('Supply and Demand')).toHaveAttribute('open', '');
    await expect(group('Elasticity')).not.toHaveAttribute('open', '');
    await blur(page);
    await page.keyboard.press('ArrowRight');
    await expect(current).toHaveText(/^3/);
    await nav.getByRole('link', { name: /^1\s*Supply and demand 1$/ }).click();
    await atSlide(page, '1 / 3');
    await expect(current).toHaveText(/^1/);
  });

  test.describe('two courses', () => {
    test.use({
      seed: seedWith((hub) => {
        addCourse(hub, 'Aaa-Course', { code: 'ZZ 9', title: 'Folder first, code last' });
        addDeck(hub, 'Aaa-Course', 'A-1', { tag: 'A-1', title: 'A deck', topic: 'A topic', week: 1, pages: 2 });
      }),
    });

    test('NAV-077 on home every course is shown; inside a course only it, with a course switcher pinned on top', async ({ page }) => {
      await page.goto('/');
      await navBtn(page).click();
      const nav = sidebar(page);
      await expect(nav.getByRole('link', { name: /ZZ 9\s*Folder first, code last/ })).toBeVisible();
      await expect(nav.getByRole('link', { name: /Demo-Course\s*Introductory Economics/ })).toBeVisible();
      await expect(nav.getByRole('navigation', { name: 'Courses' })).toHaveCount(0);
      // Two courses on home: topic groups start collapsed.
      await expect(nav.locator('details[open]')).toHaveCount(0);

      await page.goto(`/#c=${DEMO}`);
      await expect(nav.getByRole('link', { name: /ZZ 9\s*Folder first/ })).toHaveCount(0);
      const sw = nav.getByRole('navigation', { name: 'Courses' });
      await expect(sw.getByRole('link')).toHaveText(['Demo-Course', 'ZZ 9']);   // alphabetical by code
      await expect(sw.getByRole('link', { name: 'Demo-Course' })).toHaveAttribute('aria-current', 'page');
      await sw.getByRole('link', { name: 'ZZ 9' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'ZZ 9' })).toBeVisible();
      await expect(sw.getByRole('link', { name: 'ZZ 9' })).toHaveAttribute('aria-current', 'page');
    });
  });

  test('NAV-077 the sidebar is hidden on the phone photo page', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    await navBtn(page).click();
    await expect(sidebar(page)).toBeVisible();
    await page.goto(`/#upload=ask-${DEMO}`);
    await expect(main(page)).toContainText('Take a photo of your page.');
    await expect(sidebar(page)).toBeHidden();
  });
});

test.describe('NAV-078 search', () => {
  test.use({
    seed: seedWith((hub) => {
      addCourse(hub, 'Zed-Course', { code: 'ZED', title: 'Second course' });
      addDeck(hub, 'Zed-Course', 'SN-1', { tag: 'SN-1', title: 'Snippets', topic: 'Snips', week: 1, pages: 3 }, {
        transcript: transcript('SN-1', ['Snippet', 'Far', 'Elasticity again'], (n) => [
          'Snippet test: $\\frac{a}{b} \\le c$ and **bold** and `code` QQSNIP.',
          `${'filler words '.repeat(8)}then QQFAR here.`,
          'Another mention of elasticity.',
        ][n - 1]),
      });
      addDeck(hub, 'Zed-Course', 'MANY', { tag: 'MANY', title: 'Many', topic: 'Snips', week: 2, pages: 70 },
        { images: 0, transcript: transcript('MANY', Array.from({ length: 70 }, (_, i) => `Many ${i + 1}`), () => 'qqmanyhits') });
    }),
  });

  test('NAV-078 the search button or Ctrl+K (even while typing) opens an empty, focused box', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=1`);
    await page.getByRole('button', { name: 'Search all slides (Ctrl K)' }).click();
    await expect(searchBox(page)).toBeFocused();
    await expect(searchBox(page)).toHaveAttribute('placeholder', 'Search all slides');
    await searchBox(page).fill('elast');
    await page.keyboard.press('Escape');
    await expect(searchBox(page)).toBeHidden();
    await page.locator('#ask-input').click();                       // locator: markup hook (the Ask box)
    await page.keyboard.type('typing');
    await page.keyboard.press('Control+k');
    await expect(searchBox(page)).toBeFocused();
    await expect(searchBox(page)).toHaveValue('');
  });

  test('NAV-078 2+ characters search every course\'s slides case-insensitively, in course then lecture order', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Control+k');
    await searchBox(page).fill('e');
    await page.waitForTimeout(400);                                 // past the documented typing pause: still nothing
    await expect(results(page)).toHaveCount(0);
    await expect(page.getByText(/Nothing matches/)).toHaveCount(0);
    await searchBox(page).fill('  ELASTICITY ');
    await expect(results(page).locator('b')).toHaveText([
      'Demo-Course · Supply and Demand · S&D-1 s3',
      'Demo-Course · Practice · HW-1 s2',
      'ZED · Snips · SN-1 s3',
    ]);
  });

  test('NAV-078 snippets strip Markdown and common LaTeX; "…" when the match is far in; at most 60 results', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Control+k');
    await searchBox(page).fill('qqsnip');
    const snip = results(page).locator('span');
    await expect(snip).toHaveCount(1);
    await expect(snip).toContainText('(a)/(b) ≤ c and bold and code QQSNIP.');
    await expect(snip).not.toContainText(/[$*`\\]/);
    await searchBox(page).fill('qqfar');
    await expect(snip).toHaveText(/^…/);
    await searchBox(page).fill('qqmanyhits');
    await expect(results(page)).toHaveCount(60);
    await expect(results(page).first().locator('b')).toHaveText('ZED · Snips · MANY s1');
  });

  test('NAV-078 no hits: Nothing matches "<query>"; notes are not searched', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Control+k');
    await searchBox(page).fill('ask in class');                    // only in me/notes/Week1/notes.md
    await expect(page.getByText('Nothing matches "ask in class".')).toBeVisible();
  });

  test('NAV-078 ↓/↑ move the highlight, Enter opens it (or the first); a click opens; opening closes the search', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Control+k');
    await searchBox(page).fill('elasticity');
    await expect(results(page)).toHaveCount(3);
    await searchBox(page).press('ArrowDown');
    await searchBox(page).press('ArrowDown');
    await searchBox(page).press('ArrowDown');
    await searchBox(page).press('ArrowUp');
    await expect(results(page).nth(1)).toHaveClass(/sel/);          // locator: markup hook (highlighted result)
    await expect(page.locator('#search-results a.sel')).toHaveCount(1);
    await searchBox(page).press('Enter');
    await expect(searchBox(page)).toBeHidden();
    await atSlide(page, '2 / 2');
    await expect(page).toHaveURL(/d=HW-1&s=2$/);
    await page.keyboard.press('Control+k');
    await searchBox(page).fill('elasticity');
    await expect(results(page)).toHaveCount(3);
    await searchBox(page).press('Enter');
    await expect(page).toHaveURL(/d=S%26D-1&s=3$/);
    await expect(searchBox(page)).toBeHidden();
    await page.keyboard.press('Control+k');
    await searchBox(page).fill('qqsnip');
    await results(page).first().click();
    await expect(page).toHaveURL(/#c=Zed-Course&d=SN-1&s=1$/);
    await expect(searchBox(page)).toBeHidden();
  });

  test('NAV-078 Escape or a click outside the box closes it', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Control+k');
    await expect(searchBox(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(searchBox(page)).toBeHidden();
    await page.getByRole('button', { name: 'Search all slides (Ctrl K)' }).click();
    await expect(searchBox(page)).toBeVisible();
    await page.mouse.click(5, 880);                                 // the dimmed backdrop, outside the box
    await expect(searchBox(page)).toBeHidden();
  });
});

test.describe('NAV-079 keyboard', () => {
  const BUG = 'BROKEN in current app: Escape typed in the search box closes the search AND the next thing in line (the box\'s '
    + 'own Escape handler closes the search, then the page-wide handler no longer sees it open and closes the ⋯ menu / '
    + 'zoom / text panel too); see docs/functional-spec/01-navigation-and-library.md NAV-079 "first match wins"';

  async function zoomedWithText(page) {
    await page.goto(`/${SD1_HASH}&s=1`);
    const img = page.getByRole('img', { name: /^Slide 1/ });
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(900);
    await page.locator('#text-btn').click();                       // locator: markup hook
    await blur(page);
    await page.keyboard.press('z');
    await expect(stage(page)).toHaveClass(/zoomed/);
    await expect(page.locator('#transcript')).toBeVisible();
  }

  test('NAV-079 Escape closes zoom before the text panel', async ({ page }) => {
    await zoomedWithText(page);
    await page.keyboard.press('Escape');
    await expect(stage(page)).not.toHaveClass(/zoomed/);
    await expect(page.locator('#transcript')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#transcript')).toBeHidden();
    await atSlide(page, '1 / 3');
  });

  test('NAV-079 NAV-086 Escape closes the ⋯ menu before zoom and the text panel', async ({ page }) => {
    await zoomedWithText(page);
    await page.getByRole('button', { name: 'More' }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(stage(page)).toHaveClass(/zoomed/);
    await expect(page.locator('#transcript')).toBeVisible();
  });

  test('NAV-079 with the slide zoomed, Escape in the search box closes only the search', async ({ page }) => {
    test.fail(true, BUG);
    await zoomedWithText(page);
    await page.keyboard.press('Control+k');
    await searchBox(page).press('Escape');
    await expect(searchBox(page)).toBeHidden();
    await expect(stage(page)).toHaveClass(/zoomed/, { timeout: 2000 });
  });

  test('NAV-079 with the ⋯ menu open, Escape in the search box closes only the search', async ({ page }) => {
    test.fail(true, BUG);
    await page.goto(`/${SD1_HASH}&s=1`);
    await atSlide(page, '1 / 3');
    await page.getByRole('button', { name: 'More' }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(searchBox(page)).toBeVisible();
    await expect(menu).toBeVisible();
    await searchBox(page).press('Escape');
    await expect(searchBox(page)).toBeHidden();
    await expect(menu).toBeVisible({ timeout: 2000 });
  });
});
