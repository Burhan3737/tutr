/**
 * 03 · Practice problems: starting one, hints, answering (typed, photos, phone), marking, what a result does to
 * progress and the review queue, prefetch, and problems on disk.  Spec: docs/functional-spec/03-practice-reviews-drills.md
 *
 * Not covered:
 *   PRAC-006 (the quality of what the model writes: hint 1 a question, hint 2 the first step, ≤ 8-word concept,
 *            mixed problems not naming the method) — model-dependent; only the prompt wording and the app's
 *            handling of imperfect output are pinned.
 *   PRAC-007 "must not name the method or topic" — model-dependent (the prompt says so; pinned loosely).
 *   PRAC-021 the 2000 px downscale and the 12 MB limit through the UI (the browser always re-encodes; the 12 MB
 *            limit is pinned over HTTP).
 *   PRAC-030 "Marking never searches the web" is pinned through the call log's `web` flag.
 *   PRAC-044 → see reviews.spec.ts (REV-040).
 */
import * as fs from 'fs';
import { test, expect } from '../../fixtures/hub';
import {
  DEMO, SD1, SD1_S2, HW1, MARK_CLEAN, MARK_UNREADABLE, MARK_WRONG, answerAndCheck, apiCheck, apiNew, ask, askBox,
  chooseFile, iso, jpg, jpgDataUrl, mark, openSlide, openTutor, panel, practiceIds, practiceRec, practiceRules, problem,
  readState, resultBox, reviewsOnDisk, skipNearMidnight, startTry, addMoreDecks, hubState, review,
} from './helpers';

const working = (page: any) => page.getByLabel('Your working');
const checkBtn = (page: any) => page.getByRole('button', { name: 'Check', exact: true });
const hintBtn = (page: any) => page.getByRole('button', { name: /^(Hint|Another hint|Show worked example)$/ });

// ============================================================ A. Starting a practice problem

