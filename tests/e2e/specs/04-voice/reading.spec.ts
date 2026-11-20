/**
 * 04 Voice — reading an answer aloud (Voice mode), the voice row, voice/speed pickers and read-aloud failures.
 * Spec: docs/functional-spec/04-voice.md §3, §6, §7 (VOICE-018..027, 041..051).
 *
 * The hub's speech double returns 0.2 s of silence per sentence; to watch a reading in progress, slowVoice() lengthens
 * the audio the page receives (the request still reaches the hub and is logged there).
 *
 * Not covered: VOICE-027 (following along: keeping the spoken part in view depends on scroll geometry and the
 *   student's own scrolling; too timing-dependent to pin reliably), VOICE-045 (clamping an unknown voice / speed
 *   happens inside the real speech model call, which the launcher replaces).
 * Partly: VOICE-048 (the browser's refusal is simulated by making audio play() reject with NotAllowedError; real
 *   autoplay policy is [real-device]).
 */
import { test, expect } from '../../fixtures/hub';
import * as V from './helpers';

const S1 = 'Demand slopes down because people buy less when the price goes up.';
const S2 = 'Supply slopes up because sellers offer more at higher prices.';
const S3 = 'Where they cross is the equilibrium.';
const THREE = `${S1} ${S2} ${S3}`;

/** Voice mode, the voice ready, a long answer being read aloud ("Speaking…"). */
async function voiceReading(page: any, hub: any, n = 10) {
  await hub.script([V.answerRule(V.longAnswer('Long', n), '^chat:ask$', 1), V.answerRule('A newer answer.', '^chat:ask$')]);
  await V.countPlays(page);
  await V.slowVoice(page, 1500);
  await V.openVoiceReady(page);
  await V.ask(page, 'tell me a lot');
  await expect(V.voiceState(page)).toHaveText('Speaking…');
}

