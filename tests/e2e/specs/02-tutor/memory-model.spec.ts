/**
 * 02 · The tutor's memory of the student, and model / source selection (docs/functional-spec/02-tutor-and-chats.md
 * §8 MEM-*, §9 MODEL-*). The memory lives in <course>/me/tutor-memory.md and is rewritten in the background.
 *
 * Not covered:
 * - MEM-001 (b) a spoken Talk question and (d) a reply during an exam drill: the voice and practice areas drive those
 *   flows; here (b) is checked through the hub's "voice" request only.
 * - MEM-003 "updates for one course happen one at a time" (no black-box way to see two updates overlap).
 * - MEM-002 "extra sections the student added are kept": the model is told to keep them [MODEL]; the hub writes back
 *   what the model returns.
 * - MODEL-002 the cached / built-in OpenCode list when its server is unreachable (the harness always offers its list).
 * - MODEL-005 "The slides don't cover this" [MODEL] (only that the tutor is told to stick to the slides).
 * Covered elsewhere: TUT-032 / MEM-001 (c) grill answers (panel.spec.ts), MEM-001 (a) dictated drafts (live.spec.ts).
 */
import { test, expect } from '../../fixtures/hub';
import type { Page } from '@playwright/test';
import {
  DEMO, SD1_S2, answers, openSlide, openPanel, ask, askAndSettle, settled, action, rule, held, callsAtLeast,
  memoryJson, onlyChat, seedWith, openMore, scope,
} from './helpers';

// (line endings normalised: the hub writes the platform's)
const MEM = (hub: import('../../fixtures/hub').Hub) => (hub.exists(DEMO, 'me', 'tutor-memory.md') ? hub.read(DEMO, 'me', 'tutor-memory.md').replace(/\r\n/g, '\n') : null);
const tutorApi = (api: import('@playwright/test').APIRequestContext, body: Record<string, unknown>) =>
  api.post('/api/tutor', { data: { course: DEMO, tag: 'S&D-1', n: 2, mode: 'ask', question: 'What is a surplus?', ...body } });

