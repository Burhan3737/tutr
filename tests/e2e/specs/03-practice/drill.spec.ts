/**
 * 03 · Exam drill: the setup dialog and its defaults, starting a drill, drill turns and buttons, the hidden question
 * record, the drill log and ledger, and drill questions going into the review queue.
 * Spec: docs/functional-spec/03-practice-reviews-drills.md (DRILL-*)
 *
 * Not covered:
 *   DRILL-009 (how the model marks, hints and writes up; phases) — model-dependent; only the app's handling of its
 *            output is pinned (DRILL-010, DRILL-030, DRILL-040).
 *   DRILL-012 "a drill start without a range: Pick the drill's range first." — not reachable over HTTP: the hub
 *            always builds a range for a drill start, and an empty one is refused with DRILL-004's message instead.
 *   DRILL-007 dictation and Ask-box photos as drill replies (voice / tutor areas).
 */
import { test, expect } from '../../fixtures/hub';
import type { Hub } from '../../fixtures/hub';
import type { APIRequestContext, Page } from '@playwright/test';
import {
  DEMO, DRILL_Q1, HW1, MEMORY_RULE, SD1_S2, addDeck, addMoreDecks, apiTutor, ask, askBox, chatFile, deadlineDate,
  drillLine, drillReply, hubState, iso, openSlide, openTutor, panel, progress, readState, reviewsOnDisk, seedWith,
  skipIfYearWraps, skipNearMidnight,
} from './helpers';

const dialog = (page: Page) => page.getByRole('dialog').filter({ hasText: 'Decks in range' });
const box = (page: Page, label: string | RegExp) => dialog(page).getByRole('checkbox', { name: label });
const status = (page: Page) => page.getByText(/^Drill · /);
const drillRules = (reply = drillReply()) => [
  { match: { label: '^chat:drill$' }, reply: { text: DRILL_Q1 } },
  { match: { label: '^chat:drill_reply$' }, reply: { text: reply } },
  { match: { label: '^chat:drill_hint$' }, reply: { text: 'HINT-RUNG-ONE' } },
  { match: { label: '^chat:drill_end$' }, reply: { text: '#### How the drill went\n**Marks:** S&D 1/3 (SUMMARY)' } },
  MEMORY_RULE,
];