test.describe('reading an answer aloud in Voice mode', () => {
  test('VOICE-018 an answer is read in order, first piece = first sentence, the next piece prepared while one plays', async ({ page, hub }) => {
    await hub.script([V.answerRule(V.longAnswer('Order', 4), '^chat:ask$')]);
    await V.slowVoice(page, 1500);
    await V.openVoiceReady(page);
    await V.ask(page, 'q');
    await V.spokenAtLeast(hub, 2);
    await expect.poll(() => V.spokenText(hub)).toContain('Order sentence number 4');
    const rows = await hub.spoken();
    expect(rows[0].text).toBe(V.longAnswer('Order', 1));
    const said = rows.map((r) => r.text).join(' ');
    for (let i = 2; i <= 4; i++) expect(said.indexOf(`sentence number ${i} `)).toBeGreaterThan(said.indexOf(`sentence number ${i - 1} `));
    // piece 2 is asked for long before piece 1 (1.5 s of audio) has finished playing
    expect(rows[1].t - rows[0].t).toBeLessThan(1.2);
  });

  test('VOICE-018 later pieces group a few short sentences', async ({ page, hub }) => {
    await hub.script([V.answerRule('One here. Two here. Three here. Four here.', '^chat:ask$')]);
    await V.openVoiceReady(page);
    await V.ask(page, 'q');
    await expect(V.lastPlay(page)).toHaveText('▶ Play', { timeout: 15_000 });
    const texts = (await hub.spoken()).map((r) => r.text);
    expect(texts[0]).toBe('One here.');
    expect(texts.join(' ')).toBe('One here. Two here. Three here. Four here.');
    expect(texts.length).toBeLessThan(4);
  });

  test('VOICE-019 VOICE-020 the answer appears in step with the voice, the spoken sentence highlighted; all of it at the end', async ({ page, hub }) => {
    await hub.script([V.answerRule(`${V.longAnswer('Paced', 3)}`, '^chat:ask$')]);
    await V.slowVoice(page, 2000);
    await V.openVoiceReady(page);
    await V.ask(page, 'q');
    await expect(V.voiceState(page)).toHaveText('Speaking…');
    const ans = V.answers(page).last();
    await expect(ans).toContainText('Paced sentence number 1');
    await expect(ans).not.toContainText('Paced sentence number 3');
    const lit = page.locator('#thread .ans .spoken'); // locator: markup hook (the highlight)
    await expect(lit.first()).toContainText('sentence number 1');
    await expect(lit.filter({ hasText: 'sentence number 3' })).toHaveCount(0);
    await expect(V.voiceRow(page)).toBeHidden({ timeout: 15_000 });
    await expect(V.answers(page).last()).toContainText('Paced sentence number 3');
    await expect(lit).toHaveCount(0);
  });

  test('VOICE-021 drawing parts appear and light up as the sentence naming them is spoken; all shown, none lit at the end', async ({ page, hub }) => {
    const text = [
      'Here is the picture.',
      '',
      '```svg',
      '<svg viewBox="0 0 320 420" xmlns="http://www.w3.org/2000/svg"><g id="A"><rect x="10" y="10" width="50" height="50"/></g><g id="B"><circle cx="100" cy="100" r="20"/></g></svg>',
      '```',
      '',
      'The box comes first [#A].',
      '',
      'Then there is the circle, which stands for the market price in this little drawing of ours [#B].',
      '',
      'That is all there is to it, and the drawing is now complete for you to look at closely.',
    ].join('\n');
    await hub.script([V.answerRule(text, '^chat:ask$')]);
    await V.slowVoice(page, 1500);
    await V.openVoiceReady(page);
    await V.ask(page, 'draw it');
    const ans = V.answers(page).last();
    // locator: markup hook (drawing parts: cue-part / cue-hide / cue-on)
    await expect(ans.locator('.cue-on')).toHaveCount(1, { timeout: 15_000 });
    await expect(ans.locator('.cue-part.cue-hide').first()).toBeAttached();
    await expect(ans.locator('.cue-on circle')).toHaveCount(1, { timeout: 15_000 });
    await expect(V.voiceRow(page)).toBeHidden({ timeout: 15_000 });
    await expect(V.answers(page).last().locator('.cue-on')).toHaveCount(0);
    await expect(V.answers(page).last().locator('.cue-hide')).toHaveCount(0);
    const said = await V.spokenText(hub);
    expect(said).not.toContain('[#');
    expect(said).not.toContain('<svg');
  });

  test('VOICE-022 the voice row: "Getting the voice ready…" then "Speaking…", with Stop and the pickers; hidden after', async ({ page, hub }) => {
    await hub.script([V.answerRule(THREE, '^chat:ask$')]);
    await V.slowVoice(page, 1500, 1500);
    await V.openVoiceReady(page);
    await expect(V.voiceRow(page)).toBeHidden();
    await V.ask(page, 'q');
    await expect(V.voiceState(page)).toHaveText('Getting the voice ready…');
    await expect(V.rowStop(page)).toBeVisible();
    await expect(V.voiceState(page)).toHaveText('Speaking…');
    await expect(V.rowStop(page)).toBeVisible();
    await expect(V.voicePick(page)).toBeVisible();
    await expect(V.speedPick(page)).toBeVisible();
    await expect(V.voiceRow(page)).toBeHidden({ timeout: 15_000 });
  });

  test('VOICE-023 ■ Stop ends the reading at once: nothing more is said, the answer shows whole, the highlight goes', async ({ page, hub }) => {
    await voiceReading(page, hub);
    await V.rowStop(page).click();
    await expect(V.voiceRow(page)).toBeHidden();
    await expect(V.answers(page).last()).toContainText('Long sentence number 10');
    await expect(page.locator('#thread .spoken')).toHaveCount(0); // locator: markup hook
    const n = await V.plays(page);
    await page.waitForTimeout(2500);
    expect(await V.plays(page)).toBe(n);
    expect(n).toBeLessThan(4);
  });

  test('VOICE-024 while a Voice answer is read its only control is ■ Stop; the usual controls come after', async ({ page, hub }) => {
    await voiceReading(page, hub, 3);
    const ans = V.answers(page).last();
    await expect(ans.getByRole('button')).toHaveCount(1);
    await expect(ans.getByRole('button')).toHaveText('■ Stop');
    await expect(page.getByRole('button', { name: 'Copy' })).toHaveCount(0);
    await expect(V.voiceRow(page)).toBeHidden({ timeout: 20_000 });
    await expect(V.answers(page).last().getByRole('button', { name: 'Copy' })).toBeVisible();
    await expect(V.lastPlay(page)).toHaveText('▶ Play');
    await expect(page.getByRole('button', { name: 'Try one on this ›' })).toBeVisible();
  });

  test('VOICE-024 pressing ■ Stop under the answer stops the reading', async ({ page, hub }) => {
    await voiceReading(page, hub);
    await V.answers(page).last().getByRole('button', { name: '■ Stop' }).click();
    await expect(V.voiceRow(page)).toBeHidden();
    await expect(V.lastPlay(page)).toHaveText('▶ Play');
    await expect(V.answers(page).last()).toContainText('Long sentence number 10');
  });
});

