/**
 * 02 · Side questions (docs/functional-spec/02-tutor-and-chats.md §5: SIDE-*): a sheet over the panel, about a tapped
 * term or a selection, that knows the chat but never joins it.
 */
import { test, expect } from '../../fixtures/hub';
import type { Page } from '@playwright/test';
import {
  SD1_S2, HW1, S2_REF, questions, answers, sideSheets, openPanel, ask, settled, rule, held, onlyChat, scope, blur,
  devices, closeAll, openTutor,
} from './helpers';

const CHAT_ANSWER = 'At the [[equilibrium]] the price $P^* = 10$ clears the market.\n\nSecond paragraph about SELECT-ME demand.';

/** A chat answer with a tappable term, then the side answers as scripted. */
async function chatWithTerm(page: Page, hub: import('../../fixtures/hub').Hub, side: import('../../fixtures/hub').Rule[] = []) {
  await hub.script([...side, rule('^chat:ask$', { text: CHAT_ANSWER })]);
  await openPanel(page);
  await ask(page, 'Explain equilibrium');
  await settled(page);
}
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Side question' });
const sideBox = (page: Page) => sheet(page).getByRole('textbox', { name: 'Side question' });

/** Select a piece of text inside an element (as a mouse drag would). */
async function selectText(page: Page, within: import('@playwright/test').Locator, text: string) {
  await within.evaluate((root, t) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.nodeValue!.indexOf(t);
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i); r.setEnd(n, i + t.length);
        const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
        return;
      }
    }
    throw new Error('text not found: ' + t);
  }, text);
}

test.describe('opening a side question', () => {
  test('SIDE-001 tapping a term opens a side sheet and explains just that term', async ({ page, hub }) => {
    await chatWithTerm(page, hub, [{ match: { label: '^side$' }, reply: { wait_for: 's', status: ['Reading the S&D-1 slides'],
      chunks: ['Side answer ', 'SIDE-OK'], chunk_delay_ms: 1200, text: 'Side answer SIDE-OK' } }]);
    await answers(page).first().getByRole('button', { name: 'equilibrium' }).click();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page)).toContainText(/On the side · not added to your chat/i);
    await expect(sheet(page).locator('.side-anchor')).toHaveText('equilibrium'); // locator: markup hook
    await expect(sheet(page).locator('.waiting')).toHaveText('Thinking…'); // locator: markup hook
    await hub.release('s');
    await expect(sheet(page).locator('.waiting')).toHaveText('Reading the S&D-1 slides…'); // locator: markup hook
    await expect(sheet(page)).toContainText('Side answer');
    await expect(sheet(page)).toContainText('SIDE-OK');
    const [c] = await hub.calls('^side$');
    expect(c.prompt).toContain('"equilibrium"');
    expect(c.prompt).toContain('clears the market');
    expect(c.prompt).toContain(S2_REF.split(' "')[0]);
  });

  test('SIDE-002 a selection offers "Ask about this"; the sheet quotes it and waits for the question', async ({ page, hub }) => {
    await chatWithTerm(page, hub, [rule('^side$', { text: 'About the selection SEL-OK' })]);
    await selectText(page, answers(page).first(), 'SELECT-ME demand');
    const btn = page.getByRole('button', { name: 'Ask about this' });
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).locator('.side-anchor')).toContainText('SELECT-ME demand'); // locator: markup hook
    await expect(sideBox(page)).toHaveAttribute('placeholder', 'What do you want to know about this?');
    await expect(sideBox(page)).toBeFocused();
    await page.waitForTimeout(500);
    expect(await hub.calls('^side$')).toHaveLength(0);
    await sideBox(page).fill('What does it mean?');
    await sideBox(page).press('Enter');
    await expect(sheet(page)).toContainText('SEL-OK');
    const [c] = await hub.calls('^side$');
    expect(c.prompt).toContain('SELECT-ME demand');
    expect(c.prompt).toContain('What does it mean?');
  });

  test('SIDE-002 a selected formula is quoted as its $…$ source', async ({ page, hub }) => {
    await chatWithTerm(page, hub, [rule('^side$', { text: 'Formula side' })]);
    await answers(page).first().locator('p').first().evaluate((p) => {
      const r = document.createRange();
      r.selectNodeContents(p);
      const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
    });
    await page.getByRole('button', { name: 'Ask about this' }).click();
    await sideBox(page).fill('Why?');
    await sideBox(page).press('Enter');
    await expect(sheet(page)).toContainText('Formula side');
    const [c] = await hub.calls('^side$');
    expect(c.prompt).toContain('$P^* = 10$');
  });
});

