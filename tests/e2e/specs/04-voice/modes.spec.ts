/**
 * 04 Voice — the speech engine's warm-up/availability and the Text | Voice answer modes.
 * Spec: docs/functional-spec/04-voice.md §1–2 (VOICE-001..017).
 *
 * The harness reports the voice ready at once; the loading / unavailable states are produced by intercepting the
 * page's /api/voice/warm and /api/voice/speak requests (page.route).
 *
 * Not covered: VOICE-001 (no account/cost: nothing to observe with the speech double), VOICE-002 (hub start-up
 * warm-up of downloaded models happens inside the real hub's main(), replaced by the launcher), VOICE-003 (model
 * download: [real-device], needs the network), VOICE-006 (the hub-side warm-up on dictation start is internal to
 * the hub; only the start request is observable — see dictation.spec.ts VOICE-053).
 */
import { test, expect } from '../../fixtures/hub';
import * as V from './helpers';

const LOADING = { ready: false, loading: true, error: null, downloaded: true, voices: {}, default_voice: 'af_heart' };
const FAILED = { ready: false, loading: false, error: 'Voice needs two Python packages', downloaded: false, voices: {}, default_voice: 'af_heart' };

test.describe('warm-up and availability', () => {
  test('VOICE-004 showing the panel in Voice mode warms the voice (with the deck) and polls every ~2 s until ready', async ({ page }) => {
    let n = 0;
    const times: number[] = [];
    const bodies: any[] = [];
    await page.route('**/api/voice/warm', async (route) => {
      times.push(Date.now());
      bodies.push(route.request().postDataJSON());
      if (++n <= 2) return route.fulfill({ json: LOADING });
      return route.continue();
    });
    await V.rememberView(page, 'voice');
    await V.openDeck(page);
    await V.openTutor(page);
    await expect.poll(() => n, { timeout: 10_000 }).toBe(3);
    expect(bodies[0]).toMatchObject({ course: 'Demo-Course', tag: 'S&D-1' });
    expect(times[1] - times[0]).toBeGreaterThan(1500);
    expect(times[2] - times[1]).toBeGreaterThan(1500);
    // ready now: no more polling
    await page.waitForTimeout(2600);
    expect(n).toBe(3);
  });

  test('VOICE-004 in Text mode, opening the panel does not warm the voice', async ({ page }) => {
    const warms = V.recordRequests(page, '/api/voice/warm');
    await V.rememberView(page, 'text');
    await V.openDeck(page);
    await V.openTutor(page);
    await page.waitForTimeout(800);
    expect(warms).toHaveLength(0);
  });

  test('VOICE-005 pressing ▶ Play in Text mode starts the warm-up and fills the voice list', async ({ page, hub }) => {
    await hub.script([V.answerRule('A short answer.')]);
    await V.slowVoice(page, 1500);
    await V.rememberView(page, 'text');
    await V.openDeck(page);
    await V.openTutor(page);
    await V.ask(page, 'what is demand');
    await expect(V.lastPlay(page)).toHaveText('▶ Play');
    const warm = page.waitForRequest((r) => r.url().includes('/api/voice/warm'));
    await V.lastPlay(page).click();
    await warm;
    await expect(V.voicePick(page)).toBeVisible();
    await expect(V.voicePick(page).locator('option')).toHaveCount(6);
  });

  test('VOICE-007 VOICE-015 while the hub says the voice is loading, an answer arrives silently with "still loading"', async ({ page, hub }) => {
    await page.route('**/api/voice/warm', (route) => route.fulfill({ json: LOADING }));
    await hub.script([V.answerRule('Loading answer one.', '^chat:ask$')]);
    await V.rememberView(page, 'voice');
    await V.openDeck(page);
    await V.openTutor(page);
    await V.ask(page, 'first question');
    await expect(V.toast(page, 'The voice is still loading; showing the answer without it.')).toBeVisible();
    await expect(V.answers(page).last()).toContainText('Loading answer one.');
    await expect(V.lastPlay(page)).toHaveText('▶ Play');
    expect(await hub.spoken()).toHaveLength(0);
    await expect(V.toast(page, 'still loading')).toHaveCount(0, { timeout: 5000 });
    // at most once until the voice is ready
    await V.ask(page, 'second question');
    await expect(V.questions(page)).toHaveCount(2);
    await expect(V.answers(page)).toHaveCount(2);
    await page.waitForTimeout(500);
    await expect(V.toast(page, 'still loading')).toHaveCount(0);
    expect(await hub.spoken()).toHaveLength(0);
  });

  for (const [why, fail] of [
    ['the hub reports the models failed', (route: any) => route.fulfill({ json: FAILED })],
    ['the hub cannot be reached', (route: any) => route.abort()],
  ] as const) {
    test(`VOICE-007 VOICE-016 VOICE-008 when ${why}, an answer arrives silently with "Voice isn't available" once`, async ({ page, hub }) => {
      await page.route('**/api/voice/warm', fail);
      await hub.script([V.answerRule('Plain answer text.', '^chat:ask$')]);
      await V.rememberView(page, 'voice');
      await V.openDeck(page);
      const warm = page.waitForEvent('requestfinished', (r) => r.url().includes('/api/voice/warm')).catch(() => null);
      const failed = page.waitForEvent('requestfailed', (r) => r.url().includes('/api/voice/warm')).catch(() => null);
      await V.openTutor(page);
      await Promise.race([warm, failed]);
      await page.waitForTimeout(200);
      await V.ask(page, 'first question');
      await expect(V.toast(page, "Voice isn't available; showing the answer without it.")).toBeVisible();
      // VOICE-008: everything else still works
      await expect(V.answers(page).last()).toContainText('Plain answer text.');
      await expect(V.lastPlay(page)).toHaveText('▶ Play');
      await expect(V.toast(page, "Voice isn't available")).toHaveCount(0, { timeout: 5000 });
      await V.ask(page, 'second question');
      await expect(V.answers(page)).toHaveCount(2);
      await page.waitForTimeout(500);
      await expect(V.toast(page, "Voice isn't available")).toHaveCount(0);
      expect(await hub.spoken()).toHaveLength(0);
    });
  }

  test('VOICE-009 an unavailable voice is retried when the panel is shown again in Voice mode, and then reads aloud', async ({ page, hub }) => {
    let fail = true;
    const warms = V.recordRequests(page, '/api/voice/warm');
    await page.route('**/api/voice/warm', (route) => (fail ? route.fulfill({ json: FAILED }) : route.continue()));
    await hub.script([V.answerRule('Now it speaks.', '^chat:ask$')]);
    await V.rememberView(page, 'voice');
    await V.openDeck(page);
    await V.openTutor(page);
    await expect.poll(() => warms.length).toBe(1);
    fail = false;
    await page.getByRole('button', { name: 'Close the tutor' }).click();
    const ok = page.waitForResponse((r) => r.url().includes('/api/voice/warm'));
    await V.openTutor(page);
    await ok;
    expect(warms.length).toBe(2);
    await page.waitForTimeout(150);
    await V.ask(page, 'speak now');
    await expect.poll(async () => (await hub.spoken()).map((r) => r.text)).toContain('Now it speaks.');
  });

  test('VOICE-009 an unavailable voice is retried by ▶ Play', async ({ page, hub }) => {
    let fail = true;
    const warms = V.recordRequests(page, '/api/voice/warm');
    await page.route('**/api/voice/warm', (route) => (fail ? route.fulfill({ json: FAILED }) : route.continue()));
    await hub.script([V.answerRule('Replay me.', '^chat:ask$')]);
    await V.rememberView(page, 'voice');
    await V.openDeck(page);
    await V.openTutor(page);
    await expect.poll(() => warms.length).toBe(1);
    await page.waitForTimeout(150);
    await V.ask(page, 'q');
    await expect(V.lastPlay(page)).toHaveText('▶ Play');
    fail = false;
    await V.lastPlay(page).click();
    await expect.poll(() => warms.length).toBe(2);
  });
});