test.describe('what stops a reading and what does not', () => {
  test('VOICE-025 asking a new question stops the reading; the new answer starts its own', async ({ page, hub }) => {
    await voiceReading(page, hub);
    const p0 = await V.plays(page);
    await V.ask(page, 'something else');
    await expect.poll(async () => (await hub.spoken()).map((r) => r.text)).toContain('A newer answer.');
    await expect(V.voiceRow(page)).toBeHidden({ timeout: 10_000 });
    // the old answer said nothing more: only the new one's single piece was played after the question
    expect(await V.plays(page)).toBe(p0 + 1);
    await expect(V.answers(page).first()).toContainText('Long sentence number 10');
  });

  const triggers: [string, (page: any) => Promise<void>][] = [
    ['dictating', (page) => V.mic(page).click()],
    ['starting a new chat', (page) => page.getByRole('button', { name: 'New chat' }).click()],
    ['starting a practice exercise from the panel', (page) => page.getByRole('button', { name: 'Try one on this ›' }).click()],
    ['closing the tutor panel', (page) => page.getByRole('button', { name: 'Close the tutor' }).click()],
    ['going home', (page) => page.evaluate(() => { location.hash = ''; })],
    ['opening the course page', (page) => page.evaluate(() => { location.hash = '#c=Demo-Course'; })],
  ];
  for (const [what, act] of triggers) {
    test(`VOICE-025 ${what} stops the reading`, async ({ page, hub }) => {
      await hub.script([V.answerRule(V.longAnswer('Long', 10), '^chat:ask$')]);
      await V.countPlays(page);
      await V.slowVoice(page, 1500);
      await V.openDeck(page);
      await V.openTutor(page);
      await V.ask(page, 'q');
      await V.lastPlay(page).click();
      await expect(V.voiceState(page)).toHaveText('Speaking…');
      await act(page);
      await expect(V.voiceRow(page)).toBeHidden();
      const n = await V.plays(page);
      await page.waitForTimeout(2500);
      expect(await V.plays(page)).toBe(n);
      expect(n).toBeLessThan(4);
    });
  }

  const keeps: [string, (page: any) => Promise<void>][] = [
    ['turning the slide', (page) => page.getByRole('button', { name: 'Next slide (→)' }).click()],
    ['opening another deck of the same course', (page) => page.evaluate(() => { location.hash = '#c=Demo-Course&d=HW-1&s=1'; })],
    ['switching the Read view', (page) => page.getByRole('button', { name: 'Read', exact: true }).click()],
  ];
  for (const [what, act] of keeps) {
    test(`VOICE-026 ${what} does not stop the reading`, async ({ page, hub }) => {
      await voiceReading(page, hub);
      const n0 = await V.plays(page);
      await act(page);
      await page.waitForTimeout(300);
      await expect(V.voiceState(page)).toHaveText('Speaking…');
      await expect.poll(() => V.plays(page), { timeout: 10_000 }).toBeGreaterThan(n0 + 1);
      await expect(V.voiceState(page)).toHaveText('Speaking…');
    });
  }
});

