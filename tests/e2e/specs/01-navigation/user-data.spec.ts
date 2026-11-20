/**
 * 01 Navigation · B. User data in me/: notes, documents, private files, deadlines, seen-tracking, deck states, the
 * progress.md mirror, the resume point and the due-review count (NAV-020 … NAV-030).
 */
import * as fs from 'fs';
import { test, expect } from '../../fixtures/hub';
import { DEMO, SD1_HASH, addDeck, addSD2, hubState, review, iso, deadlines, deadlineDate, skipIfYearWraps, seedWith,
  atSlide, blur, seenPosted, deckState, main } from './helpers';

// locator: markup hook — the course page's notes/documents lines are plain paragraphs.
const notesLines = (page) => page.locator('#main p.notes-line');
const classNotes = (page) => notesLines(page).filter({ hasText: 'Your class notes:' });
const continueLink = (page) => page.getByRole('link', { name: /^Continue reading:/ });

test.describe('NAV-020 class notes', () => {
  test.use({
    seed: seedWith((hub) => {
      hub.write(`${DEMO}/me/notes/Week1/c.md`, '# c\n');
      hub.write(`${DEMO}/me/notes/Week1/a.txt`, 'plain a\n');
      hub.write(`${DEMO}/me/notes/Week1/empty.md`, '');
      hub.write(`${DEMO}/me/notes/week2/x.md`, '# lower-case week folder\n');
      hub.write(`${DEMO}/me/notes/Week10/y.md`, '# ten\n');
      hub.write(`${DEMO}/me/notes/Week1/sub/deeper.md`, '# not a class note\n');
      hub.write(`${DEMO}/me/notes/Week1/pic.png`, 'x');
    }),
  });

  test('NAV-020 WeekN .md then .txt files are class notes, by week number; empty files are not listed', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    const links = classNotes(page).getByRole('link');
    await expect(links).toHaveText(['W1', 'W1 (2)', 'W1 (3)', 'W2', 'W10']);
    const hrefs = await links.evaluateAll((as) => as.map((a) => decodeURIComponent(a.getAttribute('href')!)));
    expect(hrefs).toEqual([
      '#c=Demo-Course&notes=me/notes/Week1/c.md',
      '#c=Demo-Course&notes=me/notes/Week1/notes.md',
      '#c=Demo-Course&notes=me/notes/Week1/a.txt',
      '#c=Demo-Course&notes=me/notes/week2/x.md',
      '#c=Demo-Course&notes=me/notes/Week10/y.md',
    ]);
  });
});

test.describe('NAV-021 NAV-022 documents', () => {
  test.use({
    seed: seedWith((hub) => {
      const n = `${DEMO}/me/notes`;
      hub.write(`${n}/exams/top.md`, '# top\n');
      hub.write(`${n}/exams/midterm/cheat.md`, '# cheat\n');
      hub.write(`${n}/exams/midterm/deep/too-deep.md`, '# too deep\n');
      hub.write(`${n}/exams/midterm/readme.txt`, 'not md');
      fs.mkdirSync(hub.path(DEMO, 'me', 'notes', 'exams', 'emptydir'), { recursive: true });
      hub.write(`${n}/labs/lab1.md`, '# lab\n');
      hub.write(`${n}/labs/lab1.txt`, 'not md');
      hub.write(`${n}/assignments/a1/hw.md`, '# hw\n');
      hub.write(`${n}/zzz/x.md`, '# x\n');
      hub.write(`${n}/aaa-other/y.md`, '# y\n');
      hub.write(`${n}/.hidden/h.md`, '# hidden\n');
      hub.write(`${n}/loose.md`, '# loose\n');
      hub.write(`${DEMO}/me/tutor-memory.md`, '# Memory\n\nLikes graphs.\n');
    }),
  });

  test('NAV-021 NAV-022 folders under me/notes are document kinds, exams/labs/assignments first; tutor memory last', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    await expect(notesLines(page)).toHaveText([
      /^Your class notes: /,
      /^Mock tests & cheat sheets: /,
      /^Labs: /,
      /^Assignments: /,
      /^aaa-other: /,
      /^zzz: /,
      /^Voice tutor: /,
    ]);
    const linksOf = (label: string) => notesLines(page).filter({ hasText: new RegExp(`^${label}: `) }).getByRole('link');
    // Loose .md files first (an unnamed group), then one group per sub-folder, named after it; deeper/non-.md files not listed.
    await expect(linksOf('Mock tests & cheat sheets')).toHaveText(['top', 'cheat']);
    await expect(notesLines(page).filter({ hasText: /^Mock tests/ })).toContainText('midterm');
    await expect(linksOf('Labs')).toHaveText(['lab1']);
    await expect(linksOf('Assignments')).toHaveText(['hw']);
    await expect(notesLines(page).filter({ hasText: /^Assignments/ })).toContainText('a1');
    await expect(linksOf('aaa-other')).toHaveText(['y']);
    await expect(linksOf('zzz')).toHaveText(['x']);
    await expect(linksOf('Voice tutor')).toHaveText(['What your tutor remembers']);
    await expect(main(page)).not.toContainText(/too-deep|hidden|loose|emptydir|readme/);
    await linksOf('Voice tutor').click();
    await expect(page.getByText('Likes graphs.')).toBeVisible();
  });
});

