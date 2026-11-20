/**
 * Shared helpers for the 03-practice specs: the model double's problem / marking / drill / topic-practice replies,
 * seeding the review queue and hub state relative to today, and a few UI drivers (open a slide, start a problem).
 *
 * Seeding writes files in the library format (docs/library-format.md), which is part of the product contract.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { APIRequestContext, Locator, Page, TestType } from '@playwright/test';
import { Hub, REPO, Rule, expect } from '../../fixtures/hub';

export const DEMO = 'Demo-Course';
export const SD1 = '#c=Demo-Course&d=S%26D-1';
export const SD1_S2 = `${SD1}&s=2`;
export const HW1 = '#c=Demo-Course&d=HW-1&s=1';

// ------------------------------------------------------------ model replies

export type Problem = {
  problem_md: string; solution_md: string; final_answer: string; hints: string[]; concept: string; slides: string;
  deck: string;
};
export function problem(extra: Partial<Problem> = {}): Problem {
  return {
    problem_md: 'Demand is $Q=100-2P$, supply $Q=20+2P$. Find the equilibrium price.',
    solution_md: '1. Set equal: $100-2P=20+2P$\n2. So **P = 20** (SOLUTION-MARK)',
    final_answer: 'P = 20',
    hints: ['What is true at equilibrium?', 'Set $100-2P = 20+2P$.'],
    concept: 'Market equilibrium',
    slides: 'S&D-1 s2',
    deck: 'S&D-1',
    ...extra,
  };
}

export type Mark = {
  correct: boolean; unreadable: boolean; verdict: string; mistake: string; feedback_md: string; concept_missed: string;
};
export const MARK_CLEAN: Mark = { correct: true, unreadable: false, verdict: 'All right.', mistake: 'none', feedback_md: '',
  concept_missed: '' };
export const MARK_WRONG: Mark = { correct: false, unreadable: false, verdict: 'Setup right, **slip** in step 2.',
  mistake: 'Algebra slip', feedback_md: 'You wrote $2P=60$; it is $4P=80$.', concept_missed: 'Solving for P' };
export const MARK_UNREADABLE: Mark = { correct: true, unreadable: true, verdict: "I can't read the photo.", mistake: 'none',
  feedback_md: '', concept_missed: '' };
export function mark(extra: Partial<Mark> = {}): Mark {
  return { ...MARK_CLEAN, ...extra };
}

/** The memory notebook update every drill reply triggers: "nothing changed" (so no file is written). */
export const MEMORY_RULE: Rule = { match: { label: '^memory$' }, reply: { json: { changed: false, memory: '' } } };

/** Rules for a practice flow: every problem is `prob`, every marking is `mk` (both repeatable). */
export function practiceRules(prob: Partial<Problem> = {}, mk: Partial<Mark> = MARK_CLEAN, extra: Rule[] = []): Rule[] {
  return [...extra,
    { match: { label: '^practice:' }, reply: { json: problem(prob) } },
    { match: { label: '^check$' }, reply: { json: mark(mk) } },
    MEMORY_RULE];
}

/** The hidden question record a drill answer carries when it closes a question. */
export function drillLine(rec: Record<string, unknown>) {
  return `<!--drill ${JSON.stringify({ q: 1, phase: 1, deck: 'S&D-1', slides: 'S&D-1 s2', concept: 'Equilibrium price',
    problem: 'Find P', marks: '1/3', outcome: 'hinted', mistake: 'Algebra slip', ...rec })}-->`;
}
export const DRILL_Q1 = '[S&D-1] only. Quiz format, 3 marks.\n\n**Q1 · Supply and Demand · calculation** [3 marks]\nFind P.\n\n**Slides you can use:** [S&D-1 s2]';
/** A drill reply that closes question `q` with the given record and asks the next one. */
export function drillReply(rec: Record<string, unknown> = {}, head = 'Not quite (1/3).') {
  const q = Number(rec.q ?? 1);
  return `${head}\n\n#### Q${q} · Solution 1: as written for full marks\nP=20 [1]\n\n**Tally:** Q${q} ${rec.marks ?? '1/3'}\n${
    drillLine(rec)}\n\n---\n**Q${q + 1} · Supply and Demand · explain** [2 marks]\nWhy does the price rise?`;
}

/** The hidden plan line of Practice by topic. */
export function planLine(topics: unknown[]) {
  return `<!--practice ${JSON.stringify({ topics })}-->`;
}
export const PLAN2 = [
  { k: 1, name: 'Demand', slides: 's1–s2', problems: ['(a) Equilibrium, s2'] },
  { k: 2, name: 'Supply', slides: 's3', problems: [] },
];
export function topicFirstTurn(topics: unknown[] = PLAN2, extraLine = true) {
  return 'We cover the deck in two topics.\n\n| # | Topic | Slides | Numerical problems | Concept / MCQ areas |\n|---|---|---|---|---|\n| 1 | Demand | s1–s2 | 1 | law of demand |\n\n' +
    '#### Topic 1 · Demand: concepts\n\n| # | Question | Answer | Slide |\n|---|---|---|---|\n| 1.1 | What is demand? | A schedule | [S&D-1 s1] |\n\n' +
    '**Your turn:** find P.\n\n<details><summary>Answer</summary>\n\nP = 20 (HIDDEN-ANSWER)\n\n</details>\n\n' +
    "Say **done** when you've finished, and we'll move on to Topic 2: Supply.\n" + (extraLine ? planLine(topics) : '');
}

