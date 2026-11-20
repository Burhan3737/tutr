/**
 * 03 · The review queue: what is due and the daily cap, the schedule (1 → 3 → 7 → 14 → 30 days), the review page,
 * notes, and the mirror into progress.md.  Spec: docs/functional-spec/03-practice-reviews-drills.md (REV-*)
 *
 * Review state is seeded on disk with dates relative to today; date-sensitive tests skip within 2 minutes of midnight.
 *
 * Not covered:
 *   REV-011 the quality of the variation (model-dependent); the prompt's contents are pinned.
 */
import * as fs from 'fs';
import { test, expect } from '../../fixtures/hub';
import type { Hub } from '../../fixtures/hub';
import {
  readText, DEMO, MARK_CLEAN, MARK_UNREADABLE, MARK_WRONG, apiCheck, apiNew, hubState, iso, mark, practiceRules, problem,
  readState, resultBox, review, reviewsOnDisk, seedSession, seedWith, skipNearMidnight,
} from './helpers';

test.beforeEach(() => skipNearMidnight(test));

const RESUME = { resume: { deck: 'S&D-1', slide: 2 }, decks: { 'S&D-1': { seen: [1, 2], last: 2, read: false, solved: false } } };

// ============================================================ due, cap and counts

test.describe('due items and the daily cap', () => {
  test.use({ seed: seedWith((hub: Hub) => hubState(hub, { ...RESUME, reviews: [
    review('r7', -1, { created: iso(-2) }), review('r1', -7), review('r2', -6), review('r3', -5), review('r4', -4),
    review('r5', -3), review('r6', -1, { created: iso(-9) }),
    review('rfuture', 1), review('rtoday', 0, { created: iso(-1) }),
  ] })) });

  test('REV-003 REV-004 at most 5 are offered, oldest due first (then oldest created); home shows the count', async ({ page, api }) => {
    const items = await (await api.get(`/api/reviews?course=${DEMO}`)).json();
    expect(items.map((r: any) => r.id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
    expect(Object.keys(items[0]).sort()).toEqual(['concept', 'deck', 'id', 'mistake', 'slides']);
    await page.goto('/');
    await expect(page.locator('main')).toContainText('5 quick reviews · ~8 min first · Just the reviews');
    await page.getByRole('link', { name: 'Just the reviews' }).click();
    await expect(page).toHaveURL(/#review=Demo-Course$/);
    await expect(page.getByText('1 of 5', { exact: true })).toBeVisible();
  });

  test('REV-003 items practised today count against the 5 and are not offered again', async ({ api, hub }) => {
    const s = readState(hub);
    for (const r of s.reviews) if (r.id === 'r1' || r.id === 'r2') { r.last = iso(0); r.due = iso(3); r.step = 1; }
    fs.writeFileSync(hub.path(DEMO, 'me', 'hub-state.json'), JSON.stringify(s));
    const items = await (await api.get(`/api/reviews?course=${DEMO}`)).json();
    expect(items.map((r: any) => r.id)).toEqual(['r3', 'r4', 'r5']);
    const home = await (await api.get('/api/home')).json();
    expect(home.courses.find((c: any) => c.id === DEMO).reviews.count).toBe(3);
  });
});

test.describe('the due count', () => {
  test.use({ seed: seedWith((hub: Hub) => hubState(hub, RESUME)) });

  test('REV-004 minutes = N × 1.5 rounded half to even (1→2, 2→3, 3→4, 4→6, 5→8); the course page shows it too', async ({ page, api, hub }) => {
    const want: Record<number, number> = { 1: 2, 2: 3, 3: 4, 4: 6, 5: 8 };
    for (const n of [1, 2, 3, 4, 5]) {
      hubState(hub, { ...RESUME, reviews: Array.from({ length: n }, (_, i) => review(`m${i}`, -1)) });
      const home = await (await api.get('/api/home')).json();
      expect(home.courses.find((c: any) => c.id === DEMO).reviews).toEqual({ count: n, minutes: want[n] });
    }
    hubState(hub, { ...RESUME, reviews: [review('one', 0)] });
    await page.goto('/#c=Demo-Course');
    await expect(page.locator('main')).toContainText('1 quick review · ~2 min first · Just the reviews');
    await expect(page.getByRole('link', { name: 'Just the reviews' })).toHaveAttribute('href', '#review=Demo-Course');
  });

  test('REV-004 with nothing due the line falls back to the resume line', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('main')).toContainText('Nothing due. Pick up at S&D-1 →');
    await expect(page.getByRole('link', { name: 'Just the reviews' })).toHaveCount(0);
  });
});

test.describe('ignored items', () => {
  test.use({ seed: seedWith((hub: Hub) => {
    hubState(hub, { ...RESUME, reviews: [review('retired1', -3, { retired: true, step: 4 }),
      review('warm1', -3, { warmup: true }), review('live1', -2)] });
  }) });

  test('REV-005 retired and warm-up items are never due, counted, mirrored or practised', async ({ api, hub }) => {
    const items = await (await api.get(`/api/reviews?course=${DEMO}`)).json();
    expect(items.map((r: any) => r.id)).toEqual(['live1']);
    const home = await (await api.get('/api/home')).json();
    expect(home.courses.find((c: any) => c.id === DEMO).reviews.count).toBe(1);
    const r = await apiNew(api, { kind: 'review', review_id: 'warm1' });
    expect(r.status()).toBe(404);
    expect((await r.json()).error).toBe('That review item no longer exists.');
    // any state save rewrites the mirror: only the live item is in it
    await api.post('/api/seen', { data: { course: DEMO, tag: 'S&D-1', n: 1 } });
    const prog = readText(hub, 'progress.md');
    expect(prog).toContain('concept live1');
    expect(prog).not.toContain('concept warm1');
    expect(prog).not.toContain('concept retired1');
  });
});

// ============================================================ the review page

test.describe('the review page', () => {
  test.use({ seed: seedWith((hub: Hub) => hubState(hub, { ...RESUME, reviews: [
    review('aaaa000001', -2, { concept: 'Equilibrium', mistake: 'Setup', problem_md: 'SAVED-PROBLEM-ONE' }),
    review('aaaa000002', -1, { concept: 'Shifts', mistake: 'Concept gap', step: 2 }),
  ] })) });

  test('REV-010 REV-012 REV-013 REV-014 REV-021 working through the reviews: counter, Next review, Finish, done card, schedule', async ({ page, hub }) => {
    await hub.script([
      { match: { label: '^practice:review$' }, times: 1, reply: { json: problem({ problem_md: 'VARIATION-ONE' }), wait_for: 'v1' } },
      { match: { label: '^practice:review$' }, reply: { json: problem({ problem_md: 'VARIATION-TWO' }) } },
      { match: { label: '^check$' }, times: 1, reply: { json: MARK_CLEAN } },
      { match: { label: '^check$' }, reply: { json: { ...MARK_WRONG, mistake: 'Method choice' } } }]);
    await page.goto('/#review=Demo-Course');
    await expect(page.getByRole('navigation', { name: 'Where you are' })).toContainText(/Home.*Demo-Course.*Reviews/s);
    await expect(page.getByText('1 of 2', { exact: true })).toBeVisible();
    await expect(page.locator('main')).toContainText('Writing a fresh variation…');
    await hub.release('v1');
    await expect(page.locator('main')).toContainText('VARIATION-ONE');
    await page.getByLabel('Your working').fill('P = 20');
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(resultBox(page)).toContainText('✓ All right.');
    await expect(resultBox(page)).not.toContainText("It'll come back tomorrow.");   // a clean solve: no saved line
    await page.getByRole('button', { name: 'Next review' }).click();
    await expect(page.getByText('2 of 2', { exact: true })).toBeVisible();
    await expect(page.locator('main')).toContainText('VARIATION-TWO');
    await page.getByLabel('Your working').fill('wrong');
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(resultBox(page)).toContainText("It'll come back tomorrow.");
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page.getByRole('heading', { name: 'Reviews done' })).toBeVisible();
    await expect(page.locator('main')).toContainText('2 items reviewed.');
    await expect(page.getByRole('link', { name: 'Back to S&D-1 · slide 2' })).toHaveAttribute('href', '#c=Demo-Course&d=S%26D-1&s=2');
    const [one, two] = reviewsOnDisk(hub);
    expect(one).toMatchObject({ id: 'aaaa000001', step: 1, due: iso(3), last: iso(0), mistake: 'Setup' });
    expect(two).toMatchObject({ id: 'aaaa000002', step: 0, due: iso(1), last: iso(0), mistake: 'Method choice' });
    expect(readState(hub).decks['S&D-1'].solved).toBe(true);    // the clean review solved its deck
    // practised today: no longer due
    await page.goto('/');
    await expect(page.locator('main')).toContainText('Nothing due.');
  });

  test('REV-011 a review problem is a fresh variation of the saved problem, with its concept and mistake', async ({ api, hub }) => {
    await hub.script(practiceRules());
    const p = await (await apiNew(api, { kind: 'review', review_id: 'aaaa000001', tag: '', n: 1 })).json();
    expect(p).toMatchObject({ kind: 'review', review_id: 'aaaa000001' });
    const [c] = await hub.calls('^practice:review$');
    expect(c.prompt).toContain('SAVED-PROBLEM-ONE');
    expect(c.prompt).toContain('(Setup)');
    expect(c.prompt).toContain('(Equilibrium)');
    expect(c.prompt).toMatch(/fresh variation/);
  });

  test('REV-016 an item that disappears before it is practised fails with "That review item no longer exists." and Try again', async ({ page, hub }) => {
    await hub.script(practiceRules());
    await page.goto('/#review=Demo-Course');
    await expect(page.getByLabel('Your working')).toBeVisible();
    const s = readState(hub);
    s.reviews = s.reviews.filter((r: any) => r.id !== 'aaaa000002');
    fs.writeFileSync(hub.path(DEMO, 'me', 'hub-state.json'), JSON.stringify(s));
    await page.getByLabel('Your working').fill('P = 20');
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await page.getByRole('button', { name: 'Next review' }).click();
    await expect(page.locator('main')).toContainText('That review item no longer exists.');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

test.describe('the review page with a note', () => {
  test.use({ seed: seedWith((hub: Hub) => hubState(hub, { ...RESUME, reviews: [
    review('nnnn000001', -1, { note: 'draw the curves first' })] })) });

  test('REV-015 the result of a review shows "Your note from last time"', async ({ page, hub }) => {
    test.fail(true, 'BROKEN in current app: the due-items list sent to the review page has no note, so the box never '
      + 'appears; see docs/functional-spec/03-practice-reviews-drills.md REV-015');
    await hub.script(practiceRules({}, MARK_WRONG));
    await page.goto('/#review=Demo-Course');
    await page.getByLabel('Your working').fill('x');
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(resultBox(page)).toBeVisible();
    await expect(resultBox(page)).toContainText('Your note from last time', { timeout: 3000 });
    await expect(resultBox(page)).toContainText('draw the curves first');
  });
});

test.describe('nothing to review', () => {
  test.use({ seed: seedWith((hub: Hub) => hubState(hub, { ...RESUME, reviews: [review('later1', 2)] })) });

  test('REV-013 with nothing offered: "Nothing due" and "Nothing to review today."', async ({ page }) => {
    await page.goto('/#review=Demo-Course');
    await expect(page.getByRole('heading', { name: 'Nothing due' })).toBeVisible();
    await expect(page.locator('main')).toContainText('Nothing to review today.');
    await expect(page.getByRole('link', { name: 'Back to S&D-1 · slide 2' })).toBeVisible();
  });

  test('REV-013 SESS-001 during a session the done card offers "Continue: new slides"', async ({ page }) => {
    await seedSession(page, { step: 0 });
    await page.goto('/#review=Demo-Course');
    await expect(page.getByRole('heading', { name: 'Nothing due' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue: new slides' }).click();
    await expect(page).toHaveURL(/#c=Demo-Course&d=S%26D-1&s=2/);
    await expect(page.getByRole('button', { name: 'Session step 2: New slides' })).toHaveAttribute('aria-current', 'step');
  });
});

// ============================================================ the schedule

test.describe('the schedule', () => {
  test.use({ seed: seedWith((hub: Hub) => hubState(hub, { ...RESUME, reviews: [0, 1, 2, 3, 4].map((k) =>
    review(`step${k}00000`, -1, { step: k, mistake: 'Setup' })) })) });

  test('REV-002 REV-014 a clean review moves the item along 1 → 3 → 7 → 14 → 30 days, and retires it after step 4', async ({ api, hub }) => {
    await hub.script(practiceRules({}, MARK_CLEAN));
    for (const k of [0, 1, 2, 3, 4]) {
      const p = await (await apiNew(api, { kind: 'review', review_id: `step${k}00000` })).json();
      const r = await (await apiCheck(api, p.id)).json();
      expect(r).toMatchObject({ correct: true, saved: false, hinted: false });
    }
    const items = reviewsOnDisk(hub);
    const want = [3, 7, 14, 30];
    for (const k of [0, 1, 2, 3]) {
      expect(items[k]).toMatchObject({ step: k + 1, due: iso(want[k]), last: iso(0) });
      expect(items[k].retired ?? false).toBe(false);
    }
    expect(items[4]).toMatchObject({ retired: true, last: iso(0) });
    const due = await (await api.get(`/api/reviews?course=${DEMO}`)).json();
    expect(due).toEqual([]);
  });

  test('REV-002 a wrong review restarts at step 0 due tomorrow with the new mistake type', async ({ api, hub }) => {
    await hub.script(practiceRules({}, { ...MARK_WRONG, mistake: 'Algebra slip' }));
    const p = await (await apiNew(api, { kind: 'review', review_id: 'step300000' })).json();
    const r = await (await apiCheck(api, p.id, 'x')).json();
    expect(r).toMatchObject({ correct: false, saved: true, review_id: 'step300000' });
    expect(reviewsOnDisk(hub)[3]).toMatchObject({ step: 0, due: iso(1), mistake: 'Algebra slip', last: iso(0) });
    expect(reviewsOnDisk(hub)).toHaveLength(5);     // a review never adds a second item
  });

  test('REV-002 a right-with-a-hint review restarts at step 0 and keeps the mistake when marking says none', async ({ api, hub }) => {
    await hub.script(practiceRules({}, MARK_CLEAN));
    const p = await (await apiNew(api, { kind: 'review', review_id: 'step200000' })).json();
    await api.post('/api/practice/hint', { data: { id: p.id } });
    const r = await (await apiCheck(api, p.id)).json();
    expect(r).toMatchObject({ correct: true, hinted: true, saved: true });
    expect(reviewsOnDisk(hub)[2]).toMatchObject({ step: 0, due: iso(1), mistake: 'Setup' });
  });

  test('REV-002 an unreadable photo changes nothing', async ({ api, hub }) => {
    await hub.script(practiceRules({}, MARK_UNREADABLE));
    const before = reviewsOnDisk(hub)[1];
    const p = await (await apiNew(api, { kind: 'review', review_id: 'step100000' })).json();
    await apiCheck(api, p.id, 'x');
    expect(reviewsOnDisk(hub)[1]).toEqual(before);
  });
});

// ============================================================ notes

test.describe('notes', () => {
  test.use({ seed: seedWith((hub: Hub) => hubState(hub, { ...RESUME, reviews: [review('note000001', 1)] })) });

  test('REV-030 a note is trimmed to 300 characters; an unknown item does nothing', async ({ api, hub }) => {
    let r = await api.post('/api/review/note', { data: { course: DEMO, id: 'note000001', note: `  ${'x'.repeat(400)}  ` } });
    expect(await r.json()).toEqual({ ok: true });
    expect(reviewsOnDisk(hub)[0].note).toBe('x'.repeat(300));
    r = await api.post('/api/review/note', { data: { course: DEMO, id: 'nope', note: 'hi' } });
    expect(await r.json()).toEqual({ ok: false });
    // shown in the progress.md mirror as the clue
    await api.post('/api/review/note', { data: { course: DEMO, id: 'note000001', note: 'the clue | here' } });
    expect(readText(hub, 'progress.md')).toMatch(/\| concept note000001 \| Setup \| the clue \/ here \| 1\/5 \|/);
  });
});

// ============================================================ the mirror into progress.md

test.describe('the progress.md mirror', () => {
  test.use({ seed: seedWith((hub: Hub) => hubState(hub, { ...RESUME, reviews: [
    review('mir0000002', 2, { created: iso(-1), slides: '', deck: 'S&D-1', concept: 'Second\nline', step: 1 }),
    review('mir0000001', 1, { created: iso(-3), slides: 'S&D-1 s2', concept: 'a|b', note: 'clue' }),
  ] })) });

  test('REV-040 PRAC-044 any state save rewrites the mirror block: one row per open item, oldest first', async ({ api, hub }) => {
    const before = readText(hub, 'progress.md');
    expect(before).not.toContain('study-hub:start');
    await api.post('/api/seen', { data: { course: DEMO, tag: 'S&D-1', n: 1 } });     // viewing a slide saves the state
    const text = readText(hub, 'progress.md');
    expect(text.startsWith(before.trimEnd() + '\n\n<!-- study-hub:start -->')).toBe(true);    // appended after a blank line
    const block = text.slice(text.indexOf('<!-- study-hub:start -->'));
    expect(block).toBe([
      '<!-- study-hub:start -->',
      '## Mistakes saved in the Study Hub',
      '',
      "Written by the Study Hub from `me/hub-state.json`; don't edit by hand. Use it for mocks and cheat sheets.",
      '',
      '| Saved | Where | Concept | Mistake | Clue noted | Step | Next due |',
      '|---|---|---|---|---|---|---|',
      `| ${iso(-3)} | S&D-1 s2 | a/b | Setup | clue | 1/5 | ${iso(1)} |`,
      `| ${iso(-1)} | S&D-1 | Second line | Setup |  | 2/5 | ${iso(2)} |`,
      '<!-- study-hub:end -->',
      '',
    ].join('\n'));
  });

  test('REV-040 the block is replaced in place (text outside kept); with no open items it says "None yet."', async ({ api, hub }) => {
    hub.write(`${DEMO}/me/progress.md`, '# Mine\n\nBEFORE\n\n<!-- study-hub:start -->\nold stuff\n<!-- study-hub:end -->\n\nAFTER\n');
    const s = readState(hub);
    s.reviews.forEach((r: any) => { r.retired = true; });
    fs.writeFileSync(hub.path(DEMO, 'me', 'hub-state.json'), JSON.stringify(s));
    await api.post('/api/seen', { data: { course: DEMO, tag: 'S&D-1', n: 1 } });
    const text = readText(hub, 'progress.md');
    expect(text).toContain('# Mine\n\nBEFORE\n\n<!-- study-hub:start -->');
    expect(text).toContain('None yet.\n<!-- study-hub:end -->\n\nAFTER\n');
    expect(text).not.toContain('old stuff');
    expect(text).not.toContain('| Saved |');
  });

  test('REV-040 without progress.md nothing is created', async ({ api, hub }) => {
    fs.rmSync(hub.path(DEMO, 'me', 'progress.md'));
    await api.post('/api/seen', { data: { course: DEMO, tag: 'S&D-1', n: 1 } });
    expect(hub.exists(DEMO, 'me', 'progress.md')).toBe(false);
  });

  test('REV-040 a mistake saved by practice appears in the mirror', async ({ api, hub }) => {
    await hub.script(practiceRules({}, mark({ correct: false, mistake: 'Skipped step', concept_missed: 'MIRRORED-CONCEPT' })));
    const p = await (await apiNew(api, {})).json();
    await apiCheck(api, p.id, 'x');
    expect(readText(hub, 'progress.md')).toMatch(new RegExp(`\\| ${iso(0)} \\| S&D-1 s2 \\| MIRRORED-CONCEPT \\| Skipped step \\|  \\| 1/5 \\| ${iso(1)} \\|`));
  });
});
