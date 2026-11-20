/**
 * 01 Navigation · I. Study session shell (NAV-080, NAV-081, NAV-085). What happens inside the review / practice steps
 * belongs to the practice area; here only that each step hands over to the right place.
 */
import { test, expect } from '../../fixtures/hub';
import { DEMO, hubState, review, iso, seedWith, atSlide, crumbs, main } from './helpers';

const step = (page, n: number, label: string) => page.getByRole('button', { name: `Session step ${n}: ${label}` });
const STEPS = ['Review', 'New slides', 'Practise', 'Mixed', 'Note'];
const tutor = (page) => page.getByRole('complementary', { name: 'Tutor' });

test.describe('NAV-080 NAV-081 starting and running a session', () => {
  test('NAV-080 NAV-081 with nothing due, Start session goes straight to New slides at the resume point', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    await expect(page.locator('#session-bar')).toBeHidden();         // locator: markup hook (the session bar)
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await atSlide(page, '1 / 3');
    await expect(page).toHaveURL(/#c=Demo-Course&d=S%26D-1&s=1$/);
    for (const [i, label] of STEPS.entries()) await expect(step(page, i + 1, label)).toBeVisible();
    await expect(step(page, 2, 'New slides')).toHaveAttribute('aria-current', 'step');
    await expect(step(page, 1, 'Review')).toHaveClass(/done/);        // locator: markup hook (done / current / to-do)
    await expect(step(page, 3, 'Practise')).not.toHaveClass(/done|current/);
    await expect(crumbs(page)).toHaveText('Session · Demo-CourseEnd session');
    // Remembered across reloads.
    await page.reload();
    await atSlide(page, '1 / 3');
    await expect(step(page, 2, 'New slides')).toHaveAttribute('aria-current', 'step');
    await expect(crumbs(page)).toContainText('Session · Demo-Course');
  });

  test('NAV-080 steps 3 and 4 open practice in the tutor panel; step 5 the note', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await atSlide(page, '1 / 3');
    await step(page, 3, 'Practise').click();
    await expect(tutor(page).getByRole('heading', { name: 'Practise' })).toBeVisible();
    await expect(step(page, 3, 'Practise')).toHaveAttribute('aria-current', 'step');
    await step(page, 4, 'Mixed').click();
    await expect(tutor(page).getByRole('heading', { name: 'Mixed problem' })).toBeVisible();
    await step(page, 5, 'Note').click();
    await expect(page.getByRole('heading', { level: 1, name: 'One line to remember' })).toBeVisible();
    await expect(page).toHaveURL(/#step=note$/);
    await expect(step(page, 5, 'Note')).toHaveAttribute('aria-current', 'step');
    await step(page, 2, 'New slides').click();
    await atSlide(page, '1 / 3');
  });

  test.describe('reviews due', () => {
    test.use({ seed: seedWith((hub) => hubState(hub, DEMO, { reviews: [review('r1', iso(0))] })) });
    test('NAV-080 with reviews due, step 1 opens the reviews', async ({ page }) => {
      await page.goto('/');
      await page.getByRole('button', { name: 'Start session · Demo-Course' }).click();
      await expect(page).toHaveURL(/#review=Demo-Course$/);
      await expect(step(page, 1, 'Review')).toHaveAttribute('aria-current', 'step');
    });
  });

  test('NAV-081 End session ends it and goes home; the bar is hidden on the phone photo page', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await atSlide(page, '1 / 3');
    await page.goto(`/#upload=ask-${DEMO}`);
    await expect(main(page)).toContainText('Take a photo of your page.');
    await expect(page.locator('#session-bar')).toBeHidden();
    await page.goto(`/#c=${DEMO}`);
    await expect(page.locator('#session-bar')).toBeVisible();
    await crumbs(page).getByRole('button', { name: 'End session' }).click();
    await expect(page.getByRole('button', { name: /Start session · / })).toBeVisible();
    await expect(page.locator('#session-bar')).toBeHidden();
    await expect(page).toHaveURL(/\/#?$/);
    await page.reload();
    await expect(page.getByRole('button', { name: /Start session · / })).toBeVisible();
    await expect(page.locator('#session-bar')).toBeHidden();
  });
});

test.describe('NAV-085 the last step', () => {
  test('NAV-085 without a session, #step=note goes home', async ({ page }) => {
    await page.goto('/#step=note');
    await expect(page.getByRole('button', { name: 'Start session · Demo-Course' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'One line to remember' })).toHaveCount(0);
  });

  test('NAV-085 no mistake this session: the note page, Finish with a note → Session done', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await atSlide(page, '1 / 3');
    await step(page, 5, 'Note').click();
    await expect(page.getByRole('heading', { level: 1, name: 'One line to remember' })).toBeVisible();
    await expect(main(page)).toContainText('Nothing was missed today; a line still helps.');
    const box = page.getByRole('textbox', { name: 'The clue I missed was' });
    await expect(box).toHaveAttribute('placeholder', 'The clue I missed was…');
    await expect(box).toHaveAttribute('maxlength', '300');
    await expect(page.getByRole('button', { name: 'Skip' })).toBeVisible();
    await box.fill('Check the units first');
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page.getByRole('heading', { name: 'Session done' })).toBeVisible();
    await expect(main(page)).toContainText('Your note will show up next time this comes back.');
    await expect(page.locator('#session-bar')).toBeHidden();
    await page.getByRole('link', { name: 'Home' }).last().click();
    await expect(page.getByRole('button', { name: /Start session · / })).toBeVisible();
  });

  test('NAV-085 Skip ends the session with "Nice work."', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await atSlide(page, '1 / 3');
    await step(page, 5, 'Note').click();
    await page.getByRole('textbox', { name: 'The clue I missed was' }).fill('ignored');
    await page.getByRole('button', { name: 'Skip' }).click();
    await expect(page.getByRole('heading', { name: 'Session done' })).toBeVisible();
    await expect(main(page)).toContainText('Nice work.');
  });

  test.describe('after a mistake', () => {
    test.use({ seed: seedWith((hub) => hubState(hub, DEMO, { reviews: [review('r1', iso(1))] })) });
    test('NAV-085 with a mistake this session the note is saved on it', async ({ page, hub }) => {
      await page.goto(`/#c=${DEMO}`);
      await page.getByRole('button', { name: 'Start session', exact: true }).click();
      await atSlide(page, '1 / 3');
      // The practice area records the session's last mistake; here it is set the way the app stores it.
      await page.evaluate(() => {
        const s = JSON.parse(localStorage.getItem('session')!);
        localStorage.setItem('session', JSON.stringify({ ...s, lastMistake: 'r1', step: 4 }));
      });
      await page.goto('/#step=note');
      await page.reload();
      await expect(main(page)).toContainText('Shown next time this comes back.');
      await page.getByRole('textbox', { name: 'The clue I missed was' }).fill('Demand shifts, not moves along');
      await page.getByRole('button', { name: 'Finish' }).click();
      await expect(page.getByRole('heading', { name: 'Session done' })).toBeVisible();
      await expect.poll(() => hub.readJson(DEMO, 'me', 'hub-state.json').reviews[0].note).toBe('Demand shifts, not moves along');
    });
  });
});
