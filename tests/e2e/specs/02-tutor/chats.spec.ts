/**
 * 02 · Chats (docs/functional-spec/02-tutor-and-chats.md §4: CHAT-*). One current chat per course, kept in
 * <course>/me/chats/<id>.json, with the current one in me/hub-state.json.
 *
 * CHAT-012 (the tutor remembers what was said) needs a real model: covered as far as the conversation handle stored
 * with the chat being handed back to the model when the chat continues.
 */
import * as fs from 'fs';
import { test, expect } from '../../fixtures/hub';
import type { Hub } from '../../fixtures/hub';
import {
  DEMO, SD1_S2, HW1, askBox, questions, answers, errors, thread, chatBar, panel, openSlide, openPanel, openTutor, ask,
  askAndSettle, settled, qText, action, scope, rule, held, chatIds, readChat, onlyChat, hubStateChat, chatFile, hubState,
  seedWith, devices, closeAll, openMore,
} from './helpers';

/** A second course with one deck (a copy of S&D-1 as EC-1). */
function otherCourse(hub: Hub) {
  hub.write('Other-Course/course.json', JSON.stringify({ code: 'Other-Course', title: 'Another course' }));
  const src = hub.path('Demo-Course/decks/SD-1');
  hub.write('Other-Course/decks/EC-1/deck.json', JSON.stringify({ tag: 'EC-1', title: 'Econ one', role: 'lecture', week: 1,
    order: 1, pages: 3, prepared: true, topic: 'Basics' }));
  for (const f of ['s001.jpg', 's002.jpg', 's003.jpg']) fs.copyFileSync(`${src}/${f}`, hub.path('Other-Course/decks/EC-1', f));
  hub.write('Other-Course/decks/EC-1/transcript.md', '# Transcript: EC-1\n\n## [EC-1 s1] One\n\nx\n\n## [EC-1 s2] Two\n\ny\n\n## [EC-1 s3] Three\n\nz\n');
}

const newChatBtn = (page: import('@playwright/test').Page) => panel(page).getByRole('button', { name: 'New chat' });
const earlier = (page: import('@playwright/test').Page) => page.locator('#thread .earlier'); // locator: markup hook

test.describe('the course chat', () => {
  test.use({ seed: seedWith(otherCourse) });

  test('CHAT-001 every deck of a course shares one chat; another course has its own', async ({ page, hub }) => {
    await openPanel(page);
    await askAndSettle(page, 'Asked on S&D-1', 1);
    await page.goto('/' + HW1);
    await page.reload();
    await openTutor(page);
    await expect(questions(page)).toHaveCount(1);
    await askAndSettle(page, 'Asked on HW-1', 2);
    const chat = onlyChat(hub);
    expect(chat.messages.filter((m: any) => m.role === 'q').map((m: any) => [m.deck, m.slide, m.text]))
      .toEqual([['S&D-1', 2, 'Asked on S&D-1'], ['HW-1', 1, 'Asked on HW-1']]);
    // another course: an empty chat of its own
    await page.goto('/#c=Other-Course&d=EC-1&s=1');
    await page.reload();
    await openTutor(page);
    await expect(questions(page)).toHaveCount(0);
    await askAndSettle(page, 'Asked in the other course', 1);
    expect(chatIds(hub, 'Other-Course')).toHaveLength(1);
    expect(chatIds(hub)).toHaveLength(1);
    expect(onlyChat(hub).messages).toHaveLength(4);
  });
});