test.describe('voice and speed', () => {
  test('VOICE-041 six voices, Heart by default, offered only once the voice is ready', async ({ page, hub }) => {
    let ready = false;
    await page.route('**/api/voice/warm', (route) => (ready ? route.continue() : route.fulfill({
      json: { ready: false, loading: true, error: null, downloaded: true, voices: {}, default_voice: 'af_heart' } })));
    await hub.script([V.answerRule(V.longAnswer('Pick', 4))]);
    await V.slowVoice(page, 1500);
    await V.openDeck(page);
    await V.openTutor(page);
    await V.ask(page, 'q');
    await V.lastPlay(page).click();
    await expect(V.voiceState(page)).toHaveText('Speaking…');
    await expect(V.voicePick(page)).toBeHidden();
    await V.rowStop(page).click();
    ready = true;
    await page.waitForTimeout(2200); // (the page checks again every ~2 s)
    await V.lastPlay(page).click();
    await expect(V.voicePick(page)).toBeVisible();
    await expect(V.voicePick(page).locator('option')).toHaveText([
      'Heart (US, female)', 'Bella (US, female)', 'Michael (US, male)', 'Fenrir (US, male)', 'Emma (UK, female)', 'George (UK, male)']);
    await expect(V.voicePick(page).locator('option:checked')).toHaveText('Heart (US, female)');
  });

  test('VOICE-042 speeds 0.85× to 1.35×, 1× by default', async ({ page, hub }) => {
    await voiceReading(page, hub, 3);
    await expect(V.speedPick(page).locator('option')).toHaveText(['0.85×', '1×', '1.1×', '1.2×', '1.35×']);
    await expect(V.speedPick(page).locator('option:checked')).toHaveText('1×');
    expect((await hub.spoken())[0].speed).toBe(1);
  });

  test('VOICE-041 VOICE-042 VOICE-043 VOICE-093 a change applies from the next piece, and is remembered on this browser', async ({ page, hub }) => {
    await hub.script([V.answerRule(V.longAnswer('Long', 8), '^chat:ask$')]);
    await V.slowVoice(page, 1500, 0, 1200); // (pieces reach the hub one at a time, ~1.2 s apart)
    await V.openVoiceReady(page);
    await V.ask(page, 'q');
    await expect(V.voiceState(page)).toHaveText('Speaking…');
    await V.voicePick(page).selectOption({ label: 'George (UK, male)' });
    await V.speedPick(page).selectOption({ label: '1.2×' });
    await expect.poll(async () => (await hub.spoken()).at(-1)?.voice, { timeout: 10_000 }).toBe('bm_george');
    const rows = await hub.spoken();
    expect(rows[0].voice).not.toBe('bm_george');
    expect(rows[0].speed).toBe(1);
    // once changed, every later piece uses the new voice and speed (nothing restarted: no piece said twice)
    const kv = rows.findIndex((r) => r.voice === 'bm_george');
    expect(rows.slice(kv).every((r) => r.voice === 'bm_george')).toBe(true);
    await expect.poll(async () => (await hub.spoken()).at(-1)?.speed, { timeout: 10_000 }).toBe(1.2);
    const rows2 = await hub.spoken();
    const ks = rows2.findIndex((r) => r.speed === 1.2);
    expect(ks).toBeGreaterThan(0);
    expect(rows2.slice(ks).every((r) => r.speed === 1.2)).toBe(true);
    expect(new Set(rows2.map((r) => r.text)).size).toBe(rows2.length);
    await V.rowStop(page).click();
    // remembered: after a reload, a new reading uses them and the pickers show them
    await page.reload();
    await V.openTutor(page);
    const before = (await hub.spoken()).length;
    await V.lastPlay(page).click();
    await expect(V.voicePick(page).locator('option:checked')).toHaveText('George (UK, male)');
    await expect(V.speedPick(page).locator('option:checked')).toHaveText('1.2×');
    await expect.poll(async () => (await hub.spoken()).length).toBeGreaterThan(before);
    expect((await hub.spoken())[before]).toMatchObject({ voice: 'bm_george', speed: 1.2 });
  });

  test('VOICE-044 pinned as-is: the voice and speed pickers are only reachable while an answer is being read', async ({ page, hub }) => {
    // Pinned as-is (spec: "Current behaviour, recorded as found"): there is no way to choose before hearing an answer.
    await hub.script([V.answerRule('Short.')]);
    await V.openVoiceReady(page);
    await expect(V.voicePick(page)).toBeHidden();
    await expect(V.speedPick(page)).toBeHidden();
    await V.ask(page, 'q');
    await expect(V.lastPlay(page)).toHaveText('▶ Play', { timeout: 15_000 });
    await expect(V.voicePick(page)).toBeHidden();
    await expect(V.speedPick(page)).toBeHidden();
  });
});