test.describe('Text | Voice switch', () => {
  test('VOICE-010 the "Answers" switch offers Text and Voice, exactly one selected, with their descriptions', async ({ page }) => {
    await V.openDeck(page);
    await V.openTutor(page);
    await expect(V.textRadio(page)).toHaveAttribute('aria-checked', 'true');
    await expect(V.voiceRadio(page)).toHaveAttribute('aria-checked', 'false');
    await expect(V.textRadio(page)).toHaveAttribute('title', "Answers appear as they're written; ▶ Play reads one aloud");
    await expect(V.voiceRadio(page)).toHaveAttribute('title', "Answers are read aloud, appearing as they're spoken");
    await V.voiceRadio(page).click();
    await expect(V.voiceRadio(page)).toHaveAttribute('aria-checked', 'true');
    await expect(V.textRadio(page)).toHaveAttribute('aria-checked', 'false');
    await V.textRadio(page).click();
    await expect(V.textRadio(page)).toHaveAttribute('aria-checked', 'true');
    await expect(V.voiceRadio(page)).toHaveAttribute('aria-checked', 'false');
  });

  test('VOICE-011 VOICE-093 the choice is remembered across reloads and decks; a new browser defaults to Text', async ({ page }) => {
    await V.openDeck(page);
    await V.openTutor(page);
    await expect(V.textRadio(page)).toHaveAttribute('aria-checked', 'true');
    await V.voiceRadio(page).click();
    await page.reload();
    await V.openTutor(page);
    await expect(V.voiceRadio(page)).toHaveAttribute('aria-checked', 'true');
    await V.openDeck(page, V.DECK2);
    // (the panel stays open across decks)
    await expect(V.voiceRadio(page)).toHaveAttribute('aria-checked', 'true');
  });

  test('VOICE-011 a choice saved under the former name of Voice still counts as Voice', async ({ page }) => {
    await V.rememberView(page, 'board');
    await V.openDeck(page);
    await V.openTutor(page);
    await expect(V.voiceRadio(page)).toHaveAttribute('aria-checked', 'true');
  });

  test('VOICE-012 switching modes stops a reading in progress', async ({ page, hub }) => {
    await hub.script([V.answerRule(V.longAnswer('Switch', 10))]);
    await V.countPlays(page);
    await V.slowVoice(page, 1500);
    await V.rememberView(page, 'text');
    await V.openDeck(page);
    await V.openTutor(page);
    await V.ask(page, 'q');
    await V.lastPlay(page).click();
    await expect(V.voiceState(page)).toHaveText('Speaking…');
    await V.voiceRadio(page).click();
    await expect(V.voiceRow(page)).toBeHidden();
    await expect(V.lastPlay(page)).toHaveText('▶ Play');
    const n = await V.plays(page);
    await page.waitForTimeout(2500);
    expect(await V.plays(page)).toBe(n);
    expect(n).toBeLessThan(4);
  });

  test('VOICE-013 the empty chat hint mentions voice only in Voice mode', async ({ page }) => {
    await V.rememberView(page, 'voice');
    await V.openDeck(page);
    await V.openTutor(page);
    await expect(V.thread(page)).toContainText(
      'Ask anything about this slide, or type / for a mode. Voice: answers are read aloud as they appear.');
    await V.textRadio(page).click();
    await expect(V.thread(page)).toContainText('Ask anything about this slide, or type / for a mode.');
    await expect(V.thread(page)).not.toContainText('Voice: answers are read aloud');
  });

  test('VOICE-014 in Voice mode typed questions, mode buttons and slash commands are all read aloud', async ({ page, hub }) => {
    await hub.script([
      V.answerRule('Typed answer said.', '^chat:ask$'),
      V.answerRule('Explain answer said.', '^chat:explain$'),
      V.answerRule('Example answer said.', '^chat:example$'),
    ]);
    await V.openVoiceReady(page);
    await V.ask(page, 'typed one');
    await expect.poll(async () => (await hub.spoken()).map((r) => r.text)).toContain('Typed answer said.');
    await expect(V.voiceRow(page)).toBeHidden();
    await page.getByRole('button', { name: 'Explain simply' }).click();
    await expect.poll(async () => (await hub.spoken()).map((r) => r.text)).toContain('Explain answer said.');
    await expect(V.voiceRow(page)).toBeHidden();
    await V.askBox(page).fill('/example ');
    await V.askBox(page).press('Enter');
    await expect.poll(async () => (await hub.spoken()).map((r) => r.text)).toContain('Example answer said.');
  });

  test('VOICE-014 in Text mode a new answer is not read aloud', async ({ page, hub }) => {
    await hub.script([V.answerRule('Silent answer.')]);
    await V.openDeck(page);
    await V.openTutor(page);
    await V.ask(page, 'q');
    await expect(V.lastPlay(page)).toHaveText('▶ Play');
    await page.waitForTimeout(500);
    expect(await hub.spoken()).toHaveLength(0);
    await expect(V.voiceRow(page)).toBeHidden();
  });

  test('VOICE-015 pinned as-is: the first question in Voice mode sent from the closed ask bar after load is not read aloud', async ({ page, hub }) => {
    // Pinned as-is: sending from the ask bar opens the panel, which only then starts the warm-up, so the voice is
    // still "loading" (from the page's point of view) when the answer starts. The spec allows this: VOICE-004 starts
    // the warm-up when the panel is shown, and VOICE-015 says an answer asked while the voice is loading arrives
    // silently with the "still loading" message.
    await hub.script([V.answerRule('From the ask bar.', '^chat:ask$'), V.answerRule('Second time.', '^chat:ask$')]);
    await V.rememberView(page, 'voice');
    await V.openDeck(page);
    await V.ask(page, 'from the bar');
    await expect(V.toast(page, 'The voice is still loading; showing the answer without it.')).toBeVisible();
    await expect(V.answers(page).last()).toContainText('From the ask bar.');
    expect(await hub.spoken()).toHaveLength(0);
    // the next one, with the panel open (voice now ready), is read aloud
    await V.ask(page, 'again');
    await expect.poll(async () => (await hub.spoken()).length).toBeGreaterThan(0);
  });

  test('VOICE-017 only the asking device speaks; another device in Voice mode shows the turn silently', async ({ page, hub, context }) => {
    await hub.script([V.answerRule('Shared answer here.', '^chat:ask$')]);
    const other = await context.newPage();
    const speakA = V.recordRequests(page, '/api/voice/speak');
    const speakB = V.recordRequests(other, '/api/voice/speak');
    await V.openVoiceReady(page);
    await V.openVoiceReady(other);
    await page.waitForTimeout(500);
    await V.ask(page, 'asked on A');
    await expect(other.locator('#thread .msg-q')).toContainText('asked on A'); // locator: markup hook
    await expect(other.locator('#thread')).toContainText('Shared answer here.'); // locator: markup hook
    await expect.poll(() => speakA.length).toBeGreaterThan(0);
    await page.waitForTimeout(800);
    expect(speakB).toHaveLength(0);
  });
});
