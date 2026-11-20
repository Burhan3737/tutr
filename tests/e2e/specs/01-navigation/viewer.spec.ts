/**
 * 01 Navigation · E. Deck viewer (NAV-045 … NAV-055).
 *
 * // Not covered: NAV-052 (neighbouring decks load ahead: only observable as speed; the spec says not required)
 * // Not covered: NAV-045 portrait pages filling a readable column (needs a portrait JPEG fixture; landscape fit is covered)
 */
import { test, expect } from '../../fixtures/hub';
import { DEMO, SD1_HASH, addDeck, addSD2, hubState, seedWith, atSlide, blur, seenPosted, crumbs, main } from './helpers';

const textBtn = (page) => page.locator('#text-btn');          // locator: markup hook (the tutor panel has a "Text" button too)
const panel = (page) => page.locator('#transcript');          // locator: markup hook (the text panel has no name)
const stage = (page) => page.locator('#stage-main');          // locator: markup hook (the slide area)
const prev = (page) => page.getByRole('button', { name: 'Previous slide (←)' });
const next = (page) => page.getByRole('button', { name: 'Next slide (→)' });

test.describe('NAV-045 one slide large', () => {
  test('NAV-045 the slide image, its accessible name, the counter, arrows and the Text toggle', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=2`);
    const img = page.getByRole('img', { name: 'Slide 2: Demand and supply curves' });
    await expect(img).toBeVisible();
    await atSlide(page, '2 / 3');
    await expect(prev(page)).toBeVisible();
    await expect(next(page)).toBeVisible();
    await expect(textBtn(page)).toHaveText('Text');
    // Fitted to the stage, never more than 1.5x its natural size (900 px wide).
    await expect.poll(async () => (await img.boundingBox())?.width ?? 0).toBeGreaterThan(300);
    const w = (await img.boundingBox())!.width;
    expect(w).toBeLessThanOrEqual(1350);
    expect(w).toBeLessThanOrEqual((await stage(page).boundingBox())!.width);
  });
});

test.describe('NAV-046 text panel', () => {
  test.use({ seed: seedWith((hub) => addSD2(hub)) });

  test('NAV-046 Text / T toggles the slide text with maths; it follows the slide; Escape closes it', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=2`);
    await expect(textBtn(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(panel(page)).toBeHidden();
    await textBtn(page).click();
    await expect(textBtn(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(panel(page).getByRole('heading')).toHaveText('Slide 2 · Demand and supply curves');
    await expect(panel(page).locator('.katex').first()).toBeVisible();     // locator: markup hook (typeset maths)
    await expect(panel(page)).toContainText('Equilibrium: where the two curves cross.');
    await blur(page);
    await page.keyboard.press('ArrowRight');
    await expect(panel(page).getByRole('heading')).toHaveText('Slide 3 · Price elasticity');
    await expect(panel(page).locator('.katex-display')).toBeVisible();      // locator: markup hook (display maths)
    await page.keyboard.press('t');
    await expect(panel(page)).toBeHidden();
    await expect(textBtn(page)).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('T');
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
  });

  test('NAV-046 the panel closes when another deck is opened', async ({ page }) => {
    await page.goto('/#c=Demo-Course&d=S%26D-2&s=1');
    await textBtn(page).click();
    await expect(panel(page).getByRole('heading')).toHaveText('Slide 1 · S&D-2 title 1');
    await prev(page).click();                                   // previous deck: S&D-1's last slide
    await atSlide(page, '3 / 3');
    await expect(page).toHaveURL(/S%26D-1&s=3$/);
    await expect(panel(page)).toBeHidden();
    await expect(textBtn(page)).toHaveAttribute('aria-pressed', 'false');
  });

  test.describe('raw deck', () => {
    test.use({
      seed: seedWith((hub) => addDeck(hub, DEMO, 'RAW', { tag: 'RAW', title: 'Raw deck', topic: 'Supply and Demand', week: 3, pages: 1, prepared: false },
        { transcript: '## [RAW s1] Raw title\n\nline one **not bold** $x^2$\nline two\n' })),
    });
    test('NAV-046 an unprepared deck shows "Text layer only…" and the text unrendered', async ({ page }) => {
      await page.goto('/#c=Demo-Course&d=RAW&s=1');
      await textBtn(page).click();
      await expect(panel(page).getByRole('heading')).toHaveText('Slide 1 · Raw title');
      await expect(panel(page)).toContainText('Text layer only; equations and diagrams may be missing.');
      await expect(panel(page).locator('pre')).toHaveText('line one **not bold** $x^2$\nline two');
      await expect(panel(page).locator('.katex, strong')).toHaveCount(0);
    });
  });
});

test.describe('NAV-047 stepping', () => {
  test('NAV-047 arrows, ←/→ and PageUp/PageDown step slides', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=1`);
    await atSlide(page, '1 / 3');
    await next(page).click();
    await atSlide(page, '2 / 3');
    await prev(page).click();
    await atSlide(page, '1 / 3');
    await blur(page);
    await page.keyboard.press('ArrowRight');
    await atSlide(page, '2 / 3');
    await page.keyboard.press('PageDown');
    await atSlide(page, '3 / 3');
    await page.keyboard.press('ArrowLeft');
    await atSlide(page, '2 / 3');
    await page.keyboard.press('PageUp');
    await atSlide(page, '1 / 3');
    await expect(page).toHaveURL(/s=1$/);
  });

  test('NAV-047 keys are ignored while typing in a text field', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=2`);
    await atSlide(page, '2 / 3');
    const ask = page.locator('#ask-input');                    // locator: markup hook (the tutor's Ask box)
    await ask.click();
    await ask.fill('typing');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('PageDown');
    await page.keyboard.press('t');
    await atSlide(page, '2 / 3');
    await expect(panel(page)).toBeHidden();
  });
});

