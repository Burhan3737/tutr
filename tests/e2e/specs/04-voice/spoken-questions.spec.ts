/**
 * 04 Voice — spoken (dictated) questions: the 🎙 mark, the tutor's notes on the student, the hub-only spoken-question
 * style (mode "voice", the retired Talk tab's request), and what persists.
 * Spec: docs/functional-spec/04-voice.md §12–14 (VOICE-080..097).
 *
 * Not covered: VOICE-084 "the student's edit wins over an update in progress" (a race inside the hub's background
 *   update; not reproducible deterministically from outside), VOICE-085..088 answer quality ([model]: only the
 *   instructions given to the model are checked), VOICE-090 "read afresh for every question" (would need editing
 *   voice_prompt.md in the app's code folder, which tests must not touch; the stripping of editor comments is
 *   checked), VOICE-097 (the downloaded speech models live outside the library and are replaced by the launcher).
 */
import { test, expect } from '../../fixtures/hub';
import * as V from './helpers';

const HEARD = 'what is elasticity';
const stt = (text = HEARD) => ({ match: { label: '^stt$' }, reply: { text } });
const NOTES = "## About me\n- Likes graphs\n## Questions I keep asking\n- What elasticity is (1 time)\n## Mistakes I've corrected\n- (nothing yet)\n## Still shaky\n- (nothing yet)";
const memoryRule = (memory = NOTES, changed = true) => ({ match: { label: '^memory$' }, reply: { json: { changed, memory } } });

async function panel(page: any, hub: any, rules: any[]) {
  await hub.script(rules);
  await V.openDeck(page);
  await V.openTutor(page);
}

/** The course's saved chats (JSON), newest last by name. */
function chats(hub: any) {
  return hub.list('Demo-Course/me/chats').filter((f: string) => f.endsWith('.json')).map((f: string) => hub.readJson('Demo-Course/me/chats', f));
}

test.describe('the 🎙 mark', () => {
  test('VOICE-080 VOICE-094 a dictated question is sent as spoken and marked 🎙, also after a reload and in the saved chat', async ({ page, hub }) => {
    await panel(page, hub, [stt(), V.answerRule('Answer one.', '^chat:ask$'), memoryRule()]);
    await V.dictate(page);
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue(HEARD);
    await V.askBox(page).press('End');
    await page.keyboard.type(' please'); // edited: still dictated
    const sent = page.waitForRequest((r) => r.url().includes('/api/tutor'));
    await V.askButton(page).click();
    expect((await sent).postDataJSON()).toMatchObject({ question: `${HEARD} please`, spoken: true });
    await expect(V.questions(page).last()).toHaveText(new RegExp(`^\\W*🎙 ${HEARD} please`));
    await expect(V.answers(page).last()).toContainText('Answer one.');
    await page.reload();
    await V.openTutor(page);
    await expect(V.questions(page).last()).toHaveText(new RegExp(`^\\W*🎙 ${HEARD} please`));
    const q = chats(hub).flatMap((c: any) => c.messages).find((m: any) => m.role === 'q');
    expect(q).toMatchObject({ text: `${HEARD} please`, spoken: true });
  });

  test('VOICE-080 a typed question has no mark, and clearing a dictated box removes the dictated status', async ({ page, hub }) => {
    await panel(page, hub, [stt(), V.answerRule('Answer.', '^chat:ask$')]);
    const bodies: any[] = [];
    page.on('request', (r) => { if (r.url().includes('/api/tutor')) bodies.push(r.postDataJSON()); });
    await V.ask(page, 'typed question');
    await expect(V.answers(page)).toHaveCount(1);
    await expect(V.questions(page).last()).not.toContainText('🎙');
    await V.dictate(page);
    await V.micIdle(page);
    await V.askBox(page).fill('');
    await V.askBox(page).fill('typed again');
    await V.askBox(page).press('Enter');
    await expect(V.answers(page)).toHaveCount(2);
    await expect(V.questions(page).last()).not.toContainText('🎙');
    expect(bodies.map((b) => !!b.spoken)).toEqual([false, false]);
    expect(chats(hub).flatMap((c: any) => c.messages).filter((m: any) => m.role === 'q').every((m: any) => !m.spoken)).toBe(true);
  });

  test('VOICE-080 VOICE-081 the dictated status travels with the shared draft: dictated on one device, sent from another, marked on both', async ({ page, hub, context }) => {
    await hub.script([stt(), V.answerRule('Shared.', '^chat:ask$'), memoryRule()]);
    const other = await context.newPage();
    await V.openDeck(page);
    await V.openTutor(page);
    await V.openDeck(other);
    await V.openTutor(other);
    await V.dictate(page);
    await V.micIdle(page);
    await expect(V.askBox(other)).toHaveValue(HEARD, { timeout: 15_000 });
    const sent = other.waitForRequest((r) => r.url().includes('/api/tutor'));
    await V.askButton(other).click();
    expect((await sent).postDataJSON()).toMatchObject({ spoken: true });
    await expect(V.questions(other).last()).toContainText(`🎙 ${HEARD}`);
    await expect(V.questions(page).last()).toContainText(`🎙 ${HEARD}`, { timeout: 15_000 });
  });
});