test.describe('inside a side question', () => {
  test('SIDE-003 follow-ups continue the same side conversation; Shift+Enter makes a new line', async ({ page, hub }) => {
    await chatWithTerm(page, hub, [
      { match: { label: '^side$' }, times: 1, reply: { text: 'First side answer FIRST-SIDE' } },
      { match: { label: '^side$' }, times: 1, reply: { text: 'Follow-up answer FOLLOW-SIDE' } },
    ]);
    await answers(page).first().getByRole('button', { name: 'equilibrium' }).click();
    await expect(sheet(page)).toContainText('FIRST-SIDE');
    await expect(sideBox(page)).toHaveAttribute('placeholder', 'Ask a follow-up');
    await sideBox(page).fill('And');
    await sideBox(page).press('Shift+Enter');
    await sideBox(page).pressSequentially('then?');
    await expect(sideBox(page)).toHaveValue('And\nthen?');
    await sheet(page).getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(sheet(page)).toContainText('FOLLOW-SIDE');
    await expect(sheet(page)).toContainText('FIRST-SIDE');
    const calls = await hub.calls('^side$');
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain('And\nthen?');
    expect(calls[1].session).toBeTruthy();
    expect(calls[1].fork).toBe(false);
  });

  test('SIDE-003 a follow-up sent while the side answer is still being written is answered after it', async ({ page, hub }) => {
    test.fail(true, 'BROKEN in current app: a side follow-up typed while the side answer streams is silently dropped (and '
      + 'its text lost); see "Known issues" in docs/functional-spec/02-tutor-and-chats.md (SIDE-003)');
    await chatWithTerm(page, hub, [held('s', 'Slow side answer', '^side$'), rule('^side$', { text: 'Queued follow-up answer QUEUED' })]);
    await answers(page).first().getByRole('button', { name: 'equilibrium' }).click();
    await expect(sheet(page)).toBeVisible();
    await sideBox(page).fill('Typed too early');
    await sideBox(page).press('Enter');
    await hub.release('s');
    await expect(sheet(page)).toContainText('Slow side answer');
    await expect(sheet(page)).toContainText('QUEUED', { timeout: 5000 });
  });

  test('SIDE-004 a side question forks the chat\'s conversation but nothing joins the chat or other devices', async ({ browser, hub }) => {
    const [d1, d2] = await devices(browser, hub, 2);
    await hub.script([rule('^chat:ask$', { text: CHAT_ANSWER }), rule('^side$', { text: 'Private side PRIVATE-SIDE' })]);
    await ask(d1.page, 'Explain equilibrium');
    await settled(d1.page);
    await expect(answers(d2.page)).toHaveCount(1);
    const before = JSON.stringify(onlyChat(hub));
    await answers(d1.page).first().getByRole('button', { name: 'equilibrium' }).click();
    await expect(sheet(d1.page)).toContainText('PRIVATE-SIDE');
    const [c] = await hub.calls('^side$');
    expect(c.fork).toBe(true);
    expect(c.session).toBe(onlyChat(hub).session);
    await d1.page.waitForTimeout(500);
    expect(JSON.stringify(onlyChat(hub))).toEqual(before);
    await expect(d2.page.getByText('PRIVATE-SIDE')).toHaveCount(0);
    await expect(sideSheets(d2.page)).toHaveCount(0);
    await expect(questions(d1.page)).toHaveCount(1);
    await closeAll([d1, d2]);
  });

  test('SIDE-005 a term in a side answer opens a nested sheet; ‹ and Esc go back one level', async ({ page, hub }) => {
    await chatWithTerm(page, hub, [
      { match: { label: '^side$' }, times: 1, reply: { text: 'Level one: see [[surplus]] LEVEL-ONE' } },
      { match: { label: '^side$' }, times: 2, reply: { text: 'Level two LEVEL-TWO' } },
    ]);
    await answers(page).first().getByRole('button', { name: 'equilibrium' }).click();
    await expect(sheet(page)).toContainText('LEVEL-ONE');
    await expect(sheet(page).getByRole('button', { name: 'Back to the previous side question' })).toHaveCount(0);
    await sheet(page).getByRole('button', { name: 'surplus' }).click();
    await expect(sheet(page)).toContainText('LEVEL-TWO');
    await expect(sheet(page).locator('.side-anchor')).toHaveText('surplus'); // locator: markup hook
    await sheet(page).getByRole('button', { name: 'Back to the previous side question' }).click();
    await expect(sheet(page)).toContainText('LEVEL-ONE');
    await expect(sheet(page).locator('.side-anchor')).toHaveText('equilibrium'); // locator: markup hook
    await sheet(page).getByRole('button', { name: 'surplus' }).click();
    await expect(sheet(page)).toContainText('LEVEL-TWO');
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toContainText('LEVEL-ONE');
    await page.keyboard.press('Escape');
    await expect(sideSheets(page)).toHaveCount(0);
  });

  test('SIDE-008 a failed side answer shows its error in the sheet', async ({ page, hub }) => {
    await chatWithTerm(page, hub, [rule('^side$', { error: 'Claude reported an error. Try again in a moment.' })]);
    await answers(page).first().getByRole('button', { name: 'equilibrium' }).click();
    await expect(sheet(page).locator('p.err')).toHaveText('Claude reported an error. Try again in a moment.'); // locator: markup hook
  });

  test('SIDE-008 ERR-002 a side answer failing unexpectedly shows "Something went wrong. Try again." in the sheet', async ({ page, hub }) => {
    await chatWithTerm(page, hub, [rule('^side$', { crash: true })]);
    await answers(page).first().getByRole('button', { name: 'equilibrium' }).click();
    await expect(sheet(page).locator('p.err')).toHaveText('Something went wrong. Try again.'); // locator: markup hook
  });
});

