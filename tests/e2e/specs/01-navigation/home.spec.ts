/**
 * 01 Navigation · D. Home page (NAV-040 … NAV-044).
 */
import { test, expect } from '../../fixtures/hub';
import { DEMO, addCourse, addDeck, addSD2, hubState, deadlines, deadlineDate, skipIfYearWraps, seedWith, atSlide, main } from './helpers';

// locator: markup hook — the next-test line is a plain paragraph above the main button.
const nextLine = (page) => page.locator('#main p').first();
const courseRows = (page) => page.locator('.courses a');    // locator: markup hook

test.describe('NAV-040 next test line', () => {
  test('NAV-040 with no upcoming test: "No upcoming tests found in your deadlines."', async ({ page }) => {
    await page.goto('/');
    await expect(nextLine(page)).toHaveText('No upcoming tests found in your deadlines.');
  });

  test('NAV-040 NAV-044 when: today, tomorrow, in N days (home re-reads the library on each visit)', async ({ page, hub }) => {
    skipIfYearWraps(test, 0, 1, 6);
    deadlines(hub, DEMO, [`| ${deadlineDate(0)} | Quiz A — x | | | W1 |`]);
    await page.goto('/');
    await expect(nextLine(page)).toHaveText('Demo-Course Quiz A · today · Supply and Demand');
    deadlines(hub, DEMO, [`| ${deadlineDate(1)} | Quiz B — x | | | W1 |`]);
    await page.getByRole('link', { name: /Demo-Course Introductory/ }).click();
    await page.getByRole('link', { name: 'Tutr home' }).click();
    await expect(nextLine(page)).toHaveText('Demo-Course Quiz B · tomorrow · Supply and Demand');
    deadlines(hub, DEMO, [`| ~${deadlineDate(6)} | Quiz C — x | | | W1 |`]);
    await page.getByRole('link', { name: /Demo-Course Introductory/ }).click();
    await page.getByRole('link', { name: 'Home' }).click();
    await expect(nextLine(page)).toHaveText('Demo-Course Quiz C · ~in 6 days · Supply and Demand');
  });

  test.describe('two courses, the second sooner', () => {
    test.use({
      seed: seedWith((hub) => {
        deadlines(hub, DEMO, [`| ${deadlineDate(6)} | Demo test — x | | | W1 |`]);
        addCourse(hub, 'Econ-Two', { code: 'ECON 2', title: 'Second course' });
        deadlines(hub, 'Econ-Two', [`| ${deadlineDate(2)} | Exam — x | | | W1 |`]);
      }),
    });
    test('NAV-040 NAV-041 the suggested course is the one whose next test is soonest; no topics → no topic part', async ({ page }) => {
      skipIfYearWraps(test, 2, 6);
      await page.goto('/');
      await expect(nextLine(page)).toHaveText('ECON 2 Exam · in 2 days');
      await expect(page.getByRole('button', { name: 'Start session · ECON 2' })).toBeVisible();
    });
  });

  test.describe('nothing dated', () => {
    test.use({
      seed: seedWith((hub) => {
        addCourse(hub, 'Aaa-First', { code: 'AAA', title: 'First folder' });
        deadlines(hub, DEMO, ['| TBA | Final — x | | | W1 |']);
      }),
    });
    test('NAV-040 with no dated test anywhere the suggested course is the first course', async ({ page }) => {
      await page.goto('/');
      await expect(nextLine(page)).toHaveText('No upcoming tests found in your deadlines.');
      await expect(page.getByRole('button', { name: 'Start session · AAA' })).toBeVisible();
    });
  });
});

test.describe('NAV-041 NAV-042 main action and resume line', () => {
  test('NAV-041 Start session · <code> starts a session for the suggested course', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Start session · Demo-Course' }).click();
    await expect(page.getByRole('button', { name: 'Session step 2: New slides' })).toHaveAttribute('aria-current', 'step');
    await atSlide(page, '1 / 3');
    await expect(page).toHaveURL(/#c=Demo-Course&d=S%26D-1&s=1$/);
  });

  test.describe('with a resume point', () => {
    test.use({ seed: seedWith((hub) => hubState(hub, DEMO, { decks: { 'S&D-1': { seen: [2], last: 2, read: false, solved: false } }, resume: { deck: 'S&D-1', slide: 2 } })) });
    test('NAV-042 nothing due: "Nothing due." and a Pick up at <tag> → link to the resume point', async ({ page }) => {
      await page.goto('/');
      await expect(main(page)).toContainText('Nothing due. Pick up at S&D-1 →');
      await page.getByRole('link', { name: 'Pick up at S&D-1 →' }).click();
      await atSlide(page, '2 / 3');
    });
  });
});

test.describe('NAV-043 course list', () => {
  test.use({
    seed: seedWith((hub) => {
      addSD2(hub);
      hubState(hub, DEMO, { decks: { 'S&D-1': { seen: [1], last: 1, read: false, solved: false } } });
      addCourse(hub, 'Zed-Course', { code: 'ZED 1', title: 'Course with a test' });
      deadlines(hub, 'Zed-Course', [`| ~${deadlineDate(3)} | Midterm — all | 30% | | W1-1 (assumed) |`]);
    }),
  });

  test('NAV-043 each course: <code> <title>, the next test or "<N> topics", and one state dot per lecture deck', async ({ page }) => {
    skipIfYearWraps(test, 3);
    await page.goto('/');
    await expect(courseRows(page)).toHaveCount(2);
    const demo = page.getByRole('link', { name: /Demo-Course Introductory Economics \(demo\)/ });
    await expect(demo).toContainText('1 topics');           // pinned as-is: no singular
    const dots = demo.getByLabel('0 of 2 decks solved');      // HW-1 (practice) has no dot
    await expect(dots.getByTitle('S&D-1: started')).toBeAttached();
    await expect(dots.getByTitle('S&D-2: new')).toBeAttached();
    await expect(dots.locator('[title]')).toHaveCount(2);
    const zed = page.getByRole('link', { name: /ZED 1 Course with a test/ });
    await expect(zed).toContainText('Midterm ~in 3 days');
    await expect(zed.getByLabel('0 of 0 decks solved')).toBeAttached();
    await demo.click();
    await expect(page.getByRole('heading', { level: 1, name: DEMO })).toBeVisible();
  });
});

test.describe('NAV-043 one-slide decks have no dot', () => {
  test.use({
    seed: seedWith((hub) => {
      addDeck(hub, DEMO, 'ONE', { tag: 'ONE', title: 'Single slide', topic: 'Supply and Demand', week: 2, pages: 1 });
    }),
  });
  test('NAV-043 a lecture deck with one slide gets no state dot', async ({ page }) => {
    await page.goto('/');
    const dots = page.getByLabel('0 of 1 decks solved');
    await expect(dots.locator('[title]')).toHaveCount(1);
    await expect(dots.getByTitle('S&D-1: new')).toBeAttached();
  });
});

test.describe('NAV-044 fresh', () => {
  test('NAV-044 every visit to home re-reads the library (no reload)', async ({ page, hub }) => {
    await page.goto('/');
    await expect(courseRows(page)).toHaveCount(1);
    addCourse(hub, 'Late-Course', { code: 'LATE', title: 'Added while open' });
    await page.getByRole('link', { name: /Demo-Course Introductory/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: DEMO })).toBeVisible();
    await page.getByRole('link', { name: 'Tutr home' }).click();
    await expect(page.getByRole('link', { name: /LATE Added while open/ })).toBeVisible();
  });
});
