/**
 * 04 Voice — ▶ Play on a finished answer.
 * Spec: docs/functional-spec/04-voice.md §4 and VOICE-047 (VOICE-028..032, 047).
 */
import { test, expect } from '../../fixtures/hub';
import * as V from './helpers';

const playOf = (page: any, i: number) => V.answers(page).nth(i).getByRole('button', { name: /^(▶ Play|■ Stop)$/ });

/** Text mode, the panel open, two finished answers (long ones, read slowly). */
async function twoAnswers(page: any, hub: any) {
  await hub.script([
    V.answerRule(V.longAnswer('First', 8), '^chat:ask$', 1),
    V.answerRule(V.longAnswer('Second', 8), '^chat:ask$', 1),
  ]);
  await V.countPlays(page);
  await V.slowVoice(page, 1500);
  await V.openDeck(page);
  await V.openTutor(page);
  await V.ask(page, 'first');
  await expect(V.answers(page)).toHaveCount(1);
  await V.ask(page, 'second');
  await expect(V.answers(page)).toHaveCount(2);
  await expect(playOf(page, 1)).toBeVisible();
}

test.describe('▶ Play', () => {
  test('VOICE-028 every finished answer has ▶ Play, in Text and Voice modes and after a reload', async ({ page, hub }) => {
    await twoAnswers(page, hub);
    await expect(playOf(page, 0)).toHaveText('▶ Play');
    await expect(playOf(page, 1)).toHaveText('▶ Play');
    await expect(playOf(page, 0)).toHaveAttribute('title', 'Read this answer aloud');
    await V.voiceRadio(page).click();
    await expect(playOf(page, 0)).toHaveText('▶ Play');
    await expect(playOf(page, 1)).toHaveText('▶ Play');
    await page.reload();
    await V.openTutor(page);
    await expect(V.answers(page)).toHaveCount(2);
    await expect(playOf(page, 0)).toHaveText('▶ Play');
    await expect(playOf(page, 1)).toHaveText('▶ Play');
  });

  test('VOICE-029 ▶ Play reads the whole answer with the highlight, shows ■ Stop meanwhile, and a second press stops', async ({ page, hub }) => {
    await twoAnswers(page, hub);
    const before = await V.answers(page).nth(0).innerText();
    await playOf(page, 0).click();
    await expect(playOf(page, 0)).toHaveText('■ Stop');
    await expect(V.voiceState(page)).toHaveText('Speaking…');
    // the text is already all there and does not re-appear
    await expect(V.answers(page).nth(0)).toContainText('First sentence number 8');
    await expect(page.locator('#thread .ans .spoken').first()).toContainText('First sentence number 1'); // locator: markup hook
    expect(await V.spokenText(hub)).toContain('First sentence number 1');
    await playOf(page, 0).click();
    await expect(playOf(page, 0)).toHaveText('▶ Play');
    await expect(V.voiceRow(page)).toBeHidden();
    await expect(page.locator('#thread .spoken')).toHaveCount(0); // locator: markup hook
    const n = await V.plays(page);
    await page.waitForTimeout(2000);
    expect(await V.plays(page)).toBe(n);
    expect((await V.answers(page).nth(0).innerText()).replace(/■ Stop|▶ Play/g, '')).toBe(before.replace(/■ Stop|▶ Play/g, ''));
  });

  test('VOICE-029 when the reading ends by itself the label returns to ▶ Play', async ({ page, hub }) => {
    await hub.script([V.answerRule('One short answer.')]);
    await V.slowVoice(page, 800);
    await V.openDeck(page);
    await V.openTutor(page);
    await V.ask(page, 'q');
    await V.lastPlay(page).click();
    await expect(V.lastPlay(page)).toHaveText('■ Stop');
    await expect(V.lastPlay(page)).toHaveText('▶ Play', { timeout: 10_000 });
    await expect(V.voiceRow(page)).toBeHidden();
    expect((await hub.spoken()).map((r) => r.text)).toEqual(['One short answer.']);
  });

  test('VOICE-030 ▶ Play on another answer stops the current reading first', async ({ page, hub }) => {
    await twoAnswers(page, hub);
    await playOf(page, 0).click();
    await expect(V.voiceState(page)).toHaveText('Speaking…');
    await playOf(page, 1).click();
    await expect(playOf(page, 0)).toHaveText('▶ Play');
    await expect(playOf(page, 1)).toHaveText('■ Stop');
    await expect.poll(() => V.spokenText(hub)).toContain('Second sentence number 1');
    await expect(page.locator('#thread .ans').nth(0).locator('.spoken')).toHaveCount(0); // locator: markup hook
    await expect(page.locator('#thread .ans').nth(1).locator('.spoken').first()).toBeVisible(); // locator: markup hook
  });

  test('VOICE-031 ▶ Play survives a redraw of the chat: still ■ Stop, and still stops', async ({ page, hub }) => {
    await twoAnswers(page, hub);
    await playOf(page, 0).click();
    await expect(V.voiceState(page)).toHaveText('Speaking…');
    await page.getByRole('button', { name: 'Read', exact: true }).click(); // the reading view redraws the chat
    await expect(playOf(page, 0)).toHaveText('■ Stop');
    await expect(V.voiceState(page)).toHaveText('Speaking…');
    await playOf(page, 0).click();
    await expect(playOf(page, 0)).toHaveText('▶ Play');
    await expect(V.voiceRow(page)).toBeHidden();
  });

  test('VOICE-032 VOICE-047 ▶ Play when the voice fails says "Voice isn\'t available right now." every time', async ({ page, hub }) => {
    await hub.script([V.answerRule('Cannot be said.')]);
    await page.route('**/api/voice/speak', (route) => route.fulfill({ status: 503, json: { error: 'The voice failed.' } }));
    await V.openDeck(page);
    await V.openTutor(page);
    await V.ask(page, 'q');
    for (let i = 0; i < 2; i++) {
      await V.lastPlay(page).click();
      await expect(V.toast(page, "Voice isn't available right now.")).toBeVisible();
      await expect(V.lastPlay(page)).toHaveText('▶ Play');
      await expect(V.voiceRow(page)).toBeHidden();
      await expect(V.toast(page, "Voice isn't available right now.")).toHaveCount(0, { timeout: 5000 });
    }
  });
});