test.describe('the tutor\'s memory', () => {
  test('MEM-001 ordinary typed questions and quick actions do not update the memory', async ({ page, hub }) => {
    await openPanel(page);
    await askAndSettle(page, 'Typed', 1);
    await action(page, 'Explain simply').click();
    await settled(page, 2);
    await page.waitForTimeout(1000);
    expect(await hub.calls('^memory$')).toHaveLength(0);
    expect(MEM(hub)).toBeNull();
  });

  test('MEM-001 a spoken question updates the memory in the background; MEM-002 the file format', async ({ api, hub }) => {
    await hub.script([{ match: { label: '^memory$' }, reply: { wait_for: 'mem', json: memoryJson('FORMAT') } }]);
    const t0 = Date.now();
    const r = await tutorApi(api, { spoken: true });
    expect(r.ok()).toBe(true);
    expect(Date.now() - t0).toBeLessThan(20_000);      // (answered while the memory update is still held)
    const [m] = await callsAtLeast(hub, '^memory$');
    expect(m.prompt).toContain('spoken exchange');
    expect(m.prompt).toContain('What is a surplus?');
    expect(MEM(hub)).toBeNull();
    await hub.release('mem');
    await expect.poll(() => MEM(hub)).not.toBeNull();
    const text = MEM(hub)!;
    expect(text.startsWith("# What your tutor remembers\n\n_Kept by the Study Hub's tutor after each spoken question and grill answer. Edit or delete anything._\n\n")).toBe(true);
    const heads = text.match(/^## .+$/gm);
    expect(heads).toEqual(['## About me', '## Questions I keep asking', "## Mistakes I've corrected", '## Still shaky']);
    expect(text).toContain('FORMAT');
  });

  test('MEM-001 a spoken (voice) turn updates the memory; MEM-005 it is given the notes and weak points', async ({ api, hub }) => {
    hub.write(`${DEMO}/me/tutor-memory.md`, "# What your tutor remembers\n\n## About me\n- NOTE-MARK likes graphs\n## Questions I keep asking\n## Mistakes I've corrected\n## Still shaky\n");
    hub.write(`${DEMO}/me/progress.md`, '# Progress\n\n## Weak topics\n\n- WEAK-MARK elasticity\n\n## Error log\n\n- ERRLOG-MARK\n');
    await hub.script([{ match: { label: '^memory$' }, reply: { json: memoryJson('VOICE-MEM') } }]);
    const r = await tutorApi(api, { mode: 'voice', question: 'Tell me about shortages' });
    expect(r.ok()).toBe(true);
    const [v] = await hub.calls('^chat:voice$');
    expect(v.prompt).toContain('NOTE-MARK');
    expect(v.prompt).toContain('WEAK-MARK');
    expect(v.prompt).toContain('ERRLOG-MARK');
    await callsAtLeast(hub, '^memory$');
    await expect.poll(() => MEM(hub)).toContain('VOICE-MEM');
  });

  test('MEM-003 an update that adds nothing leaves the file untouched', async ({ api, hub }) => {
    const before = "# What your tutor remembers\n\n## About me\n- untouched\n";
    hub.write(`${DEMO}/me/tutor-memory.md`, before);
    await hub.script([{ match: { label: '^memory$' }, reply: { json: { changed: false, memory: 'whatever' } } }]);
    await tutorApi(api, { spoken: true });
    await callsAtLeast(hub, '^memory$');
    await new Promise((r) => setTimeout(r, 800));
    expect(MEM(hub)).toBe(before);
  });

  test('MEM-003 an update missing a section is retried once, then dropped', async ({ api, hub }) => {
    await hub.script([{ match: { label: '^memory$' }, reply: { json: { changed: true, memory: '## About me\n- only a summary' } } }]);
    await tutorApi(api, { spoken: true });
    const calls = await callsAtLeast(hub, '^memory$', 2);
    expect(calls[1].prompt).toContain('Your last reply put a summary in "memory"');
    await new Promise((r) => setTimeout(r, 800));
    expect(await hub.calls('^memory$')).toHaveLength(2);
    expect(MEM(hub)).toBeNull();
  });

  test('MEM-003 an update missing a section the first time but whole on the retry is written', async ({ api, hub }) => {
    await hub.script([
      { match: { label: '^memory$' }, times: 1, reply: { json: { changed: true, memory: '## About me\n- a summary' } } },
      { match: { label: '^memory$' }, reply: { json: memoryJson('RETRIED') } },
    ]);
    await tutorApi(api, { spoken: true });
    await expect.poll(() => MEM(hub)).toContain('RETRIED');
  });

  test('MEM-003 if the student edits the file while an update is prepared, the student\'s edit wins', async ({ api, hub }) => {
    hub.write(`${DEMO}/me/tutor-memory.md`, '# What your tutor remembers\n\n## About me\n- old\n');
    await hub.script([{ match: { label: '^memory$' }, reply: { wait_for: 'mem', json: memoryJson('MODEL-VERSION') } }]);
    await tutorApi(api, { spoken: true });
    await callsAtLeast(hub, '^memory$');
    await new Promise((r) => setTimeout(r, 50));
    const mine = '# What your tutor remembers\n\n## About me\n- STUDENT-EDIT\n';
    hub.write(`${DEMO}/me/tutor-memory.md`, mine);
    await hub.release('mem');
    await new Promise((r) => setTimeout(r, 1500));
    expect(MEM(hub)).toBe(mine);
  });

  test('MEM-003 a failed update leaves the file as it was', async ({ api, hub }) => {
    const before = '# What your tutor remembers\n\n## About me\n- kept as it was\n';
    hub.write(`${DEMO}/me/tutor-memory.md`, before);
    await hub.script([{ match: { label: '^memory$' }, reply: { error: 'Claude reported an error. Try again in a moment.' } }]);
    await tutorApi(api, { spoken: true });
    await callsAtLeast(hub, '^memory$');
    await new Promise((r) => setTimeout(r, 800));
    expect(MEM(hub)).toBe(before);
  });

  test('MEM-004 the memory is updated by Haiku 4.5, or by the chat\'s own OpenCode model', async ({ api, hub }) => {
    await hub.script([{ match: { label: '^memory$' }, reply: { json: { changed: false, memory: '' } } }]);
    await tutorApi(api, { spoken: true, model: 'claude-sonnet-5-5' });
    let calls = await callsAtLeast(hub, '^memory$', 1);
    expect(calls[0].model).toBe('claude-haiku-4-5');
    await tutorApi(api, { spoken: true, question: 'Second one', model: 'opencode/fake-big' });
    calls = await callsAtLeast(hub, '^memory$', 2);
    expect(calls[1].model).toBe('opencode/fake-big');
  });

  test('MEM-006 the memory shows on the course page as "What your tutor remembers" (handoff)', async ({ page, hub }) => {
    hub.write(`${DEMO}/me/tutor-memory.md`, "# What your tutor remembers\n\n## About me\n- SHOWN-ON-COURSE-PAGE\n## Questions I keep asking\n## Mistakes I've corrected\n## Still shaky\n");
    await page.goto('/#c=Demo-Course');
    const link = page.locator('main').getByText('What your tutor remembers').first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.getByText('SHOWN-ON-COURSE-PAGE')).toBeVisible();
  });

  test('MEM-007 an answer that opens with a correction is flagged to the memory update', async ({ page, hub }) => {
    await hub.script([
      { match: { label: '^memory$' }, reply: { json: { changed: false, memory: '' } } },
      rule('^chat:grill$', { text: 'Grill on demand.\n\n**Q1** What shifts demand?' }),
      { match: { label: '^chat:grill_reply$' }, times: 1, reply: { text: 'Not quite: price moves along the curve. **Q2** ...' } },
      { match: { label: '^chat:grill_reply$' }, times: 1, reply: { text: 'Right. **Q3** ...' } },
    ]);
    await openPanel(page);
    await action(page, 'Grill me').click();
    await settled(page, 1);
    await askAndSettle(page, 'The price', 2);
    let mem = await callsAtLeast(hub, '^memory$', 1);
    expect(mem[0].prompt).toContain("the tutor's answer opens with a correction");
    expect(mem[0].prompt).toContain('grill exchange');
    await askAndSettle(page, 'Income', 3);
    mem = await callsAtLeast(hub, '^memory$', 2);
    expect(mem[1].prompt).not.toContain("the tutor's answer opens with a correction");
  });
});

