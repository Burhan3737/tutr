/**
 * Shared helpers for the 04 Voice specs (docs/functional-spec/04-voice.md).
 * Black-box: they drive the page, intercept its HTTP requests (page.route) and read the hub's work files.
 */
import { Page, Request, Locator, expect } from '@playwright/test';
import type { Hub } from '../../fixtures/hub';

export const DECK = '/#c=Demo-Course&d=S%26D-1&s=1';
export const DECK2 = '/#c=Demo-Course&d=HW-1&s=1';

/** Open the demo deck (tutor closed: the ask bar is under the slide). */
export async function openDeck(page: Page, url = DECK) {
  await page.goto(url);
  await expect(page.locator('main')).toContainText(/\d+ \/ \d+/);
}

/** Start the page with a given Text/Voice choice (as remembered on this browser). */
export async function rememberView(page: Page, view: 'text' | 'voice' | string) {
  await page.addInitScript((v) => {
    if (!sessionStorage.getItem('__seeded_view')) {
      localStorage.setItem('view', JSON.stringify(v));
      sessionStorage.setItem('__seeded_view', '1');
    }
  }, view);
}

export const answersSwitch = (page: Page) => page.getByRole('radiogroup', { name: 'Answers' });
export const textRadio = (page: Page) => answersSwitch(page).getByRole('radio', { name: 'Text' });
export const voiceRadio = (page: Page) => answersSwitch(page).getByRole('radio', { name: 'Voice' });
export const askBox = (page: Page) => page.locator('#ask-input'); // locator: markup hook (the Ask box's label is its changing placeholder)
export const askButton = (page: Page) => page.getByRole('button', { name: 'Ask', exact: true });
export const mic = (page: Page) => page.getByRole('button', { name: 'Dictate' });
export const voiceRow = (page: Page) => page.locator('#voice-row'); // locator: markup hook
export const voiceState = (page: Page) => page.locator('#voice-state'); // locator: markup hook
export const rowStop = (page: Page) => voiceRow(page).getByRole('button', { name: '■ Stop' });
export const voicePick = (page: Page) => page.getByRole('combobox', { name: 'Voice' });
export const speedPick = (page: Page) => page.getByRole('combobox', { name: 'Speed' });
export const thread = (page: Page) => page.locator('#thread'); // locator: markup hook
export const questions = (page: Page) => page.locator('#thread .msg-q'); // locator: markup hook
export const answers = (page: Page) => page.locator('#thread .ans'); // locator: markup hook
export const playButtons = (page: Page) => page.getByRole('button', { name: /^(▶ Play|■ Stop)$/ }).and(page.locator('#thread *'));
export const toast = (page: Page, text: string | RegExp) => page.locator('.toast').filter({ hasText: text }); // locator: markup hook

/** Open the tutor panel from the ask bar. */
export async function openTutor(page: Page) {
  await page.getByRole('button', { name: 'Open the tutor' }).click();
  await expect(answersSwitch(page)).toBeVisible();
}

/**
 * Open the deck with the tutor panel open in Voice mode, and wait until the page has heard from the hub that the voice
 * is ready (the warm-up request answered).
 */
export async function openVoiceReady(page: Page, url = DECK) {
  await rememberView(page, 'voice');
  await openDeck(page, url);
  const warmed = page.waitForResponse((r) => r.url().includes('/api/voice/warm'));
  await openTutor(page);
  await warmed;
  await expect(voiceRadio(page)).toHaveAttribute('aria-checked', 'true');
  // (the page applies the warm-up answer right after the response)
  await page.waitForTimeout(150);
}

/** A silent mono 16-bit WAV of `ms` milliseconds. */
export function silentWav(ms: number, rate = 8000): Buffer {
  const n = Math.round((rate * ms) / 1000);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  return b;
}

