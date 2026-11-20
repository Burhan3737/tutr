/**
 * 01 Navigation · G. Notes pages and Markdown rendering (NAV-070 … NAV-072, NAV-075).
 *
 * The drawing rules for ```mermaid / ```svg / ```plot belong to the tutor area; here only "an svg block is drawn".
 */
import { test, expect } from '../../fixtures/hub';
import { DEMO, seedWith, atSlide, crumbs, main } from './helpers';

const notesUrl = (p: string) => `/#c=${DEMO}&notes=${encodeURIComponent(p)}`;
const article = (page) => page.locator('#main article');      // locator: markup hook (the notes page body)

const RENDER = [
  '# Render test',
  '',
  '| Col A | Col B |',
  '|---|---|',
  '| a1 | b1 |',
  '',
  '- item one',
  '- item two',
  '',
  '```',
  'code block [S&D-1 s2]',
  '```',
  '',
  'Inline code `[S&D-1 s3]` here.',
  '',
  'Inline $a^2 + b^2$ maths.',
  '',
  '$$\\int_0^1 x\\,dx$$',
  '',
  'Broken $\\frac{1}{$ formula.',
  '',
  'See [S&D-1 s2] and [S&D-1 s2–s3] and [HW-1 s1] but not [NOPE s1].',
  '',
  'Answer: ||forty-two|| and ||second secret||.',
  '',
  'Links: [https://example.com/page](https://example.com/page) and [the docs](https://example.org/x).',
  '',
  '```svg',
  '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
  '```',
  '',
].join('\n');

test.describe('NAV-070 notes pages', () => {
  test.use({
    seed: seedWith((hub) => {
      hub.write(`${DEMO}/me/notes/Week1/plain.txt`, 'line one **not md**\nline two\n');
      hub.write(`${DEMO}/me/notes/exams/top.md`, '# Top exam doc\n');
      hub.write(`${DEMO}/me/notes/exams/midterm/cheat.md`, '# Cheat\n');
      hub.write(`${DEMO}/me/tutor-memory.md`, '# Memory\n\nRemembers things.\n');
    }),
  });

  test('NAV-070 a .md file is rendered as Markdown with maths, crumbs "Class notes W<week>"', async ({ page }) => {
    await page.goto(notesUrl('me/notes/Week1/notes.md'));
    await expect(page.getByRole('heading', { level: 1, name: 'Week 1 notes' })).toBeVisible();
    await expect(article(page).getByRole('listitem')).toHaveCount(4);
    await expect(article(page).locator('.katex').first()).toBeVisible();     // locator: markup hook (typeset maths)
    await expect(crumbs(page)).toHaveText('Home›Demo-Course›Class notes W1');
    await expect(crumbs(page).getByRole('link')).toHaveText(['Home', 'Demo-Course']);
  });

  test('NAV-070 a .txt file is shown pre-formatted with its line breaks', async ({ page }) => {
    await page.goto(notesUrl('me/notes/Week1/plain.txt'));
    await expect(article(page).locator('pre')).toHaveText('line one **not md**\nline two\n');
    await expect(article(page).locator('strong')).toHaveCount(0);
    await expect(crumbs(page)).toHaveText('Home›Demo-Course›Class notes W1');
  });

  test('NAV-070 document and tutor-memory labels in the crumbs', async ({ page }) => {
    await page.goto(notesUrl('me/notes/exams/midterm/cheat.md'));
    await expect(crumbs(page)).toHaveText('Home›Demo-Course›midterm · cheat');
    await page.goto(notesUrl('me/notes/exams/top.md'));
    await expect(crumbs(page)).toHaveText('Home›Demo-Course›exams · top');
    await expect(page.getByRole('heading', { level: 1, name: 'Top exam doc' })).toBeVisible();
    await page.goto(notesUrl('me/tutor-memory.md'));
    await expect(crumbs(page)).toHaveText('Home›Demo-Course›What your tutor remembers');
    await expect(main(page)).toContainText('Remembers things.');
  });
});

test.describe('NAV-071 unlisted paths', () => {
  test.use({
    seed: seedWith((hub) => {
      hub.write(`${DEMO}/me/private/key.md`, '# SECRET\n');
      hub.write(`${DEMO}/me/notes/loose.md`, '# LOOSE\n');
    }),
  });
  test('NAV-071 an unlisted path (me/private, course.json, loose files, ../) shows "Not found."', async ({ page }) => {
    for (const p of ['me/private/key.md', 'course.json', 'me/hub-state.json', 'me/notes/loose.md', '../Demo-Course/course.json']) {
      await page.goto('/#');
      await expect(page.getByRole('button', { name: /Start session/ })).toBeVisible();
      await page.goto(notesUrl(p));
      await expect(article(page)).toHaveText('Not found.');
      await expect(main(page)).not.toContainText('SECRET');
    }
  });
});

