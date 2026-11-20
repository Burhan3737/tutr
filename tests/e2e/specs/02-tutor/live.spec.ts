/**
 * 02 · The Ask-box draft and live multi-device sync (docs/functional-spec/02-tutor-and-chats.md §7: DRAFT-*, LIVE-*).
 * A "device" is a separate browser context on the same hub.
 *
 * Not covered:
 * - LIVE-009 the re-save test stands in for "the hub went down between a keystroke and its save" by putting the older
 *   drafts.json back while the hub is down (the timing of a real crash inside the 1 s save delay isn't reproducible).
 * - DRAFT-005 IME composition is checked with synthetic composition events only; dictation holding changes back is the
 *   voice area's.
 * - LIVE-007 the phone-asleep case (same mechanism as a hidden tab, which is covered).
 * Covered elsewhere: LIVE-006 for a reloaded page (streaming.spec.ts), LIVE-008 (chats.spec.ts).
 */
import { test, expect } from '../../fixtures/hub';
import type { Page } from '@playwright/test';
import {
  DEMO, SD1_S2, HW1, askBox, questions, answers, waiting, errors, openSlide, openTutor, ask, settled, rule, held,
  drafts, devices, closeAll, MEMORY_NOOP,
} from './helpers';

const valueIs = (page: Page, v: string) => expect(askBox(page)).toHaveValue(v);

