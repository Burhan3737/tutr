/**
 * 04 Voice — dictation into the Ask box: the mic button, its states, where the words go, errors, the Space and
 * Ctrl+Space shortcuts, and when recording is not possible.
 * Spec: docs/functional-spec/04-voice.md §8, §11 (VOICE-052..066, 077..079).
 *
 * The browser records from Chromium's fake microphone; the hub's speech-to-text double answers from the script
 * (label "stt"), both for the streamed dictation and for the whole-recording fallback.
 *
 * Partly covered: VOICE-053 (the browser's permission prompt is [real-device]; the harness grants the mic),
 *   VOICE-061 (an unplugged mic is simulated by firing the track's "ended" event), VOICE-077 (an insecure page —
 *   a plain Wi-Fi address — is not reproducible here; "no recording support" is simulated by removing the browser's
 *   AudioWorkletNode / mediaDevices).
 * Not covered: VOICE-064 "if no Ask box with a mic is on screen, the tutor panel is opened first" (only happens in
 *   the practice focus mode, owned by the practice specs).
 */
import { test, expect } from '../../fixtures/hub';
import * as V from './helpers';

const IDLE_TITLE = 'Dictate: speak your question, then edit it before sending (hold Space, or Ctrl+Space)';
const HEARD = 'what is elasticity';
const stt = (text = HEARD) => ({ match: { label: '^stt$' }, reply: { text } });

async function panel(page: any, hub: any, rules: any[] = [stt()]) {
  await hub.script(rules);
  await V.openDeck(page);
  await V.openTutor(page);
}