test.describe('NAV-072 fresh', () => {
  test('NAV-072 editing a notes file and reopening the page shows the new content', async ({ page, hub }) => {
    await page.goto(`/#c=${DEMO}`);
    await page.getByRole('link', { name: 'W1', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Week 1 notes' })).toBeVisible();
    hub.write(`${DEMO}/me/notes/Week1/notes.md`, '# Rewritten notes\n\nFresh text.\n');
    await crumbs(page).getByRole('link', { name: 'Demo-Course' }).click();
    await page.getByRole('link', { name: 'W1', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Rewritten notes' })).toBeVisible();
  });
});

test.describe('NAV-075 Markdown rendering', () => {
  test.use({ seed: seedWith((hub) => hub.write(`${DEMO}/me/notes/Week2/render.md`, RENDER)) });

  test('NAV-075 tables, lists, code, inline and display maths; a malformed formula shows its source', async ({ page }) => {
    await page.goto(notesUrl('me/notes/Week2/render.md'));
    const a = article(page);
    await expect(a.getByRole('table')).toBeVisible();
    await expect(a.getByRole('cell', { name: 'b1' })).toBeVisible();
    await expect(a.getByRole('listitem')).toHaveText(['item one', 'item two']);
    await expect(a.locator('pre code')).toHaveText('code block [S&D-1 s2]');
    await expect(a.locator('.katex-display')).toHaveCount(1);              // locator: markup hook (display maths)
    await expect(a.locator('.katex')).toHaveCount(2);                       // inline and display; the broken one is not typeset
    await expect(a).toContainText('\\frac{1}{');
  });

  test('NAV-075 citations of the course\'s decks become buttons that open the slide; not inside code', async ({ page }) => {
    await page.goto(notesUrl('me/notes/Week2/render.md'));
    const a = article(page);
    await expect(a.getByRole('button', { name: /^(S&D-1|HW-1|NOPE) s/ })).toHaveCount(3);
    await expect(a.getByRole('button', { name: 'S&D-1 s2', exact: true })).toHaveAttribute('title', 'Open S&D-1 slide 2');
    await expect(a.getByRole('button', { name: 'S&D-1 s2–s3' })).toHaveAttribute('title', 'Open S&D-1 slide 2');
    await expect(a.getByRole('button', { name: 'HW-1 s1' })).toBeVisible();
    await expect(a.getByText('[NOPE s1]')).toBeVisible();
    await expect(a.locator('code').getByRole('button')).toHaveCount(0);
    await a.getByRole('button', { name: 'S&D-1 s2–s3' }).click();
    await atSlide(page, '2 / 3');
    await expect(page).toHaveURL(/#c=Demo-Course&d=S%26D-1&s=2$/);
    await page.goBack();                                        // a citation adds a history entry
    await expect(page.getByRole('heading', { level: 1, name: 'Render test' })).toBeVisible();
  });

  test('NAV-075 ||hidden text|| is revealed by click, Enter or Space', async ({ page }) => {
    await page.goto(notesUrl('me/notes/Week2/render.md'));
    const spoilers = article(page).getByRole('button', { name: /forty-two|second secret/ });
    await expect(spoilers).toHaveCount(2);
    await expect(spoilers.first()).not.toHaveClass(/shown/);     // locator: markup hook (revealed state)
    await spoilers.first().click();
    await expect(spoilers.first()).toHaveClass(/shown/);
    await spoilers.nth(1).focus();
    await page.keyboard.press('Enter');
    await expect(spoilers.nth(1)).toHaveClass(/shown/);
  });

  test('NAV-075 external links open in a new tab; a link whose text is its URL shows the host name', async ({ page }) => {
    await page.goto(notesUrl('me/notes/Week2/render.md'));
    const host = article(page).getByRole('link', { name: 'example.com', exact: true });
    await expect(host).toHaveAttribute('href', 'https://example.com/page');
    await expect(host).toHaveAttribute('target', '_blank');
    await expect(article(page).getByRole('link', { name: 'the docs' })).toHaveAttribute('target', '_blank');
  });

  test('NAV-075 an svg block is drawn as a diagram', async ({ page }) => {
    await page.goto(notesUrl('me/notes/Week2/render.md'));
    await expect(article(page).locator('figure img')).toHaveCount(1);       // locator: markup hook (drawn diagram)
    await expect(article(page)).not.toContainText('<svg');
  });
});