/** Make a page hidden (as a background tab) or visible again. */
async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { value: h, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: h ? 'hidden' : 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test.describe('the shared draft', () => {
  test('DRAFT-001 text typed on one device appears on every device with the course open (any deck)', async ({ browser, hub }) => {
    const [d1] = await devices(browser, hub, 1);
    const [d2] = await devices(browser, hub, 1, HW1, false);
    await askBox(d1.page).pressSequentially('typed on device one');
    await valueIs(d2.page, 'typed on device one');
    await askBox(d2.page).press('End');
    await askBox(d2.page).pressSequentially(' and two');
    await valueIs(d1.page, 'typed on device one and two');
    await closeAll([d1, d2]);
  });

  test('DRAFT-002 the draft is saved to drafts.json and survives a reload and a hub restart', async ({ page, hub }) => {
    await openSlide(page);
    await askBox(page).fill('half typed');
    await expect.poll(() => drafts(hub)[DEMO]?.text, { timeout: 5000 }).toBe('half typed');
    const d = drafts(hub)[DEMO];
    expect(Object.keys(d).sort()).toEqual(expect.arrayContaining(['at', 'by', 'photos', 'rev', 'spoken', 'text']));
    expect(d.spoken).toBe(false);
    expect(d.photos).toEqual([]);
    expect(typeof d.rev).toBe('number');
    await page.reload();
    await valueIs(page, 'half typed');
    await hub.restart();
    await page.goto(hub.url + '/' + SD1_S2);
    await valueIs(page, 'half typed');
  });

  test('DRAFT-003 sending a question empties the box on every device', async ({ browser, hub }) => {
    const [d1, d2] = await devices(browser, hub, 2);
    await askBox(d1.page).fill('about to send');
    await valueIs(d2.page, 'about to send');
    await askBox(d1.page).press('Enter');
    await valueIs(d1.page, '');
    await valueIs(d2.page, '');
    await settled(d1.page);
    await expect.poll(() => drafts(hub)[DEMO]?.text).toBe('');
    await closeAll([d1, d2]);
  });

  test('DRAFT-004 the hub refuses a change made on a stale copy and returns the newer draft', async ({ api }) => {
    const r1 = await (await api.post('/api/draft', { data: { course: DEMO, client: 'a', text: 'from a', base: 0 } })).json();
    expect(r1.ok).toBe(true);
    const r2 = await (await api.post('/api/draft', { data: { course: DEMO, client: 'b', text: 'from b', base: 0 } })).json();
    expect(r2.ok).toBe(false);
    expect(r2.text).toBe('from a');
    expect(r2.rev).toBe(r1.rev);
    const r3 = await (await api.post('/api/draft', { data: { course: DEMO, client: 'b', text: 'from a, then b', base: r2.rev } })).json();
    expect(r3.ok).toBe(true);
    const bad = await api.post('/api/draft', { data: { course: DEMO, client: 'b', text: 'x', base: 'nope' } });
    expect(bad.status()).toBe(400);
  });

  test('DRAFT-004 edits to different parts made at the same time on two devices are both kept', async ({ browser, hub }) => {
    const [d1, d2] = await devices(browser, hub, 2);
    await askBox(d1.page).fill('alpha middle omega');
    await valueIs(d2.page, 'alpha middle omega');
    await Promise.all([askBox(d1.page).fill('ALPHA middle omega'), askBox(d2.page).fill('alpha middle OMEGA')]);
    await valueIs(d1.page, 'ALPHA middle OMEGA');
    await valueIs(d2.page, 'ALPHA middle OMEGA');
    await closeAll([d1, d2]);
  });

  test('DRAFT-005 a change from another device keeps this device\'s cursor in the right place', async ({ browser, hub }) => {
    const [d1, d2] = await devices(browser, hub, 2);
    await askBox(d1.page).fill('hello world');
    await valueIs(d2.page, 'hello world');
    await askBox(d2.page).focus();
    await askBox(d2.page).evaluate((t: HTMLTextAreaElement) => t.setSelectionRange(6, 6));   // before "world"
    await askBox(d1.page).evaluate((t: HTMLTextAreaElement) => t.blur());
    await askBox(d1.page).fill('oh hello world');        // 3 characters before the caret
    await valueIs(d2.page, 'oh hello world');
    expect(await askBox(d2.page).evaluate((t: HTMLTextAreaElement) => [t.selectionStart, t.selectionEnd])).toEqual([9, 9]);
    await askBox(d1.page).fill('oh hello world!');      // after the caret: it doesn't move
    await valueIs(d2.page, 'oh hello world!');
    expect(await askBox(d2.page).evaluate((t: HTMLTextAreaElement) => t.selectionStart)).toBe(9);
    await closeAll([d1, d2]);
  });

  test('DRAFT-005 changes wait while the student is composing a word; the "/" list only opens where it was typed', async ({ browser, hub }) => {
    const [d1, d2] = await devices(browser, hub, 2);
    await askBox(d2.page).focus();
    await askBox(d2.page).dispatchEvent('compositionstart');
    await askBox(d1.page).fill('while composing');
    await d1.page.waitForTimeout(1500);
    await valueIs(d2.page, '');
    await askBox(d2.page).dispatchEvent('compositionend');
    await valueIs(d2.page, 'while composing');
    await askBox(d1.page).fill('');
    await valueIs(d2.page, '');
    await askBox(d2.page).evaluate((t: HTMLTextAreaElement) => t.blur());     // (device two isn't typing)
    await askBox(d1.page).press('/');
    await expect(d1.page.getByRole('listbox')).toBeVisible();
    await valueIs(d2.page, '/');
    await expect(d2.page.getByRole('listbox')).toBeHidden();
    await closeAll([d1, d2]);
  });

  test('DRAFT-006 MEM-001 a dictated draft is marked spoken: the question shows 🎙 and updates the memory', async ({ page, hub, api }) => {
    await hub.script([MEMORY_NOOP]);
    await openSlide(page);
    await openTutor(page);
    const cur = await (await api.post('/api/draft', { data: { course: DEMO, client: 'mic', text: '', base: 0 } })).json();
    const r = await (await api.post('/api/draft', { data: { course: DEMO, client: 'mic', text: 'what is a shortage', base: cur.rev, spoken: true } })).json();
    expect(r.spoken).toBe(true);
    await valueIs(page, 'what is a shortage');
    await askBox(page).press('Enter');
    await settled(page);
    await expect(questions(page).first()).toHaveText(/^▾🎙 what is a shortage/);
    const [c] = await hub.calls('^memory$');
    expect(c.prompt).toContain('what is a shortage');
    expect(c.model).toBe('claude-haiku-4-5');
    expect(JSON.parse(hub.read(DEMO, 'me', 'chats', hub.list(`${DEMO}/me/chats`)[0])).messages[0].spoken).toBe(true);
  });

  test('DRAFT-006 clearing the box clears the spoken mark', async ({ page, hub, api }) => {
    await openSlide(page);
    await openTutor(page);
    const cur = await (await api.post('/api/draft', { data: { course: DEMO, client: 'mic', text: '', base: 0 } })).json();
    await api.post('/api/draft', { data: { course: DEMO, client: 'mic', text: 'spoken words', base: cur.rev, spoken: true } });
    await valueIs(page, 'spoken words');
    await askBox(page).fill('');
    await askBox(page).fill('typed words');
    await askBox(page).press('Enter');
    await settled(page);
    await expect(questions(page).first()).toHaveText(/^▾typed words/);
    await expect.poll(() => drafts(hub)[DEMO]?.spoken).toBe(false);
    expect(await hub.calls('^memory$')).toHaveLength(0);
  });

  test('DRAFT-007 text typed just before leaving the course is kept in its draft', async ({ page, hub }) => {
    await openSlide(page);
    await askBox(page).fill('typed then left');
    await page.evaluate(() => { location.hash = '#'; });
    await expect.poll(() => drafts(hub)[DEMO]?.text, { timeout: 5000 }).toBe('typed then left');
  });

  test('DRAFT-008 a draft longer than 20,000 characters is refused', async ({ api }) => {
    const r = await api.post('/api/draft', { data: { course: DEMO, client: 'x', text: 'a'.repeat(20_001), base: 0 } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe("That's too long for a question.");
    const ok = await api.post('/api/draft', { data: { course: DEMO, client: 'x', text: 'a'.repeat(20_000), base: 0 } });
    expect(ok.ok()).toBe(true);
  });
});

test.describe('live turns from other devices', () => {
  test('LIVE-001 a listen is answered as soon as there is news', async ({ api }) => {
    const first = await (await api.get(`/api/live?course=${DEMO}&client=listener`)).json();
    expect(first.snapshot).toBeTruthy();
    expect(first.snapshot).toHaveProperty('draft');
    expect(first.snapshot).toHaveProperty('turns');
    const t0 = Date.now();
    const pending = api.get(`/api/live?course=${DEMO}&client=listener&since=${first.seq}&epoch=${first.epoch}`);
    await new Promise((r) => setTimeout(r, 300));
    await api.post('/api/draft', { data: { course: DEMO, client: 'writer', text: 'news!', base: first.snapshot.draft?.rev ?? 0 } });
    const next = await (await pending).json();
    expect(Date.now() - t0).toBeLessThan(10_000);
    const kinds = next.events.map((e: any) => e[0]);
    expect(kinds).toContain('draft');
    expect(next.events.find((e: any) => e[0] === 'draft')[1].text).toBe('news!');
  });

  test('LIVE-002 another device\'s question appears live: bubble, waiting line, status, text, saved answer', async ({ browser, hub }) => {
    await hub.script([{ match: { label: '^chat:ask$' }, reply: { wait_for: 'go', status: ['Reading the S&D-1 slides'],
      chunks: ['Remote part one ONE. ', 'Remote part two TWO.', ' '], chunk_delay_ms: 2000, text: 'Remote part one ONE. Remote part two TWO. ' } }]);
    const [d1, d2] = await devices(browser, hub, 2);
    await ask(d1.page, 'Asked on device one');
    await expect(questions(d2.page).first()).toContainText('Asked on device one');
    await expect(questions(d2.page).first()).toContainText(' · s2');
    await expect(waiting(d2.page)).toHaveText('Answering a question from another device…');
    await hub.release('go');
    await expect(waiting(d2.page)).toHaveText('Reading the S&D-1 slides…');
    await expect(answers(d2.page).first()).toContainText('ONE');
    await expect(waiting(d2.page)).toHaveText('Writing…');
    await settled(d2.page);
    await expect(answers(d2.page).first()).toContainText('TWO');
    expect(await hub.spoken()).toHaveLength(0);
    await closeAll([d1, d2]);
  });

  test('LIVE-003 a device with its panel closed catches up when it opens the panel', async ({ browser, hub }) => {
    await hub.script([held('go', 'Caught up CAUGHT-UP', '^chat:ask$')]);
    const [d1] = await devices(browser, hub, 1);
    const [d2] = await devices(browser, hub, 1, SD1_S2, false);
    await ask(d1.page, 'While you were closed');
    await expect(waiting(d1.page)).toBeVisible();
    await d2.page.waitForTimeout(500);
    await openTutor(d2.page);
    await expect(questions(d2.page).first()).toContainText('While you were closed');
    await hub.release('go');
    await settled(d2.page);
    await expect(answers(d2.page).first()).toContainText('CAUGHT-UP');
    await closeAll([d1, d2]);
  });

  test('LIVE-004 another device\'s failure shows as an error in place of that answer', async ({ browser, hub }) => {
    await hub.script([{ match: { label: '^chat:ask$' }, reply: { wait_for: 'go', error: 'That took too long. Try again.' } }]);
    const [d1, d2] = await devices(browser, hub, 2);
    await ask(d1.page, 'This fails');
    await expect(questions(d2.page).first()).toContainText('This fails');
    await hub.release('go');
    await expect(errors(d2.page)).toHaveText('That took too long. Try again.');
    await expect(errors(d1.page)).toHaveText('That took too long. Try again.');
    await closeAll([d1, d2]);
  });

  test('LIVE-005 the asking device shows its answer live even when its own stream is held back', async ({ page, hub }) => {
    await hub.script([rule('^chat:ask$', { chunks: ['Live first LIVE-1. ', 'Live second LIVE-2.', ' '], chunk_delay_ms: 2500,
      text: 'Live first LIVE-1. Live second LIVE-2. ' })]);
    await openSlide(page);
    await openTutor(page);
    // a tunnel that only delivers the reply when it ends
    await page.route('**/api/tutor', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, body: await res.body() });
    });
    await ask(page, 'Through a tunnel');
    await expect(page.locator('#thread .ans.live')).toContainText('LIVE-1'); // locator: markup hook
    await expect(page.locator('#thread .ans.live')).not.toContainText('LIVE-2'); // locator: markup hook
    await settled(page);
    await expect(answers(page).first()).toContainText('LIVE-2');
  });

  test('LIVE-006 a device that opens the course mid-answer gets the text so far and follows it to the end', async ({ browser, hub }) => {
    await hub.script([rule('^chat:ask$', { chunks: ['Early EARLY. ', 'Later LATER.', ' '], chunk_delay_ms: 3000,
      text: 'Early EARLY. Later LATER. ' })]);
    const [d1] = await devices(browser, hub, 1);
    await ask(d1.page, 'Join me');
    await expect(d1.page.locator('#thread .ans.live')).toContainText('EARLY'); // locator: markup hook
    const [d2] = await devices(browser, hub, 1);
    await expect(questions(d2.page).first()).toContainText('Join me');
    await expect(answers(d2.page).first()).toContainText('EARLY');
    await expect(answers(d2.page).first()).toContainText('LATER', { timeout: 15_000 });
    await expect(waiting(d2.page)).toHaveCount(0);
    await closeAll([d1, d2]);
  });

  test('LIVE-007 a hidden page stops listening and catches up when visible again', async ({ browser, hub }) => {
    const [d1, d2] = await devices(browser, hub, 2);
    await askBox(d1.page).fill('before hiding');
    await valueIs(d2.page, 'before hiding');
    await setHidden(d2.page, true);
    const polls: string[] = [];
    d2.page.on('request', (r) => { if (r.url().includes('/api/live')) polls.push(r.url()); });
    await d2.page.waitForTimeout(300);
    polls.length = 0;
    await askBox(d1.page).fill('while hidden');
    await ask(d1.page, 'A question while hidden');
    await settled(d1.page);
    await d2.page.waitForTimeout(1500);
    expect(polls).toHaveLength(0);
    await expect(questions(d2.page)).toHaveCount(0);
    await setHidden(d2.page, false);
    await expect(questions(d2.page).first()).toContainText('A question while hidden');
    await settled(d2.page);
    await valueIs(d2.page, '');
    await closeAll([d1, d2]);
  });
});

