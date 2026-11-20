/**
 * 01 Navigation · A. Library discovery and data contract (NAV-001 … NAV-012).
 *
 * Not covered:
 * // Not covered: NAV-001 (the `library` value in config.json and the default `library/` folder: the harness always
 * //   sets the library explicitly, and testing the fallbacks would mean editing the repo's own config.json)
 */
import * as fs from 'fs';
import { test, expect } from '../../fixtures/hub';
import { DEMO, SD1_HASH, addCourse, addDeck, addSD2, transcript, atSlide, blur, main, deadlines, deadlineDate,
  skipIfYearWraps, seedWith } from './helpers';

// locator: markup hook — the home course list and course-page sections have no accessible names of their own;
// collapsed topics hide their deck links, so rows are read with locator('a') rather than by role.
const courseRows = (page) => page.locator('.courses a');
const topicHeads = (page) => page.locator('.topics section > button');
const topicSection = (page, name: string) =>
  page.locator('.topics section').filter({ has: page.locator('button > b', { hasText: new RegExp(`^${name}$`) }) });
const practiceSection = (page) => page.locator('section').filter({ has: page.getByRole('heading', { name: 'Practice' }) });

test.describe('NAV-001 library location', () => {
  test.use({ seed: seedWith((hub) => addCourse(hub, 'Zeta-Course', { code: 'ZETA 9', title: 'Only in this library' })) });
  test('NAV-001 the hub shows the courses of the library folder it was started on', async ({ page }) => {
    await page.goto('/');
    await expect(courseRows(page)).toHaveCount(2);
    await expect(page.getByRole('link', { name: /ZETA 9 Only in this library/ })).toBeVisible();
  });
});

test.describe('NAV-001 missing library folder', () => {
  test.use({ seed: seedWith((hub) => fs.rmSync(hub.library, { recursive: true, force: true })) });
  test('NAV-001 NAV-090 a library folder that does not exist: the hub starts and shows no courses', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#main .courses')).toHaveCount(1);   // locator: markup hook (home rendered)
    await expect(courseRows(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Start session/ })).toHaveCount(0);
    await expect(main(page)).not.toContainText('No upcoming tests');
  });
});

test.describe('NAV-002 NAV-003 courses', () => {
  test.use({
    seed: seedWith((hub) => {
      addCourse(hub, 'Aaa-Course', { code: 'AAA 1', title: 'First by folder' });
      addCourse(hub, 'Zed-Course', { code: 'ZED 2', title: 'Last by folder' });
      addCourse(hub, 'No-Json', null);                                     // no course.json: not a course
      fs.mkdirSync(hub.path('No-Json', 'decks'), { recursive: true });
      addCourse(hub, 'Group/Inner-Course', { code: 'INNER', title: 'Nested' });   // not a direct sub-folder
      addCourse(hub, 'Empty-Json', {});                                      // code/title fall back to the folder
      addCourse(hub, 'Blank-Json', { code: '   ', title: '' });
      addCourse(hub, 'Bad-Json', '{this is not json');
    }),
  });

  test('NAV-002 only direct sub-folders with course.json are courses, listed by folder name', async ({ page }) => {
    await page.goto('/');
    await expect(courseRows(page)).toHaveCount(6);
    const hrefs = await courseRows(page).evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs).toEqual(['#c=Aaa-Course', '#c=Bad-Json', '#c=Blank-Json', `#c=${DEMO}`, '#c=Empty-Json', '#c=Zed-Course']);
    await expect(main(page)).not.toContainText('No-Json');
    await expect(main(page)).not.toContainText('INNER');
    // The course id is the folder name: its page opens by it.
    await page.getByRole('link', { name: /AAA 1 First by folder/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'AAA 1' })).toBeVisible();
    await expect(page).toHaveURL(/#c=Aaa-Course$/);
  });

  test('NAV-003 a missing, blank or unreadable course.json code/title falls back to the folder name', async ({ page }) => {
    await page.goto('/');
    for (const id of ['Empty-Json', 'Blank-Json', 'Bad-Json']) {
      await expect(page.locator(`.courses a[href="#c=${id}"] b`)).toHaveText(`${id} ${id}`);   // locator: markup hook
    }
    await page.goto('/#c=Bad-Json');
    await expect(page.getByRole('heading', { level: 1, name: 'Bad-Json' })).toBeVisible();
    await expect(main(page)).toContainText('Bad-Json');
  });
});