test.describe('NAV-048 NAV-049 across decks and the end card', () => {
  test.use({ seed: seedWith((hub) => addSD2(hub)) });

  test('NAV-048 on slide 1 Previous goes to the previous lecture deck\'s last slide; on the end card Next to the next deck', async ({ page }) => {
    await page.goto('/#c=Demo-Course&d=S%26D-2&s=1');
    await atSlide(page, '1 / 3');
    await expect(page.getByRole('button', { name: 'Previous slide (←)' })).toHaveAttribute('title', 'Previous deck: S&D-1 (←)');
    await prev(page).click();
    await expect(page).toHaveURL(/S%26D-1&s=3$/);
    await atSlide(page, '3 / 3');
    await next(page).click();
    await expect(page.getByRole('heading', { name: 'End of S&D-1' })).toBeVisible();
    await expect(next(page)).toHaveAttribute('title', 'Next deck: S&D-2 (→)');
    await next(page).click();
    await expect(page).toHaveURL(/S%26D-2&s=1$/);
    await atSlide(page, '1 / 3');
  });

  test('NAV-048 with no previous / next lecture deck the arrows are disabled at the edges', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=1`);
    await atSlide(page, '1 / 3');
    await expect(prev(page)).toBeDisabled();
    await expect(prev(page)).toHaveAttribute('title', 'Previous slide (←)');
    await page.goto('/#c=Demo-Course&d=S%26D-2&s=4');
    await expect(page.getByRole('heading', { name: 'End of S&D-2' })).toBeVisible();
    await expect(next(page)).toBeDisabled();
  });

  test('NAV-048 practice decks are not in the chain', async ({ page }) => {
    await page.goto('/#c=Demo-Course&d=HW-1&s=1');
    await atSlide(page, '1 / 2');
    await expect(prev(page)).toBeDisabled();
    await page.goto('/#c=Demo-Course&d=HW-1&s=3');
    await expect(page.getByRole('heading', { name: 'End of HW-1' })).toBeVisible();
    await expect(next(page)).toBeDisabled();
    await expect(main(page)).not.toContainText('Next deck:');
    await expect(main(page)).not.toContainText('Previous deck:');
  });

  test('NAV-049 the end card: End of <tag>, the solve line, Try one, links to the neighbouring decks; counter N / N', async ({ page }) => {
    await page.goto('/#c=Demo-Course&d=S%26D-2&s=3');
    await atSlide(page, '3 / 3');
    await blur(page);
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('heading', { name: 'End of S&D-2' })).toBeVisible();
    await atSlide(page, '3 / 3');
    await expect(main(page)).toContainText('Solve one problem from it to finish the deck.');
    await expect(page.getByRole('button', { name: 'Try one' })).toBeVisible();
    await expect(textBtn(page)).toBeHidden();
    await expect(page.getByRole('link', { name: 'Next deck:' })).toHaveCount(0);
    await page.getByRole('link', { name: '‹ Previous deck: S&D-1' }).click();
    await expect(page).toHaveURL(/S%26D-1&s=3$/);
    await atSlide(page, '3 / 3');
    await page.goto(`/${SD1_HASH}&s=4`);
    await page.getByRole('link', { name: 'Next deck: S&D-2 ›' }).click();
    await expect(page).toHaveURL(/S%26D-2&s=1$/);
  });

  test('NAV-049 Try one hands over to practice in the tutor panel', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=4`);
    await page.getByRole('button', { name: 'Try one' }).click();
    await expect(page.getByRole('complementary', { name: 'Tutor' }).getByRole('heading', { name: 'Practise' })).toBeVisible();
  });

  test.describe('solved deck', () => {
    test.use({ seed: seedWith((hub) => hubState(hub, DEMO, { decks: { 'S&D-1': { seen: [1, 2, 3], last: 3, read: true, solved: true } } })) });
    test('NAV-049 a solved deck\'s end card says "You\'ve solved a problem from this deck."', async ({ page }) => {
      await page.goto(`/${SD1_HASH}&s=4`);
      await expect(main(page)).toContainText("You've solved a problem from this deck.");
    });
  });
});

