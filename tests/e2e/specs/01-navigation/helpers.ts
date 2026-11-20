/**
 * Shared helpers for the 01-navigation specs: seeding the copied library (extra courses, decks, notes, deadlines,
 * hub state), dates relative to today, and a few viewer helpers.
 *
 * Seeding writes files in the library format (docs/library-format.md), which is part of the product contract.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Page, TestType } from '@playwright/test';
import { Hub, REPO, expect } from '../../fixtures/hub';

export const DEMO = 'Demo-Course';
export const SD1_HASH = '#c=Demo-Course&d=S%26D-1';
const EXAMPLE_SD1 = path.join(REPO, 'example-library', 'Demo-Course', 'decks', 'SD-1');

/** A slide image (a copy of one of the example deck's 900x507 JPGs). */
export function slideJpg(i = 1): Buffer {
  return fs.readFileSync(path.join(EXAMPLE_SD1, `s00${((i - 1) % 3) + 1}.jpg`));
}

/** Write a course folder; `courseJson` null = no course.json, a string = written as is. */
export function addCourse(hub: Hub, id: string, courseJson: object | string | null = { code: id, title: `${id} title` }) {
  fs.mkdirSync(hub.path(id), { recursive: true });
  if (courseJson !== null) {
    hub.write(`${id}/course.json`, typeof courseJson === 'string' ? courseJson : JSON.stringify(courseJson, null, 1));
  }
}

/** A transcript with one section per title: `## [tag sN] title` + a body line. */
export function transcript(tag: string, titles: string[], body = (n: number) => `Text of ${tag} slide ${n}.`) {
  return `# Transcript: ${tag}\n\n` + titles.map((t, i) => `## [${tag} s${i + 1}] ${t}\n\n${body(i + 1)}\n\nType: content\n`).join('\n');
}

/**
 * Write a deck folder `decks/<folder>/` with deck.json (object, or raw string), `images` slide JPGs and a transcript
 * (default: one section per image titled "<tag> title N"; null = no transcript.md).
 */
export function addDeck(
  hub: Hub, course: string, folder: string, deck: Record<string, unknown> | string,
  opts: { images?: number; transcript?: string | null } = {},
) {
  const dir = `${course}/decks/${folder}`;
  fs.mkdirSync(hub.path(dir), { recursive: true });
  hub.write(`${dir}/deck.json`, typeof deck === 'string' ? deck : JSON.stringify(deck, null, 1));
  const pages = typeof deck === 'string' ? 0 : parseInt(String(deck.pages ?? 0), 10) || 0;
  const n = opts.images ?? pages;
  for (let i = 1; i <= n; i++) hub.write(`${dir}/s${String(i).padStart(3, '0')}.jpg`, slideJpg(i));
  const tag = typeof deck === 'string' ? folder : String(deck.tag ?? folder);
  const tr = opts.transcript === undefined
    ? transcript(tag, Array.from({ length: n }, (_, i) => `${tag} title ${i + 1}`))
    : opts.transcript;
  if (tr !== null) hub.write(`${dir}/transcript.md`, tr);
}

/** A second lecture deck in Demo-Course: S&D-2, week 2, "Supply and Demand", 3 slides titled "S&D-2 title N". */
export function addSD2(hub: Hub, extra: Record<string, unknown> = {}) {
  addDeck(hub, DEMO, 'SD-2', { tag: 'S&D-2', title: 'Supply and demand 2', role: 'lecture', week: 2, order: 1, pages: 3,
    prepared: true, topic: 'Supply and Demand', ...extra });
}

/** Write <course>/me/hub-state.json. */
export function hubState(hub: Hub, course: string, state: Record<string, unknown>) {
  hub.write(`${course}/me/hub-state.json`, JSON.stringify({ v: 1, decks: {}, reviews: [], chats: {}, ...state }, null, 1));
}

/** One saved mistake (a review item) for the hub state. */
export function review(id: string, due: string, extra: Record<string, unknown> = {}) {
  return { id, deck: 'S&D-1', slides: 's2', concept: `concept ${id}`, problem_md: 'p', mistake: 'm', note: '', step: 0,
    due, created: due, last: null, ...extra };
}

// ------------------------------------------------------------ dates

/** Local date `days` from today. */
export function dayFrom(days: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
}
export function iso(days = 0): string {
  const d = dayFrom(days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];
/** A Deadlines-table date `days` from today: "Nov 29" (short) or "November 29" (long). */
export function deadlineDate(days: number, style: 'short' | 'long' = 'short'): string {
  const d = dayFrom(days);
  return `${(style === 'short' ? MON : MONTH)[d.getMonth()]} ${d.getDate()}`;
}
/**
 * Deadline dates have no year (the app reads them in the current year), so an offset that crosses New Year (or goes
 * back into last year) can't be expressed. Skip the test with a clear reason when that happens.
 */
export function skipIfYearWraps(test: TestType<any, any>, ...offsets: number[]) {
  const y = new Date().getFullYear();
  test.skip(offsets.some((k) => dayFrom(k).getFullYear() !== y),
    'deadline dates have no year: these offsets would cross New Year today');
}

/** Write me/progress.md with a Deadlines table holding the given rows (`| Date | Item | Weight | Status | Covers |`). */
export function deadlines(hub: Hub, course: string, rows: string[], after = '') {
  hub.write(`${course}/me/progress.md`, `# Progress: ${course}\n\n## Deadlines\n\n| Date | Item | Weight | Status | Covers |\n|---|---|---|---|---|\n${
    rows.join('\n')}\n\n## Weak topics\n${after}`);
}

// ------------------------------------------------------------ viewer

/** Wait for the viewer to show "n / N". */
export async function atSlide(page: Page, counter: string) {
  await expect(page.locator('#counter')).toHaveText(counter);    // locator: markup hook (desktop counter)
}

/** Move keyboard focus off any text field so the viewer's keys work. */
export async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Resolves when the viewer has recorded a slide as seen (it posts ~0.5 s after the slide shows). */
export function seenPosted(page: Page) {
  return page.waitForResponse((r) => r.url().includes('/api/seen') && r.request().method() === 'POST');
}

/** The deck-state JSON for a tag in the course's hub state on disk (undefined when absent). */
export function deckState(hub: Hub, course: string, tag: string) {
  if (!hub.exists(course, 'me', 'hub-state.json')) return undefined;
  return hub.readJson(course, 'me', 'hub-state.json').decks?.[tag];
}

/** The page body (main). */
export const main = (page: Page) => page.locator('main');
/** Breadcrumbs. */
export const crumbs = (page: Page) => page.getByRole('navigation', { name: 'Where you are' });

/**
 * `test.use({ seed: seedWith((hub) => ...) })`. Playwright treats a plain function given to test.use as a fixture
 * function, so a seed function has to be wrapped in a fixture that provides it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const seedWith = (fn: (hub: Hub) => void | Promise<void>): any => async ({}, use: (v: unknown) => Promise<void>) => { await use(fn); };