test.describe('the tutor\'s notes', () => {
  test('VOICE-082 VOICE-083 VOICE-095 a dictated question is answered as an ordinary ask, then the notes are updated from it', async ({ page, hub }) => {
    await panel(page, hub, [stt(), V.answerRule('Elasticity is responsiveness.', '^chat:ask$'), memoryRule()]);
    await V.dictate(page);
    await V.micIdle(page);
    await V.askButton(page).click();
    await expect(V.answers(page).last()).toContainText('Elasticity is responsiveness.');
    const [turn] = await hub.calls('^chat:');
    expect(turn.label).toBe('chat:ask');
    expect(turn.prompt).toContain(HEARD);
    expect(turn.prompt).not.toContain('They said:');
    await expect.poll(async () => (await hub.calls('^memory$')).length, { timeout: 10_000 }).toBe(1);
    const [mem] = await hub.calls('^memory$');
    expect(mem.prompt).toContain(HEARD);
    expect(mem.prompt).toContain('Elasticity is responsiveness.');
    expect(mem.prompt).toMatch(/speech recognition/);
    await expect.poll(() => hub.exists('Demo-Course/me/tutor-memory.md')).toBe(true);
    const notes = hub.read('Demo-Course/me/tutor-memory.md');
    expect(notes).toMatch(/^# What your tutor remembers/);
    expect(notes).toContain('- What elasticity is (1 time)');
  });

  test('VOICE-083 a typed question does not update the notes', async ({ page, hub }) => {
    await panel(page, hub, [V.answerRule('Typed answer.', '^chat:ask$'), memoryRule()]);
    await V.ask(page, 'typed only');
    await expect(V.answers(page).last()).toContainText('Typed answer.');
    await page.waitForTimeout(1500);
    expect(await hub.calls('^memory$')).toHaveLength(0);
    expect(hub.exists('Demo-Course/me/tutor-memory.md')).toBe(false);
  });

  test('VOICE-084 the notes show on the course page under "Voice tutor" once they exist, and open', async ({ page, hub }) => {
    await page.goto('/#c=Demo-Course');
    await expect(page.locator('main')).toContainText('Supply and demand 1');
    await expect(page.getByRole('link', { name: 'What your tutor remembers' })).toHaveCount(0);
    hub.write('Demo-Course/me/tutor-memory.md', `# What your tutor remembers\n\n${NOTES}\n`);
    await page.reload();
    await expect(page.locator('main')).toContainText('Voice tutor');
    await page.getByRole('link', { name: 'What your tutor remembers' }).click();
    await expect(page.locator('main')).toContainText('Likes graphs');
  });

  test('VOICE-084 an update missing a section is retried once, then discarded; the answer is unaffected', async ({ page, hub }) => {
    const bad = '## About me\n- x\n## Still shaky\n- y';
    await panel(page, hub, [stt(), V.answerRule('Fine answer.', '^chat:ask$'), memoryRule(bad)]);
    await V.dictate(page);
    await V.micIdle(page);
    await V.askButton(page).click();
    await expect(V.answers(page).last()).toContainText('Fine answer.');
    await expect.poll(async () => (await hub.calls('^memory$')).length, { timeout: 10_000 }).toBe(2);
    const calls = await hub.calls('^memory$');
    expect(calls[1].prompt).toContain('must be the whole notebook');
    await page.waitForTimeout(1000);
    expect((await hub.calls('^memory$')).length).toBe(2);
    expect(hub.exists('Demo-Course/me/tutor-memory.md')).toBe(false);
  });
});

test.describe('spoken-question requests (mode "voice", hub only)', () => {
  const turn = (api: any, extra: Record<string, unknown> = {}) =>
    api.post('/api/tutor', { data: { course: 'Demo-Course', tag: 'S&D-1', n: 3, mode: 'voice', question: 'what is elasticity', scope: 'slide', ...extra } });

  test('VOICE-085 VOICE-086 VOICE-089 VOICE-090 the spoken style, with what was heard and the slide, editor comments stripped', async ({ api, hub }) => {
    await hub.script([V.answerRule('Elasticity is how much quantity responds.', '^chat:voice$'), memoryRule()]);
    const r = await turn(api);
    expect(r.status()).toBe(200);
    expect((await r.json()).message.text).toContain('Elasticity is how much quantity responds.');
    const [call] = await hub.calls('^chat:voice$');
    expect(call.prompt).toContain('They said: "what is elasticity"');
    expect(call.prompt).toMatch(/speech recognition/i);
    expect(call.prompt).toMatch(/The student is studying slide \[S&D-1 s3\][^\n]*Price elasticity/);
    expect(call.prompt).toMatch(/read aloud/i);
    expect(call.prompt).not.toContain('<!--');
    expect(call.prompt).not.toContain('Fill-ins');
    expect(call.prompt).not.toMatch(/\{(where|question|memory|mistakes)\}/);
  });

  test('VOICE-089 with Whole deck, the spoken question is about the whole deck', async ({ api, hub }) => {
    await hub.script([V.answerRule('Deck answer.', '^chat:voice$'), memoryRule()]);
    await turn(api, { scope: 'deck' });
    const [call] = await hub.calls('^chat:voice$');
    expect(call.prompt).toMatch(/studying the whole deck \[S&D-1\][^\n]*Supply and demand 1/);
  });

  test('VOICE-088 a new student: no notes and no recorded mistakes are said so', async ({ api, hub }) => {
    hub.write('Demo-Course/me/progress.md', '# Progress: Demo-Course\n\n## Weak topics\n\n## Error log\n\n## Review queue\n\nKept by the Tutr hub.\n');
    await hub.script([V.answerRule('A.', '^chat:voice$'), memoryRule()]);
    await turn(api);
    const [call] = await hub.calls('^chat:voice$');
    expect(call.prompt).toContain('(nothing yet: this is a new student)');
    expect(call.prompt).toContain('(none recorded yet)');
  });

  test('VOICE-088 the tutor\'s notes and the weak topics go with every spoken question', async ({ api, hub }) => {
    hub.write('Demo-Course/me/tutor-memory.md', `# What your tutor remembers\n\n${NOTES}\n`);
    hub.write('Demo-Course/me/progress.md', '# Progress: Demo-Course\n\n## Weak topics\n\n- Elasticity sign confusion\n\n## Error log\n\n## Review queue\n\nKept by the Tutr hub.\n');
    await hub.script([V.answerRule('A.', '^chat:voice$'), memoryRule()]);
    await turn(api);
    const [call] = await hub.calls('^chat:voice$');
    expect(call.prompt).toContain('Likes graphs');
    expect(call.prompt).toContain('Elasticity sign confusion');
    expect(call.prompt).not.toContain('# What your tutor remembers');
  });

  test('VOICE-091 a spoken question is kept in the course chat with the 🎙 mark and updates the notes', async ({ api, hub, page }) => {
    await hub.script([V.answerRule('Kept answer.', '^chat:voice$'), memoryRule()]);
    await turn(api);
    const q = chats(hub).flatMap((c: any) => c.messages).find((m: any) => m.role === 'q');
    expect(q).toMatchObject({ text: 'what is elasticity', mode: 'voice' });
    await expect.poll(async () => (await hub.calls('^memory$')).length, { timeout: 10_000 }).toBe(1);
    await expect.poll(() => hub.exists('Demo-Course/me/tutor-memory.md')).toBe(true);
    await V.openDeck(page, '/#c=Demo-Course&d=S%26D-1&s=3');
    await V.openTutor(page);
    await expect(V.questions(page).last()).toContainText('🎙 what is elasticity');
    await expect(V.answers(page).last()).toContainText('Kept answer.');
  });

  test('VOICE-092 an empty spoken question is refused with "Type a question first."', async ({ api, hub }) => {
    const r = await turn(api, { question: '   ' });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe('Type a question first.');
    expect(await hub.calls('^chat:')).toHaveLength(0);
  });
});

test.describe('what persists', () => {
  test('VOICE-096 recordings, partial text and synthesised speech are never saved in the library', async ({ page, hub }) => {
    const before = new Set(hub.list());
    await panel(page, hub, [stt(), V.answerRule('Said aloud and saved as text.', '^chat:ask$'), memoryRule()]);
    await V.dictate(page);
    await V.micIdle(page);
    await V.askButton(page).click();
    await expect(V.answers(page).last()).toContainText('Said aloud and saved as text.');
    await V.lastPlay(page).click();
    await expect.poll(async () => (await hub.spoken()).length).toBeGreaterThan(0);
    await expect(V.voiceRow(page)).toBeHidden({ timeout: 10_000 });
    await expect.poll(() => hub.exists('Demo-Course/me/tutor-memory.md')).toBe(true);
    await page.waitForTimeout(1000);
    const added = hub.list().filter((f) => !before.has(f));
    expect(added.filter((f) => /\.(wav|webm|ogg|mp3|pcm|m4a|opus)$/i.test(f))).toEqual([]);
    // only chats, the hub's state/drafts and the notes appear
    for (const f of added) expect(f).toMatch(/^Demo-Course\/me\//);
    const dump = added.map((f) => hub.read(f)).join('\n');
    expect(dump).not.toMatch(/RIFF|data:audio/);
  });

  test('VOICE-096 reloading during a dictation loses it; reloading during a reading stops it', async ({ page, hub }) => {
    await panel(page, hub, [stt(), V.answerRule(V.longAnswer('Reload', 6), '^chat:ask$')]);
    await V.askBox(page).fill('');
    const chunk = page.waitForRequest((r) => r.url().includes('/api/voice/dictate/chunk'));
    await V.mic(page).click();
    await chunk;
    await page.reload();
    await expect(V.mic(page)).toHaveText('🎙');
    await expect(V.askBox(page)).toHaveValue('');
    await page.waitForTimeout(1000);
    await expect(V.askBox(page)).toHaveValue('');
    expect(await hub.calls('^stt$')).toHaveLength(0);
    await V.slowVoice(page, 1500);
    await V.openTutor(page);
    await V.ask(page, 'q');
    await V.lastPlay(page).click();
    await expect(V.voiceState(page)).toHaveText('Speaking…');
    await page.reload();
    await V.openTutor(page);
    await expect(V.voiceRow(page)).toBeHidden();
    await expect(V.lastPlay(page)).toHaveText('▶ Play');
  });
});