/** The ⋯ menu's Model drop-down. */
const modelPick = (page: Page) => page.getByRole('combobox', { name: 'Model' });

test.describe('model and sources', () => {
  test('MODEL-001 the model picker lists Claude Code first, then OpenCode, each "<name> · <score>"; default Opus 5.5', async ({ page }) => {
    await openSlide(page);
    await openMore(page);
    const pick = modelPick(page);
    await expect(pick).toBeVisible();
    await expect(pick).toHaveValue('claude-opus-5-5');
    const groups = await pick.locator('optgroup').evaluateAll((gs) => gs.map((g) => [(g as HTMLOptGroupElement).label,
      [...g.querySelectorAll('option')].map((o) => o.textContent)]));
    expect(groups).toEqual([
      ['Claude Code', ['Opus 5.5 · 96', 'Sonnet 5.5 · 88', 'Haiku 4.5 · 74']],
      ['OpenCode', ['Fake Big · 60', 'Fake Small · 40']],
    ]);
  });

  test('MODEL-002 the hub lists the OpenCode models it knows', async ({ api }) => {
    const m = await (await api.get('/api/models')).json();
    expect(m.default).toBe('claude-opus-5-5');
    const ids = m.models.map((x: any) => x.id);
    expect(ids).toEqual(expect.arrayContaining(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'opencode/fake-big', 'opencode/fake-small']));
  });

  test('MODEL-003 the chosen model is used for tutor answers and side questions, and remembered on this device only', async ({ page, hub, browser }) => {
    await hub.script([rule('^chat:ask$', { text: 'With a [[term]] in it.' }), rule('^side$', { text: 'Side on the chosen model' })]);
    await openSlide(page);
    await openMore(page);
    await modelPick(page).selectOption('claude-sonnet-5-5');
    await page.keyboard.press('Escape');
    await openPanel(page, SD1_S2);
    await askAndSettle(page, 'Which model?');
    expect((await hub.calls('^chat:ask$'))[0].model).toBe('claude-sonnet-5-5');
    await answers(page).first().getByRole('button', { name: 'term' }).click();
    await expect(page.getByRole('dialog', { name: 'Side question' })).toContainText('Side on the chosen model');
    expect((await hub.calls('^side$'))[0].model).toBe('claude-sonnet-5-5');
    await page.reload();
    await openMore(page);
    await expect(modelPick(page)).toHaveValue('claude-sonnet-5-5');
    // another device keeps the default
    const ctx = await browser.newContext({ baseURL: hub.url });
    const p2 = await ctx.newPage();
    await openSlide(p2);
    await openMore(p2);
    await expect(modelPick(p2)).toHaveValue('claude-opus-5-5');
    await ctx.close();
  });

  test('MODEL-003 a remembered model no longer listed falls back to the default; the hub answers bad models with the default', async ({ page, api, hub }) => {
    await page.addInitScript(() => localStorage.setItem('model', JSON.stringify('opencode/gone-away')));
    await openSlide(page);
    await openMore(page);
    await expect(modelPick(page)).toHaveValue('claude-opus-5-5');
    await tutorApi(api, { model: 'not a model!' });
    await tutorApi(api, { question: 'No model given' });
    const calls = await hub.calls('^chat:ask$');
    expect(calls.map((c) => c.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5']);
  });

  test('MODEL-004 every saved answer records its model, time and cost; they are not shown under the answer (pinned as-is)', async ({ page, hub }) => {
    await hub.script([rule('^chat:ask$', { text: 'Costed answer COSTED', cost: 0.0789, ms: 4321,
      tokens: { in: 1234, cache_read: 0, cache_write: 0, out: 567 } })]);
    await openPanel(page);
    await askAndSettle(page, 'How much?');
    const a = onlyChat(hub).messages[1];
    expect(a).toMatchObject({ model: 'claude-opus-5-5', ms: 4321, cost: 0.0789 });
    const shown = await answers(page).first().textContent();
    expect(shown).not.toMatch(/0\.07|\$|4\.3 ?s|4321|1,?234|tokens/);
  });

  test('MODEL-005 Stick to slides: per course, per device, off by default; on, the tutor and side questions keep to the slides', async ({ page, hub, browser }) => {
    await hub.script([rule('^chat:ask$', { text: 'A [[term]] here.' }), rule('^side$', { text: 'Side answer' })]);
    await openSlide(page);
    await openMore(page);
    const box = page.getByRole('checkbox', { name: /Stick to slides/ });
    await expect(box).toBeVisible();
    await expect(page.locator('#slides-only-row')).toContainText('Stick to slides Demo-Course'); // locator: markup hook
    await expect(box).not.toBeChecked();
    // off: the tutor may use the web
    await page.keyboard.press('Escape');
    await openPanel(page, SD1_S2);
    await askAndSettle(page, 'Web allowed?', 1);
    let [c] = await hub.calls('^chat:ask$');
    expect(c.web).toBe(true);
    expect(c.system).toContain('WebSearch/WebFetch');
    // on
    await openMore(page);
    await box.check();
    await page.keyboard.press('Escape');
    await scope(page, 'This slide');
    await askAndSettle(page, 'Slides only?', 2);
    c = (await hub.calls('^chat:ask$'))[1];
    expect(c.web).toBe(false);
    expect(c.system).toContain('Stick to the slides');
    await answers(page).nth(1).getByRole('button', { name: 'term' }).click();
    await expect(page.getByRole('dialog', { name: 'Side question' })).toContainText('Side answer');
    const [s] = await hub.calls('^side$');
    expect(s.web).toBe(false);
    // remembered on this device
    await page.reload();
    await openMore(page);
    await expect(page.getByRole('checkbox', { name: /Stick to slides/ })).toBeChecked();
    // not on another device
    const ctx = await browser.newContext({ baseURL: hub.url });
    const p2 = await ctx.newPage();
    await openSlide(p2);
    await openMore(p2);
    await expect(p2.getByRole('checkbox', { name: /Stick to slides/ })).not.toBeChecked();
    await ctx.close();
  });

  test('MODEL-006 every tutor request carries the course, the deck map, the location and the student\'s words', async ({ page, hub }) => {
    await openPanel(page);
    await askAndSettle(page, 'MY-OWN-WORDS about curves');
    const [c] = await hub.calls('^chat:ask$');
    const all = c.system + '\n' + c.prompt;
    expect(c.system).toContain('Demo-Course');
    expect(c.system).toContain('Introductory Economics (demo)');
    expect(all).toContain('S&D-1');
    expect(all).toContain('HW-1');
    expect(all).toContain('[S&D-1 s2] "Demand and supply curves"');
    expect(all).toContain('MY-OWN-WORDS about curves');
    expect(all).toMatch(/\[#/);          // the drawing-cue convention
  });
});
void held; void ask; void seedWith;
