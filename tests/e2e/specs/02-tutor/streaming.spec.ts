/**
 * 02 · Answers: streaming, status, errors (docs/functional-spec/02-tutor-and-chats.md §2: STR-*, ERR-*).
 *
 * ERR-002 "That chat was deleted while it was answering." is in chats.spec.ts (CHAT-013); the generic "Something went
 * wrong" message for a side question is in side.spec.ts (SIDE-008), for practice marking in 03-practice/practice.spec.ts.
 * ERR-003 (photos come back after a failed question) is in photos.spec.ts.
 */
import { test, expect } from '../../fixtures/hub';
import {
  DEMO, askBox, questions, answers, waiting, errors, thread, panel, openPanel, openTutor, ask, settled, action, scope,
  rule, held, chatIds, onlyChat, readChat, hubStateChat,
} from './helpers';

test.describe('waiting and status lines', () => {
  test('STR-001 the waiting line: "Thinking…", "Writing a worked example…", "Reading the whole deck…"', async ({ page, hub }) => {
    await hub.script([held('a', 'one', '^chat:ask$'), held('b', 'two', '^chat:example$'), held('c', 'three', '^chat:explain_deck$')]);
    await openPanel(page);
    await ask(page, 'Plain');
    await expect(waiting(page).last()).toHaveText('Thinking…');
    await action(page, 'Worked example').click();
    await expect(waiting(page).last()).toHaveText('Writing a worked example…');
    await scope(page, 'Whole deck');
    await action(page, 'Explain simply').click();
    await expect(waiting(page).last()).toHaveText('Reading the whole deck…');
    for (const r of ['a', 'b', 'c']) await hub.release(r);
    await settled(page, 3);
  });

  test('STR-002 a status line from the tutor replaces the waiting text', async ({ page, hub }) => {
    await hub.script([rule('^chat:ask$', { status: ['Reading the S&D-1 slides'], chunks: ['Done.'], chunk_delay_ms: 2500, text: 'Done.' })]);
    await openPanel(page);
    await ask(page, 'Status please');
    await expect(waiting(page)).toHaveText('Reading the S&D-1 slides…');
    await settled(page);
  });

  test('STR-002 status lines show while the tutor works, before any of the answer has arrived', async ({ page, hub }) => {
    await hub.script([rule('^chat:ask$', { status: ['Searching the course for “elasticity”', 'Reading the S&D-1 slides'],
      wait_after_status: 'go', text: 'Answer after the status STATUS-DONE.' })]);
    await openPanel(page);
    await ask(page, 'Status first');
    await expect(waiting(page)).toHaveText('Reading the S&D-1 slides…');
    await expect(answers(page)).toHaveCount(0);
    await hub.release('go');
    await settled(page);
    await expect(answers(page).first()).toContainText('STATUS-DONE');
  });

  test('STR-002 each new status replaces the previous one', async ({ page, hub }) => {
    await hub.script([
      { match: { label: '^chat:ask$' }, times: 1, reply: { status: ['Searching the course for “elasticity”'], wait_for: 'x', text: 'x1' } },
    ]);
    await openPanel(page);
    await ask(page, 'First');
    await expect(waiting(page)).toHaveText('Thinking…');
    await hub.release('x');
    await settled(page);
    await hub.script([rule('^chat:ask$', { status: ['Thinking it through', 'Writing it up'], chunks: ['End.'], chunk_delay_ms: 2500, text: 'End two.' })]);
    await ask(page, 'Second');
    await expect(waiting(page)).toHaveText('Writing it up…');
    await settled(page, 2);
  });
});

