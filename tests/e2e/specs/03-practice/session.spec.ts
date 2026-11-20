/**
 * 03 · The study session's practice steps: Review → New slides → Practise (three problems) → Mixed → Note.
 * Spec: docs/functional-spec/03-practice-reviews-drills.md (SESS-*). The session bar itself is 01-navigation's.
 *
 * Not covered:
 *   SESS-003 "A mixed problem outside a session gets Try another": the app only starts mixed problems from the
 *            session (no way to reach one outside it in the UI).
 */
import { test, expect } from '../../fixtures/hub';
import type { Hub } from '../../fixtures/hub';
import {
  MARK_CLEAN, MARK_WRONG, SD1_S2, answerAndCheck, hubState, iso, openSlide, openTutor, panel, practiceRules, review,
  reviewsOnDisk, seedSession, seedWith, skipNearMidnight, startTry,
} from './helpers';

const RESUME = { resume: { deck: 'S&D-1', slide: 2 }, decks: { 'S&D-1': { seen: [1, 2], last: 2, read: false, solved: false } } };
const step = (page: any, n: number, label: string) => page.getByRole('button', { name: `Session step ${n}: ${label}` });

test.describe('the review step', () => {
  test.use({ seed: seedWith((hub: Hub) => hubState(hub, { ...RESUME, reviews: [review('due0000001', -1)] })) });

  test('SESS-001 with reviews due, starting a session opens the review page', async ({ page }) => {
    skipNearMidnight(test);
    await page.goto('/');
    await page.getByRole('button', { name: 'Start session · Demo-Course' }).click();
    await expect(page).toHaveURL(/#review=Demo-Course$/);
    await expect(step(page, 1, 'Review')).toHaveAttribute('aria-current', 'step');
  });
});

test.describe('without reviews', () => {
  test.use({ seed: seedWith((hub: Hub) => hubState(hub, RESUME)) });

  test('SESS-001 with nothing due the session goes straight to new slides at the resume point', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Start session · Demo-Course' }).click();
    await expect(page).toHaveURL(/#c=Demo-Course&d=S%26D-1&s=2$/);
    await expect(step(page, 2, 'New slides')).toHaveAttribute('aria-current', 'step');
  });

  test('SESS-002 SESS-003 SESS-004 practise three, then one mixed, then the note goes on the last mistake', async ({ page, hub }) => {
    skipNearMidnight(test);
    await hub.script([{ match: { label: '^practice:mixed$' }, reply: { json: { problem_md: 'MIXED-ONE', solution_md: 's',
      final_answer: 'a', hints: ['h1', 'h2'], concept: 'c', slides: 'S&D-1 s1', deck: 'S&D-1' } } },
    { match: { label: '^check$' }, times: 1, reply: { json: MARK_WRONG } },
    ...practiceRules({}, MARK_CLEAN)]);
    await seedSession(page, { step: 1 });
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    await expect(step(page, 3, 'Practise')).toHaveAttribute('aria-current', 'step');   // starting a problem moved it on
    await answerAndCheck(page, 'wrong');
    await expect(page.locator('.result')).toContainText('Saved to review');     // locator: markup hook
    await page.getByRole('button', { name: 'Try another' }).click();
    await answerAndCheck(page);
    await page.getByRole('button', { name: 'Try another' }).click();
    await answerAndCheck(page);
    await page.getByRole('button', { name: 'Next: one mixed problem' }).click();
    await expect(page.getByRole('heading', { name: 'Mixed problem' })).toBeVisible();
    await expect(panel(page)).toContainText('MIXED-ONE');
    await expect(step(page, 4, 'Mixed')).toHaveAttribute('aria-current', 'step');
    expect((await hub.calls('^practice:')).filter((c) => c.label === 'practice:mixed')).toHaveLength(1);
    await answerAndCheck(page);
    await page.getByRole('button', { name: 'Next: one line to remember' }).click();
    await expect(page).toHaveURL(/#step=note$/);
    await expect(page.getByRole('heading', { name: 'One line to remember' })).toBeVisible();
    await expect(page.locator('main')).toContainText('Shown next time this comes back.');
    await page.getByLabel('The clue I missed was').fill('  draw the curves first  ');
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page.getByRole('heading', { name: 'Session done' })).toBeVisible();
    await expect(page.locator('main')).toContainText('Your note will show up next time this comes back.');
    const items = reviewsOnDisk(hub);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ note: 'draw the curves first', mistake: 'Algebra slip', due: iso(1) });
  });

  test('SESS-002 the count of problems practised survives a reload', async ({ page, hub }) => {
    await hub.script(practiceRules());
    await seedSession(page, { step: 2, practised: 2 });
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    await answerAndCheck(page);
    await expect(page.getByRole('button', { name: 'Next: one mixed problem' })).toBeVisible();
  });

  test('SESS-002 the Practise segment opens a slide problem on the slide on screen', async ({ page, hub }) => {
    await hub.script(practiceRules());
    await seedSession(page, { step: 1 });
    await openSlide(page, '#c=Demo-Course&d=S%26D-1&s=3');
    await step(page, 3, 'Practise').click();
    await expect(page.getByLabel('Your working')).toBeVisible();
    await expect(page.getByText('S&D-1 s3', { exact: true })).toBeVisible();
    const [c] = await hub.calls('^practice:');
    expect(c.label).toBe('practice:try');
    await expect(step(page, 3, 'Practise')).toHaveAttribute('aria-current', 'step');
  });

  test('SESS-002 the Practise segment away from the course opens the problem at the resume point', async ({ page, hub }) => {
    await hub.script(practiceRules());
    await seedSession(page, { step: 1 });
    await page.goto('/');
    await step(page, 3, 'Practise').click();
    await expect(page).toHaveURL(/#c=Demo-Course&d=S%26D-1&s=2/);
    await expect(page.getByLabel('Your working')).toBeVisible();
    expect((await hub.calls('^practice:'))[0].label).toBe('practice:try');
  });

  test('SESS-003 while on the Mixed step any problem\'s result leads to the note', async ({ page, hub }) => {
    await hub.script(practiceRules());
    await seedSession(page, { step: 3 });
    await openSlide(page, SD1_S2);
    await openTutor(page);
    await startTry(page);
    await answerAndCheck(page);
    await expect(page.getByRole('button', { name: 'Next: one line to remember' })).toBeVisible();
  });

  test('SESS-004 with nothing missed the note step says so and the line is not saved anywhere', async ({ page, hub }) => {
    await seedSession(page, { step: 4, lastMistake: null });
    await page.goto('/#step=note');
    await expect(page.locator('main')).toContainText('Nothing was missed today; a line still helps.');
    await page.getByLabel('The clue I missed was').fill('a line');
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page.getByRole('heading', { name: 'Session done' })).toBeVisible();
    expect(reviewsOnDisk(hub)).toEqual([]);
  });
});

test.describe('the note on a review item', () => {
  test.use({ seed: seedWith((hub: Hub) => hubState(hub, { ...RESUME, reviews: [review('last000001', 1)] })) });

  test('SESS-004 REV-030 the note step saves the line on the session\'s last mistake', async ({ page, hub }) => {
    await seedSession(page, { step: 4, lastMistake: 'last000001' });
    await page.goto('/#step=note');
    await expect(page.locator('main')).toContainText('Shown next time this comes back.');
    await page.getByLabel('The clue I missed was').fill('check the units');
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page.getByRole('heading', { name: 'Session done' })).toBeVisible();
    expect(reviewsOnDisk(hub)[0].note).toBe('check the units');
  });
});
