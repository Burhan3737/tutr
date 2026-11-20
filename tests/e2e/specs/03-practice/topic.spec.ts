/**
 * 03 · Practice by topic: starting it, the hidden plan line, the chat-bar status, moving on with "done", finishing,
 * and the slides-only rule.  Spec: docs/functional-spec/03-practice-reviews-drills.md (TOPIC-*)
 *
 * Not covered:
 *   TOPIC-003 the fixed per-topic format itself (model-dependent); the prompt asking for it is pinned loosely.
 */
import { test, expect } from '../../fixtures/hub';
import type { Hub } from '../../fixtures/hub';
import type { APIRequestContext, Page } from '@playwright/test';
import {
  DEMO, HW1, PLAN2, apiTutor, ask, askBox, openSlide, openTutor, panel, planLine, readState, topicFirstTurn,
} from './helpers';

const status = (page: Page) => page.getByText(/^Practice · /);
const NEXT_TOPIC = 'Supply topic text.\n\n#### Topic 2 · Supply: concepts\n\nSay **done** when you\'ve finished, and we\'ll wrap up the deck.';
const rules = (first = topicFirstTurn()) => [
  { match: { label: '^chat:practice$' }, reply: { text: first } },
  { match: { label: '^chat:practice_reply$' }, reply: { text: NEXT_TOPIC } },
];

async function startTopicPractice(page: Page, hash?: string) {
  await openSlide(page, hash);
  await openTutor(page);
  await page.getByRole('button', { name: 'Practice by topic' }).click();
  await expect(panel(page)).toContainText('Topic 1 · Demand: concepts');
}
async function apiStart(api: APIRequestContext, tag = 'S&D-1', question = '') {
  const r = await apiTutor(api, { mode: 'practice', question, tag });
  expect(r.status()).toBe(200);
  return r.json();
}
const chatOf = (hub: Hub) => hub.readJson(DEMO, 'me', 'chats', `${readState(hub).chat}.json`);

test('TOPIC-001 TOPIC-003 TOPIC-004 TOPIC-005 starting: a new chat on the whole deck, the plan hidden, the status bar', async ({ page, hub }) => {
  await hub.script([{ match: { label: '^chat:explain$' }, reply: { text: 'OLD-ANSWER' } }, ...rules()]);
  await openSlide(page);
  await openTutor(page);
  await page.getByRole('button', { name: 'Explain simply' }).click();
  await expect(panel(page)).toContainText('OLD-ANSWER');
  const old = readState(hub).chat;
  await page.getByRole('button', { name: 'Practice by topic' }).click();
  await expect(panel(page)).toContainText('Topic 1 · Demand: concepts');
  await expect(panel(page)).not.toContainText('OLD-ANSWER');
  await expect(panel(page)).not.toContainText('<!--practice');
  await expect(panel(page).locator('.msg-q').last()).toContainText('Practice by topic');   // locator: markup hook
  await expect(status(page)).toHaveText('Practice · S&D-1 · Demand (1/2)');
  await expect(status(page)).toHaveAttribute('title', '1. Demand (s1–s2)\n2. Supply (s3)');
  const chat = chatOf(hub);
  expect(chat.id).not.toBe(old);
  expect(chat.title).toBe('Practice by topic · S&D-1');
  expect(chat.practice).toMatchObject({ deck: 'S&D-1', at: 0, topics: [
    { k: 1, name: 'Demand', slides: 's1–s2', problems: ['(a) Equilibrium, s2'] }, { k: 2, name: 'Supply', slides: 's3', problems: [] }] });
  expect(chat.messages[chat.messages.length - 1].text).not.toContain('<!--practice');
  // the prompt asks for the plan table and the hidden plan line
  const [c] = await hub.calls('^chat:practice$');
  expect(c.prompt).toContain('| # | Topic | Slides | Numerical problems | Concept / MCQ areas |');
  expect(c.prompt).toMatch(/<!--practice/);
});

test('TOPIC-004 the Answer disclosure renders collapsed and opens on click', async ({ page, hub }) => {
  await hub.script(rules());
  await startTopicPractice(page);
  const answer = panel(page).getByText('P = 20 (HIDDEN-ANSWER)');
  await expect(answer).toBeHidden();
  await panel(page).locator('summary', { hasText: 'Answer' }).click();   // locator: markup hook (<details> disclosure)
  await expect(answer).toBeVisible();
});

test('TOPIC-001 /practice with words passes them to the model and shows them on the question line', async ({ page, hub }) => {
  await hub.script(rules());
  await openSlide(page);
  await openTutor(page);
  await ask(page, '/practice only the graphs');
  await expect(panel(page)).toContainText('Topic 1 · Demand');
  await expect(panel(page).locator('.msg-q').last()).toContainText('Practice by topic: only the graphs');   // locator: markup hook
  expect((await hub.calls('^chat:practice$'))[0].prompt).toContain('only the graphs');
});