/**
 * Make every sentence the voice says last `ms` (the hub's double returns 0.2 s of silence), so a reading can be watched
 * while it is in progress. The request still goes to the hub (and is logged there); only the audio is lengthened.
 * `delayMs` holds each answer back that long first (to watch "Getting the voice ready…"); `holdMs` holds each request
 * back before it reaches the hub (the page prepares pieces ahead: this paces how far ahead it gets).
 */
export async function slowVoice(page: Page, ms = 1500, delayMs = 0, holdMs = 0) {
  await page.route('**/api/voice/speak', async (route) => {
    if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
    const res = await route.fetch().catch(() => null);
    if (!res) return route.abort().catch(() => {});
    if (!res.ok()) return route.fulfill({ response: res });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav(ms) }).catch(() => {});
  });
}

/** Every request the page made to an endpoint, recorded from now on. */
export function recordRequests(page: Page, part: string) {
  const out: Request[] = [];
  page.on('request', (r) => { if (r.url().includes(part)) out.push(r); });
  return out;
}

/** Ask a question through the Ask box (typed). */
export async function ask(page: Page, question: string) {
  await askBox(page).fill(question);
  await askBox(page).press('Enter');
}

/** Wait for the hub to have spoken at least n sentences; returns them. */
export async function spokenAtLeast(hub: Hub, n: number) {
  let rows: Awaited<ReturnType<Hub['spoken']>> = [];
  await expect.poll(async () => (rows = await hub.spoken()).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(n);
  return rows;
}

/** All the text sent for speech so far, joined. */
export async function spokenText(hub: Hub) {
  return (await hub.spoken()).map((r) => r.text).join(' ');
}

/** The newest finished answer's ▶ Play control. */
export const lastPlay = (page: Page): Locator => answers(page).last().getByRole('button', { name: /^(▶ Play|■ Stop)$/ });

/** Dictation: tap the mic, wait until it is really listening (the mic started and audio reaches the hub), tap again. */
export async function dictate(page: Page, listenMs = 1200) {
  const chunk = page.waitForRequest((r) => r.url().includes('/api/voice/dictate/chunk'), { timeout: 10_000 });
  await mic(page).click();
  await expect(mic(page)).toHaveAttribute('aria-pressed', 'true');
  await chunk;
  if (listenMs) await page.waitForTimeout(listenMs);
  await mic(page).click();
}

/** Wait until the mic is idle again (🎙, not pressed, enabled). */
export async function micIdle(page: Page) {
  await expect(mic(page)).toHaveText('🎙', { timeout: 20_000 });
  await expect(mic(page)).toHaveAttribute('aria-pressed', 'false');
}

/** Wrap getUserMedia so a test can get at the microphone stream (window.__stream). */
export async function exposeMicStream(page: Page) {
  await page.addInitScript(() => {
    const md = navigator.mediaDevices;
    if (!md) return;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      const s = await orig(c);
      (window as any).__stream = s;
      return s;
    };
  });
}

/** A one-answer script for the tutor (any chat mode). */
export const answerRule = (text: string, label = '^chat:', times?: number) => ({ match: { label }, reply: { text }, ...(times ? { times } : {}) });

/** An answer of n long sentences, one per paragraph (each over 140 characters, so each is read as its own piece). */
export function longAnswer(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) =>
    `${prefix} sentence number ${i + 1} talks at some length about supply and demand, prices and quantities, so that it is read as a piece of its own.`).join('\n\n');
}

/**
 * Count the pieces of speech the page actually starts playing (window.__plays), as opposed to the pieces it asks the
 * hub to synthesise (it prepares them ahead). Only audio longer than the page's own "unlock" silence counts: use with
 * slowVoice(). Must be called before the page loads.
 */
export async function countPlays(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__plays = 0;
    w.__speech = new Set<string>();
    const mk = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (o: any) => { const u = mk(o); if (o && o.size > 5000) w.__speech.add(u); return u; };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { if (w.__speech.has(this.src)) w.__plays++; return play.call(this); };
  });
}
export const plays = (page: Page) => page.evaluate(() => (window as any).__plays as number);