// ------------------------------------------------------------ dates

/** Local date `days` from today, as YYYY-MM-DD (the hub uses the machine's local date). */
export function iso(days = 0): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Skip a date-sensitive test when the local clock is within 2 minutes of midnight (today would change mid-test). */
export function skipNearMidnight(test: TestType<any, any>) {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  test.skip(mins < 2 || mins >= 24 * 60 - 2, 'too close to midnight: "today" could change during the test');
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A Deadlines-table date `days` from today ("Nov 29"); deadline dates have no year. */
export function deadlineDate(days: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return `${MON[d.getMonth()]} ${d.getDate()}`;
}
export function skipIfYearWraps(test: TestType<any, any>, ...offsets: number[]) {
  const y = new Date().getFullYear();
  test.skip(offsets.some((k) => { const d = new Date(); d.setDate(d.getDate() + k); return d.getFullYear() !== y; }),
    'deadline dates have no year: these offsets would cross New Year today');
}

// ------------------------------------------------------------ seeding

/** Write <course>/me/hub-state.json. */
export function hubState(hub: Hub, state: Record<string, unknown>, course = DEMO) {
  hub.write(`${course}/me/hub-state.json`, JSON.stringify({ v: 1, decks: {}, reviews: [], chats: {}, ...state }, null, 1));
}
export function readState(hub: Hub, course = DEMO): any {
  return hub.readJson(course, 'me', 'hub-state.json');
}
export function reviewsOnDisk(hub: Hub, course = DEMO): any[] {
  return hub.exists(course, 'me', 'hub-state.json') ? readState(hub, course).reviews : [];
}

/** One saved mistake (a review item). `due` is days from today. */
export function review(id: string, due = 0, extra: Record<string, unknown> = {}) {
  return { id, deck: 'S&D-1', slides: 'S&D-1 s2', concept: `concept ${id}`, problem_md: `Saved problem ${id}.`,
    mistake: 'Setup', note: '', step: 0, due: iso(due), created: iso(due - 1), last: null, ...extra };
}

/** Write me/progress.md with a Deadlines table holding the given rows, and optional extra sections. */
export function progress(hub: Hub, rows: string[] = [], after = '', course = DEMO) {
  hub.write(`${course}/me/progress.md`, `# Progress: ${course}\n\n## Deadlines\n\n| Date | Item | Weight | Status | Covers |\n|---|---|---|---|---|\n${
    rows.join('\n')}\n\n## Weak topics\n\n${after}\n`);
}

const EXAMPLE_SD1 = path.join(REPO, 'example-library', 'Demo-Course', 'decks', 'SD-1');
/**
 * Write a deck folder `decks/<folder>/` (deck.json, slide JPGs copied from the example deck, a transcript with one
 * section per slide).
 */
export function addDeck(hub: Hub, folder: string, deck: Record<string, unknown>, course = DEMO) {
  const dir = `${course}/decks/${folder}`;
  const n = Number(deck.pages ?? 3);
  hub.write(`${dir}/deck.json`, JSON.stringify({ role: 'lecture', order: 1, prepared: true, pages: n, ...deck }, null, 1));
  for (let i = 1; i <= n; i++) {
    hub.write(`${dir}/s${String(i).padStart(3, '0')}.jpg`, fs.readFileSync(path.join(EXAMPLE_SD1, `s00${((i - 1) % 3) + 1}.jpg`)));
  }
  const tag = String(deck.tag);
  hub.write(`${dir}/transcript.md`, `# Transcript: ${tag}\n\n` + Array.from({ length: n }, (_, i) =>
    `## [${tag} s${i + 1}] ${tag} title ${i + 1}\n\nText of ${tag} slide ${i + 1}.\n\nType: content\n`).join('\n'));
}
/** Two more lecture decks: S&D-2 (week 2, topic Supply and Demand) and EL-1 (week 3, topic Elasticity). */
export function addMoreDecks(hub: Hub) {
  addDeck(hub, 'SD-2', { tag: 'S&D-2', title: 'Supply and demand 2', week: 2, topic: 'Supply and Demand' });
  addDeck(hub, 'EL-1', { tag: 'EL-1', title: 'Elasticity 1', week: 3, topic: 'Elasticity' });
}

/** A saved chat file in me/chats (id: 12 hex). */
export function chatFile(hub: Hub, id: string, chat: Record<string, unknown>, course = DEMO) {
  hub.write(`${course}/me/chats/${id}.json`, JSON.stringify({ id, course, code: course, deck: 'S&D-1',
    created: '2026-01-01 10:00', updated: '2026-01-01 10:00', title: 'A chat', messages: [], ...chat }, null, 1));
}

/** Seed the study session in localStorage before the page loads. */
export async function seedSession(page: Page, s: Record<string, unknown>) {
  await page.addInitScript((v) => {
    if (!sessionStorage.getItem('e2e-seeded')) {
      localStorage.setItem('session', JSON.stringify(v));
      sessionStorage.setItem('e2e-seeded', '1');
    }
  }, { course: DEMO, step: 0, practised: 0, lastMistake: null, started: Date.now(), ...s });
}

// ------------------------------------------------------------ UI

/** The tutor / practice panel (right-hand side). */
export const panel = (page: Page) => page.locator('#tutor');        // locator: markup hook
/** The Ask box. */
export const askBox = (page: Page) => page.locator('#ask-input');   // locator: markup hook
/** The result box of a marked problem. */
export const resultBox = (page: Page) => page.locator('.result');   // locator: markup hook

/** Open a slide (default S&D-1 slide 2) and wait for it. */
export async function openSlide(page: Page, hash = SD1_S2) {
  await page.goto('/' + hash);
  await expect(page.locator('#counter')).toHaveText(/\d+ \/ \d+/);   // locator: markup hook (slide counter)
}
export async function openTutor(page: Page) {
  await page.getByRole('button', { name: 'Open the tutor' }).click();
  await expect(page.getByRole('heading', { name: 'Tutor' })).toBeVisible();
}

/** Type into the Ask box and send it with Enter. */
export async function ask(page: Page, text: string) {
  await askBox(page).fill(text);
  await askBox(page).press('Enter');
}

/** On an open slide: start a slide problem via `/try` and wait for it to be shown. */
export async function startTry(page: Page, words = '') {
  await ask(page, words ? `/try ${words}` : '/try');
  await expect(page.getByLabel('Your working')).toBeVisible();
}

/** Type an answer and press Check; waits for the result box. */
export async function answerAndCheck(page: Page, text = 'P = 20') {
  await page.getByLabel('Your working').fill(text);
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(resultBox(page)).toBeVisible();
}

/** The practice problem files on disk (ids). */
export function practiceIds(hub: Hub, course = DEMO): string[] {
  return hub.list(`${course}/me/practice`).map((f) => f.replace(/\.json$/, ''));
}
export function practiceRec(hub: Hub, id: string, course = DEMO): any {
  return hub.readJson(course, 'me', 'practice', `${id}.json`);
}
/** The newest problem record on disk. */
export function newestPractice(hub: Hub, course = DEMO): any {
  const recs = practiceIds(hub, course).map((id) => practiceRec(hub, id, course));
  recs.sort((a, b) => fs.statSync(hub.path(course, 'me', 'practice', `${a.id}.json`)).birthtimeMs
    - fs.statSync(hub.path(course, 'me', 'practice', `${b.id}.json`)).birthtimeMs);
  return recs[recs.length - 1];
}

/** POST /api/practice/new without streaming. */
export async function apiNew(api: APIRequestContext, body: Record<string, unknown>) {
  return api.post('/api/practice/new', { data: { course: DEMO, kind: 'try', tag: 'S&D-1', n: 2, ...body } });
}
export async function apiCheck(api: APIRequestContext, id: string, answer = 'P = 20', extra: Record<string, unknown> = {}) {
  return api.post('/api/practice/check', { data: { id, answer, ...extra } });
}
/** POST /api/tutor (not streamed). */
export async function apiTutor(api: APIRequestContext, body: Record<string, unknown>) {
  return api.post('/api/tutor', { data: { course: DEMO, tag: 'S&D-1', n: 2, ...body } });
}

/** A small valid JPEG (a slide image of the example deck). */
export function jpg(): Buffer {
  return fs.readFileSync(path.join(EXAMPLE_SD1, 's001.jpg'));
}
export function jpgDataUrl(): string {
  return 'data:image/jpeg;base64,' + jpg().toString('base64');
}

/** Pick a file through the next file chooser opened by clicking `trigger`. */
export async function chooseFile(page: Page, trigger: Locator, file: { name: string; mimeType: string; buffer: Buffer }) {
  const chooser = page.waitForEvent('filechooser');
  await trigger.click();
  await (await chooser).setFiles(file);
}

/**
 * A `seed` option value for test.use. (Playwright treats a bare function in test.use as a fixture, so the seed
 * function is handed over by a tiny fixture: `test.use({ seed: seedWith((hub) => ...) })`.)
 */
export function seedWith(fn: (hub: Hub) => void | Promise<void>): any {
  // eslint-disable-next-line no-empty-pattern
  return async ({}, use: (v: unknown) => Promise<void>) => { await use(fn); };
}

/** A text file under <course>/me, with the platform's line endings normalised to \n. */
export function readText(hub: Hub, rel: string, course = DEMO): string {
  return hub.read(course, 'me', rel).split('\r\n').join('\n');
}