test.describe('NAV-023 private files', () => {
  test.use({
    seed: seedWith((hub) => {
      hub.write(`${DEMO}/me/private/key.md`, '# SECRET-KEY-QQ\n');
      hub.write(`${DEMO}/me/notes/loose.md`, '# loose\n');
      hub.write(`${DEMO}/x.md`, '# outside\n');
      hubState(hub, DEMO, {});
    }),
  });

  test('NAV-023 me/private and any unlisted path are never listed or served', async ({ page, api }) => {
    await page.goto(`/#c=${DEMO}`);
    await expect(page.getByRole('heading', { level: 1, name: DEMO })).toBeVisible();
    await expect(main(page)).not.toContainText(/private|key|SECRET/);
    const course = await (await api.get(`/api/course?id=${DEMO}`)).text();
    expect(course).not.toMatch(/private|SECRET/);
    for (const p of ['me/private/key.md', 'course.json', 'me/hub-state.json', 'me/notes/loose.md', '../Demo-Course/x.md',
      'x.md', 'me/notes/Week1/../../private/key.md', 'me/progress.md']) {
      const r = await api.get(`/api/note?course=${DEMO}&path=${encodeURIComponent(p)}`);
      expect(r.status(), p).toBe(404);
      expect(await r.text(), p).not.toContain('SECRET');
    }
    const ok = await api.get(`/api/note?course=${DEMO}&path=${encodeURIComponent('me/notes/Week1/notes.md')}`);
    expect(ok.status()).toBe(200);
    expect(await ok.text()).toContain('# Week 1 notes');
  });
});