test.describe('NAV-050 zoom', () => {
  test('NAV-050 double-click or Z toggles a 2x view; Escape or changing slide un-zooms', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=1`);
    const img = page.getByRole('img', { name: /^Slide 1/ });
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(900);
    const fitted = (await img.boundingBox())!.width;
    await img.dblclick();
    await expect.poll(async () => (await img.boundingBox())!.width).toBe(1800);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await img.boundingBox())!.width).toBeCloseTo(fitted, 0);
    await blur(page);
    await page.keyboard.press('z');
    await expect.poll(async () => (await img.boundingBox())!.width).toBe(1800);
    await page.keyboard.press('z');
    await expect.poll(async () => (await img.boundingBox())!.width).toBeCloseTo(fitted, 0);
    await page.keyboard.press('Z');
    await expect.poll(async () => (await img.boundingBox())!.width).toBe(1800);
    await page.keyboard.press('ArrowRight');
    await atSlide(page, '2 / 3');
    const img2 = page.getByRole('img', { name: /^Slide 2/ });
    await expect.poll(async () => (await img2.boundingBox())?.width ?? 0).toBeLessThan(1800);
    await expect(stage(page)).not.toHaveClass(/zoomed/);
  });
});

test.describe('NAV-051 breadcrumbs', () => {
  test('NAV-051 Home › <code> › <topic> › <tag> (W<week>), with the topic link opening that topic', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=1`);
    await expect(crumbs(page)).toHaveText('Home›Demo-Course›Supply and Demand›S&D-1 (W1)');
    await expect(crumbs(page).getByRole('link')).toHaveText(['Home', 'Demo-Course', 'Supply and Demand']);
    await crumbs(page).getByRole('link', { name: 'Supply and Demand' }).click();
    await expect(page).toHaveURL(/#c=Demo-Course&t=Supply(\+|%20)and(\+|%20)Demand$/);
    await expect(page.getByRole('button', { name: /Supply and Demand/ })).toHaveAttribute('aria-expanded', 'true');
    await page.goto('/#c=Demo-Course&d=HW-1&s=1');
    await expect(crumbs(page)).toHaveText('Home›Demo-Course›Practice›HW-1 (W1)');
    await crumbs(page).getByRole('link', { name: 'Practice' }).click();
    await expect(page.getByRole('link', { name: /HW-1 · Homework 1/ })).toBeInViewport();
    await crumbs(page).getByRole('link', { name: 'Home' }).click();
    await expect(page.getByRole('button', { name: /Start session/ })).toBeVisible();
  });
});