test.describe('read-aloud failures', () => {
  test('VOICE-046 the voice failing mid-answer: reading stops, the answer shows whole, "Voice isn\'t available" once; voice then off', async ({ page, hub }) => {
    await hub.script([V.answerRule(V.longAnswer('Fail', 4), '^chat:ask$', 1), V.answerRule('Next answer.', '^chat:ask$')]);
    let n = 0;
    await page.route('**/api/voice/speak', async (route) => {
      if (++n >= 2) return route.fulfill({ status: 503, json: { error: 'The voice failed.' } });
      const res = await route.fetch();
      await route.fulfill({ status: 200, contentType: 'audio/wav', body: V.silentWav(1500) });
    });
    await V.openVoiceReady(page);
    await V.ask(page, 'q');
    await expect(V.toast(page, "Voice isn't available; showing the answer without it.")).toBeVisible({ timeout: 10_000 });
    await expect(V.voiceRow(page)).toBeHidden();
    await expect(V.answers(page).last()).toContainText('Fail sentence number 4');
    await expect(V.toast(page, "Voice isn't available")).toHaveCount(0, { timeout: 5000 });
    const sent = n;
    await V.ask(page, 'again');
    await expect(V.answers(page).last()).toContainText('Next answer.');
    await page.waitForTimeout(600);
    await expect(V.toast(page, "Voice isn't available")).toHaveCount(0);
    expect(n).toBe(sent);
  });

  test('VOICE-048 VOICE-022 the browser refusing to play: the answer shows whole and the row says the voice was blocked, without Stop', async ({ page, hub }) => {
    await page.addInitScript(() => {
      HTMLMediaElement.prototype.play = function () { return Promise.reject(new DOMException('blocked', 'NotAllowedError')); };
    });
    await hub.script([V.answerRule(THREE, '^chat:ask$')]);
    await V.openVoiceReady(page);
    await V.ask(page, 'q');
    await expect(V.voiceState(page)).toHaveText("The browser blocked the voice: tap ▶ Play under the answer (once it's written) to hear it.");
    await expect(V.rowStop(page)).toBeHidden();
    await expect(V.answers(page).last()).toContainText(S3);
    await page.waitForTimeout(500);
    await expect(V.voiceRow(page)).toBeVisible();
  });

  test('VOICE-049 an answer that fails to arrive ends its reading and shows the error in its place', async ({ page, hub }) => {
    await hub.script([{ match: { label: '^chat:ask$' }, reply: { error: 'The tutor fell over.' } }]);
    await V.openVoiceReady(page);
    await V.ask(page, 'q');
    await expect(V.thread(page)).toContainText('The tutor fell over.');
    await expect(V.voiceRow(page)).toBeHidden();
    expect(await hub.spoken()).toHaveLength(0);
  });

  test('VOICE-050 the saved answer differing from what streamed: it shows whole at once, the reading carries on to its end', async ({ page, hub }) => {
    const streamed = V.longAnswer('Streamed', 3);
    await hub.script([{ match: { label: '^chat:ask$' }, reply: {
      // (a last blank piece, so all of the text has reached the page before the answer ends)
      chunks: [...streamed.split(/(?<=\n\n)/), ' '], chunk_delay_ms: 300, text: 'The saved answer SAVED-WHOLE is not what streamed in.' } }]);
    await V.countPlays(page);
    await V.slowVoice(page, 2000);
    await V.openVoiceReady(page);
    await V.ask(page, 'q');
    await expect(V.voiceState(page)).toHaveText('Speaking…');
    // all of the answer shows while the first pieces are still being read (not in step with the voice)
    await expect(V.answers(page).last()).toContainText('SAVED-WHOLE');
    await expect(V.voiceState(page)).toHaveText('Speaking…');
    expect(await V.plays(page)).toBeLessThan(3);
    // the reading isn't stopped: it goes on through the rest of what streamed in (pinned as-is: what it reads is the
    // streamed text, not the saved one)
    await expect(V.voiceRow(page)).toBeHidden({ timeout: 20_000 });
    await expect.poll(() => V.spokenText(hub)).toContain('Streamed sentence number 3');
    expect(await V.spokenText(hub)).not.toContain('SAVED-WHOLE');
    await expect(V.answers(page).last()).toContainText('SAVED-WHOLE');
    await expect(V.answers(page).last()).not.toContainText('Streamed sentence');
  });

  test('VOICE-051 an empty piece (only a drawing) is never sent for speech', async ({ page, hub }) => {
    const bodies: any[] = [];
    page.on('request', (r) => { if (r.url().includes('/api/voice/speak')) bodies.push(r.postDataJSON()); });
    const bad: number[] = [];
    page.on('response', (r) => { if (r.url().includes('/api/voice/speak') && !r.ok()) bad.push(r.status()); });
    const text = [
      '```svg',
      '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="50" height="50"/></svg>',
      '```',
      '',
      'After the drawing comes this sentence.',
    ].join('\n');
    await hub.script([V.answerRule(text, '^chat:ask$')]);
    await V.openVoiceReady(page);
    await V.ask(page, 'q');
    await expect.poll(async () => V.spokenText(hub)).toContain('After the drawing comes this sentence.');
    await expect(V.voiceRow(page)).toBeHidden({ timeout: 10_000 });
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(String(b.text).trim()).not.toBe('');
    expect(bad).toHaveLength(0);
  });
});