async function openDrillDialog(page: Page, hash = SD1_S2) {
  await openSlide(page, hash);
  await openTutor(page);
  await page.getByRole('button', { name: 'Exam drill', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
}

/** Start a drill over HTTP; returns the chat id. */
async function startDrill(api: APIRequestContext, drill: Record<string, unknown> = {}) {
  const r = await apiTutor(api, { mode: 'drill', question: '', drill: { decks: ['S&D-1'], papers: [], focus: '', ...drill } });
  expect(r.status()).toBe(200);
  return (await r.json()).chat as string;
}
const chatOnDisk = (hub: Hub, id: string) => hub.readJson(DEMO, 'me', 'chats', `${id}.json`);

// ============================================================ the setup dialog

test.describe('the setup dialog', () => {
  test.use({ seed: seedWith((hub: Hub) => {
    addMoreDecks(hub);
    addDeck(hub, 'SD-3', { tag: 'S&D-3', title: 'Supply and demand 3', week: 4, topic: 'Supply and Demand' });
  }) });

  test('DRILL-001 DRILL-002 the dialog: explanation, decks grouped by topic in lecture order, papers, focus', async ({ page }) => {
    await openDrillDialog(page);
    const d = dialog(page);
    await expect(d.getByRole('heading', { name: 'Exam drill' })).toBeVisible();
    await expect(d).toContainText('Questions like the real paper, one at a time, from the decks you pick. Work on paper, then send what you got (typed, spoken or a photo). Hints when you ask; the answer only when you ask for it, then the written solution, a shortcut and the method for variants.');
    const labels = await d.getByRole('checkbox').evaluateAll((els) => els.map((e) => (e.parentElement as HTMLElement).innerText.trim()));
    expect(labels).toEqual(['S&D-1 · W1 · Supply and demand 1', 'S&D-2 · W2 · Supply and demand 2', 'EL-1 · W3 · Elasticity 1',
      'S&D-3 · W4 · Supply and demand 3', 'HW-1 · Homework 1']);
    // a topic split by another topic's decks appears twice; practice decks are not in the range
    const groups = await d.locator('.drill-topic > b').allInnerTexts();   // locator: markup hook (topic group names)
    expect(groups).toEqual(['Supply and Demand', 'Elasticity', 'Supply and Demand']);
    await expect(d).toContainText("None ticked: the format of the course's assessments.");
    await expect(d.getByLabel('Focus')).toHaveAttribute('placeholder',
      "Optional: e.g. calculations only, harder questions — or paste the test's study guide");
    // no next assessment: every lecture deck ticked, no paper
    for (const t of ['S&D-1', 'S&D-2', 'EL-1', 'S&D-3']) await expect(box(page, new RegExp(`^${t} ·`))).toBeChecked();
    await expect(box(page, /^HW-1/)).not.toBeChecked();
    await d.getByRole('button', { name: 'Close' }).click();
    await expect(dialog(page)).toHaveCount(0);
  });

  test('DRILL-002 quick choices: up to a deck, All, None; Start with none ticked is refused', async ({ page, hub }) => {
    await openDrillDialog(page);
    const d = dialog(page);
    await d.getByLabel('From the first deck up to a deck').selectOption('S&D-2');
    await expect(box(page, /^S&D-1 ·/)).toBeChecked();
    await expect(box(page, /^S&D-2 ·/)).toBeChecked();
    await expect(box(page, /^EL-1 ·/)).not.toBeChecked();
    await expect(box(page, /^S&D-3 ·/)).not.toBeChecked();
    await d.getByRole('button', { name: 'All', exact: true }).click();
    await expect(box(page, /^S&D-3 ·/)).toBeChecked();
    await d.getByRole('button', { name: 'None', exact: true }).click();
    await expect(d.getByRole('checkbox', { checked: true })).toHaveCount(0);
    await d.getByRole('button', { name: 'Start the drill' }).click();
    await expect(d).toContainText('Pick at least one deck.');
    await expect(d).toBeVisible();
    expect(await hub.calls('^chat:')).toHaveLength(0);
  });

  test('DRILL-001 the slash command /drill opens the dialog', async ({ page }) => {
    await openSlide(page);
    await openTutor(page);
    await ask(page, '/drill');
    await expect(dialog(page)).toBeVisible();
  });

  test('DRILL-001 the course page\'s "Exam drill ›" opens the resume deck with the tutor and the dialog', async ({ page }) => {
    await page.goto('/#c=Demo-Course');
    await page.getByRole('button', { name: 'Exam drill ›' }).click();
    await expect(page).toHaveURL(/#c=Demo-Course&d=S%26D-1/);
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Tutor' })).toBeVisible();
  });
});

test.describe('the next assessment', () => {
  test.use({ seed: seedWith((hub: Hub) => {
    addMoreDecks(hub);
    progress(hub, [`| ${deadlineDate(10)} | **Midterm** | 20% | | W2-3 (assumed) |`]);
  }) });

  test('DRILL-002 DRILL-003 with a next assessment its weeks are the default range, and a link ticks them', async ({ page }) => {
    skipIfYearWraps(test, 10);
    await openDrillDialog(page);
    await expect(box(page, /^S&D-1 ·/)).not.toBeChecked();
    await expect(box(page, /^S&D-2 ·/)).toBeChecked();
    await expect(box(page, /^EL-1 ·/)).toBeChecked();
    await dialog(page).getByRole('button', { name: 'All', exact: true }).click();
    await dialog(page).getByRole('button', { name: 'Midterm (W2–3, assumed)' }).click();
    await expect(box(page, /^S&D-1 ·/)).not.toBeChecked();
    await expect(box(page, /^EL-1 ·/)).toBeChecked();
  });
});

test.describe('without practice papers', () => {
  test.use({ seed: seedWith((hub: Hub) => {
    require('fs').rmSync(hub.path(DEMO, 'decks', 'HW-1'), { recursive: true });
  }) });

  test('DRILL-002 with no practice decks the dialog says the drill follows the course notes', async ({ page }) => {
    await openDrillDialog(page);
    await expect(dialog(page)).toContainText('No practice papers in this course yet: the drill follows the assessment format in the course notes.');
  });
});

test.describe('defaults from earlier drills', () => {
  test.use({ seed: seedWith((hub: Hub) => {
    addMoreDecks(hub);
    chatFile(hub, 'aaaaaaaaaaa1', { title: 'Exam drill: older starred', starred: true, updated: '2026-01-01 10:00',
      drill: { decks: ['EL-1'], papers: [], focus: 'STARRED-FOCUS', started: '2026-01-01 10:00', log: [], photos: [] } });
    chatFile(hub, 'bbbbbbbbbbb2', { title: 'Exam drill: newer', updated: '2026-02-01 10:00',
      drill: { decks: ['S&D-2'], papers: ['HW-1'], focus: 'NEWER-FOCUS', started: '2026-02-01 10:00', log: [], photos: [] } });
  }) });

  test('DRILL-003 the last drill\'s range, papers and focus are the defaults (a starred older drill wins)', async ({ page }) => {
    // [quirk] pinned as-is: a starred older drill takes precedence over a newer unstarred one (spec DRILL-003)
    await openDrillDialog(page);
    await expect(box(page, /^EL-1 ·/)).toBeChecked();
    await expect(box(page, /^S&D-2 ·/)).not.toBeChecked();
    await expect(box(page, /^HW-1/)).not.toBeChecked();
    await expect(dialog(page).getByLabel('Focus')).toHaveValue('STARRED-FOCUS');
  });
});

test.describe('defaults from the last drill', () => {
  test.use({ seed: seedWith((hub: Hub) => {
    addMoreDecks(hub);
    hubState(hub, { resume: { deck: 'HW-1', slide: 1 } });
    chatFile(hub, 'ccccccccccc3', { title: 'Exam drill: last', updated: '2026-02-01 10:00',
      drill: { decks: ['S&D-2'], papers: [], focus: 'LAST-FOCUS', started: '2026-02-01 10:00', log: [], photos: [] } });
  }) });

  test('DRILL-003 opened from the tutor on a practice deck, that paper is ticked; from the course page it is not', async ({ page }) => {
    await openDrillDialog(page, HW1);
    await expect(box(page, /^HW-1/)).toBeChecked();
    await expect(box(page, /^S&D-2 ·/)).toBeChecked();
    await expect(box(page, /^S&D-1 ·/)).not.toBeChecked();
    await expect(dialog(page).getByLabel('Focus')).toHaveValue('LAST-FOCUS');
    await page.keyboard.press('Escape');
    await page.goto('/#c=Demo-Course');
    await page.getByRole('button', { name: 'Exam drill ›' }).click();
    await expect(page).toHaveURL(/d=HW-1/);
    await expect(dialog(page)).toBeVisible();
    await expect(box(page, /^HW-1/)).not.toBeChecked();
  });
});

// ============================================================ running a drill

test.describe('a drill', () => {
  test('DRILL-004 DRILL-006 DRILL-007 starting: a new chat, the question line, the status bar and the drill placeholder', async ({ page, hub }) => {
    await hub.script([{ match: { label: '^chat:explain$' }, reply: { text: 'OLD-CHAT-ANSWER' } }, ...drillRules()]);
    await openSlide(page);
    await openTutor(page);
    await page.getByRole('button', { name: 'Explain simply' }).click();
    await expect(panel(page)).toContainText('OLD-CHAT-ANSWER');
    const oldChat = readState(hub).chat;
    await page.getByRole('button', { name: 'Exam drill', exact: true }).click();
    await dialog(page).getByLabel('Focus').fill('calculations only');
    await dialog(page).getByRole('button', { name: 'Start the drill' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(panel(page)).toContainText('Q1 · Supply and Demand · calculation');
    await expect(panel(page)).not.toContainText('OLD-CHAT-ANSWER');
    await expect(page.locator('.msg-q').last()).toContainText('Exam drill');   // locator: markup hook (question line)
    await expect(status(page)).toHaveText('Drill · S&D-1 · 0 done · 0/1 decks');
    await expect(status(page)).toHaveAttribute('title', 'Range: S&D-1');
    await expect(askBox(page)).toHaveAttribute('placeholder', 'Your answer or what you got on paper, a question, or "give me the answer"');
    const chatId = readState(hub).chat;
    expect(chatId).not.toBe(oldChat);
    expect(hub.exists(DEMO, 'me', 'chats', `${oldChat}.json`)).toBe(true);
    const chat = hub.readJson(DEMO, 'me', 'chats', `${chatId}.json`);
    expect(chat.title).toBe('Exam drill: [S&D-1] only');
    expect(chat.drill).toMatchObject({ decks: ['S&D-1'], papers: [], focus: 'calculations only', log: [] });
    // pinned as-is: the thread bar shows the provisional title "Exam drill" until a reload shows the saved one
    await page.reload();
    await openTutor(page);
    await expect(panel(page)).toContainText('Exam drill: [S&D-1] only');
    // DRILL-005: the focus reaches the model
    const [c] = await hub.calls('^chat:drill$');
    expect(c.system + c.prompt).toContain('calculations only');
  });

  test('DRILL-006 DRILL-007 DRILL-010 a reply closes a question: hidden line stripped, status updated, mistake saved', async ({ page, hub }) => {
    skipNearMidnight(test);
    await hub.script(drillRules());
    await openDrillDialog(page);
    await dialog(page).getByRole('button', { name: 'Start the drill' }).click();
    await expect(status(page)).toHaveText('Drill · S&D-1 · 0 done · 0/1 decks');
    await ask(page, '   ');                    // DRILL-007: nothing typed, no photo: nothing is sent
    expect(await hub.calls('^chat:drill_reply$')).toHaveLength(0);
    await ask(page, 'I got P = 25');
    await expect(panel(page)).toContainText('Q2 · Supply and Demand · explain');
    await expect(panel(page).locator('.msg-q').last()).toContainText('I got P = 25');   // locator: markup hook
    await expect(panel(page)).not.toContainText('<!--drill');
    await expect(panel(page)).not.toContainText('"outcome"');
    await expect(status(page)).toHaveText('Drill · S&D-1 · 1 done · 1/3 marks · 1/1 decks · 1 to revisit');
    const [c] = await hub.calls('^chat:drill_reply$');
    expect(c.prompt).toContain('I got P = 25');
    const chat = hub.readJson(DEMO, 'me', 'chats', `${readState(hub).chat}.json`);
    expect(chat.messages[chat.messages.length - 1].text).not.toContain('<!--drill');
    const items = reviewsOnDisk(hub);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ deck: 'S&D-1', slides: 'S&D-1 s2', concept: 'Equilibrium price', problem_md: 'Find P',
      mistake: 'Algebra slip', step: 0, due: iso(1) });
    expect(chat.drill.log[0].review_id).toBe(items[0].id);
  });

  test('DRILL-008 DRILL-011 drill buttons send their requests; ending the drill returns the Ask box to normal', async ({ page, hub }) => {
    await hub.script(drillRules());
    await openDrillDialog(page);
    await dialog(page).getByRole('button', { name: 'Start the drill' }).click();
    await expect(panel(page)).toContainText('Q1 ·');
    for (const b of ['Hint', 'Show the answer', 'Skip', 'End the drill ›']) {
      await expect(panel(page).getByRole('button', { name: b, exact: true })).toBeVisible();
    }
    await panel(page).getByRole('button', { name: 'Hint', exact: true }).click();
    await expect(panel(page)).toContainText('HINT-RUNG-ONE');
    await expect(panel(page).locator('.msg-q').last()).toContainText('Hint · s2');   // locator: markup hook
    await panel(page).getByRole('button', { name: 'End the drill ›' }).click();
    await expect(panel(page)).toContainText('How the drill went');
    await expect(panel(page).locator('.msg-q').last()).toContainText('End the drill');   // locator: markup hook
    await expect(panel(page).getByRole('button', { name: 'Skip', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Try one on this ›' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go deeper' })).toBeVisible();
    await expect(askBox(page)).toHaveAttribute('placeholder', 'Ask anything about this slide, or / for a mode');
    await expect(status(page)).toHaveText(/^Drill · S&D-1 · /);       // the bar keeps the drill status
    expect((await hub.calls('^chat:drill')).map((c) => c.label)).toEqual(['chat:drill', 'chat:drill_hint', 'chat:drill_end']);
    // after the drill the drill commands are gone
    await ask(page, '/hint');
    await expect(page.getByText("/hint isn't available right now.")).toBeVisible();
  });

  test('DRILL-008 the slash commands /hint /answer /skip /enddrill while drilling', async ({ page, hub }) => {
    await hub.script([...drillRules(), { match: { label: '^chat:drill_(reveal|skip)$' }, reply: { text: 'Next: **Q2** ...' } }]);
    await openDrillDialog(page);
    await dialog(page).getByRole('button', { name: 'Start the drill' }).click();
    await expect(panel(page)).toContainText('Q1 ·');
    for (const cmd of ['/hint', '/answer', '/skip', '/enddrill']) {
      const n = (await hub.calls('^chat:')).length;
      await ask(page, cmd);
      await expect.poll(async () => (await hub.calls('^chat:')).length).toBe(n + 1);
      await expect(page.locator('.waiting')).toHaveCount(0);    // locator: markup hook (answer still coming)
    }
    expect((await hub.calls('^chat:drill')).map((c) => c.label)).toEqual(
      ['chat:drill', 'chat:drill_hint', 'chat:drill_reveal', 'chat:drill_skip', 'chat:drill_end']);
  });

  test('DRILL-008 /hint outside a drill is not available', async ({ page }) => {
    await openSlide(page);
    await openTutor(page);
    await ask(page, '/skip');
    await expect(page.getByText("/skip isn't available right now.")).toBeVisible();
  });

  test('DRILL-013 every drill reply also updates the tutor\'s notebook', async ({ api, hub }) => {
    await hub.script(drillRules());
    await startDrill(api);
    await apiTutor(api, { mode: 'drill_reply', question: 'P=25' });
    await expect.poll(async () => (await hub.calls('^memory$')).length).toBe(1);
  });
});

// ============================================================ server rules and records

test.describe('drill records', () => {
  test.use({ seed: seedWith((hub: Hub) => addMoreDecks(hub)) });

  test('DRILL-004 the range keeps lecture decks in lecture order and papers; unknown or wrong-kind tags are dropped', async ({ api, hub }) => {
    await hub.script(drillRules());
    const id = await startDrill(api, { decks: ['EL-1', 'HW-1', 'NOPE', 'S&D-1'], papers: ['S&D-2', 'HW-1', 'X'] });
    const chat = chatOnDisk(hub, id);
    expect(chat.drill.decks).toEqual(['S&D-1', 'EL-1']);
    expect(chat.drill.papers).toEqual(['HW-1']);
    expect(chat.title).toBe('Exam drill: [S&D-1] → [EL-1] · HW-1');
    const r = await apiTutor(api, { mode: 'drill', question: '', drill: { decks: ['HW-1', 'NOPE'], papers: [] } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe('Pick at least one deck for the drill.');
  });

  test('DRILL-005 DRILL-014 DECK-003 the first turn carries the range, papers, focus and the known weak points', async ({ api, hub }) => {
    progress(hub, [], 'WEAK-TOPIC-ELASTICITY-SIGNS');
    await hub.script(drillRules());
    await startDrill(api, { decks: ['S&D-1', 'S&D-2'], papers: ['HW-1'], focus: 'FOCUS-WORDS' });
    const [c] = await hub.calls('^chat:drill$');
    const all = c.system + '\n' + c.prompt;
    expect(c.prompt).toContain('[S&D-1] Supply and demand 1');
    expect(c.prompt).toContain('[S&D-2] Supply and demand 2');
    expect(c.prompt).toMatch(/Not in range \(never ask from these\): \[EL-1\]/);
    expect(c.prompt).toContain('WEAK-TOPIC-ELASTICITY-SIGNS');
    expect(all).toContain('FOCUS-WORDS');
    expect(all).toContain('HW-1');
  });

  test('DECK-003 with no weak points the model is told "(none recorded yet)"', async ({ api, hub }) => {
    require('fs').rmSync(hub.path(DEMO, 'me', 'progress.md'));
    await hub.script(drillRules());
    await startDrill(api);
    expect((await hub.calls('^chat:drill$'))[0].prompt).toContain('(none recorded yet)');
  });

  test('DRILL-012 drill turns on a chat without a drill are refused', async ({ api, hub }) => {
    await hub.script([{ match: { label: '^chat:' }, reply: { text: 'ok' } }]);
    await apiTutor(api, { mode: 'explain' });
    for (const mode of ['drill_reply', 'drill_hint', 'drill_reveal', 'drill_skip', 'drill_end']) {
      const r = await apiTutor(api, { mode, question: 'x' });
      expect(r.status()).toBe(400);
      expect((await r.json()).error).toBe('No drill is running in this chat. Start one with Exam drill.');
    }
  });

  test('DRILL-007 an empty drill reply with no photo is refused', async ({ api, hub }) => {
    test.fail(true, 'BROKEN in current app: the hub accepts a blank drill_reply (it sends "(see the photos)" to the '
      + 'model) instead of refusing it with "Type a question first."; see docs/functional-spec/03-practice-reviews-drills.md DRILL-007');
    await hub.script(drillRules());
    await startDrill(api);
    const r = await apiTutor(api, { mode: 'drill_reply', question: '   ' });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe('Type a question first.');
  });

  test('DRILL-010 DRILL-030 several record lines are each logged; a broken one is removed and ignored; KaTeX is accepted', async ({ api, hub }) => {
    const text = 'Two closed.\n' + drillLine({ q: 1, outcome: 'skipped', mistake: 'none' }) + '\nmiddle\n'
      + '<!--drill {"q": 2, broken} -->\n'
      + '<!--drill {"q": 3, "phase": 1, "deck": "S&D-1", "slides": "s2", "concept": "Slope", "problem": "Find $\\frac{1}{2}$ of \\Delta P", "marks": "0/2", "outcome": "revealed", "mistake": "Typo"}-->\nend';
    await hub.script(drillRules(text));
    const id = await startDrill(api);
    const r = await (await apiTutor(api, { mode: 'drill_reply', question: 'x' })).json();
    expect(r.message.text).not.toContain('<!--');
    expect(r.message.text).toContain('middle');
    const log = chatOnDisk(hub, id).drill.log;
    expect(log.map((e: any) => e.q)).toEqual(['1', '3']);
    expect(log[1]).toMatchObject({ problem: 'Find $\\frac{1}{2}$ of \\Delta P', mistake: 'none', outcome: 'revealed', marks: '0/2' });
    expect(log[1].at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    const items = reviewsOnDisk(hub);
    expect(items).toHaveLength(1);                       // the skipped Q1 saves nothing; the revealed Q3 does
    expect(items[0]).toMatchObject({ mistake: 'No attempt', problem_md: 'Find $\\frac{1}{2}$ of \\Delta P' });
  });

  test('DRILL-030 DRILL-040 a question closed again replaces its entry, keeps earlier values and saves no second item', async ({ api, hub }) => {
    await hub.script([{ match: { label: '^chat:drill$' }, reply: { text: DRILL_Q1 } },
      { match: { label: '^chat:drill_reply$' }, reply: { text: drillReply({ q: 1, outcome: 'hinted', mistake: 'Setup', marks: '1/3' }) } },
      { match: { label: '^chat:drill_end$' }, reply: { text: 'Summary.\n' + drillLine({ q: 1, outcome: 'skipped', mistake: 'none', marks: '', concept: '' }) } },
      MEMORY_RULE]);
    const id = await startDrill(api);
    await apiTutor(api, { mode: 'drill_reply', question: 'x' });
    await apiTutor(api, { mode: 'drill_end', question: '' });
    const log = chatOnDisk(hub, id).drill.log;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ q: '1', outcome: 'hinted', mistake: 'Setup', marks: '1/3', concept: 'Equilibrium price' });
    expect(reviewsOnDisk(hub)).toHaveLength(1);
    expect(log[0].review_id).toBe(reviewsOnDisk(hub)[0].id);
  });

  test('DRILL-031 later turns carry the ledger of questions so far', async ({ api, hub }) => {
    await hub.script(drillRules(drillReply({ q: 1, outcome: 'hinted', marks: '1/3' })));
    await startDrill(api, { decks: ['S&D-1', 'S&D-2'] });
    expect((await hub.calls('^chat:drill$'))[0].prompt).toContain('- nothing yet: this is the first question.');
    await apiTutor(api, { mode: 'drill_reply', question: 'one' });
    await apiTutor(api, { mode: 'drill_reply', question: 'two' });
    const [, second] = await hub.calls('^chat:drill_reply$');
    expect(second.prompt).toContain('- Phase 1');
    expect(second.prompt).toContain('- Q1 [S&D-1] Equilibrium price: 1/3, hinted');
    expect(second.prompt).toContain('- Decks not asked yet: S&D-2');
    expect(second.prompt).toContain('- Weak list (Phase 2 only): Equilibrium price [S&D-1]');
    expect(second.prompt).toContain('- Next question number: Q2');
  });

  const cases: [string, Record<string, unknown>, (hub: Hub) => void][] = [
    ['solo, no mistake, full marks: the deck is solved, nothing saved', { outcome: 'solo', mistake: 'none', marks: '3/3' },
      (hub) => { expect(reviewsOnDisk(hub)).toEqual([]); expect(readState(hub).decks['S&D-1'].solved).toBe(true); }],
    ['solo, no mistake, unreadable marks: solved', { outcome: 'solo', mistake: 'none', marks: 'full' },
      (hub) => { expect(reviewsOnDisk(hub)).toEqual([]); expect(readState(hub).decks['S&D-1'].solved).toBe(true); }],
    ['skipped: nothing', { outcome: 'skipped', mistake: 'none' },
      (hub) => { expect(reviewsOnDisk(hub)).toEqual([]); expect(readState(hub).decks?.['S&D-1']?.solved ?? false).toBe(false); }],
    ['revealed with no mistake: "No attempt"', { outcome: 'revealed', mistake: 'none' },
      (hub) => expect(reviewsOnDisk(hub)[0].mistake).toBe('No attempt')],
    ['hinted with no mistake: "Needed hints"', { outcome: 'hinted', mistake: 'none' },
      (hub) => expect(reviewsOnDisk(hub)[0].mistake).toBe('Needed hints')],
    ['solo with marks lost: "Skipped step"', { outcome: 'solo', mistake: 'none', marks: '2/3' },
      (hub) => { expect(reviewsOnDisk(hub)[0].mistake).toBe('Skipped step'); expect(readState(hub).decks?.['S&D-1']?.solved ?? false).toBe(false); }],
    ['the record\'s own mistake type', { outcome: 'solo', mistake: 'Method choice', marks: '1/3' },
      (hub) => expect(reviewsOnDisk(hub)[0].mistake).toBe('Method choice')],
    ['a deck outside the range: the item has no deck', { deck: 'HW-1', outcome: 'hinted', mistake: 'Setup' },
      (hub) => expect(reviewsOnDisk(hub)[0].deck).toBeNull()],
    ['no question text: nothing', { outcome: 'hinted', mistake: 'Setup', problem: '' },
      (hub) => expect(reviewsOnDisk(hub)).toEqual([])],
  ];
  for (const [name, rec, check] of cases) {
    test(`DRILL-040 DECK-002 a closed question, ${name}`, async ({ api, hub }) => {
      skipNearMidnight(test);
      await hub.script(drillRules(drillReply(rec)));
      await startDrill(api);
      await apiTutor(api, { mode: 'drill_reply', question: 'my answer' });
      check(hub);
      for (const it of reviewsOnDisk(hub)) expect(it).toMatchObject({ step: 0, due: iso(1) });
    });
  }
});