test.describe('NAV-053 NAV-054 tutor area', () => {
  test.use({
    seed: seedWith((hub) => {
      addSD2(hub);
      // A second course with a deck, to move to.
      hub.write('Other-Course/course.json', JSON.stringify({ code: 'OTH', title: 'Other' }));
      addDeck(hub, 'Other-Course', 'O-1', { tag: 'O-1', title: 'Other deck', topic: 'Other topic', week: 1, pages: 2 });
    }),
  });

  test('NAV-054 the viewer shows the tutor\'s ask bar under the slide', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=1`);
    await expect(page.locator('#ask-input')).toBeVisible();     // locator: markup hook (the Ask box)
    await expect(page.getByRole('button', { name: 'Open the tutor' })).toBeVisible();
  });

  test('NAV-053 moving to another deck of the course keeps the open tutor panel; another course rebuilds the viewer', async ({ page }) => {
    await page.goto(`/${SD1_HASH}&s=3`);
    await page.getByRole('button', { name: 'Open the tutor' }).click();
    const tutor = page.getByRole('complementary', { name: 'Tutor' });
    await expect(tutor.getByRole('heading', { name: 'Tutor' })).toBeVisible();
    await tutor.evaluate((el) => { (el.querySelector('.panel') as HTMLElement).dataset.probe = 'kept'; });
    await blur(page);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');                     // into S&D-2
    await expect(page).toHaveURL(/S%26D-2&s=1$/);
    await atSlide(page, '1 / 3');
    await expect(tutor.locator('[data-probe="kept"]')).toHaveCount(1);
    await page.goto('/#c=Other-Course&d=O-1&s=1');
    await atSlide(page, '1 / 2');
    await expect(page.locator('[data-probe="kept"]')).toHaveCount(0);
  });

  test('NAV-054 Exam drill › on the course page opens the resume deck with the drill setup in the tutor panel', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    await page.getByRole('button', { name: 'Exam drill ›' }).click();
    await atSlide(page, '1 / 3');
    await expect(page).toHaveURL(/S%26D-1&s=1$/);
    await expect(page.getByRole('button', { name: 'Start the drill' })).toBeVisible();
  });
});

test.describe('NAV-055 seen tracking shows everywhere', () => {
  test('NAV-055 after viewing, the course page, the sidebar and home show the deck as started', async ({ page }) => {
    const seen = seenPosted(page);
    await page.goto(`/${SD1_HASH}&s=1`);
    await seen;
    await crumbs(page).getByRole('link', { name: 'Demo-Course' }).click();
    const row = page.getByRole('link', { name: /S&D-1 · Supply and demand 1/ });
    await expect(row.getByTitle('Started', { exact: true })).toBeAttached();
    await page.getByRole('button', { name: 'Show or hide the topics sidebar' }).click();
    await expect(page.getByRole('complementary', { name: 'Topics' }).locator('a[title="Supply and demand 1 · Started"]')).toBeAttached();  // locator: markup hook
    await crumbs(page).getByRole('link', { name: 'Home' }).click();
    await expect(page.getByTitle('S&D-1: started')).toBeAttached();
  });
});