test.describe('NAV-024 NAV-025 deadlines', () => {
  test.describe('rows that do not count', () => {
    test.use({
      seed: seedWith((hub) => {
        addSD2(hub);
        hub.write(`${DEMO}/me/progress.md`, [
          '# Progress', '', '## Other', '', '| Date | Item | Weight | Status | Covers |', '|---|---|---|---|---|',
          `| ${deadlineDate(1)} | Not under Deadlines — x | | | W1 |`, '',
          '## Deadlines', '',
          '| Date | Item | Status |', '|---|---|---|', `| ${deadlineDate(1)} | No covers column — x | |`, '',
          '| date | item | weight | status | COVERS |', '|---|---|---|---|---|',
          `| ${deadlineDate(1)} | Done one — x | | Done ✓ | W1 |`,
          `| ${deadlineDate(2)} | Submitted one — x | | submitted | W1 |`,
          `| ${deadlineDate(2)} | Completed one — x | | Complete | W1 |`,
          `| ${deadlineDate(3)} | Ungraded — no covers | | | |`,
          `| ${deadlineDate(-2)} | Already past — x | | | W1 |`,
          `| ${deadlineDate(5, 'long').toLowerCase()} | **Quiz 1** — markets and prices | 10% | in progress | W2 (and some of W3) |`,
          '', '## Weak topics', '',
        ].join('\n'));
      }),
    });

    test('NAV-024 NAV-025 only Deadlines tables with Covers count; done, uncovered and past rows are ignored', async ({ page, api }) => {
      skipIfYearWraps(test, -2, 1, 2, 3, 5);
      await page.goto(`/#c=${DEMO}`);
      // "**" removed, name = text before the em dash; long month name in any case; weeks before "(" → W2 only.
      await expect(main(page)).toContainText('Quiz 1 · in 5 days · covers Supply and Demand');
      await expect(main(page)).not.toContainText('(scope assumed)');
      const next = (await (await api.get(`/api/course?id=${DEMO}`)).json()).next;
      expect(next).toMatchObject({ name: 'Quiz 1', detail: 'Quiz 1 — markets and prices', approx: false, assumed: false,
        weeks: [2, 2], days: 5, date: iso(5) });
    });
  });

  test.describe('approximate and assumed', () => {
    test.use({
      seed: seedWith((hub) => {
        addSD2(hub);
        addDeck(hub, DEMO, 'EL-1', { tag: 'EL-1', title: 'Elasticity', topic: 'Elasticity', week: 3, order: 1, pages: 2 });
        addDeck(hub, DEMO, 'UN-1', { tag: 'UN-1', title: 'Unsorted', topic: '', week: 2, order: 2, pages: 2 });
        addDeck(hub, DEMO, 'LATE', { tag: 'LATE', title: 'Late', topic: 'Later topic', week: 9, order: 1, pages: 2 });
        deadlines(hub, DEMO, [
          `| ${deadlineDate(10)} | **Quiz 2** — later | 10% | | W1 |`,
          `| ~${deadlineDate(3)}. | Midterm — weeks 2 to 3 | 30% | | W2-3 (assumed) |`,
          '| TBA | Final — everything | 40% | | all |',
        ]);
      }),
    });

    test('NAV-024 NAV-025 "~" marks an approximate date, "assumed" an assumed scope; topics are those with decks in range', async ({ page }) => {
      skipIfYearWraps(test, 3, 10);
      await page.goto(`/#c=${DEMO}`);
      await expect(main(page)).toContainText('Midterm · ~in 3 days · covers Supply and Demand, Elasticity (scope assumed)');
      await page.goto('/');
      await expect(page.locator('#main p').first()).toHaveText('Demo-Course Midterm · ~in 3 days · Supply and Demand, Elasticity');
    });
  });

  test.describe('undated', () => {
    test.use({
      seed: seedWith((hub) => {
        deadlines(hub, DEMO, [
          '| TBA | Final — everything | 40% | | W1-12 |',
          `| ${deadlineDate(-3)} | Past one — x | | | W1 |`,
          '| Week 12 | Second undated — x | | | W1 |',
        ]);
      }),
    });

    test('NAV-024 NAV-025 with no dated upcoming test, the first undated one is next and shows its Date cell', async ({ page }) => {
      skipIfYearWraps(test, -3);
      await page.goto(`/#c=${DEMO}`);
      await expect(main(page)).toContainText('Final · TBA · covers Supply and Demand');
    });
  });
});

