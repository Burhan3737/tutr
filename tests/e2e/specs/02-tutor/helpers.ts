/**
 * Shared helpers for the 02-tutor specs (docs/functional-spec/02-tutor-and-chats.md): opening a slide with the tutor,
 * asking, waiting for an answer to settle, reading the course's chats / drafts / memory on disk, and two "devices"
 * (browser contexts) on one hub.
 *
 * Seeding writes files in the library format (docs/library-format.md), which is part of the product contract.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { Hub, REPO, Rule, expect } from '../../fixtures/hub';

export const DEMO = 'Demo-Course';
export const SD1 = '#c=Demo-Course&d=S%26D-1';
export const SD1_S2 = `${SD1}&s=2`;
export const HW1 = '#c=Demo-Course&d=HW-1&s=1';
/** How the prompt names slide 2 of S&D-1. */
export const S2_REF = '[S&D-1 s2] "Demand and supply curves"';

// ------------------------------------------------------------ locators

export const askBox = (page: Page) => page.locator('#ask-input');             // locator: markup hook (label = changing placeholder)
export const askButton = (page: Page) => page.getByRole('button', { name: 'Ask', exact: true }).first();
export const thread = (page: Page) => page.locator('#thread');                // locator: markup hook
export const questions = (page: Page) => page.locator('#thread .msg-q');      // locator: markup hook
export const answers = (page: Page) => page.locator('#thread .ans');          // locator: markup hook
export const waiting = (page: Page) => page.locator('#thread .waiting');      // locator: markup hook
export const errors = (page: Page) => page.locator('#thread p.err');          // locator: markup hook
export const feet = (page: Page) => page.locator('#thread .msg-foot');        // locator: markup hook
export const chatBar = (page: Page) => page.locator('#thread .chat-bar');     // locator: markup hook
export const sideSheets = (page: Page) => page.locator('section.side-sheet'); // locator: markup hook
export const tray = (page: Page) => page.locator('#ask-photos');              // locator: markup hook
export const toast = (page: Page, text: string | RegExp) => page.locator('.toast').filter({ hasText: text }); // locator: markup hook
export const panel = (page: Page) => page.locator('#tutor');                  // locator: markup hook

// ------------------------------------------------------------ driving

/** Open a slide (default S&D-1 slide 2) and wait for it. */
export async function openSlide(page: Page, hash = SD1_S2) {
  await page.goto('/' + hash);
  await expect(page.locator('#counter')).toHaveText(/\d+ \/ \d+/);      // locator: markup hook (slide counter)
  await expect(askBox(page)).toBeVisible();
}

/** Open the tutor panel from the ask bar. */
export async function openTutor(page: Page) {
  await page.getByRole('button', { name: 'Open the tutor' }).click();
  await expect(page.getByRole('heading', { name: 'Tutor' })).toBeVisible();
}

/** Open a slide with the tutor panel open. */
export async function openPanel(page: Page, hash = SD1_S2) {
  await openSlide(page, hash);
  await openTutor(page);
}

/** Type into the Ask box and send with Enter. */
export async function ask(page: Page, text: string) {
  await askBox(page).fill(text);
  await askBox(page).press('Enter');
}

/** A quick-action button of the open panel. */
export const action = (page: Page, name: string) => page.locator('.panel-actions').getByRole('button', { name, exact: true }); // locator: markup hook (the action row)

/** Wait until `k` answers are finished on screen (saved, nothing still being written). */
export async function settled(page: Page, k = 1) {
  await expect(page.locator('#thread .ans:not(.live)')).toHaveCount(k, { timeout: 15_000 }); // locator: markup hook (.live = still streaming)
  await expect(waiting(page)).toHaveCount(0);
}

/** Ask and wait for the k-th finished answer. */
export async function askAndSettle(page: Page, text: string, k = 1) {
  await ask(page, text);
  await settled(page, k);
}

/** The text of the k-th question bubble (textContent: off-screen bubbles may have no innerText). */
export async function qText(page: Page, k: number) {
  return (await questions(page).nth(k).textContent()) ?? '';
}

/** Choose the scope switch value. */
export async function scope(page: Page, which: 'This slide' | 'Whole deck') {
  await page.getByRole('radiogroup', { name: 'Work on' }).getByRole('radio', { name: which }).click();
}

/** Open the ⋯ menu of the app header. */
export async function openMore(page: Page) {
  await page.locator('#menu-btn').click();   // locator: markup hook (⋯ "More")
}

/** Move keyboard focus off any text field. */
export async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Remember that `window.print` was called instead of opening the dialog. */
export async function stubPrint(page: Page) {
  await page.addInitScript(() => {
    (window as any).__printed = 0;
    window.print = () => { (window as any).__printed++; };
  });
}

/** Clipboard text of the page. */
export async function clipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

// ------------------------------------------------------------ the model double

/** A reply rule for one label (regex). */
export function rule(label: string, reply: Rule['reply'], extra: Partial<Rule> = {}): Rule {
  return { match: { label }, reply, ...extra };
}
/** A tutor-turn reply held until `hub.release(name)`. */
export function held(name: string, text: string, label = '^chat:', extra: Rule['reply'] = {}): Rule {
  return { match: { label }, times: 1, reply: { wait_for: name, text, ...extra } };
}