test.describe('starting a problem', () => {
  test('PRAC-001 PRAC-002 "Try one on this ›" under an explanation starts a slide problem on the open slide', async ({ page, hub }) => {
    await hub.script([{ match: { label: '^chat:explain$' }, reply: { text: 'Prices rise.' } }, ...practiceRules()]);
    await openSlide(page);
    await openTutor(page);
    await page.getByRole('button', { name: 'Explain simply' }).click();
    await page.getByRole('button', { name: 'Try one on this ›' }).click();
    await expect(page.getByRole('heading', { name: 'Practise' })).toBeVisible();
    await expect(working(page)).toBeVisible();
    const calls = await hub.calls('^practice:');
    expect(calls.map((c) => c.label)).toEqual(['practice:try']);
    expect(calls[0].prompt).toMatch(/slide .*2|s2/);
    expect(calls[0].prompt).toContain('[S&D-1]');
  });

  test('PRAC-001 "Try one on this deck ›" follows a whole-deck answer and starts a deck problem', async ({ page, hub }) => {
    await hub.script([{ match: { label: '^chat:explain_deck$' }, reply: { text: 'The whole deck.' } }, ...practiceRules()]);
    await openSlide(page);
    await openTutor(page);
    await page.getByRole('radio', { name: 'Whole deck' }).click();
    await page.getByRole('button', { name: 'Explain simply' }).click();
    await page.getByRole('button', { name: 'Try one on this deck ›' }).click();
    await expect(working(page)).toBeVisible();
    expect((await hub.calls('^practice:')).map((c) => c.label)).toEqual(['practice:deck']);
  });

  test('PRAC-001 "Your turn: finish from here ›" after a worked example starts a your-turn problem from that example', async ({ page, hub }) => {
    await hub.script([{ match: { label: '^chat:example$' }, reply: { text: 'Worked: set 100-2P = 20+2P (EXAMPLE-TEXT).' } },
      ...practiceRules()]);
    await openSlide(page);
    await openTutor(page);
    await page.getByRole('button', { name: 'Worked example' }).click();
    await page.getByRole('button', { name: 'Your turn: finish from here ›' }).click();
    await expect(working(page)).toBeVisible();
    const [c] = await hub.calls('^practice:');
    expect(c.label).toBe('practice:yourturn');
    expect(c.prompt).toContain('EXAMPLE-TEXT');
    expect(c.prompt).toMatch(/\*\*Your turn:\*\* finish from here/);
  });

  test('PRAC-001 PRAC-002 the end card\'s "Try one" starts a deck problem on the last slide', async ({ page, hub }) => {
    await hub.script(practiceRules());
    await openSlide(page, `${SD1}&s=3`);
    await page.locator('#next').click();     // locator: markup hook (next-slide arrow)
    await expect(page.getByRole('heading', { name: 'End of S&D-1' })).toBeVisible();
    await page.getByRole('button', { name: 'Try one', exact: true }).click();
    await expect(working(page)).toBeVisible();
    expect((await hub.calls('^practice:')).map((c) => c.label)).toEqual(['practice:deck']);
    await expect(page.getByRole('img', { name: 'Slide 3' })).toBeVisible();
    await expect(page.getByText('S&D-1 s3', { exact: true })).toBeVisible();
  });

  test('PRAC-001 PRAC-004 /try with words starts a slide problem and passes the words along', async ({ page, hub }) => {
    await hub.script(practiceRules());
    await openSlide(page);
    await openTutor(page);
    await startTry(page, 'a harder one');
    await expect(panel(page)).toContainText('You asked for: a harder one');
    const [c] = await hub.calls('^practice:');
    expect(c.label).toBe('practice:try');
    expect(c.prompt).toContain('a harder one');
  });

  test('PRAC-001 /try with the scope on Whole deck starts a deck problem', async ({ page, hub }) => {
    await hub.script(practiceRules());
    await openSlide(page);
    await openTutor(page);
    await page.getByRole('radio', { name: 'Whole deck' }).click();
    await startTry(page);
    expect((await hub.calls('^practice:')).map((c) => c.label)).toEqual(['practice:deck']);
  });

  test('PRAC-002 the practice panel: heading, thumbnail of the slide, and three ways back to the tutor with the chat as it was', async ({ page, hub }) => {
    await hub.script([{ match: { label: '^chat:explain$' }, reply: { text: 'KEEP-THIS-ANSWER' } }, ...practiceRules()]);
    await openSlide(page);
    await openTutor(page);
    await page.getByRole('button', { name: 'Explain simply' }).click();
    await expect(panel(page)).toContainText('KEEP-THIS-ANSWER');
    for (const way of ['link', 'x', 'thumb'] as const) {
      await page.getByRole('button', { name: /^Try one on this/ }).click();
      await expect(page.getByRole('heading', { name: 'Practise' })).toBeVisible();
      await expect(page.getByRole('img', { name: 'Slide 2' })).toBeVisible();
      await expect(page.getByText('S&D-1 s2', { exact: true })).toBeVisible();
      if (way === 'link') await page.getByRole('button', { name: '‹ Back to slide' }).click();
      if (way === 'x') await page.getByRole('button', { name: 'Back to the slide' }).click();
      if (way === 'thumb') await page.getByRole('img', { name: 'Slide 2' }).click();
      await expect(page.getByRole('heading', { name: 'Tutor' })).toBeVisible();
      await expect(panel(page)).toContainText('KEEP-THIS-ANSWER');
      await expect(page.getByRole('heading', { name: 'Practise' })).toHaveCount(0);
    }
  });

  test('PRAC-003 the panel says it is writing the problem; a your-turn says it is setting up', async ({ page, hub }) => {
    await hub.script([{ match: { label: '^practice:try$' }, reply: { json: problem(), wait_for: 'p1' } },
      { match: { label: '^chat:example$' }, reply: { text: 'Worked.' } },
      { match: { label: '^practice:yourturn$' }, reply: { json: problem(), wait_for: 'p2' } }]);
    await openSlide(page);
    await openTutor(page);
    await ask(page, '/try');
    await expect(panel(page)).toContainText('Writing a problem for you…');
    await hub.release('p1');
    await expect(working(page)).toBeVisible();
    await page.getByRole('button', { name: '‹ Back to slide' }).click();
    await page.getByRole('button', { name: 'Worked example' }).click();
    await page.getByRole('button', { name: 'Your turn: finish from here ›' }).click();
    await expect(panel(page)).toContainText('Setting up your turn…');
    await hub.release('p2');
    await expect(working(page)).toBeVisible();
  });

  test('PRAC-003 the model\'s progress messages replace the waiting text', async ({ page, hub }) => {
    await hub.script([{ match: { label: '^practice:try$' },
      reply: { json: problem(), status: ['Reading the slides'], chunks: ['a', 'b', 'c', 'd'], chunk_delay_ms: 700,
        stream_json_text: true } as any }]);
    await openSlide(page);
    await openTutor(page);
    await ask(page, '/try');
    await expect(panel(page)).toContainText('Reading the slides…');
    await expect(working(page)).toBeVisible();
  });

  test('PRAC-004 the problem as shown: From line, Markdown with maths, answer field (focused), photo, Hint and Check', async ({ page, hub }) => {
    await hub.script(practiceRules({ problem_md: 'Find **P** when $Q=100-2P$.' }));
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    await expect(panel(page)).toContainText('From S&D-1 s2');
    await expect(panel(page).locator('strong', { hasText: 'P' })).toBeVisible();
    await expect(panel(page).locator('.katex').first()).toBeVisible();   // locator: markup hook (KaTeX output)
    await expect(working(page)).toHaveAttribute('placeholder', 'Your working… (or add a photo of it)');
    await expect(working(page)).toBeFocused();
    await expect(page.getByRole('button', { name: '📷 Add photo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hint' })).toBeVisible();
    await expect(checkBtn(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send from phone' })).toHaveCount(0);   // no phone link known
    await expect(panel(page)).not.toContainText('You asked for');
  });

  test('PRAC-004 an empty slide reference leaves out the From line', async ({ page, hub }) => {
    await hub.script(practiceRules({ slides: '' }));
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    await expect(panel(page)).not.toContainText('From ');
  });

  test('PRAC-005 a failed problem shows the error and "Try again" repeats the same request', async ({ page, hub }) => {
    await hub.script([{ match: { label: '^practice:try$' }, times: 1, reply: { error: 'The model is down (FAIL-1).' } },
      ...practiceRules()]);
    await openSlide(page);
    await openTutor(page);
    await ask(page, '/try');
    await expect(panel(page)).toContainText('The model is down (FAIL-1).');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(working(page)).toBeVisible();
    const calls = await hub.calls('^practice:');
    expect(calls.map((c) => c.label)).toEqual(['practice:try', 'practice:try']);
    expect(calls[1].prompt).toBe(calls[0].prompt);
  });

  test('PRAC-005 refusals: no deck, unknown kind, review item gone', async ({ api, hub }) => {
    await hub.script(practiceRules());
    let r = await apiNew(api, { tag: 'NOPE-9' });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe('Open a deck first.');
    r = await apiNew(api, { kind: 'bogus' });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe('Unknown practice kind.');
    r = await apiNew(api, { kind: 'review', review_id: 'gone000000' });
    expect(r.status()).toBe(404);
    expect((await r.json()).error).toBe('That review item no longer exists.');
    expect(await hub.calls('^practice:')).toHaveLength(0);
  });
});

// ============================================================ PRAC-006 / 007 what the problem must be

test.describe('what is asked of the model', () => {
  test('PRAC-006 the prompt follows the course\'s assessment style and asks for a changed setting (not for your-turn)', async ({ api, hub }) => {
    await hub.script(practiceRules());
    await apiNew(api, { kind: 'try' });
    await apiNew(api, { kind: 'yourturn', example_md: 'Worked example text.' });
    const [tryCall, yt] = await hub.calls('^practice:');
    expect(tryCall.prompt).toContain('a short closed-book quiz question');
    expect(tryCall.prompt).toMatch(/change the setting and wording/);
    expect(yt.prompt).toMatch(/same structure as the example/);
    expect(yt.prompt).not.toMatch(/change the setting and wording/);
    expect(tryCall.schema).toBe(true);
  });

  test('PRAC-006 without an assessment style the prompt asks for an exam-style question', async ({ api, hub }) => {
    const cj = hub.readJson(DEMO, 'course.json');
    delete cj.assessment_style;
    hub.write(`${DEMO}/course.json`, JSON.stringify(cj));
    await hub.script(practiceRules());
    await apiNew(api, {});
    expect((await hub.calls('^practice:'))[0].prompt).toContain('an exam-style question for this course');
  });

  test('PRAC-006 empty hints are dropped; with none left a single fallback hint is used', async ({ page, hub }) => {
    await hub.script(practiceRules({ hints: ['', ''] }));
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    await page.getByRole('button', { name: 'Hint' }).click();
    await expect(panel(page)).toContainText('Hint 1');
    await expect(panel(page)).toContainText('Look again at the definition on the slide.');
    await expect(page.getByRole('button', { name: 'Show worked example' })).toBeVisible();
  });

  test('PRAC-006 more than two hints: at most two are kept', async ({ api, hub }) => {
    await hub.script(practiceRules({ hints: ['h one', '', 'h two', 'h three'] }));
    const p = await (await apiNew(api, {})).json();
    expect(p.hints_total).toBe(2);
    expect(practiceRec(hub, p.id).hints).toEqual(['h one', 'h two']);
  });

  test('PRAC-006 a deck tag that is not in the course falls back to the open deck; a mixed problem gets no deck', async ({ api, hub }) => {
    await hub.script(practiceRules({ deck: 'NOT-A-DECK' }));
    const p = await (await apiNew(api, { kind: 'deck' })).json();
    expect(p.deck).toBe('S&D-1');
    const m = await (await apiNew(api, { kind: 'mixed', topics: null })).json();
    expect(m.deck).toBe('');
    expect(practiceRec(hub, m.id).deck).toBe('');
  });

  test('PRAC-006 a review problem with an empty concept or unknown deck takes the review item\'s', async ({ playwright, api, hub }) => {
    hubState(hub, { reviews: [review('r100000000', 0, { concept: 'Item concept' })] });
    await hub.restart();
    await hub.script(practiceRules({ deck: 'NOPE', concept: '' }));
    const ctx = await playwright.request.newContext({ baseURL: hub.url });
    const p = await (await apiNew(ctx, { kind: 'review', review_id: 'r100000000' })).json();
    expect(p.deck).toBe('S&D-1');
    expect(p.concept).toBe('Item concept');
    await ctx.dispose();
  });

  test('PRAC-006 web search follows the course\'s slides-only setting when writing problems', async ({ page, hub }) => {
    await hub.script(practiceRules());
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    await page.evaluate(() => localStorage.setItem('slidesOnly:Demo-Course', 'true'));
    await page.getByRole('button', { name: '‹ Back to slide' }).click();
    await startTry(page);
    const calls = await hub.calls('^practice:');
    expect(calls.map((c) => c.web)).toEqual([true, false]);
  });

  test('PRAC-007 a mixed problem comes from the topics already opened, else every sorted topic', async ({ playwright, api, hub }) => {
    addMoreDecks(hub);
    await hub.restart();
    await hub.script(practiceRules());
    const ctx = await playwright.request.newContext({ baseURL: hub.url });
    await apiNew(ctx, { kind: 'mixed', topics: null });
    let [c] = await hub.calls('^practice:mixed$');
    expect(c.prompt).toMatch(/topics: .*Supply and Demand/);
    expect(c.prompt).toMatch(/topics: .*Elasticity/);
    expect(c.prompt).not.toMatch(/Not sorted yet/);
    expect(c.prompt).toMatch(/don't name the method or the topic/);
    await ctx.dispose();
  });

  test('PRAC-007 SESS-003 a mixed problem started in the app is limited to the topics with an opened deck', async ({ page, hub }) => {
    addMoreDecks(hub);
    await hub.script(practiceRules());
    await openSlide(page);   // S&D-1 is now opened (Supply and Demand); Elasticity is untouched
    await expect.poll(() => readState(hub).decks?.['S&D-1']?.seen?.length ?? 0).toBeGreaterThan(0);
    await page.reload();
    await expect(page.locator('#counter')).toHaveText('2 / 3');   // locator: markup hook
    await page.evaluate(() => localStorage.setItem('session', JSON.stringify({ course: 'Demo-Course', step: 2, practised: 3,
      lastMistake: null, started: Date.now() })));
    await page.reload();
    await page.getByRole('button', { name: 'Session step 4: Mixed' }).click();
    await expect(page.getByRole('heading', { name: 'Mixed problem' })).toBeVisible();
    await expect(working(page)).toBeVisible();
    const [c] = await hub.calls('^practice:mixed$');
    expect(c.prompt).toMatch(/topics: Supply and Demand\./);
  });
});

// ============================================================ PRAC-008 / 050 / 051 problems on disk

test.describe('problems on disk', () => {
  test('PRAC-008 PRAC-050 every problem is saved as me/practice/<id>.json with its parts', async ({ page, hub }) => {
    await hub.script(practiceRules());
    await openSlide(page);
    await openTutor(page);
    await startTry(page, 'with numbers');
    const ids = practiceIds(hub);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^[0-9a-f]{12}$/);
    const rec = practiceRec(hub, ids[0]);
    expect(rec).toMatchObject({ id: ids[0], course: DEMO, kind: 'try', tag: 'S&D-1', n: 2, deck: 'S&D-1', review_id: null,
      problem_md: problem().problem_md, solution_md: problem().solution_md, final_answer: 'P = 20',
      hints: problem().hints, concept: 'Market equilibrium', slides: 'S&D-1 s2', hints_used: 0, attempts: [], photos: [],
      focus: 'with numbers' });
    expect(rec.created).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    expect(rec).toHaveProperty('model');
  });

  test('PRAC-008 a problem stays usable after a restart (hints, photos, checking, the phone page)', async ({ playwright, page, api, hub }) => {
    await hub.script(practiceRules());
    const p = await (await apiNew(api, {})).json();
    await hub.restart();
    await hub.script(practiceRules());
    const ctx = await playwright.request.newContext({ baseURL: hub.url });
    expect((await (await ctx.post('/api/practice/hint', { data: { id: p.id } })).json()).hint).toBe('What is true at equilibrium?');
    expect((await (await ctx.post('/api/practice/photo', { data: { id: p.id, data: jpgDataUrl() } })).json()).photos).toBe(1);
    expect((await (await apiCheck(ctx, p.id)).json()).correct).toBe(true);
    await page.goto(`${hub.url}/#upload=${p.id}`);
    await expect(page.getByText('Find the equilibrium price.')).toBeVisible();
    await ctx.dispose();
  });

  test('PRAC-051 only 12-hex ids are accepted, and a problem is found in any course', async ({ playwright, api, hub }) => {
    hub.write('Other-Course/course.json', JSON.stringify({ code: 'OTH', title: 'Other' }));
    hub.write('Other-Course/me/practice/abcdef012345.json', JSON.stringify({ id: 'abcdef012345', course: 'Other-Course',
      kind: 'try', tag: 'X', n: 1, deck: '', review_id: null, problem_md: 'OTHER-COURSE-PROBLEM', solution_md: 's',
      final_answer: 'a', hints: ['h'], concept: 'c', slides: '', hints_used: 0, attempts: [], photos: [],
      created: '2026-01-01 10:00', focus: '' }));
    await hub.restart();
    const ctx = await playwright.request.newContext({ baseURL: hub.url });
    const ok = await ctx.get('/api/practice?id=abcdef012345');
    expect(ok.status()).toBe(200);
    expect((await ok.json()).problem_md).toBe('OTHER-COURSE-PROBLEM');
    for (const bad of ['ABCDEF012345', '../x', 'abcdef01234', 'abcdef0123456']) {
      const r = await ctx.get(`/api/practice?id=${encodeURIComponent(bad)}`);
      expect(r.status()).toBe(404);
      expect((await r.json()).error).toBe('That problem has expired.');
    }
    await ctx.dispose();
  });
});

// ============================================================ B. Hints

test.describe('hints', () => {
  test('PRAC-010 hints one at a time, then the worked solution; every click is counted on disk', async ({ page, hub, api }) => {
    await hub.script(practiceRules());
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    await page.getByRole('button', { name: 'Hint', exact: true }).click();
    await expect(panel(page).getByText('Hint 1', { exact: true })).toBeVisible();
    await expect(panel(page)).toContainText('What is true at equilibrium?');
    await page.getByRole('button', { name: 'Another hint' }).click();
    await expect(panel(page).getByText('Hint 2', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Show worked example' }).click();
    await expect(panel(page).getByText('Worked solution', { exact: true })).toBeVisible();
    await expect(panel(page)).toContainText('SOLUTION-MARK');
    await expect(hintBtn(page)).toHaveCount(0);
    const [id] = practiceIds(hub);
    expect(practiceRec(hub, id).hints_used).toBe(3);
    // after the solution the hub keeps returning the solution
    const again = await (await api.post('/api/practice/hint', { data: { id } })).json();
    expect(again.solution_md).toContain('SOLUTION-MARK');
    expect(again.more).toBe(false);
    expect(practiceRec(hub, id).hints_used).toBe(4);
  });

  test('PRAC-010 with a single hint the button goes from Hint straight to Show worked example', async ({ page, hub }) => {
    await hub.script(practiceRules({ hints: ['Only hint here.'] }));
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    await page.getByRole('button', { name: 'Hint', exact: true }).click();
    await expect(panel(page)).toContainText('Only hint here.');
    await expect(page.getByRole('button', { name: 'Show worked example' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Another hint' })).toHaveCount(0);
  });

  test('PRAC-010 a failed hint shows the error under the hints', async ({ page, hub }) => {
    await hub.script(practiceRules());
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    const [id] = practiceIds(hub);
    await page.route('**/api/practice/hint', (r) => r.fulfill({ status: 404, contentType: 'application/json',
      body: JSON.stringify({ error: 'That problem has expired. Start a new one.' }) }));
    await page.getByRole('button', { name: 'Hint', exact: true }).click();
    await expect(panel(page)).toContainText('That problem has expired. Start a new one.');
    await expect(page.getByRole('button', { name: 'Hint', exact: true })).toBeEnabled();
    expect(id).toBeTruthy();
  });

  test('PRAC-011 PRAC-042 a correct answer after a hint is saved to review as "Needed hints" and does not solve the deck', async ({ page, hub }) => {
    skipNearMidnight(test);
    await hub.script(practiceRules({}, MARK_CLEAN));
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    await page.getByRole('button', { name: 'Hint', exact: true }).click();
    await expect(panel(page)).toContainText('Hint 1');
    await answerAndCheck(page);
    await expect(resultBox(page)).toContainText('✓ All right.');
    await expect(resultBox(page)).toContainText('Solved with a hint · saved to review · back tomorrow');
    const items = reviewsOnDisk(hub);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ mistake: 'Needed hints', due: iso(1), step: 0, deck: 'S&D-1' });
    expect(readState(hub).decks['S&D-1']?.solved ?? false).toBe(false);
  });
});

// ============================================================ C. Answering

test.describe('answering', () => {
  test('PRAC-020 PRAC-036 the typed answer is marked and every attempt is recorded on the problem', async ({ page, hub }) => {
    await hub.script(practiceRules());
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    const [id] = practiceIds(hub);
    await answerAndCheck(page, 'MY-TYPED-WORKING P=20');
    const [c] = await hub.calls('^check$');
    expect(c.prompt).toContain('MY-TYPED-WORKING P=20');
    expect(c.prompt).toContain('Find the equilibrium price.');
    const rec = practiceRec(hub, id);
    expect(rec.attempts).toHaveLength(1);
    expect(rec.attempts[0]).toMatchObject({ answer: 'MY-TYPED-WORKING P=20', photos: [], result: MARK_CLEAN });
    expect(rec.attempts[0].at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  });

  test('PRAC-021 PRAC-024 photos of working are attached, counted, stored, and enough on their own', async ({ page, hub }) => {
    await hub.script(practiceRules());
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    const add = page.getByRole('button', { name: '📷 Add photo' });
    await chooseFile(page, add, { name: 'work.jpg', mimeType: 'image/jpeg', buffer: jpg() });
    await expect(panel(page)).toContainText('1 photo added');
    await chooseFile(page, add, { name: 'work2.jpg', mimeType: 'image/jpeg', buffer: jpg() });
    await expect(panel(page)).toContainText('2 photos added');
    const [id] = practiceIds(hub);
    expect(hub.list(`${DEMO}/me/uploads`)).toEqual([`${id}-1.jpg`, `${id}-2.jpg`]);
    expect(practiceRec(hub, id).photos).toEqual([`me/uploads/${id}-1.jpg`, `me/uploads/${id}-2.jpg`]);
    await checkBtn(page).click();
    await expect(resultBox(page)).toContainText('All right.');
    const [c] = await hub.calls('^check$');
    expect(c.prompt).toContain('(see the photos)');
    expect(c.prompt).toContain(`me/uploads/${id}-1.jpg`);
    expect(practiceRec(hub, id).attempts[0].photos).toHaveLength(2);
  });

  test('PRAC-021 a file the browser cannot open as an image is refused with an alert', async ({ page, hub }) => {
    await hub.script(practiceRules());
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    const msg = new Promise<string>((res) => page.once('dialog', async (d) => { res(d.message()); await d.dismiss(); }));
    await chooseFile(page, page.getByRole('button', { name: '📷 Add photo' }),
      { name: 'notes.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not really an image') });
    expect(await msg).toBe("That file isn't an image the browser can open.");
    expect(hub.list(`${DEMO}/me/uploads`)).toEqual([]);
  });

  test('PRAC-021 the hub refuses non-images, photos over 12 MB, and unknown problems', async ({ api, hub }) => {
    await hub.script(practiceRules());
    const p = await (await apiNew(api, {})).json();
    let r = await api.post('/api/practice/photo', { data: { id: p.id, data: 'data:text/plain;base64,aGVsbG8=' } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe("That isn't an image.");
    const big = 'data:image/png;base64,' + Buffer.alloc(12_000_001, 1).toString('base64');
    r = await api.post('/api/practice/photo', { data: { id: p.id, data: big } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe('That photo is too large (over 12 MB).');
    r = await api.post('/api/practice/photo', { data: { id: '000000000000', data: jpgDataUrl() } });
    expect(r.status()).toBe(404);
    expect((await r.json()).error).toBe('That problem has expired.');
    r = await api.post('/api/practice/photo', { data: { id: p.id, data: 'data:image/png;base64,' + jpg().toString('base64') } });
    expect((await r.json()).photos).toBe(1);
    expect(hub.list(`${DEMO}/me/uploads`)).toEqual([`${p.id}-1.png`]);
  });

  test('PRAC-024 Check with nothing typed and no photo asks for an answer and sends nothing', async ({ page, hub }) => {
    await hub.script(practiceRules());
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    await checkBtn(page).click();
    await expect(panel(page)).toContainText('Write your answer or add a photo of your working first.');
    await expect(checkBtn(page)).toBeEnabled();
    expect(await hub.calls('^check$')).toHaveLength(0);
    await answerAndCheck(page);
    await expect(resultBox(page)).toContainText('All right.');
  });
});

test.describe('send from phone', () => {
  test.use({ phoneUrl: 'http://192.168.1.50:8000/' });

  test('PRAC-022 Send from phone shows a QR dialog that closes once the phone\'s photo arrives', async ({ page, hub, api }) => {
    await hub.script(practiceRules());
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    await page.getByRole('button', { name: 'Send from phone' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('Send a photo from your phone');
    await expect(dlg).toContainText("Scan this with your phone's camera, take a photo of your working, and it appears here.");
    await expect(dlg.locator('svg')).toBeVisible();
    const [id] = practiceIds(hub);
    await api.post('/api/practice/photo', { data: { id, data: jpgDataUrl() } });
    await expect(dlg).toBeHidden({ timeout: 10_000 });
    await expect(panel(page)).toContainText('1 photo added');
  });
});

test.describe('the phone photo page', () => {
  test('PRAC-023 the phone page shows the problem, takes photos and counts them; no session bar', async ({ page, hub, api }) => {
    await hub.script(practiceRules());
    const p = await (await apiNew(api, {})).json();
    await page.addInitScript(() => localStorage.setItem('session', JSON.stringify({ course: 'Demo-Course', step: 1,
      practised: 0, lastMistake: null, started: Date.now() })));
    await page.goto(`/#upload=${p.id}`);
    await expect(page.getByText('S&D-1 s2', { exact: true })).toBeVisible();
    await expect(page.getByText('Find the equilibrium price.')).toBeVisible();
    await expect(page.locator('#session-bar')).toBeHidden();    // locator: markup hook (session bar)
    await chooseFile(page, page.getByRole('button', { name: 'Take a photo of your working' }),
      { name: 'w.jpg', mimeType: 'image/jpeg', buffer: jpg() });
    await expect(page.getByText('Sent ✓ (1 photo). Check your laptop, or add another.')).toBeVisible();
    await chooseFile(page, page.getByRole('button', { name: 'Add another photo' }),
      { name: 'w.jpg', mimeType: 'image/jpeg', buffer: jpg() });
    await expect(page.getByText('Sent ✓ (2 photos). Check your laptop, or add another.')).toBeVisible();
    expect(practiceRec(hub, p.id).photos).toHaveLength(2);
    await page.reload();
    await expect(page.getByText('2 photos sent so far.')).toBeVisible();
  });

  test('PRAC-023 an unknown problem on the phone page has expired', async ({ page }) => {
    await page.goto('/#upload=0123456789ab');
    await expect(page.getByText('That problem has expired.')).toBeVisible();
  });
});

// ============================================================ D. Marking

test.describe('marking', () => {
  test('PRAC-030 while marking: Check disabled, "Marking your work…", then "Writing your feedback…"; never the web', async ({ page, hub }) => {
    await hub.script([{ match: { label: '^practice:' }, reply: { json: problem() } },
      { match: { label: '^check$' }, times: 1, reply: { json: MARK_CLEAN, wait_for: 'mark' } },
      { match: { label: '^check$' }, reply: { json: MARK_CLEAN, status: ['Writing it up'], chunks: ['a', 'b', 'c', 'd'],
        chunk_delay_ms: 700, stream_json_text: true } as any }]);
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    await working(page).fill('P = 20');
    await checkBtn(page).click();
    await expect(panel(page)).toContainText('Marking your work…');
    await expect(checkBtn(page)).toBeDisabled();
    await hub.release('mark');
    await expect(resultBox(page)).toContainText('All right.');
    await page.getByRole('button', { name: 'Try another' }).click();
    await working(page).fill('P = 20');
    await checkBtn(page).click();
    await expect(panel(page)).toContainText('Writing your feedback…');
    await expect(resultBox(page)).toContainText('All right.');
    expect((await hub.calls('^check$')).map((c) => c.web)).toEqual([false, false]);
  });

  test('PRAC-031 PRAC-032 PRAC-041 REV-001 a wrong answer: verdict, mistake chip, feedback, saved line, collapsed solution, Try another', async ({ page, hub }) => {
    skipNearMidnight(test);
    await hub.script(practiceRules({}, MARK_WRONG));
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    const [id] = practiceIds(hub);
    await answerAndCheck(page, 'P = 30');
    const box = resultBox(page);
    await expect(box).toContainText('Setup right, slip in step 2.');
    await expect(box.locator('strong', { hasText: 'slip' })).toBeVisible();
    await expect(box).not.toContainText('✓');
    await expect(box.getByText('Algebra slip', { exact: true })).toBeVisible();
    await expect(box).toContainText('You wrote');
    await expect(box.locator('.katex').first()).toBeVisible();   // locator: markup hook (KaTeX)
    await expect(box).toContainText('Saved to review · back tomorrow');
    const solution = box.getByText('SOLUTION-MARK');
    await expect(solution).toBeHidden();
    await box.getByText('See the full solution').click();
    await expect(solution).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try another' })).toBeVisible();
    await expect(checkBtn(page)).toBeHidden();
    await expect(page.getByRole('button', { name: 'Hint', exact: true })).toBeHidden();
    // the saved mistake
    const items = reviewsOnDisk(hub);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ deck: 'S&D-1', slides: 'S&D-1 s2', concept: 'Solving for P',
      problem_md: problem().problem_md, mistake: 'Algebra slip', step: 0, due: iso(1), created: iso(0), last: null, note: '' });
    expect(items[0].id).toMatch(/^[0-9a-f]{10}$/);
    expect(practiceRec(hub, id).saved_review).toBe(items[0].id);
    expect(readState(hub).decks['S&D-1']?.solved ?? false).toBe(false);
  });

  test('PRAC-041 with no concept from marking the saved mistake takes the problem\'s concept', async ({ api, hub }) => {
    await hub.script(practiceRules({}, { ...MARK_WRONG, concept_missed: '' }));
    const p = await (await apiNew(api, {})).json();
    const r = await (await apiCheck(api, p.id, 'P=30')).json();
    expect(r).toMatchObject({ correct: false, saved: true, mistake: 'Algebra slip' });
    expect(reviewsOnDisk(hub)[0].concept).toBe('Market equilibrium');
  });

  test('PRAC-031 a result counts as correct only when it is also readable', async ({ api, hub }) => {
    await hub.script(practiceRules({}, { correct: true, unreadable: true, verdict: 'x', mistake: 'none', feedback_md: '',
      concept_missed: '' }));
    const p = await (await apiNew(api, {})).json();
    const r = await (await apiCheck(api, p.id)).json();
    expect(r).toMatchObject({ correct: false, unreadable: true, saved: false, solution_md: '' });
  });

  test('PRAC-032 PRAC-040 a clean solve: ✓ verdict, no chip or saved line, and the deck is solved', async ({ page, hub }) => {
    await hub.script(practiceRules());
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    await answerAndCheck(page);
    await expect(resultBox(page)).toContainText('✓ All right.');
    await expect(resultBox(page).getByText('See the full solution')).toBeVisible();
    await expect(resultBox(page)).not.toContainText('Saved to review');
    expect(reviewsOnDisk(hub)).toEqual([]);
    expect(readState(hub).decks['S&D-1'].solved).toBe(true);
    // without a reload: the course page shows it solved
    await page.evaluate(() => { location.hash = '#c=Demo-Course'; });
    await expect(page.getByRole('link', { name: /S&D-1 · Supply and demand 1/ }).locator('[title="Solved"]')).toBeVisible();
    await expect(page.getByTitle('1 of 1 decks solved')).toBeVisible();
  });

  test('PRAC-040 solved is never undone by a later wrong answer', async ({ api, hub }) => {
    await hub.script(practiceRules());
    const p = await (await apiNew(api, {})).json();
    await apiCheck(api, p.id);
    expect(readState(hub).decks['S&D-1'].solved).toBe(true);
    await hub.script(practiceRules({}, MARK_WRONG));
    const q = await (await apiNew(api, { n: 1 })).json();
    await apiCheck(api, q.id, 'wrong');
    expect(readState(hub).decks['S&D-1'].solved).toBe(true);
  });

  test('PRAC-033 PRAC-036 an unreadable photo: nothing saved, no solution, "Check again" brings back Check (but not Hint)', async ({ page, hub }) => {
    await hub.script([{ match: { label: '^practice:' }, reply: { json: problem() } },
      { match: { label: '^check$' }, times: 1, reply: { json: MARK_UNREADABLE } },
      { match: { label: '^check$' }, reply: { json: MARK_WRONG } }]);
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    const [id] = practiceIds(hub);
    await answerAndCheck(page, 'blurry');
    const box = resultBox(page);
    await expect(box).toContainText("I can't read the photo.");
    await expect(box).toContainText('Try a clearer photo (flat, good light), or type the key steps.');
    await expect(box.getByText('See the full solution')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Try another' })).toHaveCount(0);
    expect(reviewsOnDisk(hub)).toEqual([]);
    expect(readState(hub).decks['S&D-1']?.solved ?? false).toBe(false);
    expect(practiceRec(hub, id).attempts).toHaveLength(1);
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect(resultBox(page)).toHaveCount(0);
    await expect(checkBtn(page)).toBeVisible();
    await expect(checkBtn(page)).toBeEnabled();
    // [quirk] pinned as-is: Hint does not come back after an unreadable result (spec PRAC-033)
    await expect(page.getByRole('button', { name: 'Hint', exact: true })).toBeHidden();
    await answerAndCheck(page, 'P = 30 typed');
    await expect(resultBox(page)).toContainText('Saved to review · back tomorrow');
    expect(practiceRec(hub, id).attempts).toHaveLength(2);
    expect(reviewsOnDisk(hub)).toHaveLength(1);
  });

  test('PRAC-033 an unreadable result with no verdict says it couldn\'t read the photo', async ({ page, hub }) => {
    await hub.script(practiceRules({}, { ...MARK_UNREADABLE, verdict: '' }));
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    await answerAndCheck(page, 'x');
    await expect(resultBox(page)).toContainText("I couldn't read that photo.");
  });

  test('PRAC-034 "Try another" writes a new problem of the same kind; a your-turn is followed by a slide problem', async ({ page, hub }) => {
    await hub.script([{ match: { label: '^chat:example$' }, reply: { text: 'Worked.' } }, ...practiceRules()]);
    await openSlide(page);
    await openTutor(page);
    await page.getByRole('button', { name: 'Worked example' }).click();
    await page.getByRole('button', { name: 'Your turn: finish from here ›' }).click();
    await answerAndCheck(page);
    await page.getByRole('button', { name: 'Try another' }).click();
    await expect(working(page)).toBeVisible();
    await expect(working(page)).toHaveValue('');
    expect((await hub.calls('^practice:')).map((c) => c.label)).toEqual(['practice:yourturn', 'practice:try']);
  });

  test('PRAC-034 "Try another" after /try with words keeps the words', async ({ page, hub }) => {
    await hub.script(practiceRules());
    await openSlide(page);
    await openTutor(page);
    await startTry(page, 'about taxes');
    await answerAndCheck(page);
    await page.getByRole('button', { name: 'Try another' }).click();
    await expect(working(page)).toBeVisible();
    await expect(panel(page)).toContainText('You asked for: about taxes');
    const calls = await hub.calls('^practice:');
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain('about taxes');
  });

  test('PRAC-035 a marking error shows the message and re-enables Check', async ({ page, hub }) => {
    await hub.script([{ match: { label: '^practice:' }, reply: { json: problem() } },
      { match: { label: '^check$' }, times: 1, reply: { error: 'Marking failed (MARK-ERR).' } },
      { match: { label: '^check$' }, reply: { json: MARK_CLEAN } }]);
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    await working(page).fill('P = 20');
    await checkBtn(page).click();
    await expect(panel(page)).toContainText('Marking failed (MARK-ERR).');
    await expect(checkBtn(page)).toBeEnabled();
    await checkBtn(page).click();
    await expect(resultBox(page)).toContainText('All right.');
  });

  test('PRAC-035 ERR-002 marking failing unexpectedly shows "Something went wrong. Try again." and re-enables Check', async ({ page, hub }) => {
    await hub.script([{ match: { label: '^practice:' }, reply: { json: problem() } },
      { match: { label: '^check$' }, times: 1, reply: { crash: true } },
      { match: { label: '^check$' }, reply: { json: MARK_CLEAN } }]);
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    await working(page).fill('P = 20');
    await checkBtn(page).click();
    await expect(panel(page)).toContainText('Something went wrong. Try again.');
    await expect(checkBtn(page)).toBeEnabled();
    await checkBtn(page).click();
    await expect(resultBox(page)).toContainText('All right.');
  });

  test('PRAC-035 checking a problem whose file is gone: "That problem has expired. Start a new one."', async ({ playwright, api, hub }) => {
    await hub.script(practiceRules());
    const p = await (await apiNew(api, {})).json();
    await hub.restart();
    fs.rmSync(hub.path(DEMO, 'me', 'practice', `${p.id}.json`));
    const ctx = await playwright.request.newContext({ baseURL: hub.url });
    let r = await apiCheck(ctx, p.id);
    expect(r.status()).toBe(404);
    expect((await r.json()).error).toBe('That problem has expired. Start a new one.');
    r = await ctx.post('/api/practice/hint', { data: { id: p.id } });
    expect((await r.json()).error).toMatch(/That problem has expired/);
    r = await ctx.post('/api/practice/photo', { data: { id: p.id, data: jpgDataUrl() } });
    expect((await r.json()).error).toBe('That problem has expired.');
    await ctx.dispose();
  });

  test('PRAC-043 a problem saves at most one review item however often it is checked', async ({ api, hub }) => {
    await hub.script(practiceRules({}, MARK_WRONG));
    const p = await (await apiNew(api, {})).json();
    const a = await (await apiCheck(api, p.id, 'one')).json();
    const b = await (await apiCheck(api, p.id, 'two')).json();
    expect(a.saved && b.saved).toBe(true);
    expect(b.review_id).toBe(a.review_id);
    expect(reviewsOnDisk(hub)).toHaveLength(1);
  });
});

// ============================================================ F. Prefetch

test.describe('prefetch', () => {
  test('PRAC-045 after a check the next problem is written in the background and "Try another" takes it', async ({ page, hub }) => {
    await hub.script([
      { match: { label: '^practice:try$' }, times: 1, reply: { json: problem({ problem_md: 'FIRST-PROBLEM' }) } },
      { match: { label: '^practice:try$' }, times: 1, reply: { json: problem({ problem_md: 'PREFETCHED-PROBLEM' }) } },
      { match: { label: '^practice:try$' }, reply: { json: problem({ problem_md: 'FRESH-PROBLEM' }) } },
      { match: { label: '^check$' }, reply: { json: MARK_CLEAN } }]);
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    await expect(panel(page)).toContainText('FIRST-PROBLEM');
    await answerAndCheck(page);
    await expect.poll(() => practiceIds(hub).length).toBe(2);       // the prefetched one is on disk already
    await page.getByRole('button', { name: 'Try another' }).click();
    await expect(panel(page)).toContainText('PREFETCHED-PROBLEM');
    await answerAndCheck(page);
    await expect.poll(() => practiceIds(hub).length).toBe(3);
    expect((await hub.calls('^practice:try$')).length).toBe(3);   // initial + one prefetch per check
  });

  test('PRAC-003 PRAC-045 a prefetch still being written: "Finishing the problem that\'s already being written…"', async ({ page, hub }) => {
    await hub.script([
      { match: { label: '^practice:try$' }, times: 1, reply: { json: problem({ problem_md: 'FIRST-PROBLEM' }) } },
      { match: { label: '^practice:try$' }, times: 1, reply: { json: problem({ problem_md: 'SLOW-PREFETCH' }), wait_for: 'pf' } },
      { match: { label: '^check$' }, reply: { json: MARK_CLEAN } }]);
    await openSlide(page);
    await openTutor(page);
    await startTry(page);
    await answerAndCheck(page);
    await expect.poll(async () => (await hub.calls('^practice:try$')).length).toBe(2);
    await page.getByRole('button', { name: 'Try another' }).click();
    await expect(panel(page)).toContainText("Finishing the problem that's already being written…");
    await hub.release('pf');
    await expect(panel(page)).toContainText('SLOW-PREFETCH');
    expect(await hub.calls('^practice:try$')).toHaveLength(2);
  });

  test('PRAC-045 review, your-turn and /try-with-words problems are never prefetched', async ({ page, hub }) => {
    await hub.script([{ match: { label: '^chat:example$' }, reply: { text: 'Worked.' } }, ...practiceRules()]);
    await openSlide(page);
    await openTutor(page);
    await startTry(page, 'something odd');
    await answerAndCheck(page);
    await page.getByRole('button', { name: '‹ Back to slide' }).click();
    await page.getByRole('button', { name: 'Worked example' }).click();
    await page.getByRole('button', { name: 'Your turn: finish from here ›' }).click();
    await answerAndCheck(page);
    // give a background prefetch time to start, if one (wrongly) were started
    await page.waitForTimeout(1000);
    expect((await hub.calls('^practice:')).map((c) => c.label)).toEqual(['practice:try', 'practice:yourturn']);
  });

  test('PRAC-045 a slide prefetch is only used on the same slide; a failed prefetch is replaced by a fresh problem', async ({ api, hub }) => {
    await hub.script([
      { match: { label: '^practice:try$' }, times: 1, reply: { json: problem({ problem_md: 'A' }) } },
      { match: { label: '^practice:try$' }, times: 1, reply: { json: problem({ problem_md: 'PF-SLIDE-2' }) } },
      { match: { label: '^practice:try$' }, reply: { json: problem({ problem_md: 'FRESH' }) } },
      { match: { label: '^check$' }, reply: { json: MARK_CLEAN } }]);
    const a = await (await apiNew(api, { n: 2 })).json();
    await apiCheck(api, a.id, 'x', { prefetch: true });
    await expect.poll(() => practiceIds(hub).length).toBe(2);
    const other = await (await apiNew(api, { n: 3 })).json();
    expect(other.problem_md).toBe('FRESH');
    expect(practiceIds(hub)).toHaveLength(3);     // the prefetched one stays on disk unused
    // a failed prefetch
    await hub.script([{ match: { label: '^practice:deck$' }, times: 1, reply: { json: problem({ problem_md: 'D1' }) } },
      { match: { label: '^practice:deck$' }, times: 1, reply: { error: 'prefetch broke' } },
      { match: { label: '^practice:deck$' }, reply: { json: problem({ problem_md: 'D-FRESH' }) } },
      { match: { label: '^check$' }, reply: { json: MARK_CLEAN } }]);
    const d = await (await apiNew(api, { kind: 'deck' })).json();
    await apiCheck(api, d.id, 'x', { prefetch: true });
    await expect.poll(async () => (await hub.calls('^practice:deck$')).length).toBe(2);
    const next = await apiNew(api, { kind: 'deck' });
    expect(next.status()).toBe(200);
    expect((await next.json()).problem_md).toBe('D-FRESH');
  });

  test('PRAC-045 prefetched problems are lost on restart (their files remain)', async ({ playwright, api, hub }) => {
    await hub.script([
      { match: { label: '^practice:try$' }, times: 1, reply: { json: problem({ problem_md: 'A' }) } },
      { match: { label: '^practice:try$' }, times: 1, reply: { json: problem({ problem_md: 'PREFETCHED' }) } },
      { match: { label: '^practice:try$' }, reply: { json: problem({ problem_md: 'AFTER-RESTART' }) } },
      { match: { label: '^check$' }, reply: { json: MARK_CLEAN } }]);
    const a = await (await apiNew(api, {})).json();
    await apiCheck(api, a.id, 'x', { prefetch: true });
    await expect.poll(() => practiceIds(hub).length).toBe(2);
    await hub.restart();
    await hub.script(practiceRules({ problem_md: 'AFTER-RESTART' }));
    const ctx = await playwright.request.newContext({ baseURL: hub.url });
    const b = await (await apiNew(ctx, {})).json();
    expect(b.problem_md).toBe('AFTER-RESTART');
    expect(practiceIds(hub)).toHaveLength(3);    // pinned as-is: prefetched problems remain in me/practice/
    await ctx.dispose();
  });
});

// ============================================================ practice on a practice deck (DECK-001)

test('DECK-001 a practice deck can be practised like any deck', async ({ page, hub }) => {
  await hub.script(practiceRules({ deck: 'HW-1', slides: 'HW-1 s1' }));
  await openSlide(page, HW1);
  await openTutor(page);
  await startTry(page);
  await expect(panel(page)).toContainText('From HW-1 s1');
  await answerAndCheck(page);
  expect(readState(hub).decks['HW-1'].solved).toBe(true);
  const [c] = await hub.calls('^practice:try$');
  expect(c.prompt).toContain('[HW-1]');
});