test.describe('NAV-026 NAV-055 seen tracking', () => {
  test('NAV-026 NAV-055 a slide shown for ~0.5 s is recorded: seen list, last slide, resume point; the last slide marks it read', async ({ page, hub }) => {
    let seen = seenPosted(page);
    await page.goto(`/${SD1_HASH}&s=2`);
    await seen;
    expect(deckState(hub, DEMO, 'S&D-1')).toEqual({ seen: [2], last: 2, read: false, solved: false });
    expect(hub.readJson(DEMO, 'me', 'hub-state.json').resume).toEqual({ deck: 'S&D-1', slide: 2 });
    seen = seenPosted(page);
    await blur(page);
    await page.keyboard.press('ArrowRight');
    await seen;
    // Pinned as-is: reaching the last slide makes the deck read even though slide 1 was never seen.
    expect(deckState(hub, DEMO, 'S&D-1')).toEqual({ seen: [2, 3], last: 3, read: true, solved: false });
    expect(hub.readJson(DEMO, 'me', 'hub-state.json').resume).toEqual({ deck: 'S&D-1', slide: 3 });
  });

  test('NAV-026 slides passed through quickly are not recorded, and the end card records nothing', async ({ page, hub }) => {
    await page.goto(`/${SD1_HASH}&s=1`);
    await atSlide(page, '1 / 3');
    const seen = seenPosted(page);
    // Two steps in one go, well inside half a second (the handler listens on the document).
    await page.evaluate(() => {
      for (let i = 0; i < 2; i++) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    await atSlide(page, '3 / 3');
    await seen;
    expect(deckState(hub, DEMO, 'S&D-1').seen).toEqual([3]);
    await blur(page);
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('heading', { name: 'End of S&D-1' })).toBeVisible();
    let posted = false;
    page.on('request', (r) => { if (r.url().includes('/api/seen')) posted = true; });
    await page.waitForTimeout(1200);   // longer than the documented ~0.5 s seen delay: nothing may be recorded
    expect(posted).toBe(false);
    expect(deckState(hub, DEMO, 'S&D-1')).toMatchObject({ seen: [3], last: 3 });
    expect(hub.readJson(DEMO, 'me', 'hub-state.json').resume).toEqual({ deck: 'S&D-1', slide: 3 });
  });

  test.describe('without me/', () => {
    test.use({ seed: seedWith((hub) => fs.rmSync(hub.path(DEMO, 'me'), { recursive: true, force: true })) });
    test('NAV-026 NAV-028 me/ and hub-state.json are created when missing; progress.md is not', async ({ page, hub }) => {
      const seen = seenPosted(page);
      await page.goto(`/${SD1_HASH}&s=1`);
      await seen;
      expect(deckState(hub, DEMO, 'S&D-1')).toMatchObject({ seen: [1], last: 1, read: false });
      expect(hub.exists(DEMO, 'me', 'progress.md')).toBe(false);
    });
  });
});

test.describe('NAV-027 deck states', () => {
  test.use({
    seed: seedWith((hub) => {
      addSD2(hub);
      addDeck(hub, DEMO, 'EL-1', { tag: 'EL-1', title: 'Elasticity', topic: 'Elasticity', week: 3, order: 1, pages: 2 });
      hubState(hub, DEMO, {
        decks: {
          'S&D-1': { seen: [1, 2, 3], last: 3, read: true, solved: true },
          'S&D-2': { seen: [1, 2, 3], last: 3, read: true, solved: false },
          'EL-1': { seen: [1], last: 1, read: false, solved: false },
        },
        resume: { deck: 'EL-1', slide: 1 },
      });
    }),
  });

  test('NAV-027 not started / started / read / solved show on the course page, the sidebar and home', async ({ page }) => {
    await page.goto(`/#c=${DEMO}&t=Supply+and+Demand`);
    const row = (tag: string) => page.locator('#main a', { hasText: `${tag} · ` });   // locator: markup hook (hidden rows)
    await expect(row('S&D-1').getByTitle('Solved', { exact: true })).toBeAttached();
    await expect(row('S&D-2').getByTitle('Read · solve one to finish', { exact: true })).toBeAttached();
    await expect(row('S&D-2')).toContainText('Solve one to finish');
    await expect(row('S&D-1')).toContainText('3 slides');
    await expect(row('EL-1').getByTitle('Started', { exact: true })).toBeAttached();
    await expect(row('HW-1').getByTitle('Not started', { exact: true })).toBeAttached();
    await expect(page.locator('.topics section > button', { hasText: 'Supply and Demand' })).toContainText('1/2');

    // Sidebar: each deck link's tooltip carries the state.
    await page.getByRole('button', { name: 'Show or hide the topics sidebar' }).click();
    const nav = page.getByRole('complementary', { name: 'Topics' });
    await expect(nav.locator('a[title="Supply and demand 1 · Solved"]')).toBeAttached();    // locator: markup hook
    await expect(nav.locator('a[title="Supply and demand 2 · Read · solve one to finish"]')).toBeAttached();
    await expect(nav.locator('a[title="Elasticity · Started"]')).toBeAttached();
    await expect(nav.locator('a[title="Homework 1 · Not started"]')).toBeAttached();

    // Home: one dot per lecture deck with more than one slide.
    await page.goto('/');
    const dots = page.getByLabel('1 of 3 decks solved');
    await expect(dots).toBeVisible();
    await expect(dots.getByTitle('S&D-1: solved')).toBeAttached();
    await expect(dots.getByTitle('S&D-2: read')).toBeAttached();
    await expect(dots.getByTitle('EL-1: started')).toBeAttached();
  });
});

test.describe('NAV-028 progress.md mirror', () => {
  test('NAV-028 the first recorded slide appends the "Mistakes saved in the Study Hub" block to progress.md', async ({ page, hub }) => {
    const lf = (t: string) => t.replace(/\r\n/g, '\n');    // line endings are the platform's
    const before = lf(hub.read(DEMO, 'me', 'progress.md'));
    const seen = seenPosted(page);
    await page.goto(`/${SD1_HASH}&s=1`);
    await seen;
    const after = lf(hub.read(DEMO, 'me', 'progress.md'));
    expect(after.startsWith(before.trimEnd())).toBe(true);
    expect(after).toContain([
      '<!-- study-hub:start -->',
      '## Mistakes saved in the Study Hub',
      '',
      "Written by the Study Hub from `me/hub-state.json`; don't edit by hand. Use it for mocks and cheat sheets.",
      '',
      'None yet.',
      '<!-- study-hub:end -->',
    ].join('\n'));
  });

  test.describe('existing block', () => {
    test.use({
      seed: seedWith((hub) => hub.write(`${DEMO}/me/progress.md`, '# Progress\n\nBEFORE text.\n\n<!-- study-hub:start -->\n'
        + '## Mistakes saved in the Study Hub\n\nOLD STALE ROWS\n<!-- study-hub:end -->\n\nAFTER text.\n')),
    });
    test('NAV-028 an existing block is replaced and the text around it is left unchanged', async ({ page, hub }) => {
      const seen = seenPosted(page);
      await page.goto(`/${SD1_HASH}&s=1`);
      await seen;
      const after = hub.read(DEMO, 'me', 'progress.md').replace(/\r\n/g, '\n');   // line endings are the platform's
      expect(after).not.toContain('OLD STALE ROWS');
      expect(after).toMatch(/^# Progress\n\nBEFORE text\.\n\n<!-- study-hub:start -->\n[\s\S]*None yet\.\n<!-- study-hub:end -->\n\nAFTER text\.\n$/);
      expect(after.match(/study-hub:start/g)).toHaveLength(1);
    });
  });
});

test.describe('NAV-029 resume point', () => {
  test('NAV-029 resume follows the last slide viewed; once that deck is read it moves to the first unread deck', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    await expect(continueLink(page)).toHaveText('Continue reading: S&D-1 · slide 1 ›');
    let seen = seenPosted(page);
    await page.goto(`/${SD1_HASH}&s=2`);
    await seen;
    await page.goto(`/#c=${DEMO}`);
    await expect(continueLink(page)).toHaveText('Continue reading: S&D-1 · slide 2 ›');
    seen = seenPosted(page);
    await page.goto(`/${SD1_HASH}&s=3`);
    await seen;
    await page.goto(`/#c=${DEMO}`);
    // Pinned as-is: practice decks count for the resume point (HW-1 is next in lecture order).
    await expect(continueLink(page)).toHaveText('Continue reading: HW-1 · slide 1 ›');
    await continueLink(page).click();
    await atSlide(page, '1 / 2');
    await expect(page).toHaveURL(/d=HW-1&s=1$/);
  });

  test.describe('first unread deck at its last slide', () => {
    test.use({
      seed: seedWith((hub) => {
        addSD2(hub);
        hubState(hub, DEMO, {
          decks: { 'S&D-1': { seen: [1, 2, 3], last: 3, read: true, solved: false },
            'HW-1': { seen: [1, 2], last: 2, read: true, solved: false },
            'S&D-2': { seen: [2], last: 2, read: false, solved: false } },
          resume: { deck: 'S&D-1', slide: 3 },
        });
      }),
    });
    test('NAV-029 the first unread deck in lecture order opens at its last slide', async ({ page }) => {
      await page.goto(`/#c=${DEMO}`);
      await expect(continueLink(page)).toHaveText('Continue reading: S&D-2 · slide 2 ›');
    });
  });

  test.describe('everything read', () => {
    test.use({
      seed: seedWith((hub) => hubState(hub, DEMO, {
        decks: { 'S&D-1': { seen: [1, 2, 3], last: 3, read: true, solved: false }, 'HW-1': { seen: [2], last: 2, read: true, solved: false } },
        resume: { deck: 'S&D-1', slide: 2 },
      })),
    });
    test('NAV-029 with every deck read, resume stays on the last slide viewed', async ({ page }) => {
      await page.goto(`/#c=${DEMO}`);
      await expect(continueLink(page)).toHaveText('Continue reading: S&D-1 · slide 2 ›');
    });
  });

  test.describe('everything read, nothing viewed', () => {
    test.use({
      seed: seedWith((hub) => hubState(hub, DEMO, {
        decks: { 'S&D-1': { seen: [3], last: 3, read: true, solved: false }, 'HW-1': { seen: [2], last: 2, read: true, solved: false } },
      })),
    });
    test('NAV-029 with every deck read and no last view, resume is the first deck at slide 1', async ({ page }) => {
      await page.goto(`/#c=${DEMO}`);
      await expect(continueLink(page)).toHaveText('Continue reading: S&D-1 · slide 1 ›');
    });
  });
});

test.describe('NAV-030 due reviews', () => {
  test.describe('one due', () => {
    test.use({ seed: seedWith((hub) => hubState(hub, DEMO, { reviews: [review('r1', iso(0)), review('r2', iso(2))] })) });
    test('NAV-030 NAV-042 one review due today: "1 quick review · ~2 min first" with Just the reviews', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByText('1 quick review · ~2 min first ·')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Just the reviews' })).toHaveAttribute('href', '#review=Demo-Course');
      await page.goto(`/#c=${DEMO}`);
      await expect(page.getByText('1 quick review · ~2 min first ·')).toBeVisible();
    });
  });

  test.describe('over the daily cap', () => {
    test.use({
      seed: seedWith((hub) => hubState(hub, DEMO, {
        reviews: [1, 2, 3, 4, 5, 6, 7].map((i) => review(`r${i}`, iso(-i))),
      })),
    });
    test('NAV-030 at most 5 reviews a day are counted, ~1.5 min each rounded', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByText('5 quick reviews · ~8 min first ·')).toBeVisible();
    });
  });

  test.describe('some answered today', () => {
    test.use({
      seed: seedWith((hub) => hubState(hub, DEMO, {
        reviews: [
          ...[1, 2, 3].map((i) => review(`d${i}`, iso(-1))),
          ...[1, 2, 3].map((i) => review(`a${i}`, iso(3), { last: iso(0), step: 1 })),
          review('retired', iso(-1), { retired: true }),
        ],
      })),
    });
    test('NAV-030 reviews already answered today count against the daily limit of 5', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByText('2 quick reviews · ~3 min first ·')).toBeVisible();
    });
  });
});