test('TOPIC-006 TOPIC-009 "Done › next topic", then "Done › finish the deck", then finished', async ({ page, hub }) => {
  await hub.script([{ match: { label: '^chat:practice$' }, reply: { text: topicFirstTurn() } },
    { match: { label: '^chat:practice_reply$' }, times: 1, reply: { text: NEXT_TOPIC } },
    { match: { label: '^chat:practice_reply$' }, reply: { text: 'Every topic is covered. DECK-WRAPPED.' } }]);
  await startTopicPractice(page);
  await expect(askBox(page)).toHaveAttribute('placeholder', 'done, or ask about this topic');
  await page.getByRole('button', { name: 'Done › next topic' }).click();
  await expect(panel(page)).toContainText('Topic 2 · Supply: concepts');
  await expect(panel(page).locator('.msg-q').last()).toContainText('done');   // locator: markup hook
  await expect(status(page)).toHaveText('Practice · S&D-1 · Supply (2/2)');
  const [first] = await hub.calls('^chat:practice_reply$');
  expect(first.prompt).toMatch(/Topic 2/);
  expect(first.prompt).toContain('Supply');
  expect(first.prompt).toContain("wrap up the deck");
  await page.getByRole('button', { name: 'Done › finish the deck' }).click();
  await expect(panel(page)).toContainText('DECK-WRAPPED');
  await expect(status(page)).toHaveText('Practice · S&D-1 · all 2 topics done');
  await expect(page.getByRole('button', { name: /^Done ›/ })).toHaveCount(0);
  await expect(askBox(page)).toHaveAttribute('placeholder', 'Ask anything about this slide, or / for a mode');
  const chat = chatOf(hub);
  expect(chat.practice).toMatchObject({ at: 1, finished: true });
});

test('TOPIC-006 anything else is answered inside the current topic without moving on', async ({ api, hub }) => {
  await hub.script(rules());
  await apiStart(api);
  const r = await (await apiTutor(api, { mode: 'practice_reply', question: 'what is next?' })).json();
  expect(r.practice.at).toBe(0);
  const [c] = await hub.calls('^chat:practice_reply$');
  expect(c.prompt).toContain('what is next?');
  expect(c.prompt).toContain("Say **done** when you're ready, and we'll move on to Topic 2: Supply");
});

const DONE = ['done', 'Done.', 'next?', 'I’m done', "i'm done", 'okay done', 'Done, thanks', 'ok, next topic', 'yes I am finished',
  'move on please', 'go on', 'continue!', 'next one', 'alright, im done, thank you', '  DONE  '];
const NOT_DONE = ['not done', 'what is next?', 'done with step 2, but why…', 'done done', 'next slide'];
test('TOPIC-006 what counts as "done"', async ({ api, hub }) => {
  test.setTimeout(90_000);
  await hub.script(rules());
  for (const q of [...DONE, ...NOT_DONE]) {
    await apiStart(api);
    const r = await (await apiTutor(api, { mode: 'practice_reply', question: q })).json();
    expect.soft(r.practice.at, `"${q}"`).toBe(DONE.includes(q) ? 1 : 0);
  }
});

test('TOPIC-006 two "done"s sent at the same time advance only one topic', async ({ api, hub }) => {
  const three = [...PLAN2, { k: 3, name: 'Shifts', slides: 's3', problems: [] }];
  await hub.script([{ match: { label: '^chat:practice$' }, reply: { text: topicFirstTurn(three) } },
    { match: { label: '^chat:practice_reply$' }, reply: { text: 'next', wait_for: 'both' } }]);
  await apiStart(api);
  const a = apiTutor(api, { mode: 'practice_reply', question: 'done' });
  const b = apiTutor(api, { mode: 'practice_reply', question: 'done' });
  await expect.poll(async () => (await hub.calls('^chat:practice_reply$')).length).toBe(2);
  await hub.release('both');
  await Promise.all([a, b]);
  expect(chatOf(hub).practice.at).toBe(1);
});