test.describe('NAV-004 decks', () => {
  test.use({
    seed: seedWith((hub) => {
      addCourse(hub, 'Decks-Course', { code: 'DK', title: 'Deck parsing' });
      addDeck(hub, 'Decks-Course', 'bad-json', '{not json', { images: 1, transcript: null });
      addDeck(hub, 'Decks-Course', 'empty', '{}', { images: 1, transcript: null });
      addDeck(hub, 'Decks-Course', 'blank', '', { images: 1, transcript: null });
      addDeck(hub, 'Decks-Course', 'NoTag', { week: '2nd', order: '1', pages: '2 pages', topic: 'T', prepared: true });
      addDeck(hub, 'Decks-Course', 'X', { tag: 'X-1', week: 'abc', pages: 1, topic: 'T', prepared: 'true' },
        { transcript: '## [X-1 s1] Raw one\n\nraw text $x^2$ here\n' });
    }),
  });

  test('NAV-004 invalid or empty deck.json is skipped; tag, title, numbers and prepared are read leniently', async ({ page }) => {
    await page.goto('/#c=Decks-Course');
    await expect(topicHeads(page)).toHaveCount(1);
    const t = topicSection(page, 'T');
    await expect(t.getByRole('link')).toHaveCount(2);
    // Folder name as tag, tag as title, "2nd" → week 2, "2 pages" → 2 slides.
    const noTag = t.getByRole('link', { name: /NoTag · NoTag/ });
    await expect(noTag).toContainText('W2');
    await expect(noTag).toContainText('2 slides');
    // "abc" → week 0.
    const x = t.getByRole('link', { name: /X-1 · X-1/ });
    await expect(x).toContainText('W0');
    await expect(x).toContainText('1 slides');
    await expect(main(page)).not.toContainText('bad-json');
    await expect(main(page)).not.toContainText('empty');
    // prepared "true" (a string) is not prepared: the slide text is shown raw.
    await x.click();
    await atSlide(page, '1 / 1');
    await page.locator('#text-btn').click();    // locator: markup hook (the tutor panel also has a "Text" button)
    await expect(page.locator('#transcript')).toContainText('Text layer only; equations and diagrams may be missing.');
    await page.goto('/#c=Decks-Course&d=NoTag&s=1');
    await atSlide(page, '1 / 2');
  });
});

test.describe('NAV-005 deck roles', () => {
  test.use({
    seed: seedWith((hub) => {
      addCourse(hub, 'Roles', { code: 'RL', title: 'Roles' });
      addDeck(hub, 'Roles', 'P1', { tag: 'P1', title: 'Paper', role: 'PRACTICE', topic: 'Alpha', week: 1, pages: 1 });
      addDeck(hub, 'Roles', 'L1', { tag: 'L1', title: 'Lecture', role: 'lecture', topic: 'Alpha', week: 1, order: 1, pages: 2 });
      addDeck(hub, 'Roles', 'U1', { tag: 'U1', title: 'Blank topic', topic: '  ', week: 1, order: 2, pages: 2 });
      addDeck(hub, 'Roles', 'U2', { tag: 'U2', title: 'Unsorted any case', topic: 'UNSORTED', week: 1, order: 3, pages: 2 });
      addDeck(hub, 'Roles', 'U3', { tag: 'U3', title: 'No topic key', week: 1, order: 4, pages: 2 });
    }),
  });

  test('NAV-005 practice decks go under Practice whatever their topic; blank/Unsorted topics under "Not sorted yet"', async ({ page }) => {
    await page.goto('/#c=Roles');
    await expect(topicHeads(page)).toHaveText([/^›Alpha0\/1$/, /^›Not sorted yet0\/3$/]);
    const alpha = topicSection(page, 'Alpha');
    await expect(alpha.locator('a')).toHaveText([/L1 · Lecture/]);
    const unsorted = topicSection(page, 'Not sorted yet');
    await expect(unsorted.locator('a')).toHaveText([/U1 · Blank topic/, /U2 · Unsorted any case/, /U3 · No topic key/]);
    await expect(practiceSection(page).locator('a')).toHaveText([/P1 · Paper/]);
  });
});

