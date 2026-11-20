/**
 * 01 Navigation · F. Course page (NAV-060 … NAV-066).
 */
import { test, expect } from '../../fixtures/hub';
import { DEMO, addDeck, hubState, deadlines, deadlineDate, skipIfYearWraps, seedWith, atSlide, crumbs, main } from './helpers';

// locator: markup hook — topic sections are found by their header button's bold name.
const topic = (page, name: string) =>
  page.locator('.topics section').filter({ has: page.locator('button > b', { hasText: new RegExp(`^${name}$`) }) });
const topicBtn = (page, name: string) => topic(page, name).getByRole('button');

test.describe('NAV-060 NAV-061 header and actions', () => {
  test('NAV-060 NAV-061 crumbs, title, subtitle; Start session, the resume line, Continue reading and Exam drill', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    await expect(crumbs(page)).toHaveText('Home›Demo-Course');
    await expect(crumbs(page).getByRole('link')).toHaveText(['Home']);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(DEMO);
    await expect(main(page)).toContainText('Introductory Economics (demo)');
    await expect(main(page)).not.toContainText(' · covers ');             // no next assessment: no line
    await expect(page.getByRole('button', { name: 'Start session', exact: true })).toBeVisible();
    await expect(main(page)).toContainText('Nothing due. Pick up at S&D-1 →');
    await expect(page.getByRole('link', { name: 'Continue reading: S&D-1 · slide 1 ›' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Exam drill ›' })).toBeVisible();
    await page.getByRole('link', { name: 'Continue reading: S&D-1 · slide 1 ›' }).click();
    await atSlide(page, '1 / 3');
  });

  test.describe('with a next assessment', () => {
    test.use({ seed: seedWith((hub) => deadlines(hub, DEMO, [`| ${deadlineDate(8)} | **Midterm** — chapters 1-3 | 30% | | W1 |`])) });
    test('NAV-060 the next assessment line: <name> · <when> · covers <topics>', async ({ page }) => {
      skipIfYearWraps(test, 8);
      await page.goto(`/#c=${DEMO}`);
      await expect(main(page)).toContainText('Midterm · in 8 days · covers Supply and Demand');
      await expect(main(page)).not.toContainText('(scope assumed)');
    });
  });
});

test.describe('NAV-062 NAV-063 NAV-064 topics, practice and deck rows', () => {
  test.use({
    seed: seedWith((hub) => {
      addDeck(hub, DEMO, 'EL-1', { tag: 'EL-1', title: 'Elasticity deck', topic: 'Elasticity', week: 3, order: 1, pages: 2 });
      hubState(hub, DEMO, {
        decks: { 'EL-1': { seen: [2], last: 2, read: false, solved: false } },
        resume: { deck: 'EL-1', slide: 2 },
      });
    }),
  });

  test('NAV-062 the resume deck\'s topic starts expanded, others collapsed; clicking a header toggles it', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    await expect(topicBtn(page, 'Elasticity')).toHaveAttribute('aria-expanded', 'true');
    await expect(topicBtn(page, 'Supply and Demand')).toHaveAttribute('aria-expanded', 'false');
    await expect(topicBtn(page, 'Supply and Demand')).toContainText('0/1');
    await expect(page.getByRole('link', { name: /S&D-1 · Supply and demand 1/ })).toBeHidden();
    await topicBtn(page, 'Supply and Demand').click();
    await expect(topicBtn(page, 'Supply and Demand')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('link', { name: /S&D-1 · Supply and demand 1/ })).toBeVisible();
    await expect(topic(page, 'Supply and Demand')).toContainText('Textbook: Any introductory economics textbook, chapter on markets');
    await topicBtn(page, 'Elasticity').click();
    await expect(topicBtn(page, 'Elasticity')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('link', { name: /EL-1 · Elasticity deck/ })).toBeHidden();
  });

  test('NAV-062 the topic named in the route starts expanded instead', async ({ page }) => {
    await page.goto(`/#c=${DEMO}&t=Supply+and+Demand`);
    await expect(topicBtn(page, 'Supply and Demand')).toHaveAttribute('aria-expanded', 'true');
    await expect(topicBtn(page, 'Elasticity')).toHaveAttribute('aria-expanded', 'false');
  });

  test('NAV-063 NAV-064 the Practice list and deck rows: dot, <tag> · <title>, W<week>, N slides/pages, link to the last slide', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    const practice = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Practice' }) });
    await expect(practice).toContainText('Homework and practice exams');
    const hw = practice.getByRole('link', { name: /HW-1 · Homework 1/ });
    await expect(hw).toContainText('W1');
    await expect(hw).toContainText('2 pages');
    await expect(hw.getByTitle('Not started', { exact: true })).toBeAttached();
    const el = page.getByRole('link', { name: /EL-1 · Elasticity deck/ });
    await expect(el).toContainText('W3');
    await expect(el).toContainText('2 slides');
    await expect(el.getByTitle('Started', { exact: true })).toBeAttached();
    await el.click();                                         // at its last viewed slide
    await atSlide(page, '2 / 2');
    await expect(page).toHaveURL(/d=EL-1&s=2$/);
  });
});

test.describe('NAV-065 notes and documents', () => {
  test.use({
    seed: seedWith((hub) => {
      hub.write(`${DEMO}/me/notes/exams/midterm/cheat.md`, '# Cheat sheet\n');
      hub.write(`${DEMO}/me/notes/Week1/more.md`, '# More week 1\n');
    }),
  });
  test('NAV-065 class-notes links W<week> (2)… and document links open the notes page', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    await expect(main(page)).toContainText('Your class notes: W1W1 (2)');
    await page.getByRole('link', { name: 'W1 (2)' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Week 1 notes' })).toBeVisible();
    await page.goBack();
    await page.getByRole('link', { name: 'cheat', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Cheat sheet' })).toBeVisible();
    await expect(crumbs(page)).toHaveText('Home›Demo-Course›midterm · cheat');
  });
});

test.describe('NAV-066 fresh', () => {
  test('NAV-066 every visit to the course page re-reads the course (no reload)', async ({ page, hub }) => {
    await page.goto(`/#c=${DEMO}`);
    await expect(main(page)).toContainText('Introductory Economics (demo)');
    hub.write(`${DEMO}/course.json`, JSON.stringify({ ...hub.readJson(DEMO, 'course.json'), title: 'Renamed while open' }));
    addDeck(hub, DEMO, 'NEW-1', { tag: 'NEW-1', title: 'Brand new', topic: 'Supply and Demand', week: 4, pages: 2 });
    await page.getByRole('link', { name: 'Continue reading: S&D-1 · slide 1 ›' }).click();
    await atSlide(page, '1 / 3');
    await crumbs(page).getByRole('link', { name: 'Demo-Course' }).click();
    await expect(main(page)).toContainText('Renamed while open');
    await expect(page.getByRole('link', { name: /NEW-1 · Brand new/ })).toBeVisible();
  });
});