test('TOPIC-007 without a readable plan line: plain status, "done" asks for the next topic of the plan and never advances', async ({ page, hub }) => {
  // pinned as the spec describes it (TOPIC-007): without a stored plan the session never advances or finishes
  const broken = topicFirstTurn(PLAN2, false) + '<!--practice {"topics": [ broken -->';
  await hub.script([{ match: { label: '^chat:practice$' }, reply: { text: broken } },
    { match: { label: '^chat:practice_reply$' }, reply: { text: 'Some next topic.' } }]);
  await startTopicPractice(page);
  await expect(panel(page)).not.toContainText('<!--practice');
  await expect(panel(page)).not.toContainText('broken');
  await expect(status(page)).toHaveText('Practice · S&D-1');
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Done › next topic' }).click();
    await expect(page.getByRole('button', { name: 'Done › next topic' })).toBeVisible();
  }
  const calls = await hub.calls('^chat:practice_reply$');
  expect(calls).toHaveLength(3);
  expect(calls[0].prompt).toMatch(/next topic of your plan/);
  const chat = chatOf(hub);
  expect(chat.practice.topics).toEqual([]);
  expect(chat.practice.at).toBe(0);
  expect(chat.practice.finished ?? false).toBe(false);
});

test('TOPIC-004 the first readable plan wins; later plan lines are ignored but still hidden', async ({ api, hub }) => {
  await hub.script([{ match: { label: '^chat:practice$' }, reply: { text: topicFirstTurn() } },
    { match: { label: '^chat:practice_reply$' }, reply: { text: 'More.\n' + planLine([{ name: 'Other' }]) } }]);
  await apiStart(api);
  const r = await (await apiTutor(api, { mode: 'practice_reply', question: 'why?' })).json();
  expect(r.message.text).not.toContain('<!--practice');
  expect(r.practice.topics.map((t: any) => t.name)).toEqual(['Demand', 'Supply']);
});

test('TOPIC-008 topics without numbers count from 1, or from 0 when the first is an overview', async ({ api, hub }) => {
  for (const [first, want] of [['Basics', 'Topic 2'], ['Overview of the deck', 'Topic 1']] as const) {
    await hub.script([{ match: { label: '^chat:practice$' }, reply: { text: 'x\n' + planLine([{ name: first, slides: 's1' },
      { name: 'Second', slides: 's2' }, { name: 'Third', slides: 's3' }]) } },
    { match: { label: '^chat:practice_reply$' }, reply: { text: 'y' } }]);
    await apiStart(api);
    await apiTutor(api, { mode: 'practice_reply', question: 'done' });
    const calls = await hub.calls('^chat:practice_reply$');
    const p = calls[calls.length - 1].prompt;
    expect(p).toContain(want);
    expect(p).toContain('Second');
  }
});

test('TOPIC-002 every turn of a topic practice is slides-only, also ordinary questions and after it finished', async ({ page, hub }) => {
  await hub.script([{ match: { label: '^chat:practice$' }, reply: { text: topicFirstTurn([{ k: 1, name: 'Only', slides: 's1', problems: [] }]) } },
    { match: { label: '^chat:practice_reply$' }, reply: { text: 'All covered.' } },
    { match: { label: '^chat:ask$' }, reply: { text: 'An ordinary answer.' } }]);
  await startTopicPractice(page);
  await page.getByRole('button', { name: 'Done › finish the deck' }).click();
  await expect(panel(page)).toContainText('All covered.');
  await ask(page, 'a normal question afterwards');
  await expect(panel(page)).toContainText('An ordinary answer.');
  const calls = await hub.calls('^chat:');
  expect(calls.map((c) => c.label)).toEqual(['chat:practice', 'chat:practice_reply', 'chat:ask']);
  expect(calls.every((c) => c.web === false)).toBe(true);
});

test('TOPIC-002 a topic practice stays on the deck it started on, whichever deck is open later', async ({ api, hub }) => {
  await hub.script([{ match: { label: '^chat:practice' }, reply: { text: topicFirstTurn() } }]);
  await apiStart(api, 'S&D-1');
  await apiTutor(api, { mode: 'practice_reply', question: 'why?', tag: 'HW-1', n: 1 });
  const [, reply] = await hub.calls('^chat:practice');
  expect(reply.system).toContain('S&D-1');
  expect(reply.web).toBe(false);
  expect(chatOf(hub).practice.deck).toBe('S&D-1');
});

test('TOPIC-010 a topic-practice reply on a chat without one is refused', async ({ api, hub }) => {
  await hub.script([{ match: { label: '^chat:' }, reply: { text: 'ok' } }]);
  await apiTutor(api, { mode: 'explain' });
  const r = await apiTutor(api, { mode: 'practice_reply', question: 'done' });
  expect(r.status()).toBe(400);
  expect((await r.json()).error).toBe('No practice is running in this chat. Start one with Practice by topic.');
});

test('DECK-001 Practice by topic works on a practice deck', async ({ page, hub }) => {
  await hub.script(rules());
  await startTopicPractice(page, HW1);
  await expect(status(page)).toHaveText('Practice · HW-1 · Demand (1/2)');
  expect(chatOf(hub).title).toBe('Practice by topic · HW-1');
});