test.describe('creating and keeping chats', () => {
  test('CHAT-002 a chat file is written only once the first answer is saved, and becomes the current chat', async ({ page, hub }) => {
    await hub.script([held('a', 'First answer')]);
    await openPanel(page);
    await ask(page, 'Start a chat');
    await expect(questions(page)).toHaveCount(1);
    await page.waitForTimeout(500);
    expect(chatIds(hub)).toHaveLength(0);
    await hub.release('a');
    await settled(page);
    const ids = chatIds(hub);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^[0-9a-f]{12}$/);
    expect(hubStateChat(hub)).toBe(ids[0]);
  });

  test('CHAT-002 a failing first answer writes no chat file', async ({ page, hub }) => {
    await hub.script([rule('^chat:', { error: 'Claude reported an error. Try again in a moment.' })]);
    await openPanel(page);
    await ask(page, 'Fails at once');
    await expect(errors(page)).toBeVisible();
    expect(chatIds(hub)).toHaveLength(0);
  });

  test('CHAT-003 a new chat is named after its first question', async ({ page, hub, api }) => {
    await openPanel(page);
    await action(page, 'Explain simply').click();
    await settled(page);
    expect(onlyChat(hub).title).toBe('Explain simply · s2');
    // the bar may show the short form until the chat is next loaded; after a reload it has the full name
    await expect(chatBar(page).getByRole('button', { name: /^Explain simply/ })).toBeVisible();
    await page.reload();
    await openTutor(page);
    await expect(chatBar(page)).toContainText('Explain simply · s2');
    // whole deck
    await newChatBtn(page).click();
    await scope(page, 'Whole deck');
    await action(page, 'Explain simply').click();
    await settled(page);
    // typed words: first 70 characters
    await newChatBtn(page).click();
    await scope(page, 'This slide');
    const long = 'Why does the demand curve slope downwards when the price of the good rises so very sharply indeed?';
    await askAndSettle(page, long);
    const titles = chatIds(hub).map((id) => readChat(hub, id).title);
    expect(titles).toContain('Explain simply · whole deck · S&D-1');
    expect(titles).toContain(`${long.slice(0, 70)} · s2`);
    void api;
  });

  test('CHAT-004 what a saved chat holds; the conversation handle is never sent to the browser', async ({ page, hub, api }) => {
    await hub.script([rule('^chat:', { text: 'Saved answer SAVED', cost: 0.0421, ms: 2345 })]);
    await openPanel(page);
    await scope(page, 'Whole deck');
    await action(page, 'Quiz prep').click();
    await settled(page);
    const chat = onlyChat(hub);
    expect(chat).toMatchObject({ course: DEMO, code: DEMO, deck: 'S&D-1', title: expect.any(String) });
    expect(chat.created).toBeTruthy();
    expect(chat.updated).toBeTruthy();
    expect(chat.session).toBeTruthy();
    expect(chat.messages[0]).toMatchObject({ role: 'q', mode: 'quiz_deck', deck: 'S&D-1', slide: 2, text: 'Quiz prep · whole deck' });
    expect(chat.messages[1]).toMatchObject({ role: 'a', mode: 'quiz_deck', deck: 'S&D-1', slide: 2, text: 'Saved answer SAVED',
      ms: 2345, cost: 0.0421, model: 'claude-opus-5-5' });
    const pub = await (await api.get(`/api/chat?id=${chat.id}`)).json();
    expect(pub.session).toBeUndefined();
    expect(pub.messages).toHaveLength(2);
    const cur = await (await api.get(`/api/course/chat?course=${DEMO}`)).json();
    expect(cur.chat.id).toBe(chat.id);
    expect(cur.chat.session).toBeUndefined();
  });

  test('CHAT-005 the chat survives a reload and a hub restart: name, star, every message', async ({ page, hub }) => {
    await hub.script([rule('^chat:ask$', { text: 'Kept answer with $x^2$ KEPT' })]);
    await openPanel(page);
    await askAndSettle(page, 'Keep me', 1);
    await chatBar(page).getByRole('button', { name: 'Star this chat' }).click();
    await chatBar(page).getByTitle('Rename this chat').click();
    await page.getByRole('textbox', { name: 'Chat name' }).fill('My kept chat');
    await page.getByRole('textbox', { name: 'Chat name' }).press('Enter');
    await expect.poll(() => onlyChat(hub).title).toBe('My kept chat');
    await page.reload();
    await openTutor(page);
    await expect(chatBar(page)).toContainText('★');
    await expect(chatBar(page)).toContainText('My kept chat');
    await expect(answers(page).first()).toContainText('KEPT');
    await hub.restart();
    await page.goto(hub.url + '/#c=Demo-Course&d=HW-1&s=1');
    await openTutor(page);
    await expect(chatBar(page).getByRole('button', { name: 'Unstar this chat' })).toBeVisible();
    await expect(chatBar(page)).toContainText('My kept chat');
    await expect(questions(page).first()).toContainText('Keep me');
    await expect(answers(page).first().locator('.katex')).toHaveCount(1);
  });

  test('CHAT-006 the chat bar (star + name) shows above a chat\'s first message; an empty chat has none', async ({ page }) => {
    await openPanel(page);
    await expect(chatBar(page)).toHaveCount(0);
    await askAndSettle(page, 'Bar please');
    await expect(chatBar(page)).toHaveCount(1);
    await expect(chatBar(page).getByRole('button', { name: 'Star this chat' })).toBeVisible();
    await expect(chatBar(page).getByTitle('Rename this chat')).toBeVisible();
    const first = await thread(page).evaluate((t) => t.firstElementChild?.className);
    expect(first).toContain('chat-bar');
  });
});