/** The memory update: "nothing changed" (no file written). */
export const MEMORY_NOOP: Rule = { match: { label: '^memory$' }, reply: { json: { changed: false, memory: '' } } };

export function memoryJson(marker = 'MEMORY-MARK') {
  return { changed: true, memory: `## About me\n- Likes graphs (${marker})\n## Questions I keep asking\n- What is elasticity\n## Mistakes I've corrected\n- Mixed up demand and supply\n## Still shaky\n- Elasticity` };
}

/** Wait until n model calls with a label exist; returns them. */
export async function callsAtLeast(hub: Hub, label: string, n = 1) {
  let rows: Awaited<ReturnType<Hub['calls']>> = [];
  await expect.poll(async () => (rows = await hub.calls(label)).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(n);
  return rows;
}

// ------------------------------------------------------------ library on disk

export function chatIds(hub: Hub, course = DEMO): string[] {
  return hub.list(`${course}/me/chats`).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}
export function readChat(hub: Hub, id: string, course = DEMO): any {
  return hub.readJson(course, 'me', 'chats', `${id}.json`);
}
/** The only chat of the course (fails when there are 0 or several). */
export function onlyChat(hub: Hub, course = DEMO): any {
  const ids = chatIds(hub, course);
  expect(ids).toHaveLength(1);
  return readChat(hub, ids[0], course);
}
export function hubStateChat(hub: Hub, course = DEMO): string | null | undefined {
  if (!hub.exists(course, 'me', 'hub-state.json')) return undefined;
  return hub.readJson(course, 'me', 'hub-state.json').chat;
}
export function drafts(hub: Hub): any {
  return hub.exists(DEMO, 'me', 'drafts.json') ? hub.readJson(DEMO, 'me', 'drafts.json') : {};
}

/** Write a chat file in me/chats (id: 12 hex). */
export function chatFile(hub: Hub, id: string, chat: Record<string, unknown> = {}, course = DEMO) {
  hub.write(`${course}/me/chats/${id}.json`, JSON.stringify({
    id, course, code: course, deck: 'S&D-1', created: '2026-01-01 10:00', updated: '2026-01-01 10:00', title: `Chat ${id}`,
    messages: [
      { role: 'q', mode: 'ask', deck: 'S&D-1', slide: 2, text: `Question of ${id}` },
      { role: 'a', mode: 'ask', deck: 'S&D-1', slide: 2, text: `Answer of ${id}.`, ms: 1200, cost: 0.01, model: 'claude-opus-5-5' },
    ],
    ...chat,
  }, null, 1));
}
/** Write <course>/me/hub-state.json with a current chat. */
export function hubState(hub: Hub, state: Record<string, unknown>, course = DEMO) {
  hub.write(`${course}/me/hub-state.json`, JSON.stringify({ v: 1, decks: {}, reviews: [], chats: {}, ...state }, null, 1));
}

/** `test.use({ seed: seedWith((hub) => ...) })` (a seed function must be wrapped as a fixture value). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const seedWith = (fn: (hub: Hub) => void | Promise<void>): any => async ({}, use: (v: unknown) => Promise<void>) => { await use(fn); };

// ------------------------------------------------------------ photos

const EXAMPLE_SD1 = path.join(REPO, 'example-library', 'Demo-Course', 'decks', 'SD-1');
/** A small real JPEG (a slide image of the example deck). */
export function jpg(i = 1): Buffer {
  return fs.readFileSync(path.join(EXAMPLE_SD1, `s00${i}.jpg`));
}
export function jpgFile(name = 'working.jpg', i = 1) {
  return { name, mimeType: 'image/jpeg', buffer: jpg(i) };
}
export const uploads = (hub: Hub) => hub.list(`${DEMO}/me/uploads`);

/** Attach files through the 📷 button's file chooser (desktop, no phone link). */
export async function attach(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach a photo' }).click();
  await (await chooser).setFiles(files);
}
export const thumbs = (page: Page) => tray(page).locator('img[alt="Attached photo"]');

// ------------------------------------------------------------ two devices

export type Device = { ctx: BrowserContext; page: Page };
/** Open `n` separate browser contexts (devices) on the hub at a slide. */
export async function devices(browser: Browser, hub: Hub, n = 2, hash = SD1_S2, open = true): Promise<Device[]> {
  const out: Device[] = [];
  for (let i = 0; i < n; i++) {
    const ctx = await browser.newContext({ baseURL: hub.url, viewport: { width: 1400, height: 900 },
      permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await ctx.newPage();
    await openSlide(page, hash);
    if (open) await openTutor(page);
    out.push({ ctx, page });
  }
  return out;
}
export async function closeAll(devs: Device[]) {
  for (const d of devs) await d.ctx.close();
}

/** The live channel has delivered its first snapshot (the page is listening). */
export function listening(page: Page) {
  return page.waitForResponse((r) => r.url().includes('/api/live'));
}

export type { Locator };
