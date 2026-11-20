/**
 * 02 · The tutor panel (docs/functional-spec/02-tutor-and-chats.md §1): ask bar, panel, scope, quick actions, Ask box,
 * slash commands, bubbles, fold, copy, print, reading view, width, keyboard safety, Grill me.
 *
 * Covered elsewhere: TUT-013 (photos.spec.ts), TUT-017 photo thumbnails (photos.spec.ts), 🎙 bubbles (live.spec.ts).
 */
import { test, expect } from '../../fixtures/hub';
import {
  DEMO, SD1, SD1_S2, HW1, S2_REF, askBox, askButton, questions, answers, waiting, feet, panel, toast, thread,
  openSlide, openTutor, openPanel, ask, askAndSettle, settled, qText, action, scope, blur, stubPrint, clipboard,
  rule, held, onlyChat, callsAtLeast, MEMORY_NOOP, seedWith, chatFile, hubState,
} from './helpers';

const NORMAL_HINT = 'Ask anything about this slide, or / for a mode';
const GRILL_HINT = 'Your answer, or "stuck" / "stop"';

test.describe('ask bar and panel', () => {
  test('TUT-001 a slide opens with the tutor closed as an ask bar, also after a reload', async ({ page }) => {
    await openSlide(page);
    const t = panel(page);
    await expect(t).toContainText('✦');
    await expect(askBox(page)).toBeVisible();
    await expect(t.getByRole('button', { name: 'Attach a photo' })).toBeVisible();
    await expect(t.getByRole('button', { name: 'Dictate' })).toBeVisible();
    await expect(askButton(page)).toBeVisible();
    await expect(t.getByRole('button', { name: 'Open the tutor' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Tutor' })).toHaveCount(0);
    await openTutor(page);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Open the tutor' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Tutor' })).toHaveCount(0);
  });

  test('TUT-002 the ask bar hint names the slide and follows it', async ({ page }) => {
    await openSlide(page);
    await expect(askBox(page)).toHaveAttribute('placeholder', 'Ask about slide 2… or / for a mode');
    await blur(page);
    await page.keyboard.press('ArrowRight');
    await expect(askBox(page)).toHaveAttribute('placeholder', 'Ask about slide 3… or / for a mode');
  });

  test('TUT-003 sending from the ask bar opens the panel with the question answered there', async ({ page, hub }) => {
    await hub.script([rule('^chat:ask$', { text: 'Bar answer ASKBAR-OK' })]);
    await openSlide(page);
    await ask(page, 'What is demand?');
    await expect(page.getByRole('heading', { name: 'Tutor' })).toBeVisible();
    await settled(page);
    await expect(questions(page).first()).toContainText('What is demand?');
    await expect(answers(page).first()).toContainText('ASKBAR-OK');
    expect(await hub.calls('^chat:ask$')).toHaveLength(1);
  });

  test('TUT-004 Open the tutor focuses the Ask box; × goes back to the ask bar', async ({ page }) => {
    await openSlide(page);
    await openTutor(page);
    await expect(askBox(page)).toBeFocused();
    await page.getByRole('button', { name: 'Close the tutor' }).click();
    await expect(page.getByRole('button', { name: 'Open the tutor' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Tutor' })).toHaveCount(0);
  });

  test('TUT-004 an answer still being written when the panel closes is saved and shows on reopening', async ({ page, hub }) => {
    await hub.script([held('a', 'Written while closed CLOSED-OK')]);
    await openPanel(page);
    await ask(page, 'Keep going');
    await expect(waiting(page)).toBeVisible();
    await page.getByRole('button', { name: 'Close the tutor' }).click();
    await hub.release('a');
    await expect.poll(() => { try { return JSON.stringify(onlyChat(hub).messages); } catch { return ''; } }).toContain('CLOSED-OK');
    await openTutor(page);
    await expect(answers(page).last()).toContainText('CLOSED-OK');
  });

  test('TUT-005 the panel header: title, where, zoom tools, Read, New chat, Print, ⋯, ×', async ({ page }) => {
    await openPanel(page);
    const head = page.locator('.panel-head'); // locator: markup hook
    await expect(head.getByRole('heading', { name: 'Tutor' })).toBeVisible();
    await expect(page.locator('#tutor-where')).toHaveText('S&D-1 s2'); // locator: markup hook
    // (the zoom tools show in the reading view, TUT-025)
    const order = await head.locator('h2, button, summary').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || e.textContent?.trim()));
    expect(order).toEqual(['Tutor', 'Zoom out', '100%', 'Zoom in', 'Fit width', 'Read', 'New chat', 'Print', 'More',
      'Copy chat as Markdown', 'Close the tutor']);
    await head.getByLabel('More').click();
    await expect(head.getByRole('menuitem', { name: 'Copy chat as Markdown' })).toBeVisible();
    await head.getByLabel('More').click();
    await expect(head.getByRole('menuitem', { name: 'Copy chat as Markdown' })).toBeHidden();
    await scope(page, 'Whole deck');
    await expect(page.locator('#tutor-where')).toHaveText('S&D-1 · whole deck'); // locator: markup hook
  });

  test('TUT-006 the scope switch is remembered and redraws without losing the chat or a streaming answer', async ({ page, hub }) => {
    await hub.script([held('a', 'Still streaming SCOPE-OK')]);
    await openPanel(page);
    const sw = page.getByRole('radiogroup', { name: 'Work on' });
    await expect(sw.getByRole('radio', { name: 'This slide' })).toHaveAttribute('aria-checked', 'true');
    await ask(page, 'First question');
    await expect(waiting(page)).toBeVisible();
    await scope(page, 'Whole deck');
    await expect(sw.getByRole('radio', { name: 'Whole deck' })).toHaveAttribute('aria-checked', 'true');
    await expect(questions(page)).toHaveCount(1);
    await hub.release('a');
    await settled(page);
    await expect(answers(page).first()).toContainText('SCOPE-OK');
    // remembered across reloads and decks
    await page.goto('/' + HW1);
    await page.reload();
    await openTutor(page);
    await expect(sw.getByRole('radio', { name: 'Whole deck' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#tutor-where')).toHaveText('HW-1 · whole deck'); // locator: markup hook
  });
});

test.describe('quick actions', () => {
  const slideActions: [string, string, string][] = [
    ['Big picture', 'Big picture · whole deck', 'map_deck'],
    ['Worked example', 'Worked example', 'example'],
    ['Explain simply', 'Explain simply', 'explain'],
    ['Grill me', 'Grill me', 'grill'],
    ['Quiz prep', 'Quiz prep', 'quiz'],
    ['Before you start', 'Before you start', 'before'],
    ['Cheat sheet', 'Cheat sheet · whole deck', 'cheatsheet_deck'],
  ];
  const deckActions: [string, string, string][] = [
    ['Big picture', 'Big picture · whole deck', 'map_deck'],
    ['Worked example', 'Worked example · whole deck', 'example_deck'],
    ['Explain simply', 'Explain simply · whole deck', 'explain_deck'],
    ['Grill me', 'Grill me · whole deck', 'grill_deck'],
    ['Quiz prep', 'Quiz prep · whole deck', 'quiz_deck'],
    ['Before you start', 'Before you start · whole deck', 'before_deck'],
    ['Cheat sheet', 'Cheat sheet · whole deck', 'cheatsheet_deck'],
  ];
  for (const [scopeName, list] of [['This slide', slideActions], ['Whole deck', deckActions]] as const) {
    test(`TUT-007 TUT-008 quick actions in "${scopeName}" scope: question label, kind of request and where`, async ({ page, hub }) => {
      await hub.script([MEMORY_NOOP]);
      await openPanel(page);
      if (scopeName === 'Whole deck') await scope(page, 'Whole deck');
      let k = 0;
      for (const [button, label, mode] of list) {
        await action(page, button).click();
        await settled(page, ++k);
        expect(await qText(page, k - 1)).toContain(label);
        const calls = await hub.calls(`^chat:${mode}$`);
        expect(calls, `${button} -> chat:${mode}`).toHaveLength(1);
        const p = calls[0].prompt;
        if (mode.endsWith('_deck')) expect(p).toContain('[S&D-1] "Supply and demand 1" (slides 1–3)');
        else expect(p).toContain(S2_REF);
        // A grill turn changes what the next typed text means; another action ends it (no answer typed).
      }
      // each action asked for something different
      const prompts = (await hub.calls('^chat:')).map((c) => c.prompt.replace(/\s+/g, ' '));
      expect(new Set(prompts).size).toBe(prompts.length);
    });
  }

  test('TUT-007 Exam drill opens the drill setup; Practice by topic starts practice (handoffs)', async ({ page, hub }) => {
    await openPanel(page);
    await action(page, 'Exam drill').click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Exam drill' })).toBeVisible();
    expect(await hub.calls('^chat:')).toHaveLength(0);
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await action(page, 'Practice by topic').click();
    await callsAtLeast(hub, '^chat:practice$');
    await expect(questions(page).first()).toContainText('Practice by topic');
  });

  test('TUT-008 the whole-deck Explain and the slide Explain ask for different answers', async ({ page, hub }) => {
    await openPanel(page);
    await action(page, 'Explain simply').click();
    await settled(page, 1);
    await scope(page, 'Whole deck');
    await action(page, 'Explain simply').click();
    await settled(page, 2);
    await feet(page).getByRole('button', { name: 'Go deeper' }).click(); // (a fuller version of the last answer)
    await settled(page, 3);
    const [slide] = await hub.calls('^chat:explain$');
    const [deck] = await hub.calls('^chat:explain_deck$');
    const [deeper] = await hub.calls('^chat:deeper$');
    expect(slide.prompt).not.toEqual(deck.prompt);
    expect(deeper.prompt).not.toEqual(slide.prompt);
  });

  test('TUT-009 Go deeper sends "Go deeper" on the current slide, and is not offered under a Go deeper answer', async ({ page, hub }) => {
    await openPanel(page);
    await scope(page, 'Whole deck');
    await action(page, 'Explain simply').click();
    await settled(page, 1);
    await feet(page).getByRole('button', { name: 'Go deeper' }).click();
    await settled(page, 2);
    expect(await qText(page, 1)).toContain('Go deeper · s2');
    expect(await hub.calls('^chat:deeper$')).toHaveLength(1);
    await expect(feet(page)).toHaveCount(1);
    await expect(feet(page).getByRole('button', { name: 'Go deeper' })).toHaveCount(0);
    await expect(feet(page)).toContainText('Try one on this ›');
  });

  test('TUT-010 what-next links: only under the newest answer, by kind of answer', async ({ page, hub }) => {
    await hub.script([MEMORY_NOOP]);
    await openPanel(page);
    await askAndSettle(page, 'Plain question', 1);
    await expect(feet(page)).toHaveCount(1);
    await expect(feet(page)).toHaveText(/Try one on this ›\s*Go deeper/);
    await action(page, 'Worked example').click();
    await settled(page, 2);
    await expect(feet(page)).toHaveCount(1);
    await expect(answers(page).nth(1).locator('.msg-foot')).toContainText('Your turn: finish from here ›'); // locator: markup hook
    await expect(feet(page)).toContainText('Go deeper');
    await action(page, 'Big picture').click();
    await settled(page, 3);
    await expect(feet(page)).toHaveText(/Try one on this deck ›\s*Go deeper/);
    await action(page, 'Grill me').click();
    await settled(page, 4);
    await expect(feet(page)).toHaveText('End the grill: summary ›');
  });
});

test.describe('the Ask box', () => {
  test('TUT-011 a typed question is sent with the slide; Shift+Enter makes a new line', async ({ page, hub }) => {
    await openPanel(page);
    await askBox(page).fill('Line one');
    await askBox(page).press('Shift+Enter');
    await askBox(page).pressSequentially('line two');
    await expect(askBox(page)).toHaveValue('Line one\nline two');
    expect(await hub.calls('^chat:')).toHaveLength(0);
    await askBox(page).press('Enter');
    await settled(page);
    const [c] = await hub.calls('^chat:ask$');
    expect(c.prompt).toContain(`(The student is looking at slide ${S2_REF}.)`);
    expect(c.prompt).toContain('Line one\nline two');
    expect(onlyChat(hub).messages[0]).toMatchObject({ role: 'q', mode: 'ask', deck: 'S&D-1', slide: 2, text: 'Line one\nline two' });
  });

  test('TUT-012 an empty Ask does nothing and Ask looks inactive until there is text', async ({ page, hub }) => {
    await openPanel(page);
    const send = page.locator('#ask-send'); // locator: markup hook (ghost style)
    await expect(send).toHaveClass(/ghost/);
    await askBox(page).fill('   ');
    await askBox(page).press('Enter');
    await send.click();
    await expect(send).toHaveClass(/ghost/);
    await askBox(page).fill('x');
    await expect(send).not.toHaveClass(/ghost/);
    await askBox(page).fill('');
    await expect(send).toHaveClass(/ghost/);
    await page.waitForTimeout(300);
    expect(await hub.calls('^chat:')).toHaveLength(0);
    await expect(questions(page)).toHaveCount(0);
  });

  test('TUT-014 the open panel placeholder (and accessible name)', async ({ page }) => {
    await openPanel(page);
    await expect(askBox(page)).toHaveAttribute('placeholder', NORMAL_HINT);
    await expect(page.getByRole('textbox', { name: NORMAL_HINT })).toBeVisible();
  });

  test('TUT-015 "/" lists the modes with hints; typing filters; arrows, Tab, Esc', async ({ page }) => {
    await openPanel(page);
    await askBox(page).fill('');
    await askBox(page).press('/');
    const menu = page.getByRole('listbox');
    await expect(menu).toBeVisible();
    const opts = menu.getByRole('option');
    const texts = await opts.allTextContents();
    const cmds = await opts.evaluateAll((els) => els.map((e) => e.id.replace(/^slash-/, ''))); // locator: markup hook (option ids)
    expect(cmds).toEqual(['explain', 'example', 'try', 'quiz', 'grill', 'drill', 'practice', 'before', 'bigpicture', 'cheatsheet', 'brush']);
    expect(texts.join('|')).toContain('Explain simply');
    expect(texts.join('|')).toContain('Grill me: an oral exam');
    expect(texts.join('|')).toContain('Brush up a prerequisite');
    // filter
    await askBox(page).pressSequentially('ex');
    await expect(opts).toHaveCount(2);
    // arrows move the highlight
    const active0 = await askBox(page).getAttribute('aria-activedescendant');
    await askBox(page).press('ArrowDown');
    const active1 = await askBox(page).getAttribute('aria-activedescendant');
    expect(active1).not.toEqual(active0);
    await askBox(page).press('ArrowUp');
    expect(await askBox(page).getAttribute('aria-activedescendant')).toEqual(active0);
    // Tab fills it in followed by a space
    await askBox(page).press('Tab');
    await expect(askBox(page)).toHaveValue('/explain ');
    // Esc hides the list
    await askBox(page).fill('/');
    await askBox(page).press('/'); // (re-open)
    await askBox(page).fill('');
    await askBox(page).press('/');
    await expect(menu).toBeVisible();
    await askBox(page).press('Escape');
    await expect(menu).toBeHidden();
  });

  test('TUT-015 /deeper is listed once the chat has messages; "/" on the page focuses the box', async ({ page }) => {
    await openPanel(page);
    await askAndSettle(page, 'Something');
    await blur(page);
    await page.keyboard.press('/');
    await expect(askBox(page)).toBeFocused();
    await expect(askBox(page)).toHaveValue('/');
    await expect(page.getByRole('listbox').getByRole('option', { name: /\/deeper/ })).toBeVisible();
  });

  test('TUT-015 Enter on a partly typed command fills it in; Enter on a complete one runs it', async ({ page, hub }) => {
    await openPanel(page);
    await askBox(page).fill('');
    await askBox(page).pressSequentially('/qui');
    await askBox(page).press('Enter');
    await expect(askBox(page)).toHaveValue('/quiz ');
    expect(await hub.calls('^chat:')).toHaveLength(0);
    await askBox(page).press('Enter');
    await settled(page);
    expect(await hub.calls('^chat:quiz$')).toHaveLength(1);
    expect(await qText(page, 0)).toContain('Quiz prep');
  });

  test('TUT-016 slash commands carry the student\'s words; /brush; unknown and unavailable commands', async ({ page, hub }) => {
    await openPanel(page);
    await ask(page, '/explain using a bank queue');
    await settled(page, 1);
    expect(await qText(page, 0)).toContain('Explain simply: using a bank queue');
    const [ex] = await hub.calls('^chat:explain$');
    expect(ex.prompt).toContain('The student added this to the request: "using a bank queue"');
    await ask(page, '/brush percentage change');
    await settled(page, 2);
    expect(await qText(page, 1)).toContain('Brush up: percentage change');
    expect(await hub.calls('^chat:brush$')).toHaveLength(1);
    await ask(page, '/brush');
    await expect(toast(page, 'Say what to brush up on, e.g. /brush percentage change')).toBeVisible();
    await ask(page, '/xyz');
    await expect(toast(page, 'No command /xyz. Type / to see them.')).toBeVisible();
    await ask(page, '/end');
    await expect(toast(page, "/end isn't available right now.")).toBeVisible();
    await page.waitForTimeout(300);
    expect(await hub.calls('^chat:')).toHaveLength(2);
  });

  test('TUT-016 /explain follows the scope switch; /drill opens the drill setup; /try hands over to practice', async ({ page, hub }) => {
    await openPanel(page);
    await scope(page, 'Whole deck');
    await ask(page, '/explain in one line');
    await settled(page, 1);
    expect(await hub.calls('^chat:explain_deck$')).toHaveLength(1);
    await ask(page, '/drill');
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Exam drill' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await ask(page, '/try');
    await callsAtLeast(hub, '^practice:');
  });
});

test.describe('the thread', () => {
  test.use({ seed: seedWith((hub) => {
    // A second lecture deck of the course, for where-labels.
    hub.write('Demo-Course/decks/SD-2/deck.json', JSON.stringify({ tag: 'S&D-2', title: 'Supply and demand 2', role: 'lecture',
      week: 2, order: 1, pages: 3, prepared: true, topic: 'Supply and Demand' }));
    for (const i of [1, 2, 3]) hub.write(`Demo-Course/decks/SD-2/s00${i}.jpg`, require('fs').readFileSync(hub.path('Demo-Course/decks/SD-1/s001.jpg')));
    hub.write('Demo-Course/decks/SD-2/transcript.md', '# Transcript: S&D-2\n\n## [S&D-2 s1] A\n\nx\n\n## [S&D-2 s2] B\n\ny\n\n## [S&D-2 s3] C\n\nz\n');
  }) });

  test('TUT-017 TUT-018 question bubbles show where they were asked, relative to the open deck', async ({ page }) => {
    await openPanel(page);
    await askAndSettle(page, 'On slide two', 1);
    await scope(page, 'Whole deck');
    await action(page, 'Explain simply').click();
    await settled(page, 2);
    await expect(questions(page).nth(0)).toHaveText('▾On slide two · s2');
    await expect(questions(page).nth(1)).toHaveText('▾Explain simply · whole deck · S&D-1');
    await expect(questions(page).nth(0).getByTitle('Hide the answer')).toBeVisible();
    // another deck of the course: the panel stays, labels are recomputed
    await page.evaluate(() => { location.hash = '#c=Demo-Course&d=S%26D-2&s=1'; });
    await expect(page.locator('#counter')).toHaveText('1 / 3'); // locator: markup hook
    await expect(questions(page).nth(0)).toHaveText('▾On slide two · S&D-1 s2');
    await expect(questions(page).nth(1)).toHaveText('▾Explain simply · whole deck · S&D-1');
    await scope(page, 'This slide');
    await askAndSettle(page, 'On the other deck', 3);
    await expect(questions(page).nth(2)).toHaveText('▾On the other deck · s1');
  });

  test('TUT-018 moving to another deck keeps an answer still streaming', async ({ page, hub }) => {
    await hub.script([held('a', 'Streamed across decks DECKS-OK')]);
    await openPanel(page);
    await ask(page, 'Across');
    await expect(waiting(page)).toBeVisible();
    await page.evaluate(() => { location.hash = '#c=Demo-Course&d=S%26D-2&s=1'; });
    await expect(page.locator('#counter')).toHaveText('1 / 3'); // locator: markup hook
    await expect(page.getByRole('heading', { name: 'Tutor' })).toBeVisible();
    await hub.release('a');
    await settled(page);
    await expect(answers(page).first()).toContainText('DECKS-OK');
    await expect(questions(page).first()).toHaveText('▾Across · S&D-1 s2');
  });

  test('TUT-020 a sent question shows at once with a waiting line; the empty message goes', async ({ page, hub }) => {
    await hub.script([held('a', 'Late answer')]);
    await openPanel(page);
    await expect(thread(page)).toContainText('Ask anything about this slide, or type / for a mode.');
    await ask(page, 'Right away');
    await expect(questions(page).first()).toContainText('Right away');
    await expect(waiting(page)).toBeVisible();
    await expect(thread(page)).not.toContainText('Ask anything about this slide, or type / for a mode.');
    const atBottom = await thread(page).evaluate((t) => t.scrollHeight - t.scrollTop - t.clientHeight < 5);
    expect(atBottom).toBe(true);
    await hub.release('a');
    await settled(page);
  });

  test('TUT-021 several questions in flight each get their own answer, all saved in one chat', async ({ page, hub }) => {
    await hub.script([
      { match: { label: '^chat:ask$', prompt: 'first one' }, reply: { wait_for: 'one', text: 'Answer ONE' } },
      { match: { label: '^chat:ask$', prompt: 'second one' }, reply: { text: 'Answer TWO' } },
    ]);
    await openPanel(page);
    await ask(page, 'the first one');
    await expect(waiting(page)).toHaveCount(1);
    await ask(page, 'the second one');
    await expect(questions(page)).toHaveCount(2);
    await expect(page.locator('#thread .ans:not(.live)')).toHaveCount(1); // locator: markup hook
    await hub.release('one');
    await settled(page, 2);
    // each answer follows its own question
    const order = await page.locator('#thread .msg-q, #thread .ans').allTextContents(); // locator: markup hook
    const i1 = order.findIndex((t) => t.includes('the first one'));
    const i2 = order.findIndex((t) => t.includes('the second one'));
    expect(order[i1 + 1]).toContain('Answer ONE');
    expect(order[i2 + 1]).toContain('Answer TWO');
    const texts = onlyChat(hub).messages.map((m: any) => m.text);
    expect(texts).toEqual(expect.arrayContaining(['the first one', 'Answer ONE', 'the second one', 'Answer TWO']));
  });

  test('TUT-022 Copy copies one answer as Markdown without terms, cues or spoken lines', async ({ page, hub }) => {
    await hub.script([rule('^chat:ask$', { text: 'The [[equilibrium]] point [#D] is **here**.\n[say: spoken only]\n\nCOPY-END' })]);
    await openPanel(page);
    await askAndSettle(page, 'Copy this');
    const copy = answers(page).first().getByRole('button', { name: 'Copy', exact: true });
    await copy.click();
    await expect(answers(page).first().getByRole('button', { name: 'Copied' })).toBeVisible();
    const text = await clipboard(page);
    expect(text).toContain('The equilibrium point');
    expect(text).toContain('**here**');
    expect(text).toContain('COPY-END');
    expect(text).not.toMatch(/\[\[|\[#|\[say:/);
  });

  test('TUT-023 Copy chat as Markdown; "Nothing to copy yet" on an empty chat', async ({ page, hub }) => {
    await hub.script([rule('^chat:ask$', { text: 'Chat answer CHATCOPY' })]);
    await openPanel(page);
    await panel(page).getByLabel('More', { exact: true }).click();
    await page.getByRole('menuitem', { name: 'Copy chat as Markdown' }).click();
    await expect(toast(page, 'Nothing to copy yet')).toBeVisible();
    await askAndSettle(page, 'What is it?');
    await panel(page).getByLabel('More', { exact: true }).click();
    await page.getByRole('menuitem', { name: 'Copy chat as Markdown' }).click();
    const md = await clipboard(page);
    expect(md).toMatch(/^# What is it\?/);
    expect(md).toMatch(/\n_.*Demo-Course.*S&D-1.*_/);
    expect(md).toContain('**You** (S&D-1 slide 2): What is it?');
    expect(md).toContain('Chat answer CHATCOPY');
    expect(md).toContain('---');
  });

  test('TUT-024 Print prints only the chat; "Nothing to print yet" on an empty chat', async ({ page, hub }) => {
    await stubPrint(page);
    await hub.script([rule('^chat:ask$', { text: 'Printed $x^2$ and ||secret answer|| PRINT-OK' })]);
    await openPanel(page);
    await panel(page).getByRole('button', { name: 'Print', exact: true }).click();
    await expect(toast(page, 'Nothing to print yet')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__printed)).toBe(0);
    await askAndSettle(page, 'Print me');
    await panel(page).getByRole('button', { name: 'Print', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__printed)).toBe(1);
    const root = page.locator('#print-root'); // locator: markup hook
    await expect(root).toContainText('You (S&D-1 slide 2): Print me');
    await expect(root).toContainText('PRINT-OK');
    await expect(root).toContainText('secret answer');
    await expect(root.locator('.katex').first()).toBeAttached();
  });

  test('TUT-025 the reading view: Read / R, zoom, Fit width / W, Esc; remembered on the device', async ({ page }) => {
    await openPanel(page);
    const viewer = page.locator('.viewer'); // locator: markup hook
    const read = page.getByRole('button', { name: 'Read', exact: true });
    await read.click();
    await expect(viewer).toHaveClass(/reading/);
    await expect(read).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(page.getByRole('button', { name: '110%' })).toBeVisible();
    for (let i = 0; i < 10; i++) await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(page.getByRole('button', { name: '200%' })).toBeVisible();
    await page.getByRole('button', { name: '200%' }).click();
    await expect(page.getByRole('button', { name: '100%' })).toBeVisible();
    for (let i = 0; i < 5; i++) await page.getByRole('button', { name: 'Zoom out' }).click();
    await expect(page.getByRole('button', { name: '80%' })).toBeVisible();
    await page.getByRole('button', { name: 'Fit width' }).click();
    await expect(viewer).toHaveClass(/read-wide/);
    await page.reload();
    await openTutor(page);
    await expect(viewer).toHaveClass(/reading/);
    await expect(viewer).toHaveClass(/read-wide/);
    await expect(page.getByRole('button', { name: '80%' })).toBeVisible();
    await blur(page);
    await page.keyboard.press('Escape');
    await expect(viewer).not.toHaveClass(/reading/);
    await page.keyboard.press('r');
    await expect(viewer).toHaveClass(/reading/);
    await page.keyboard.press('w');
    await expect(viewer).not.toHaveClass(/read-wide/);
  });

  test('TUT-026 the panel edge resizes (keys 40 px, 300 px .. 75%), double-click resets, remembered', async ({ page }) => {
    await openPanel(page);
    const sep = page.getByRole('separator');
    const tutor = panel(page);
    await expect.poll(async () => (await tutor.boundingBox())!.width).toBeGreaterThanOrEqual(300);
    const w0 = await stableWidth(tutor);
    await sep.focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => Math.abs((await tutor.boundingBox())!.width - (w0 + 40))).toBeLessThan(2);
    // (each press adds 40 px to the width on screen, which follows in a short CSS transition: let it move between presses)
    for (let i = 0; i < 15; i++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(120); }
    await expect.poll(async () => Math.round((await tutor.boundingBox())!.width)).toBe(300);
    const vw = (await page.locator('.viewer').boundingBox())!.width; // locator: markup hook
    for (let i = 0; i < 25; i++) { await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(120); }
    await expect.poll(async () => Math.abs((await tutor.boundingBox())!.width - vw * 0.75)).toBeLessThan(2);
    // drag
    const box = (await sep.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const dragged = await stableWidth(tutor);
    expect(dragged).toBeLessThan(vw * 0.75 - 100);
    await page.reload();
    await openTutor(page);
    await expect.poll(async () => Math.abs((await tutor.boundingBox())!.width - dragged)).toBeLessThan(2);
    await sep.dblclick();
    await expect.poll(async () => Math.abs((await tutor.boundingBox())!.width - w0)).toBeLessThan(2);
  });

  test('TUT-027 slide shortcuts do not fire while typing in the Ask box', async ({ page }) => {
    await openPanel(page);
    await askBox(page).click();
    await page.keyboard.type('r t z /');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#counter')).toHaveText('2 / 3'); // locator: markup hook
    await expect(page.locator('.viewer')).not.toHaveClass(/reading/); // locator: markup hook
    await expect(page.getByRole('listbox')).toBeHidden();
    await expect(askBox(page)).toHaveValue('r t z /');
  });
});

test.describe('folding', () => {
  test.use({ seed: seedWith((hub) => { chatFile(hub, 'aaaaaaaaaaaa'); hubState(hub, { chat: 'aaaaaaaaaaaa' }); }) });

  test('TUT-019 ▾ folds an answer for the page lifetime (survives redraws, not a reload)', async ({ page }) => {
    await openPanel(page);
    await expect(answers(page)).toHaveCount(1);
    await questions(page).first().getByTitle('Hide the answer').click();
    const unfold = questions(page).first().getByTitle('Show the answer');
    await expect(unfold).toHaveAttribute('aria-expanded', 'false');
    await expect(answers(page).first()).toBeHidden();
    await scope(page, 'Whole deck');            // a redraw of the thread
    await expect(answers(page).first()).toBeHidden();
    await questions(page).first().getByTitle('Show the answer').click();
    await expect(answers(page).first()).toBeVisible();
    await expect(questions(page).first().getByTitle('Hide the answer')).toHaveAttribute('aria-expanded', 'true');
    await questions(page).first().getByTitle('Hide the answer').click();
    await expect(answers(page).first()).toBeHidden();
    await page.reload();
    await openTutor(page);
    await expect(answers(page).first()).toBeVisible();
  });

  test('TUT-019 ▾ also folds an answer still streaming', async ({ page, hub }) => {
    await hub.script([held('a', 'Folded while streaming FOLD-OK', '^chat:ask$', { chunks: ['Folded while ', 'streaming FOLD-OK'] })]);
    await openPanel(page);
    await ask(page, 'Fold me');
    await questions(page).last().getByTitle('Hide the answer').click();
    await expect(questions(page).last().getByTitle('Show the answer')).toHaveAttribute('aria-expanded', 'false');
    await expect(waiting(page)).toBeHidden();
    await hub.release('a');
    await expect(page.locator('#thread .ans:not(.live)')).toHaveCount(2); // locator: markup hook
    await expect(waiting(page)).toHaveCount(0);
  });

});

/** The panel's width once its open/resize transition has finished. */
async function stableWidth(el: import('@playwright/test').Locator) {
  let last = -1;
  await expect.poll(async () => { const w = (await el.boundingBox())!.width; const same = Math.abs(w - last) < 0.5; last = w; return same; },
    { intervals: [200] }).toBe(true);
  return last;
}

test.describe('Grill me', () => {
  test.use({ seed: seedWith((hub) => {
    hub.write('Demo-Course/me/progress.md', '# Progress: Demo-Course\n\n## Weak topics\n\n- WEAK-TOPIC-MARK elasticity\n\n## Error log\n\n| Date | What was wrong |\n|---|---|\n| x | ERROR-LOG-MARK |\n');
    hub.write('Demo-Course/me/tutor-memory.md', "# What your tutor remembers\n\n## About me\n\n## Questions I keep asking\n\n## Mistakes I've corrected\n\n## Still shaky\n\n- SHAKY-MARK shifts vs movements\n");
  }) });

  test('TUT-030 TUT-014 a grill: typed text is the answer, then End the grill gives a summary', async ({ page, hub }) => {
    await hub.script([MEMORY_NOOP,
      rule('^chat:grill$', { text: 'I will cover demand.\n\n**Q1** What shifts demand?' }),
      rule('^chat:grill_reply$', { text: 'Good. **Q2** And supply?' }),
      rule('^chat:grill_end$', { text: '## How the grill went\n\nHeld up: demand. Shaky: supply. Next: s3.' }),
    ]);
    await openPanel(page);
    await action(page, 'Grill me').click();
    await settled(page, 1);
    await expect(askBox(page)).toHaveAttribute('placeholder', GRILL_HINT);
    await expect(feet(page)).toHaveText('End the grill: summary ›');
    await askAndSettle(page, 'Income and tastes', 2);
    const [reply] = await hub.calls('^chat:grill_reply$');
    expect(reply.prompt).toContain('Income and tastes');
    expect(await hub.calls('^chat:ask$')).toHaveLength(0);
    await expect(askBox(page)).toHaveAttribute('placeholder', GRILL_HINT);
    await feet(page).getByRole('button', { name: 'End the grill: summary ›' }).click();
    await settled(page, 3);
    expect(await qText(page, 2)).toContain('End the grill');
    await expect(answers(page).last()).toContainText('How the grill went');
    await expect(askBox(page)).toHaveAttribute('placeholder', NORMAL_HINT);
    await askAndSettle(page, 'A normal question now', 4);
    expect(await hub.calls('^chat:ask$')).toHaveLength(1);
  });

  test('TUT-030 /end ends a running grill', async ({ page, hub }) => {
    await hub.script([MEMORY_NOOP]);
    await openPanel(page);
    await ask(page, '/grill');
    await settled(page, 1);
    await askBox(page).fill('');
    await askBox(page).press('/');
    await expect(page.getByRole('listbox').getByRole('option', { name: /\/end/ })).toBeVisible();
    await askBox(page).fill('/end');
    await askBox(page).press('Enter');
    await settled(page, 2);
    expect(await hub.calls('^chat:grill_end$')).toHaveLength(1);
  });

  test('TUT-031 the grill opening request carries the known weak points', async ({ page, hub }) => {
    await openPanel(page);
    await action(page, 'Grill me').click();
    await settled(page, 1);
    const [g] = await hub.calls('^chat:grill$');
    expect(g.prompt).toContain('WEAK-TOPIC-MARK');
    expect(g.prompt).toContain('ERROR-LOG-MARK');
    expect(g.prompt).toContain('SHAKY-MARK');
  });

  test('TUT-032 each typed grill answer updates the tutor\'s memory in the background', async ({ page, hub }) => {
    await hub.script([{ match: { label: '^memory$' }, reply: { json: { changed: true, memory:
      "## About me\n- GRILL-MEMORY\n## Questions I keep asking\n- x\n## Mistakes I've corrected\n- y\n## Still shaky\n- z" } } }]);
    await openPanel(page);
    await action(page, 'Grill me').click();
    await settled(page, 1);
    expect(await hub.calls('^memory$')).toHaveLength(0);
    await askAndSettle(page, 'My grill answer', 2);
    const [m] = await callsAtLeast(hub, '^memory$');
    expect(m.prompt).toContain('My grill answer');
    await expect.poll(() => hub.read(DEMO, 'me', 'tutor-memory.md')).toContain('GRILL-MEMORY');
  });
});

test.describe('the scope of a fresh course chat', () => {
  test.use({ seed: seedWith((hub) => { chatFile(hub, 'aaaaaaaaaaaa'); hubState(hub, { chat: 'aaaaaaaaaaaa' }); }) });
  test('TUT-020 the earlier-chats list disappears once a question is sent', async ({ page, hub }) => {
    await hub.script([held('a', 'x')]);
    await openPanel(page);
    await panel(page).getByRole('button', { name: 'New chat' }).click();
    await expect(thread(page)).toContainText('Earlier chats in this course:');
    await ask(page, 'New one');
    await expect(thread(page)).not.toContainText('Earlier chats in this course:');
    await hub.release('a');
    await settled(page);
  });
});
void SD1; void SD1_S2;