test.describe('rename and star', () => {
  test.use({ seed: seedWith((hub) => { chatFile(hub, 'aaaaaaaaaaaa', { title: 'Original name' }); hubState(hub, { chat: 'aaaaaaaaaaaa' }); }) });

  test('CHAT-007 rename: Enter saves, whitespace collapsed, shown at once', async ({ page, hub }) => {
    await openPanel(page);
    await chatBar(page).getByTitle('Rename this chat').click();
    const box = page.getByRole('textbox', { name: 'Chat name' });
    await expect(box).toBeFocused();
    await expect(box).toHaveAttribute('maxlength', '120');
    expect(await box.evaluate((i: HTMLInputElement) => [i.selectionStart, i.selectionEnd])).toEqual([0, 'Original name'.length]);
    await box.fill('  Brand   new\tname  ');
    await box.press('Enter');
    await expect(chatBar(page).getByTitle('Rename this chat')).toHaveText('Brand new name');
    await expect.poll(() => readChat(hub, 'aaaaaaaaaaaa').title).toBe('Brand new name');
  });

  test('CHAT-007 rename: leaving the field saves; Esc cancels; an empty name is not saved', async ({ page, hub }) => {
    await openPanel(page);
    const title = chatBar(page).getByTitle('Rename this chat');
    const box = page.getByRole('textbox', { name: 'Chat name' });
    await title.click();
    await box.fill('Cancelled name');
    await box.press('Escape');
    await expect(title).toHaveText('Original name');
    await title.click();
    await box.fill('   ');
    await box.press('Enter');
    await expect(title).toHaveText('Original name');
    await title.click();
    await box.fill('Saved on blur');
    await askBox(page).click();
    await expect(title).toHaveText('Saved on blur');
    await expect.poll(() => readChat(hub, 'aaaaaaaaaaaa').title).toBe('Saved on blur');
  });

  test('CHAT-007 the hub refuses an empty name and collapses whitespace', async ({ api, hub }) => {
    let r = await api.post('/api/chat/update', { data: { id: 'aaaaaaaaaaaa', title: '   ' } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe('A chat needs a name.');
    r = await api.post('/api/chat/update', { data: { id: 'aaaaaaaaaaaa', title: ' a   b ' } });
    expect((await r.json()).title).toBe('a b');
    expect(readChat(hub, 'aaaaaaaaaaaa').title).toBe('a b');
  });

  test('CHAT-008 the star toggle marks the chat starred in its file', async ({ page, hub }) => {
    await openPanel(page);
    const star = chatBar(page).getByRole('button', { name: 'Star this chat' });
    await expect(star).toHaveText('☆');
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await star.click();
    const unstar = chatBar(page).getByRole('button', { name: 'Unstar this chat' });
    await expect(unstar).toHaveText('★');
    await expect(unstar).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => readChat(hub, 'aaaaaaaaaaaa').starred).toBe(true);
    await unstar.click();
    await expect(chatBar(page).getByRole('button', { name: 'Star this chat' })).toBeVisible();
    await expect.poll(() => readChat(hub, 'aaaaaaaaaaaa').starred).toBe(false);
  });
});

/** Seven saved chats: c1..c7, c7 the most recently updated, c2 starred; c7 is the current one. */
function sevenChats(hub: Hub) {
  for (let i = 1; i <= 7; i++) chatFile(hub, `00000000000${i}`, { title: `Chat number ${i}`, updated: `2026-01-0${i} 10:00`, starred: i === 2 });
  hubState(hub, { chat: '000000000007' });
}

test.describe('new chat and earlier chats', () => {
  test.use({ seed: seedWith(sevenChats) });

  test('CHAT-010 the empty view lists up to five earlier chats, starred first then most recent', async ({ page, hub }) => {
    await openPanel(page);
    await expect(questions(page)).toHaveCount(1);
    await newChatBtn(page).click();
    await expect(thread(page)).toContainText('Ask anything about this slide, or type / for a mode.');
    await expect(earlier(page)).toContainText('Earlier chats in this course:');
    const names = await earlier(page).getByRole('button').allTextContents();
    expect(names).toEqual(['Chat number 7', '★ Chat number 2', 'Chat number 6', 'Chat number 5', 'Chat number 4']);
    void hub;
  });

  test('CHAT-010 a freshly loaded course without a current chat lists the earlier chats, starred first', async ({ page, hub }) => {
    hubState(hub, { chat: null });
    await openPanel(page);
    const names = await earlier(page).getByRole('button').allTextContents();
    expect(names).toEqual(['★ Chat number 2', 'Chat number 7', 'Chat number 6', 'Chat number 5', 'Chat number 4']);
  });

  test('CHAT-009 New chat empties the thread, focuses the box, and the next question starts a new chat', async ({ page, hub }) => {
    await openPanel(page);
    await newChatBtn(page).click();
    await expect(questions(page)).toHaveCount(0);
    await expect(askBox(page)).toBeFocused();
    await expect.poll(() => hubStateChat(hub)).toBeNull();
    await expect(earlier(page).getByRole('button').first()).toHaveText('Chat number 7');
    await askAndSettle(page, 'Fresh start');
    expect(chatIds(hub)).toHaveLength(8);
    const fresh = hubStateChat(hub)!;
    expect(fresh).not.toBe('000000000007');
    expect(readChat(hub, fresh).messages[0].text).toBe('Fresh start');
    expect(readChat(hub, '000000000007').messages).toHaveLength(2);
  });

  test('CHAT-011 opening an earlier chat shows it and the next question continues it', async ({ page, hub }) => {
    await openPanel(page);
    await newChatBtn(page).click();
    await earlier(page).getByRole('button', { name: 'Chat number 5' }).click();
    await expect(questions(page).first()).toContainText('Question of 000000000005');
    await expect(chatBar(page)).toContainText('Chat number 5');
    await expect.poll(() => hubStateChat(hub)).toBe('000000000005');
    await askAndSettle(page, 'Continue five', 2);
    expect(readChat(hub, '000000000005').messages.map((m: any) => m.text)).toContain('Continue five');
    expect(chatIds(hub)).toHaveLength(7);
  });

  test('CHAT-009 CHAT-011 LIVE-008 New chat and opening an earlier chat switch every device', async ({ browser, hub }) => {
    const [d1, d2] = await devices(browser, hub, 2);
    await expect(questions(d2.page).first()).toContainText('Question of 000000000007');
    await newChatBtn(d1.page).click();
    await expect(questions(d2.page)).toHaveCount(0);
    await expect(d2.page.locator('#thread .earlier')).toContainText('Chat number 7'); // locator: markup hook
    await d1.page.locator('#thread .earlier').getByRole('button', { name: 'Chat number 4' }).click(); // locator: markup hook
    await expect(questions(d2.page).first()).toContainText('Question of 000000000004');
    // the next question on device 2 goes where its screen says
    await askAndSettle(d2.page, 'From device two', 2);
    expect(readChat(hub, '000000000004').messages.map((m: any) => m.text)).toContain('From device two');
    await closeAll([d1, d2]);
  });

  test('CHAT-012 continuing an old chat hands its conversation back to the tutor', async ({ page, hub }) => {
    chatFile(hub, '00000000000a', { title: 'With a conversation', session: 'sess-remembered', updated: '2026-02-01 10:00' });
    await openPanel(page);
    await newChatBtn(page).click();
    await earlier(page).getByRole('button', { name: 'With a conversation' }).click();
    await expect(chatBar(page)).toContainText('With a conversation');
    await askAndSettle(page, 'Do you remember?', 2);
    const [c] = await hub.calls('^chat:ask$');
    expect(c.session).toBe('sess-remembered');
  });
});

test.describe('deleting chats', () => {
  test.use({ seed: seedWith(sevenChats) });

  test('CHAT-013 LIVE-008 deleting the current chat removes its file and every device switches to the empty chat', async ({ browser, hub, api }) => {
    const [d1, d2] = await devices(browser, hub, 2);
    await expect(questions(d1.page)).toHaveCount(1);
    const r = await api.post('/api/chat/delete', { data: { id: '000000000007', client: 'someone' } });
    expect((await r.json()).ok).toBe(true);
    expect(hub.exists(DEMO, 'me', 'chats', '000000000007.json')).toBe(false);
    expect(hubStateChat(hub)).toBeNull();
    for (const d of [d1, d2]) {
      await expect(questions(d.page)).toHaveCount(0);
      await expect(d.page.locator('#thread')).toContainText('Ask anything about this slide, or type / for a mode.'); // locator: markup hook
    }
    await askAndSettle(d1.page, 'After the delete');
    expect(chatIds(hub)).toHaveLength(7);
    expect(hubStateChat(hub)).not.toBe('000000000007');
    await closeAll([d1, d2]);
  });

  test('CHAT-013 deleting another chat leaves the current one alone', async ({ api, hub }) => {
    await api.post('/api/chat/delete', { data: { id: '000000000003', client: 'x' } });
    expect(hub.exists(DEMO, 'me', 'chats', '000000000003.json')).toBe(false);
    expect(hubStateChat(hub)).toBe('000000000007');
    const list = await (await api.get('/api/chats')).json();
    expect(list.map((c: any) => c.id)).not.toContain('000000000003');
  });

  test('CHAT-013 ERR-002 a chat deleted while it is answering is not brought back; that answer fails', async ({ page, hub, api }) => {
    await hub.script([held('a', 'Too late')]);
    await openPanel(page);
    await ask(page, 'Answer slowly');
    await expect.poll(async () => (await hub.calls('^chat:ask$')).length).toBe(1);
    await api.post('/api/chat/delete', { data: { id: '000000000007', client: 'x' } });
    await hub.release('a');
    await expect(errors(page)).toHaveText('That chat was deleted while it was answering.');
    await page.waitForTimeout(300);
    expect(hub.exists(DEMO, 'me', 'chats', '000000000007.json')).toBe(false);
  });

  test('CHAT-013 CHAT-014 a chat can be deleted on screen from History, after a confirmation', async ({ page, hub }) => {
    test.fail(true, 'BROKEN in current app: ⋯ → History does nothing ("showHistory is not defined"), so no chat can be '
      + 'deleted on screen; see "Known issues" in docs/functional-spec/02-tutor-and-chats.md');
    await openSlide(page, SD1_S2);
    await openMore(page);
    await page.getByRole('menuitem', { name: 'History' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toBeVisible({ timeout: 3000 });
    page.once('dialog', (d) => { expect(d.message()).toContain('Delete this chat?'); d.accept(); });
    await dlg.locator('.hist-row').filter({ hasText: 'Chat number 3' }).getByRole('button', { name: 'Delete' }).click(); // locator: markup hook
    await expect.poll(() => hub.exists(DEMO, 'me', 'chats', '000000000003.json')).toBe(false);
  });
});

test.describe('history', () => {
  test.use({ seed: seedWith((hub) => { sevenChats(hub); otherCourse(hub); chatFile(hub, '0000000000ff', { course: 'Other-Course', code: 'Other-Course', deck: 'EC-1', title: 'Other course chat' }, 'Other-Course'); }) });

  test('CHAT-014 History lists the course\'s chats with code, deck, questions, update, Open, star, rename and Delete', async ({ page }) => {
    test.fail(true, 'BROKEN in current app: ⋯ → History raises "showHistory is not defined" and the dialog never opens; '
      + 'see "Known issues" in docs/functional-spec/02-tutor-and-chats.md (CHAT-014)');
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await openSlide(page, SD1_S2);
    await openMore(page);
    await page.getByRole('menuitem', { name: 'History' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toBeVisible({ timeout: 3000 });
    await expect(dlg.getByRole('heading', { name: 'History · Demo-Course' })).toBeVisible();
    await expect(dlg).toContainText('Chat number 1');
    await expect(dlg).toContainText('Chat number 7');
    await expect(dlg).not.toContainText('Other course chat');
    await expect(dlg.getByRole('button', { name: /Demo-Course · S&D-1 · 1 question · .* · Open ›/ }).first()).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Delete' })).toHaveCount(7);
    expect(pageErrors).toEqual([]);
  });

  test('CHAT-014 the hub lists every chat: summaries, starred first then newest', async ({ api }) => {
    const list = await (await api.get('/api/chats')).json();
    expect(list).toHaveLength(8);
    expect(list[0]).toMatchObject({ id: '000000000002', starred: true });
    const demo = list.filter((c: any) => c.course === DEMO);
    expect(demo.map((c: any) => c.id).slice(1, 3)).toEqual(['000000000007', '000000000006']);
    expect(list.find((c: any) => c.id === '000000000005')).toMatchObject({ title: 'Chat number 5', course: DEMO, code: DEMO,
      deck: 'S&D-1', count: 1, updated: expect.any(String) });
    expect(list.find((c: any) => c.id === '0000000000ff')).toMatchObject({ course: 'Other-Course' });
  });

  test('CHAT-014 renaming and starring a chat that is not the current one (through the hub)', async ({ api, hub }) => {
    const r = await (await api.post('/api/chat/update', { data: { id: '000000000004', title: 'Renamed four', starred: true } })).json();
    expect(r).toEqual({ id: '000000000004', title: 'Renamed four', starred: true });
    expect(readChat(hub, '000000000004')).toMatchObject({ title: 'Renamed four', starred: true });
    expect(hubStateChat(hub)).toBe('000000000007');
  });
});

test.describe('old and missing chats', () => {
  test.use({ seed: seedWith((hub) => {
    hub.write(`${DEMO}/me/chats/0000000000aa.json`, JSON.stringify({ id: '0000000000aa', course: DEMO, code: DEMO,
      created: '2025-01-01 10:00', updated: '2025-01-01 10:00', title: 'Before decks', messages: [
        { role: 'q', text: 'An old question OLD-Q' }, { role: 'a', text: 'An old answer OLD-A' }] }));
  }) });

  test('CHAT-015 a chat from before decks cannot be continued and opens read-only', async ({ page, api }) => {
    const r = await api.post('/api/chat/open', { data: { id: '0000000000aa', client: 'x' } });
    expect(r.status()).toBe(404);
    expect((await r.json()).error).toBe("That chat can't be continued.");
    await page.goto('/#chat=0000000000aa');
    await expect(page.getByRole('heading', { name: 'Before decks' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy chat' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save as PDF' })).toBeVisible();
    await expect(page.locator('main')).toContainText('OLD-Q');
    await expect(page.locator('main')).toContainText('OLD-A');
    await expect(askBox(page)).toHaveCount(0);
  });

  test('CHAT-016 a chat that no longer exists: "That chat no longer exists."', async ({ api }) => {
    let r = await api.get('/api/chat?id=0123456789ab');
    expect(r.status()).toBe(404);
    expect((await r.json()).error).toBe('That chat no longer exists.');
    r = await api.post('/api/chat/update', { data: { id: '0123456789ab', title: 'x' } });
    expect(r.status()).toBe(404);
    expect((await r.json()).error).toBe('That chat no longer exists.');
    r = await api.post('/api/chat/update', { data: { id: '0123456789ab', starred: true } });
    expect((await r.json()).error).toBe('That chat no longer exists.');
    r = await api.post('/api/chat/open', { data: { id: '0123456789ab', client: 'x' } });
    expect(r.ok()).toBe(false);
  });
});

test.describe('New chat while an answer is being written (known issue)', () => {
  test('CHAT-009 LIVE-008 after New chat mid-answer, every device shows the empty chat and the next question starts a new one', async ({ browser, hub }) => {
    test.fail(true, 'BROKEN in current app: an answer finishing after New chat pulls the old chat back onto the screens '
      + 'while the course has no current chat; see "Known issues" in docs/functional-spec/02-tutor-and-chats.md');
    await hub.script([held('a', 'Old chat answer', '^chat:ask$')]);
    const [d1, d2] = await devices(browser, hub, 2);
    await ask(d1.page, 'Slow question');
    await expect(questions(d2.page)).toHaveCount(1);
    await newChatBtn(d1.page).click();
    await expect.poll(() => hubStateChat(hub)).toBeNull();
    await hub.release('a');
    await expect.poll(() => chatIds(hub).length).toBe(1);
    await d1.page.waitForTimeout(1500);
    for (const d of [d1, d2]) await expect(questions(d.page)).toHaveCount(0, { timeout: 3000 });
    await closeAll([d1, d2]);
  });

  test('CHAT-009 New chat mid-answer: the answer is still saved, into the chat it was asked in (pinned as-is)', async ({ page, hub }) => {
    await openPanel(page);
    await askAndSettle(page, 'First', 1);
    const id = hubStateChat(hub)!;
    await hub.script([held('b', 'Slow answer SLOW-OLD', '^chat:ask$')]);
    await ask(page, 'Second, slow');
    await expect.poll(async () => (await hub.calls('^chat:ask$')).length).toBe(2);
    await newChatBtn(page).click();
    await expect.poll(() => hubStateChat(hub)).toBeNull();
    await hub.release('b');
    await expect.poll(() => JSON.stringify(readChat(hub, id).messages)).toContain('SLOW-OLD');
    expect(chatIds(hub)).toHaveLength(1);
  });
});
void qText; void HW1;