test.describe('hub restart', () => {
  test('LIVE-009 after the hub restarts, a listening page recovers by itself and follows the course again', async ({ browser, hub }) => {
    test.setTimeout(90_000);
    const [d1] = await devices(browser, hub, 1);
    const old = hub.url;
    await hub.restart();
    // (the restarted hub listens on another port: send the open page's requests there, as if it had come back)
    await d1.page.route(`${old}/**`, (route) => route.continue({ url: route.request().url().replace(old, hub.url) }));
    const ctx = await browser.newContext({ baseURL: hub.url });
    const p2 = await ctx.newPage();
    await openSlide(p2);
    await openTutor(p2);
    await askBox(p2).fill('after the restart');
    await expect(askBox(d1.page)).toHaveValue('after the restart', { timeout: 30_000 });
    await ask(p2, 'Asked after the restart');
    await expect(questions(d1.page).first()).toContainText('Asked after the restart', { timeout: 30_000 });
    await settled(d1.page);
    await ctx.close();
    await closeAll([d1]);
  });

  test('LIVE-009 a page holding newer draft text than the restarted hub re-saves its own', async ({ browser, hub }) => {
    test.setTimeout(90_000);
    const [d1] = await devices(browser, hub, 1);
    await askBox(d1.page).fill('older draft');
    await expect.poll(() => drafts(hub)[DEMO]?.text, { timeout: 5000 }).toBe('older draft');
    const older = hub.read(DEMO, 'me', 'drafts.json');
    const saved = d1.page.waitForResponse((r) => r.url().includes('/api/draft') && r.request().postDataJSON()?.text === 'newer draft');
    await askBox(d1.page).fill('newer draft');
    expect((await (await saved).json()).ok).toBe(true);
    // The hub goes down before writing the newer text to disk: it comes back (on the same port) with the older draft.
    const port = Number(new URL(hub.url).port);
    await hub.stop();
    hub.write(`${DEMO}/me/drafts.json`, older);
    const end = Date.now() + 15_000;
    for (;;) {
      try { await hub.start(port); break; } catch (e) {
        if (Date.now() > end) throw e;
        await new Promise((r) => setTimeout(r, 250));     // (the old socket may take a moment to be released)
      }
    }
    await expect.poll(() => drafts(hub)[DEMO]?.text, { timeout: 30_000 }).toBe('newer draft');
    await valueIs(d1.page, 'newer draft');
    const [d2] = await devices(browser, hub, 1, HW1, false);
    await valueIs(d2.page, 'newer draft');
    await closeAll([d1, d2]);
  });

  test('LIVE-009 a page left open recovers by itself when the hub comes back on the same address', async ({ browser, hub }) => {
    test.setTimeout(90_000);
    const [d1] = await devices(browser, hub, 1);
    await hub.restart({ samePort: true });
    const [d2] = await devices(browser, hub, 1);
    await askBox(d2.page).fill('typed after the restart');
    await expect(askBox(d1.page)).toHaveValue('typed after the restart', { timeout: 30_000 });
    await ask(d2.page, 'Asked after the restart');
    await expect(questions(d1.page).first()).toContainText('Asked after the restart', { timeout: 30_000 });
    await settled(d1.page);
    await closeAll([d1, d2]);
  });
});
void HW1;