test.describe('streaming', () => {
  test('STR-003 the answer appears as it is written, the waiting line reading "Writing…"', async ({ page, hub }) => {
    await hub.script([rule('^chat:ask$', { chunks: ['First piece PIECE-1. ', 'Second piece PIECE-2. ', 'Third piece PIECE-3.'],
      chunk_delay_ms: 1200, text: 'First piece PIECE-1. Second piece PIECE-2. Third piece PIECE-3.' })]);
    await openPanel(page);
    await ask(page, 'Stream it');
    const live = page.locator('#thread .ans.live'); // locator: markup hook (an answer still being written)
    await expect(live).toContainText('PIECE-1');
    await expect(waiting(page)).toHaveText('Writing…');
    await expect(live).not.toContainText('PIECE-3');
    await expect(live).toContainText('PIECE-2');
    await settled(page);
    await expect(answers(page).first()).toContainText('PIECE-3');
  });

  test('STR-003 the thread follows the newest text unless the student scrolled up', async ({ page, hub }) => {
    const para = (i: number) => `Paragraph ${i} ` + 'of quite some length about supply and demand. '.repeat(6) + '\n\n';
    const chunks = Array.from({ length: 16 }, (_, i) => para(i));
    await hub.script([rule('^chat:ask$', { chunks, chunk_delay_ms: 400, text: chunks.join('') })]);
    await openPanel(page);
    await ask(page, 'A long one');
    const th = thread(page);
    const gap = () => th.evaluate((t) => t.scrollHeight - t.scrollTop - t.clientHeight);
    await expect(page.locator('#thread .ans.live')).toContainText('Paragraph 5'); // locator: markup hook
    await expect.poll(async () => (await th.evaluate((t) => t.scrollHeight > t.clientHeight + 200))).toBe(true);
    await expect.poll(gap).toBeLessThan(80);
    // scroll up: it stays there while more text arrives
    await th.evaluate((t) => { t.scrollTop = 0; });
    await expect(page.locator('#thread .ans.live')).toContainText('Paragraph 9', { timeout: 10_000 }); // locator: markup hook
    expect(await th.evaluate((t) => t.scrollTop)).toBeLessThan(50);
    // back to the bottom: following resumes
    await th.evaluate((t) => { t.scrollTop = t.scrollHeight; });
    await expect(page.locator('#thread .ans.live')).toContainText('Paragraph 12', { timeout: 10_000 }); // locator: markup hook
    await expect.poll(gap).toBeLessThan(80);
    await settled(page);
  });

  test('STR-004 a half-arrived drawing cue or spoken line is never shown; a display formula waits for its closing $$', async ({ page, hub }) => {
    await hub.script([rule('^chat:ask$', {
      chunks: ['Demand pulls up [#', 'D] here.\n\n[say: only for the ', 'ear]\n\nThe price $$P^* = ', '10$$ settles.\n\nEND-MARK', ' '],
      chunk_delay_ms: 1500,
      text: 'Demand pulls up [#D] here.\n\n[say: only for the ear]\n\nThe price $$P^* = 10$$ settles.\n\nEND-MARK' })]);
    await openPanel(page);
    await ask(page, 'Careful');
    const live = page.locator('#thread .ans.live'); // locator: markup hook
    await expect(live).toContainText('Demand pulls up');
    await expect(live).not.toContainText('[#');
    await expect(live).toContainText('here.', { timeout: 10_000 });
    await expect(live).not.toContainText('[say');
    await expect(live).not.toContainText('only for the');
    await expect(live).toContainText('The price', { timeout: 10_000 });
    await expect(live.locator('.katex-display')).toHaveCount(0);
    await expect(live).toContainText('settles', { timeout: 10_000 });
    await expect(live.locator('.katex-display')).toHaveCount(1);
    await settled(page);
    await expect(answers(page).first()).not.toContainText('[#');
    await expect(answers(page).first()).not.toContainText('[say');
  });

  test('STR-005 the finished answer settles in place, keeping the drawings already drawn', async ({ page, hub }) => {
    const plot = '```plot\nf: 100 - 2*x\nx: 0..50\ntitle: Demand line\n```\n\n';
    await hub.script([rule('^chat:ask$', { chunks: [plot, 'Under the plot KEEP-OK', ' '], chunk_delay_ms: 1500,
      text: plot + 'Under the plot KEEP-OK ' })]);
    await openPanel(page);
    await ask(page, 'Draw it');
    const live = page.locator('#thread .ans.live'); // locator: markup hook
    await expect(live).toContainText('KEEP-OK');
    const handle = await live.locator('svg.plot').elementHandle(); // locator: markup hook
    await settled(page);
    expect(await handle!.evaluate((e) => e.isConnected)).toBe(true);
    await expect(answers(page).first().getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
    await expect(answers(page).first().getByRole('button', { name: '▶ Play' })).toBeVisible();
    await expect(answers(page).first().getByRole('button', { name: 'Go deeper' })).toBeVisible();
  });

  test('STR-005 when the saved text differs from what streamed, the saved text is shown', async ({ page, hub }) => {
    await hub.script([rule('^chat:ask$', { chunks: ['Streamed STREAMED-TEXT', ' '], chunk_delay_ms: 1500, text: 'Saved SAVED-TEXT' })]);
    await openPanel(page);
    await ask(page, 'Which one?');
    await expect(page.locator('#thread .ans.live')).toContainText('STREAMED-TEXT'); // locator: markup hook
    await settled(page);
    await expect(answers(page).first()).toContainText('SAVED-TEXT');
    await expect(answers(page).first()).not.toContainText('STREAMED-TEXT');
  });

  test('STR-006 an answer is saved even when the page reloads while it is written', async ({ page, hub }) => {
    await hub.script([held('a', 'Survived the reload RELOAD-OK')]);
    await openPanel(page);
    await ask(page, 'Reload me');
    await expect(waiting(page)).toBeVisible();
    const live = page.waitForResponse((r) => r.url().includes('/api/live'));
    const loaded = page.waitForResponse((r) => r.url().includes('/api/course/chat'));
    await page.reload();
    await Promise.all([live, loaded]);     // (the reloaded page has the chat and is listening again)
    await page.waitForTimeout(300);
    await hub.release('a');
    await expect.poll(() => chatIds(hub).length).toBe(1);
    await expect.poll(() => JSON.stringify(onlyChat(hub).messages)).toContain('RELOAD-OK');
    await openTutor(page);
    await expect(answers(page).last()).toContainText('RELOAD-OK');
    await expect(questions(page).last()).toContainText('Reload me');
  });

  test('STR-006 an answer is saved even when the page goes to another course', async ({ page, hub }) => {
    await hub.script([held('a', 'Saved while away AWAY-OK')]);
    await openPanel(page);
    await ask(page, 'Leave');
    await expect(waiting(page)).toBeVisible();
    await page.goto('/#');
    await hub.release('a');
    await expect.poll(() => { try { return JSON.stringify(onlyChat(hub).messages); } catch { return ''; } }).toContain('AWAY-OK');
  });

  test('STR-006 LIVE-006 a page reloaded mid-answer catches up with the text so far and follows it to the end', async ({ page, hub }) => {
    await hub.script([rule('^chat:ask$', { chunks: ['Early part EARLY. ', 'Middle MIDDLE. ', 'Late part LATE.'], chunk_delay_ms: 2500,
      text: 'Early part EARLY. Middle MIDDLE. Late part LATE.' })]);
    await openPanel(page);
    await ask(page, 'Reload during');
    await expect(page.locator('#thread .ans.live')).toContainText('EARLY'); // locator: markup hook
    await page.reload();
    await openTutor(page);
    await expect(questions(page).first()).toContainText('Reload during');
    await expect(thread(page)).toContainText('EARLY');
    await expect(answers(page).first()).toContainText('LATE', { timeout: 15_000 });
    await expect(waiting(page)).toHaveCount(0);
  });

  test('STR-007 there is no control to stop a written answer (pinned as-is)', async ({ page, hub }) => {
    await hub.script([held('a', 'No stop')]);
    await openPanel(page);
    await ask(page, 'Can I stop?');
    await expect(waiting(page)).toBeVisible();
    await expect(panel(page).getByRole('button', { name: /stop|cancel/i }).filter({ visible: true })).toHaveCount(0);
    await hub.release('a');
    await settled(page);
  });
});

test.describe('errors', () => {
  test('ERR-001 ERR-002 a failed answer shows the tutor\'s message in red; nothing is saved; gone after a reload', async ({ page, hub }) => {
    await hub.script([rule('^chat:ask$', { error: 'Claude reported an error. Try again in a moment.' })]);
    await openPanel(page);
    await ask(page, 'Will fail');
    await expect(errors(page)).toHaveText('Claude reported an error. Try again in a moment.');
    await expect(questions(page)).toHaveCount(1);
    await expect(waiting(page)).toHaveCount(0);
    await expect(answers(page)).toHaveCount(0);
    expect(chatIds(hub)).toHaveLength(0);
    await page.reload();
    await openTutor(page);
    await expect(questions(page)).toHaveCount(0);
  });

  test('ERR-001 an answer that fails part-way: the text so far is replaced by the error, and nothing is saved', async ({ page, hub }) => {
    await hub.script([rule('^chat:ask$', { chunks: ['Partial start PART-1. ', 'Partial more PART-2.'], chunk_delay_ms: 1500,
      text: 'Partial start PART-1. Partial more PART-2.', error_after_text: 'Claude reported an error. Try again in a moment.' })]);
    await openPanel(page);
    await ask(page, 'Fail half way');
    await expect(page.locator('#thread .ans.live')).toContainText('PART-1'); // locator: markup hook
    await expect(errors(page)).toHaveText('Claude reported an error. Try again in a moment.', { timeout: 15_000 });
    await expect(answers(page)).toHaveCount(0);
    await expect(waiting(page)).toHaveCount(0);
    await expect(thread(page)).not.toContainText('PART-1');
    await expect(questions(page)).toHaveCount(1);
    expect(chatIds(hub)).toHaveLength(0);
    await page.reload();
    await openTutor(page);
    await expect(questions(page)).toHaveCount(0);
    await expect(thread(page)).not.toContainText('PART-1');
  });

  test('ERR-001 an answer that fails part-way in an existing chat leaves the chat file as it was', async ({ page, hub }) => {
    await hub.script([{ match: { label: '^chat:ask$' }, times: 1, reply: { text: 'Good answer GOOD-1' } }]);
    await openPanel(page);
    await ask(page, 'Works');
    await settled(page);
    const before = JSON.stringify(onlyChat(hub).messages);
    await hub.script([rule('^chat:ask$', { chunks: ['Half HALF-1. ', 'More HALF-2.'], chunk_delay_ms: 800,
      text: 'Half HALF-1. More HALF-2.', error_after_text: 'That took too long. Try again.' })]);
    await ask(page, 'Fails half way');
    await expect(errors(page)).toHaveText('That took too long. Try again.', { timeout: 15_000 });
    await expect(thread(page)).not.toContainText('HALF-1');
    expect(JSON.stringify(onlyChat(hub).messages)).toEqual(before);
    expect(JSON.stringify(onlyChat(hub).messages)).not.toContain('HALF-1');
  });

  test('ERR-002 an unexpected failure inside the hub shows "Something went wrong. Try again."; nothing is saved', async ({ page, hub }) => {
    await hub.script([rule('^chat:ask$', { crash: true })]);
    await openPanel(page);
    await ask(page, 'Crash it');
    await expect(errors(page)).toHaveText('Something went wrong. Try again.');
    await expect(answers(page)).toHaveCount(0);
    await expect(waiting(page)).toHaveCount(0);
    expect(chatIds(hub)).toHaveLength(0);
  });

  test('ERR-002 a quick action failing unexpectedly shows the same generic message', async ({ page, hub }) => {
    await hub.script([rule('^chat:', { crash: true })]);
    await openPanel(page);
    await action(page, 'Explain simply').click();
    await expect(errors(page)).toHaveText('Something went wrong. Try again.');
  });

  test('ERR-001 a failed answer in an existing chat leaves the chat as it was', async ({ page, hub }) => {
    await hub.script([{ match: { label: '^chat:ask$' }, times: 1, reply: { text: 'Good answer GOOD-1' } }]);
    await openPanel(page);
    await ask(page, 'Works');
    await settled(page);
    const before = JSON.stringify(onlyChat(hub).messages);
    await hub.script([rule('^chat:ask$', { error: 'That took too long. Try again.' })]);
    await ask(page, 'Fails');
    await expect(errors(page)).toHaveText('That took too long. Try again.');
    expect(JSON.stringify(onlyChat(hub).messages)).toEqual(before);
    // the next redraw of the thread drops the failed question
    await scope(page, 'Whole deck');
    await expect(questions(page)).toHaveCount(1);
  });

  test('ERR-001 the error message is shown in red', async ({ page, hub }) => {
    test.fail(true, 'BROKEN in current app: the error shows in the normal text colour on a grey box, not red (.err uses '
      + 'var(--text)); docs/functional-spec/02-tutor-and-chats.md ERR-001 / LIVE-004 / SIDE-008 say red');
    await hub.script([rule('^chat:ask$', { error: 'Claude reported an error. Try again in a moment.' })]);
    await openPanel(page);
    await ask(page, 'Will fail');
    await expect(errors(page)).toBeVisible();
    const [r, g, b] = (await errors(page).evaluate((e) => getComputedStyle(e).color)).match(/\d+/g)!.map(Number);
    expect(r, 'red').toBeGreaterThan(g + 60);
    expect(r, 'red').toBeGreaterThan(b + 60);
  });

  test('ERR-001 the text of a failed question is put back in the Ask box', async ({ page, hub }) => {
    test.fail(true, 'BROKEN in current app: a failed question\'s text is lost (the box stays empty); see "Known issues" in '
      + 'docs/functional-spec/02-tutor-and-chats.md (ERR-001)');
    await hub.script([rule('^chat:ask$', { error: 'Claude reported an error. Try again in a moment.' })]);
    await openPanel(page);
    await ask(page, 'Please keep my words');
    await expect(errors(page)).toBeVisible();
    await expect(askBox(page)).toHaveValue('Please keep my words', { timeout: 3000 });
  });

  for (const msg of [
    'That took too long. Try again.',
    "Claude didn't answer. Check that Claude Code is signed in, then try again.",
    'Claude ran out of look-up steps. Try a narrower question.',
    "Claude's answer came back in the wrong shape. Try again.",
  ]) {
    test(`ERR-002 the tutor's own message is shown: "${msg.slice(0, 30)}…"`, async ({ page, hub }) => {
      await hub.script([rule('^chat:', { error: msg })]);
      await openPanel(page);
      await action(page, 'Explain simply').click();
      await expect(errors(page)).toHaveText(msg);
    });
  }

  test('ERR-002 "The hub isn\'t responding…" when the hub cannot be reached', async ({ page }) => {
    await openPanel(page);
    await page.route('**/api/tutor', (r) => r.abort());
    await ask(page, 'Anyone there?');
    await expect(errors(page)).toHaveText("The hub isn't responding. Start it again with start.bat, then retry.");
  });

  test('ERR-002 "The answer was cut off…" when the answer stream ends without completing', async ({ page }) => {
    await openPanel(page);
    await page.route('**/api/tutor', (r) => r.fulfill({ status: 200, contentType: 'text/event-stream',
      body: 'event: status\ndata: "Thinking"\n\nevent: text\ndata: "Half an ans"\n\n' }));
    await ask(page, 'Cut me off');
    await expect(errors(page)).toHaveText('The answer was cut off. Try again.');
  });

  test('ERR-004 request validation: empty question, unknown deck, unknown mode, unknown course', async ({ api, hub }) => {
    const post = (body: Record<string, unknown>) => api.post('/api/tutor', { data: { course: DEMO, tag: 'S&D-1', n: 2, mode: 'ask', question: 'q', ...body } });
    let r = await post({ question: '   ' });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe('Type a question first.');
    r = await post({ tag: 'NOPE-9' });
    expect(r.ok()).toBe(false);
    expect((await r.json()).error).toBe('Open a deck first.');
    r = await post({ mode: 'sing' });
    expect(r.ok()).toBe(false);
    expect((await r.json()).error).toBe('Unknown request.');
    r = await post({ course: 'No-Such-Course' });
    expect(r.ok()).toBe(false);
    expect((await r.json()).error).toBe('Unknown course.');
    expect(await hub.calls('^chat:')).toHaveLength(0);
    expect(hubStateChat(hub) ?? null).toBeNull();
  });

  test('ERR-005 a failed answer is still counted in usage', async ({ page, hub, api }) => {
    await hub.script([rule('^chat:ask$', { error: 'Claude reported an error. Try again in a moment.' })]);
    await openPanel(page);
    await ask(page, 'Counted?');
    await expect(errors(page)).toBeVisible();
    const u = await (await api.get('/api/usage')).json();
    expect(u.this.failed).toBe(1);
    expect(u.calls.some((c: any) => c.error && /chat:ask/.test(c.kind))).toBe(true);
  });
});
void readChat;