test.describe('NAV-006 ordering', () => {
  test.use({
    seed: seedWith((hub) => {
      addCourse(hub, 'Order', { code: 'ORD', title: 'Ordering',
        topics: [{ name: 'Zeta' }, { name: 'Alpha' }, { name: 'Gamma' }, { name: 'Listed but empty', read_more: 'x' }] });
      const d = (folder: string, topic: string, week: number, order: number, extra = {}) =>
        addDeck(hub, 'Order', folder, { tag: folder.toUpperCase(), title: `${folder} deck`, topic, week, order, pages: 2, ...extra });
      d('a', 'Alpha', 2, 1);
      d('b', 'Gamma', 1, 2);
      d('c', 'Zeta', 1, 5);
      d('cc', 'Zeta', 1, 5);          // same week and order as c: folder name decides
      d('d', 'Gamma', 1, 1);
      d('e', '', 0, 0);               // earliest of all, but "Not sorted yet" is always last
      d('f', 'Alpha', 1, 9);
      d('p2', '', 2, 0, { role: 'practice' });
      d('p1', '', 1, 3, { role: 'practice' });
      d('p0', '', 1, 3, { role: 'practice' });
    }),
  });

  test('NAV-006 topics by their earliest deck, decks in lecture order, Not sorted yet last, empty listed topics hidden', async ({ page }) => {
    await page.goto('/#c=Order');
    await expect(topicHeads(page)).toHaveText([/Gamma/, /Zeta/, /Alpha/, /Not sorted yet/]);
    await expect(main(page)).not.toContainText('Listed but empty');
    await expect(topicSection(page, 'Gamma').locator('a')).toHaveText([/^D · d deck/, /^B · b deck/]);
    await expect(topicSection(page, 'Zeta').locator('a')).toHaveText([/^C · c deck/, /^CC · cc deck/]);
    await expect(topicSection(page, 'Alpha').locator('a')).toHaveText([/^F · f deck/, /^A · a deck/]);
    await expect(practiceSection(page).locator('a')).toHaveText([/^P0 · /, /^P1 · /, /^P2 · /]);
  });
});

test.describe('NAV-007 duplicate tags', () => {
  test.use({
    seed: seedWith((hub) => {
      addCourse(hub, 'Dups', { code: 'DUP', title: 'Duplicates' });
      addDeck(hub, 'Dups', 'a-dup', { tag: 'DUP', title: 'Later in lecture order', topic: 'T', week: 1, order: 2, pages: 2 });
      addDeck(hub, 'Dups', 'b-dup', { tag: 'DUP', title: 'Earlier in lecture order', topic: 'T', week: 1, order: 1, pages: 2 });
      addDeck(hub, 'Dups', 'x1', { tag: 'TWIN', title: 'First folder', topic: 'T', week: 1, order: 5, pages: 2 });
      addDeck(hub, 'Dups', 'x2', { tag: 'TWIN', title: 'Second folder', topic: 'T', week: 1, order: 5, pages: 2 });
    }),
  });

  test('NAV-007 when two decks claim a tag, the first in lecture order keeps it and the other is not shown', async ({ page }) => {
    await page.goto('/#c=Dups');
    const rows = topicSection(page, 'T').getByRole('link');
    await expect(rows).toHaveText([/DUP · Earlier in lecture order/, /TWIN · First folder/]);
  });
});