test.describe('closing side questions', () => {
  test('SIDE-006 × closes the side question and ends it on the hub; a follow-up on it is refused', async ({ page, hub, api }) => {
    await chatWithTerm(page, hub, [rule('^side$', { text: 'Closing side' })]);
    await answers(page).first().getByRole('button', { name: 'equilibrium' }).click();
    await expect(sheet(page)).toContainText('Closing side');
    const closed = page.waitForRequest((r) => r.url().includes('/api/side/close'));
    await sheet(page).getByRole('button', { name: 'Close the side question' }).click();
    const sideId = (await closed).postDataJSON().side;
    expect(sideId).toMatch(/^[0-9a-f]{12}$/);
    await expect(sideSheets(page)).toHaveCount(0);
    const r = await api.post('/api/side', { data: { course: 'Demo-Course', tag: 'S&D-1', n: 2, side: sideId, question: 'more?' } });
    expect(r.status()).toBe(410);
    expect((await r.json()).error).toBe('That side question was closed. Ask it again.');
  });

  test('SIDE-006 Esc on the last sheet, or a tap on the chat above, closes it', async ({ page, hub }) => {
    await chatWithTerm(page, hub, [rule('^side$', { text: 'Side text' })]);
    await answers(page).first().getByRole('button', { name: 'equilibrium' }).click();
    await expect(sheet(page)).toContainText('Side text');
    await page.keyboard.press('Escape');
    await expect(sideSheets(page)).toHaveCount(0);
    await answers(page).first().getByRole('button', { name: 'equilibrium' }).click();
    await expect(sheet(page)).toContainText('Side text');
    await page.locator('#thread').click({ position: { x: 10, y: 10 } }); // locator: markup hook (the chat above the sheet)
    await expect(sideSheets(page)).toHaveCount(0);
  });

  test('SIDE-007 a side question survives a scope switch, the reading view and a slide change in the deck', async ({ page, hub }) => {
    await chatWithTerm(page, hub, [rule('^side$', { text: 'Survivor SURVIVES' })]);
    await answers(page).first().getByRole('button', { name: 'equilibrium' }).click();
    await expect(sheet(page)).toContainText('SURVIVES');
    await scope(page, 'Whole deck');
    await expect(sheet(page)).toContainText('SURVIVES');
    await blur(page);
    await page.keyboard.press('r');          // the reading view (R)
    await expect(page.locator('.viewer')).toHaveClass(/reading/); // locator: markup hook
    await expect(sheet(page)).toContainText('SURVIVES');
    await page.keyboard.press('r');
    await expect(page.locator('.viewer')).not.toHaveClass(/reading/); // locator: markup hook
    await page.locator('#next').click(); // locator: markup hook (next-slide arrow)
    await expect(page.locator('#counter')).toHaveText('3 / 3'); // locator: markup hook
    await expect(sheet(page)).toContainText('SURVIVES');
  });

  test('SIDE-007 a side question survives the Read button', async ({ page, hub }) => {
    test.fail(true, 'BROKEN in current app: clicking Read counts as "a tap on the chat above the sheet" and closes the '
      + 'side question (the R key keeps it); docs/functional-spec/02-tutor-and-chats.md SIDE-007 says it survives the reading view');
    await chatWithTerm(page, hub, [rule('^side$', { text: 'Survivor SURVIVES' })]);
    await answers(page).first().getByRole('button', { name: 'equilibrium' }).click();
    await expect(sheet(page)).toContainText('SURVIVES');
    await page.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(page.locator('.viewer')).toHaveClass(/reading/); // locator: markup hook
    await expect(sheet(page)).toContainText('SURVIVES', { timeout: 3000 });
  });

  test('SIDE-007 a side question is closed when the deck changes or the panel closes', async ({ page, hub }) => {
    await chatWithTerm(page, hub, [rule('^side$', { text: 'Short-lived' })]);
    await answers(page).first().getByRole('button', { name: 'equilibrium' }).click();
    await expect(sheet(page)).toContainText('Short-lived');
    await page.getByRole('button', { name: 'Close the tutor' }).click();
    await openTutor(page);
    await expect(sideSheets(page)).toHaveCount(0);
    await answers(page).first().getByRole('button', { name: 'equilibrium' }).click();
    await expect(sheet(page)).toContainText('Short-lived');
    await page.evaluate((h) => { location.hash = h; }, HW1);
    await expect(page.locator('#counter')).toHaveText('1 / 2'); // locator: markup hook
    await expect(sideSheets(page)).toHaveCount(0);
  });
});
void SD1_S2;