test.describe('the mic button', () => {
  test('VOICE-052 a "Dictate" mic button sits by the Ask box, in the ask bar and in the open panel', async ({ page }) => {
    await V.openDeck(page);
    await expect(V.mic(page)).toBeVisible();
    await expect(V.mic(page)).toHaveText('🎙');
    await expect(V.mic(page)).toHaveAttribute('title', IDLE_TITLE);
    await V.openTutor(page);
    await expect(V.mic(page)).toBeVisible();
    await expect(V.mic(page)).toHaveAttribute('title', IDLE_TITLE);
    await expect(V.mic(page)).toHaveAttribute('aria-pressed', 'false');
  });

  test('VOICE-053 tapping starts listening: ■, pressed, box read-only with the listening hint; the hub session opens for this slide', async ({ page, hub }) => {
    await panel(page, hub);
    const start = page.waitForRequest((r) => r.url().includes('/api/voice/dictate/start'));
    await V.mic(page).click();
    expect((await start).postDataJSON()).toMatchObject({ course: 'Demo-Course', tag: 'S&D-1', n: 1, scope: 'slide' });
    await expect(V.mic(page)).toHaveText('■');
    await expect(V.mic(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(V.mic(page)).toHaveClass(/\bon\b/); // locator: markup hook (the "recording" look)
    await expect(V.mic(page)).toHaveAttribute('title', 'Stop and type out what you said (Ctrl+Space)');
    await expect(V.askBox(page)).toHaveAttribute('readonly', '');
    await expect(V.askBox(page)).toHaveAttribute('placeholder', 'Listening… tap ■ or Ctrl+Space to stop');
  });

  test('VOICE-054 tapping again: "…", disabled, "Writing down what you said…" until the words are ready', async ({ page, hub }) => {
    await panel(page, hub);
    await page.route('**/api/voice/dictate/finish', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await V.dictate(page, 300);
    await expect(V.mic(page)).toHaveText('…');
    await expect(V.mic(page)).toBeDisabled();
    await expect(V.mic(page)).toHaveAttribute('title', 'Writing down what you said…');
    await expect(V.askBox(page)).toHaveAttribute('placeholder', 'Writing down what you said…');
    await expect(V.askBox(page)).toHaveAttribute('readonly', '');
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue(HEARD);
    await expect(V.askBox(page)).not.toHaveAttribute('readonly', '');
  });

  test('VOICE-055 the words go in at the cursor with spaces, focused and caret after; nothing is sent', async ({ page, hub }) => {
    await panel(page, hub);
    const tutor = V.recordRequests(page, '/api/tutor');
    await V.askBox(page).fill('Hello world');
    await V.askBox(page).evaluate((ta: HTMLTextAreaElement) => ta.setSelectionRange(5, 5));
    await V.dictate(page);
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue(`Hello ${HEARD} world`);
    await expect(V.askBox(page)).toBeFocused();
    const caret = await V.askBox(page).evaluate((ta: HTMLTextAreaElement) => [ta.selectionStart, ta.selectionEnd]);
    expect(caret).toEqual([`Hello ${HEARD}`.length, `Hello ${HEARD}`.length]);
    await page.waitForTimeout(500);
    expect(tutor).toHaveLength(0);
    await expect(V.questions(page)).toHaveCount(0);
  });

  test('VOICE-055 dictating over a selection replaces it', async ({ page, hub }) => {
    await panel(page, hub);
    await V.askBox(page).fill('Hello world');
    await V.askBox(page).evaluate((ta: HTMLTextAreaElement) => ta.setSelectionRange(6, 11));
    await V.dictate(page);
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue(`Hello ${HEARD}`);
  });

  test('VOICE-056 nothing heard: the box goes back and "Didn\'t catch that" is shown', async ({ page, hub }) => {
    await panel(page, hub, [stt('')]);
    await V.askBox(page).fill('keep me');
    await V.dictate(page);
    await expect(V.toast(page, "Didn't catch that. Tap 🎙 and try again.")).toBeVisible();
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue('keep me');
  });

  test('VOICE-057 an error while writing down shows the hub\'s message and leaves the box as it was', async ({ page, hub }) => {
    await panel(page, hub, [{ match: { label: '^stt$' }, reply: { error: 'The recording was empty or damaged. Try again.', error_status: 400 } }]);
    await V.askBox(page).fill('keep me');
    await V.dictate(page);
    await expect(V.toast(page, 'The recording was empty or damaged. Try again.')).toBeVisible({ timeout: 15_000 });
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue('keep me');
  });

  test('VOICE-057 the hub not answering: "The hub isn\'t responding…"', async ({ page, hub }) => {
    await panel(page, hub);
    await page.route('**/api/voice/dictate/start', (route) => route.fulfill({ status: 503, json: { error: 'x' } }));
    await page.route('**/api/voice/transcribe', (route) => route.abort());
    await V.askBox(page).fill('keep me');
    await V.mic(page).click();
    await expect(V.mic(page)).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(1200);
    await V.mic(page).click();
    await expect(V.toast(page, "The hub isn't responding. Start it again with start.bat, then retry.")).toBeVisible({ timeout: 15_000 });
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue('keep me');
  });

  test('VOICE-058 recognition is primed with the deck and slide titles (the deck\'s slide titles for Whole deck)', async ({ page, hub }) => {
    await hub.script([stt()]);
    await V.openDeck(page, '/#c=Demo-Course&d=S%26D-1&s=2');
    await V.openTutor(page);
    await V.dictate(page);
    await V.micIdle(page);
    const [first] = await hub.calls('^stt$');
    expect(first.prompt).toMatch(/^Supply and demand 1\. Demand and supply curves/);
    await V.askBox(page).fill('');
    await page.getByRole('radiogroup', { name: 'Work on' }).getByRole('radio', { name: 'Whole deck' }).click();
    await V.dictate(page);
    await V.micIdle(page);
    const calls = await hub.calls('^stt$');
    expect(calls.at(-1)!.prompt).toMatch(/^Demand and supply curves\. Price elasticity\. Supply and demand 1/);
  });

  test('VOICE-059 tapping ■ before the microphone has started cancels quietly', async ({ page, hub }) => {
    await page.addInitScript(() => {
      const md = navigator.mediaDevices;
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = (c?: MediaStreamConstraints) => new Promise((res, rej) => setTimeout(() => orig(c).then(res, rej), 1500));
    });
    await panel(page, hub);
    const cancels = V.recordRequests(page, '/api/voice/dictate/cancel');
    const finishes = V.recordRequests(page, '/api/voice/dictate/finish');
    const transcribes = V.recordRequests(page, '/api/voice/transcribe');
    await V.askBox(page).fill('keep me');
    await V.mic(page).click();
    await expect(V.mic(page)).toHaveAttribute('aria-pressed', 'true');
    await V.mic(page).click();
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue('keep me');
    await expect.poll(() => cancels.length).toBe(1);
    await page.waitForTimeout(2000);
    await expect(page.locator('.toast')).toHaveCount(0); // locator: markup hook
    expect(finishes).toHaveLength(0);
    expect(transcribes).toHaveLength(0);
    expect(await hub.calls('^stt$')).toHaveLength(0);
    await expect(V.mic(page)).toHaveText('🎙');
  });

  test('VOICE-060 a recording stops by itself after 2 minutes and is written down', async ({ page, hub }) => {
    await page.clock.install();
    await panel(page, hub);
    const chunk = page.waitForRequest((r) => r.url().includes('/api/voice/dictate/chunk'));
    await V.mic(page).click();
    await chunk;
    await page.clock.fastForward(119_000);
    await expect(V.mic(page)).toHaveAttribute('aria-pressed', 'true');
    await page.clock.fastForward(1_500);
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue(HEARD);
  });

  test('VOICE-061 the microphone stopping during recording is treated as Stop', async ({ page, hub }) => {
    await V.exposeMicStream(page);
    await panel(page, hub);
    const chunk = page.waitForRequest((r) => r.url().includes('/api/voice/dictate/chunk'));
    await V.mic(page).click();
    await chunk;
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__stream.getAudioTracks()[0].dispatchEvent(new Event('ended')));
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue(HEARD);
  });

  test('VOICE-062 sending while listening sends the box as it is and drops the recording', async ({ page, hub }) => {
    await panel(page, hub, [stt(), V.answerRule('Answer.', '^chat:')]);
    const cancels = V.recordRequests(page, '/api/voice/dictate/cancel');
    await V.askBox(page).fill('typed words');
    const chunk = page.waitForRequest((r) => r.url().includes('/api/voice/dictate/chunk'));
    await V.mic(page).click();
    await chunk;
    const sent = page.waitForRequest((r) => r.url().includes('/api/tutor'));
    await V.askButton(page).click();
    expect((await sent).postDataJSON().question).toBe('typed words');
    await V.micIdle(page);
    await expect.poll(() => cancels.length).toBe(1);
    await expect(V.questions(page).last()).toContainText('typed words');
    await page.waitForTimeout(1500);
    expect(await hub.calls('^stt$')).toHaveLength(0);
    await expect(V.askBox(page)).toHaveValue('');
  });
});

test.describe('Space and Ctrl+Space', () => {
  const blur = (page: any) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  test('VOICE-063 holding Space outside a text field dictates; letting go writes the words down', async ({ page, hub }) => {
    await panel(page, hub);
    await blur(page);
    const chunk = page.waitForRequest((r) => r.url().includes('/api/voice/dictate/chunk'));
    await page.keyboard.down(' ');
    await expect(V.mic(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(V.askBox(page)).toHaveAttribute('placeholder', 'Listening… let go of Space to stop');
    await chunk;
    await page.waitForTimeout(500);
    await page.keyboard.up(' ');
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue(HEARD);
  });

  test('VOICE-063 a quick Space tap keeps its normal effect (presses the focused button) and does not dictate', async ({ page, hub }) => {
    await panel(page, hub);
    const starts = V.recordRequests(page, '/api/voice/dictate/start');
    await V.voiceRadio(page).focus();
    await page.keyboard.press(' ');
    await expect(V.voiceRadio(page)).toHaveAttribute('aria-checked', 'true');
    await page.waitForTimeout(500);
    expect(starts).toHaveLength(0);
    await expect(V.mic(page)).toHaveText('🎙');
  });

  test('VOICE-063 in the Ask box a press types a space; holding it takes the space back and dictates', async ({ page, hub }) => {
    await panel(page, hub);
    const starts = V.recordRequests(page, '/api/voice/dictate/start');
    await V.askBox(page).fill('Hi');
    await V.askBox(page).press('End');
    await page.keyboard.press(' ');
    await expect(V.askBox(page)).toHaveValue('Hi ');
    expect(starts).toHaveLength(0);
    await V.askBox(page).fill('Hi');
    await V.askBox(page).press('End');
    const chunk = page.waitForRequest((r) => r.url().includes('/api/voice/dictate/chunk'));
    await page.keyboard.down(' ');
    await page.keyboard.down(' '); // (held: the key repeats)
    await expect(V.mic(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(V.askBox(page)).toHaveValue('Hi');
    await chunk;
    await page.waitForTimeout(500);
    await page.keyboard.up(' ');
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue(`Hi ${HEARD}`);
  });

  test('VOICE-063 in other text fields Space just types', async ({ page, hub }) => {
    await panel(page, hub);
    const starts = V.recordRequests(page, '/api/voice/dictate/start');
    await page.getByRole('button', { name: 'Search all slides (Ctrl K)' }).click();
    const search = page.getByRole('searchbox', { name: 'Search all slides' });
    await expect(search).toBeFocused();
    await page.keyboard.type('a');
    await page.keyboard.down(' ');
    await page.waitForTimeout(500);
    await page.keyboard.up(' ');
    await page.keyboard.type('b');
    await expect(search).toHaveValue('a b');
    expect(starts).toHaveLength(0);
  });

  test('VOICE-063 while listening after a tap on the mic, a Space press stops it', async ({ page, hub }) => {
    await panel(page, hub);
    const chunk = page.waitForRequest((r) => r.url().includes('/api/voice/dictate/chunk'));
    await V.mic(page).click();
    await chunk;
    await page.waitForTimeout(500);
    await page.keyboard.press(' ');
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue(HEARD);
  });

  test('VOICE-063 with the tutor closed, holding Space dictates into the ask bar', async ({ page, hub }) => {
    await hub.script([stt()]);
    await V.openDeck(page);
    await blur(page);
    const chunk = page.waitForRequest((r) => r.url().includes('/api/voice/dictate/chunk'));
    await page.keyboard.down(' ');
    await expect(V.mic(page)).toHaveAttribute('aria-pressed', 'true');
    await chunk;
    await page.waitForTimeout(500);
    await page.keyboard.up(' ');
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue(HEARD);
    await expect(page.getByRole('button', { name: 'Open the tutor' })).toBeVisible();
  });

  test('VOICE-064 Ctrl+Space (even inside the Ask box): a press starts, a second press stops', async ({ page, hub }) => {
    await panel(page, hub);
    await V.askBox(page).focus();
    const chunk = page.waitForRequest((r) => r.url().includes('/api/voice/dictate/chunk'));
    await page.keyboard.press('Control+Space');
    await expect(V.mic(page)).toHaveAttribute('aria-pressed', 'true');
    await chunk;
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+Space');
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue(HEARD);
  });

  test('VOICE-064 holding Ctrl+Space and letting go stops on release', async ({ page, hub }) => {
    await panel(page, hub);
    await blur(page);
    const chunk = page.waitForRequest((r) => r.url().includes('/api/voice/dictate/chunk'));
    await page.keyboard.down('Control');
    await page.keyboard.down(' ');
    await expect(V.mic(page)).toHaveAttribute('aria-pressed', 'true');
    await chunk;
    await page.waitForTimeout(600);
    await page.keyboard.up(' ');
    await page.keyboard.up('Control');
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue(HEARD);
  });

  test('VOICE-064 with the tutor closed, Ctrl+Space dictates into the ask bar', async ({ page, hub }) => {
    await hub.script([stt()]);
    await V.openDeck(page);
    const chunk = page.waitForRequest((r) => r.url().includes('/api/voice/dictate/chunk'));
    await page.keyboard.press('Control+Space');
    await expect(V.mic(page)).toHaveAttribute('aria-pressed', 'true');
    await chunk;
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+Space');
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue(HEARD);
  });

  test('VOICE-065 without a deck open, Space and Ctrl+Space do nothing voice-related', async ({ page }) => {
    const starts = V.recordRequests(page, '/api/voice/dictate/start');
    await page.goto('/#c=Demo-Course');
    await expect(page.locator('main')).toContainText('Supply and demand 1');
    await page.keyboard.down(' ');
    await page.waitForTimeout(600);
    await page.keyboard.up(' ');
    await page.keyboard.press('Control+Space');
    await page.waitForTimeout(500);
    expect(starts).toHaveLength(0);
  });

  test('VOICE-065 VOICE-077 without recording support there is no mic and no shortcut', async ({ page, hub }) => {
    await page.addInitScript(() => { delete (window as any).AudioWorkletNode; });
    await hub.script([V.answerRule('Still answers.')]);
    const starts = V.recordRequests(page, '/api/voice/dictate/start');
    await V.openDeck(page);
    await expect(V.askBox(page)).toBeVisible();
    await expect(V.mic(page)).toHaveCount(0);
    await page.keyboard.press('Control+Space');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.down(' ');
    await page.waitForTimeout(600);
    await page.keyboard.up(' ');
    await V.openTutor(page);
    await expect(V.mic(page)).toHaveCount(0);
    expect(starts).toHaveLength(0);
    // everything else works
    await V.ask(page, 'q');
    await expect(V.answers(page).last()).toContainText('Still answers.');
  });

  test('VOICE-077 with no microphone API the mic is absent', async ({ page }) => {
    await page.addInitScript(() => { Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }); });
    await V.openDeck(page);
    await expect(V.askBox(page)).toBeVisible();
    await expect(V.mic(page)).toHaveCount(0);
  });

  test('VOICE-066 a redraw mid-dictation keeps the listening state and the box', async ({ page, hub }) => {
    await panel(page, hub);
    await V.askBox(page).fill('before');
    await V.askBox(page).press('End');
    const chunk = page.waitForRequest((r) => r.url().includes('/api/voice/dictate/chunk'));
    await V.mic(page).click();
    await chunk;
    await page.getByRole('radiogroup', { name: 'Work on' }).getByRole('radio', { name: 'Whole deck' }).click(); // redraws the panel
    await expect(V.askBox(page)).toHaveValue('before');
    await expect(V.askBox(page)).toHaveAttribute('readonly', '');
    await expect(V.askBox(page)).toHaveAttribute('placeholder', 'Listening… tap ■ or Ctrl+Space to stop');
    await expect(V.mic(page)).toHaveText('■');
    await expect(V.mic(page)).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Read', exact: true }).click(); // and again
    await expect(V.mic(page)).toHaveText('■');
    await V.mic(page).click();
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue(`before ${HEARD}`);
  });
});

test.describe('when recording is not possible', () => {
  test('VOICE-078 the microphone refused: cancelled, box restored, "The microphone is blocked"', async ({ page, hub }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
    });
    await panel(page, hub);
    await V.askBox(page).fill('keep me');
    await V.mic(page).click();
    await expect(V.toast(page, 'The microphone is blocked: allow it from the site settings.')).toBeVisible();
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue('keep me');
    await expect(V.askBox(page)).not.toHaveAttribute('readonly', '');
  });

  test('VOICE-079 recording cannot be set up: "This browser couldn\'t start recording"', async ({ page, hub }) => {
    // the audio-processing module fails to load
    await page.addInitScript(() => { AudioWorklet.prototype.addModule = () => Promise.reject(new DOMException('failed', 'AbortError')); });
    await panel(page, hub);
    await V.askBox(page).fill('keep me');
    await V.mic(page).click();
    await expect(V.toast(page, "This browser couldn't start recording. Try Chrome or Edge.")).toBeVisible();
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue('keep me');
  });
});