test.describe('NAV-008 read more', () => {
  test.use({ seed: seedWith((hub) => addDeck(hub, DEMO, 'EL-1', { tag: 'EL-1', title: 'Elasticity', topic: 'Elasticity', week: 3, order: 1, pages: 2 })) });

  test('NAV-008 a topic shows its read_more from course.json; a topic without one shows nothing extra', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    await expect(topicSection(page, 'Supply and Demand')).toContainText('Textbook: Any introductory economics textbook, chapter on markets');
    await topicSection(page, 'Elasticity').getByRole('button').click();
    await expect(topicSection(page, 'Elasticity').getByRole('link', { name: /EL-1/ })).toBeVisible();
    await expect(topicSection(page, 'Elasticity')).not.toContainText('Textbook:');
  });
});

test.describe('NAV-009 slide text', () => {
  test.use({
    seed: seedWith((hub) => {
      addDeck(hub, DEMO, 'TR', { tag: 'TR', title: 'Transcript rules', topic: 'Supply and Demand', week: 5, pages: 3, prepared: true }, {
        transcript: '# Transcript\n\n## [TR s1] First title\n\nBody one **bold**.\n\nType: admin\n\n'
          + '## [TR s3] Third title\n\nBody three.\n\n## [TR s5] Beyond pages\n\nQQBEYONDPAGES text.\n',
      });
      addDeck(hub, DEMO, 'NOTR', { tag: 'NOTR', title: 'No transcript', topic: 'Supply and Demand', week: 6, pages: 2, prepared: true },
        { transcript: null });
    }),
  });

  test('NAV-009 each slide text comes from its "## [tag sN] title" section; missing ones are empty, extra ones ignored', async ({ page }) => {
    await page.goto('/#c=Demo-Course&d=TR&s=1');
    await atSlide(page, '1 / 3');
    await expect(page.getByRole('img', { name: 'Slide 1: First title' })).toBeVisible();
    await page.locator('#text-btn').click();
    const panel = page.locator('#transcript');    // locator: markup hook
    await expect(panel.getByRole('heading')).toHaveText('Slide 1 · First title');
    await expect(panel).toContainText('Body one bold.');
    await expect(panel).not.toContainText('Type: admin');
    await blur(page);
    await page.keyboard.press('ArrowRight');
    await atSlide(page, '2 / 3');
    await expect(panel.getByRole('heading')).toHaveText('Slide 2');
    await expect(page.getByRole('img', { name: 'Slide 2', exact: true })).toBeAttached();
    await page.keyboard.press('ArrowRight');
    await expect(panel.getByRole('heading')).toHaveText('Slide 3 · Third title');
    // Exactly `pages` slides: the s5 section is ignored (not even searchable).
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('heading', { name: 'End of TR' })).toBeVisible();
    await page.keyboard.press('Control+k');
    await page.getByRole('searchbox', { name: 'Search all slides' }).fill('qqbeyondpages');
    await expect(page.getByText('Nothing matches "qqbeyondpages".')).toBeVisible();
  });

  test('NAV-009 a deck without transcript.md has untitled slides with empty text', async ({ page }) => {
    await page.goto('/#c=Demo-Course&d=NOTR&s=1');
    await atSlide(page, '1 / 2');
    await page.locator('#text-btn').click();
    await expect(page.locator('#transcript').getByRole('heading')).toHaveText('Slide 1');
    await expect(page.locator('#transcript')).toHaveText('Slide 1');
  });
});

test.describe('NAV-010 slide images', () => {
  test('NAV-010 slide N is served from sNNN.jpg; numbers outside 1…pages give no image', async ({ page, api }) => {
    await page.goto(`/${SD1_HASH}&s=2`);
    const img = page.getByRole('img', { name: 'Slide 2: Demand and supply curves' });
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(900);
    const ok = await api.get('/api/slide?course=Demo-Course&tag=S%26D-1&n=3');
    expect(ok.status()).toBe(200);
    expect(ok.headers()['content-type']).toBe('image/jpeg');
    for (const n of [0, 4, -1]) expect((await api.get(`/api/slide?course=Demo-Course&tag=S%26D-1&n=${n}`)).status()).toBe(404);
  });
});

test.describe('NAV-011 never shown', () => {
  test.use({
    seed: seedWith((hub) => {
      hub.write(`${DEMO}/sources/Week1/lecture.pdf`, '%PDF-1.4 QQSOURCEPDF');
      hub.write(`${DEMO}/sources/Week1/notes.md`, '# QQSOURCEMD\n');
      hub.write(`${DEMO}/.work/SD-9/transcript.md`, '## [S&D-9 s1] QQWORKTITLE\n\nQQWORK\n');
      hub.write(`${DEMO}/decks/SD-1/original.pdf`, '%PDF-1.4 QQDECKPDF');
      fs.appendFileSync(hub.path(DEMO, 'CLAUDE.md'), '\nQQCLAUDE marker.\n');
    }),
  });

  test('NAV-011 PDFs, sources/, .work/ and CLAUDE.md never appear in the UI or search', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    await expect(page.getByRole('heading', { level: 1, name: DEMO })).toBeVisible();
    await expect(main(page)).not.toContainText(/QQ|lecture\.pdf|sources/);
    await page.getByRole('button', { name: 'Search all slides (Ctrl K)' }).click();
    await page.getByRole('searchbox', { name: 'Search all slides' }).fill('qq');
    await expect(page.getByText('Nothing matches "qq".')).toBeVisible();
  });
});

test.describe('NAV-012 live library changes', () => {
  test('NAV-012 new decks, edited course.json, transcripts, progress.md, new courses and notes show without a restart', async ({ page, hub }) => {
    skipIfYearWraps(test, 4);
    await page.goto(`/#c=${DEMO}`);
    await expect(page.getByRole('link', { name: /S&D-1 · Supply and demand 1/ })).toBeVisible();

    // A new deck folder, an edited course.json and a new notes file.
    addSD2(hub);
    const cj = hub.readJson(DEMO, 'course.json');
    hub.write(`${DEMO}/course.json`, JSON.stringify({ ...cj, title: 'Retitled on disk' }));
    hub.write(`${DEMO}/me/notes/Week2/new.md`, '# Added while running\n');
    deadlines(hub, DEMO, [`| ${deadlineDate(4)} | Pop quiz — added | 5% | | W1 |`]);
    await page.reload();
    await expect(page.getByRole('link', { name: /S&D-2 · Supply and demand 2/ })).toBeVisible();
    await expect(page.getByText('Retitled on disk')).toBeVisible();
    await expect(page.getByRole('link', { name: 'W2', exact: true })).toBeVisible();
    await expect(main(page)).toContainText('Pop quiz · in 4 days');

    // An edited transcript.
    const tr = hub.read(DEMO, 'decks', 'SD-1', 'transcript.md').replace('Title slide.', 'EDITED ON DISK.');
    hub.write(`${DEMO}/decks/SD-1/transcript.md`, tr);
    await page.goto(`/${SD1_HASH}&s=1`);
    await page.reload();
    await page.locator('#text-btn').click();
    await expect(page.locator('#transcript')).toContainText('EDITED ON DISK.');

    // A new course folder, and a removed notes file.
    addCourse(hub, 'New-Course', { code: 'NEW 1', title: 'Appeared' });
    fs.rmSync(hub.path(DEMO, 'me', 'notes', 'Week2', 'new.md'));
    await page.goto('/');
    await page.reload();
    await expect(page.getByRole('link', { name: /NEW 1 Appeared/ })).toBeVisible();
    await page.goto(`/#c=${DEMO}`);
    await expect(page.getByRole('link', { name: 'W1', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'W2', exact: true })).toHaveCount(0);
  });
});
