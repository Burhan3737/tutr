/**
 * 04 Voice — writing down while you talk (streamed dictation), the whole-recording fallback, live preview,
 * the hub's dictation-session limits, and cancelling a dictation.
 * Spec: docs/functional-spec/04-voice.md §9, §10 (VOICE-067..076) and the pinned part of VOICE-062.
 *
 * The hub writes a piece down at a pause or, failing one, every ~12 s; the harness's speech detector hears speech
 * everywhere, so a recording longer than ~12 s yields a piece mid-stream and the rest at Stop. Those tests are slow.
 *
 * Not covered: VOICE-067 "only the last few seconds remain after Stop" and the cut positions ([model]/timing);
 *   VOICE-072 "a session that received nothing for 30 s is discarded when the next dictation starts" (needs a 30 s
 *   idle wait and is not observable without the session's id surviving; the id-based checks below cover the rest).
 * Partly: VOICE-076 (the OS recording indicator is [real-device]; checked as the microphone track being ended).
 */
import { test, expect } from '../../fixtures/hub';
import * as V from './helpers';

const HEARD = 'what is elasticity';
const stt = (text = HEARD, times?: number) => ({ match: { label: '^stt$' }, reply: { text }, ...(times ? { times } : {}) });

async function panel(page: any, hub: any, rules: any[] = [stt()]) {
  await hub.script(rules);
  await V.openDeck(page);
  await V.openTutor(page);
}

/** Decode a data:audio/wav;base64 URL's header. */
function wavInfo(dataUrl: string) {
  const b = Buffer.from(dataUrl.split(',').pop()!, 'base64');
  return { riff: b.toString('ascii', 0, 4), wave: b.toString('ascii', 8, 12), channels: b.readUInt16LE(22),
    rate: b.readUInt32LE(24), bits: b.readUInt16LE(34), seconds: b.readUInt32LE(40) / 2 / b.readUInt32LE(24) };
}

test.describe('streaming while you talk', () => {
  test('VOICE-067 the recording goes to the hub in small parts, in order, one at a time, then finish', async ({ page, hub }) => {
    await panel(page, hub);
    const log: string[] = [];
    let inFlight = 0, maxInFlight = 0;
    page.on('request', (r) => {
      if (!r.url().includes('/api/voice/dictate/')) return;
      const u = new URL(r.url());
      log.push(u.pathname.split('/').pop() + (u.searchParams.has('seq') ? ':' + u.searchParams.get('seq') : ''));
      if (u.pathname.endsWith('/chunk')) { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); }
    });
    const done = (r: any) => { if (r.url().includes('/api/voice/dictate/chunk')) inFlight--; };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
    await V.dictate(page, 2000);
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue(HEARD);
    expect(log[0]).toBe('start');
    const chunks = log.filter((x) => x.startsWith('chunk'));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks).toEqual(chunks.map((_, i) => `chunk:${i}`));
    expect(log.at(-1)).toBe('finish');
    expect(maxInFlight).toBe(1);
    expect(await hub.calls('^stt$')).toHaveLength(1);
  });

  test('VOICE-069 VOICE-068 a long recording is written down in parts, once each, joined by spaces; without the preview the box waits for Stop', async ({ page, hub }) => {
    test.setTimeout(90_000);
    await panel(page, hub, [stt('alpha bravo charlie', 1), stt('delta echo')]);
    const heard: string[] = [];
    page.on('response', async (r) => {
      if (r.url().includes('/api/voice/dictate/chunk')) heard.push((await r.json().catch(() => ({}))).text || '');
    });
    await V.askBox(page).fill('');
    await V.mic(page).click();
    // the first part comes back while still listening…
    await expect.poll(() => heard.at(-1), { timeout: 30_000 }).toBe('alpha bravo charlie');
    // …but the box does not change until Stop (preview off by default)
    await expect(V.mic(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(V.askBox(page)).toHaveValue('');
    await V.mic(page).click();
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue('alpha bravo charlie delta echo');
    const calls = await hub.calls('^stt$');
    expect(calls).toHaveLength(2);
    // the second part is primed with the course words and the last words already written
    expect(calls[0].prompt).toMatch(/^Supply and demand 1/);
    expect(calls[1].prompt).toMatch(/^Supply and demand 1.*alpha bravo charlie$/);
  });

  test('VOICE-068 VOICE-093 "Show words while dictating" is off by default and remembered on this browser', async ({ page }) => {
    await V.openDeck(page);
    await page.locator('#menu-btn').click(); // locator: markup hook (the top bar's "More"; the panel has another)
    const box = page.getByRole('checkbox', { name: 'Show words while dictating' });
    await expect(box).not.toBeChecked();
    await box.check();
    await page.reload();
    await page.locator('#menu-btn').click(); // locator: markup hook
    await expect(page.getByRole('checkbox', { name: 'Show words while dictating' })).toBeChecked();
  });

  test('VOICE-068 with the preview on, words appear while listening (box read-only), never reach other devices, and a cancel removes them', async ({ page, hub }) => {
    test.setTimeout(90_000);
    await page.addInitScript(() => localStorage.setItem('dictPreview', 'true'));
    await panel(page, hub, [stt('alpha bravo charlie', 1), stt('delta echo')]);
    const leaks: string[] = [];
    page.on('request', (r) => {
      if (/\/api\/voice\//.test(r.url())) return;
      if ((r.postData() || '').includes('alpha bravo')) leaks.push(r.url());
    });
    await V.askBox(page).fill('before');
    await V.askBox(page).press('End');
    await page.waitForTimeout(1200); // (the draft "before" is saved)
    await V.mic(page).click();
    await expect(V.askBox(page)).toHaveValue('before alpha bravo charlie', { timeout: 30_000 });
    await expect(V.mic(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(V.askBox(page)).toHaveAttribute('readonly', '');
    // a cancelled dictation (starting a new chat) takes the preview out again
    await page.getByRole('button', { name: 'New chat' }).click();
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue('before');
    await page.waitForTimeout(1500);
    expect(leaks).toEqual([]);
  });

  test('VOICE-062 pinned as-is: with the preview on, sending while listening sends the words previewed so far', async ({ page, hub }) => {
    // Pinned as-is: the box holds the preview at that moment, so the partial words go with the question.
    test.setTimeout(90_000);
    await page.addInitScript(() => localStorage.setItem('dictPreview', 'true'));
    await panel(page, hub, [stt('alpha bravo charlie', 1), stt('delta echo'), V.answerRule('Answer.', '^chat:')]);
    await V.mic(page).click();
    await expect(V.askBox(page)).toHaveValue('alpha bravo charlie', { timeout: 30_000 });
    const sent = page.waitForRequest((r) => r.url().includes('/api/tutor'));
    await V.askButton(page).click();
    expect((await sent).postDataJSON().question).toBe('alpha bravo charlie');
    await V.micIdle(page);
    await page.waitForTimeout(1000);
    expect((await hub.calls('^stt$')).map((c) => c.prompt)).toHaveLength(1);
  });
});

test.describe('the whole-recording fallback', () => {
  const cases: [string, (page: any) => Promise<void>][] = [
    ['the hub refuses to start the session', (page) => page.route('**/api/voice/dictate/start', (r: any) => r.fulfill({ status: 503, json: { error: 'x' } }))],
    ['a part is rejected', (page) => page.route('**/api/voice/dictate/chunk**', (r: any) => r.fulfill({ status: 500, json: { error: 'x' } }))],
    ['finishing fails', (page) => page.route('**/api/voice/dictate/finish', (r: any) => r.fulfill({ status: 503, json: { error: 'Writing it down failed.' } }))],
    ['finishing gets no answer', (page) => page.route('**/api/voice/dictate/finish', (r: any) => r.abort())],
  ];
  for (const [why, breakIt] of cases) {
    test(`VOICE-070 when ${why}, Stop sends the whole recording as a 16 kHz mono WAV and the words still arrive`, async ({ page, hub }) => {
      await panel(page, hub, [stt('fallback words')]);
      await breakIt(page);
      const tr = page.waitForRequest((r) => r.url().includes('/api/voice/transcribe'));
      await V.mic(page).click();
      await expect(V.mic(page)).toHaveAttribute('aria-pressed', 'true');
      await page.waitForTimeout(1500);
      await V.mic(page).click();
      const body = (await tr).postDataJSON();
      expect(body).toMatchObject({ course: 'Demo-Course', tag: 'S&D-1', n: 1, scope: 'slide' });
      expect(body.audio).toMatch(/^data:audio\/wav;base64,/);
      const w = wavInfo(body.audio);
      expect(w).toMatchObject({ riff: 'RIFF', wave: 'WAVE', channels: 1, rate: 16000, bits: 16 });
      expect(w.seconds).toBeGreaterThan(0.8);
      expect(w.seconds).toBeLessThan(10);
      await V.micIdle(page);
      await expect(V.askBox(page)).toHaveValue('fallback words');
      await expect(page.locator('.toast')).toHaveCount(0); // locator: markup hook
    });
  }

  test('VOICE-070 when writing down fails on the hub, the session is cancelled and the whole recording is sent', async ({ page, hub }) => {
    await panel(page, hub, [{ match: { label: '^stt$' }, reply: { error: 'boom' }, times: 1 }, stt('second try')]);
    const cancels = V.recordRequests(page, '/api/voice/dictate/cancel');
    const tr = V.recordRequests(page, '/api/voice/transcribe');
    await V.dictate(page);
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue('second try');
    expect(tr).toHaveLength(1);
    expect(cancels).toHaveLength(1);
  });

  test('VOICE-071 finishing that takes too long (past 15 s + 0.1 s per second recorded) falls back to the whole recording', async ({ page, hub }) => {
    await page.clock.install();
    await panel(page, hub, [stt('late words')]);
    await page.route('**/api/voice/dictate/finish', () => { /* never answered */ });
    const tr = V.recordRequests(page, '/api/voice/transcribe');
    const finish = page.waitForRequest((r) => r.url().includes('/api/voice/dictate/finish'));
    await V.dictate(page, 1000);
    await finish;
    await page.clock.fastForward(14_000);
    await page.waitForTimeout(300);
    expect(tr).toHaveLength(0);
    await expect(V.mic(page)).toHaveText('…');
    await page.clock.fastForward(2_000);
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue('late words');
    expect(tr).toHaveLength(1);
  });
});

test.describe('the hub\'s dictation sessions', () => {
  const pcm = (samples: number) => Buffer.alloc(samples * 2);
  test('VOICE-072 parts in order, size and length limits, nothing after finishing; cancel always answers', async ({ api, hub }) => {
    await hub.script([stt('server words')]);
    const start = async () => (await (await api.post('/api/voice/dictate/start', { data: { course: 'Demo-Course', tag: 'S&D-1', n: 1, scope: 'slide' } })).json()).id;
    const chunk = (id: string, seq: number, body: Buffer) =>
      api.post(`/api/voice/dictate/chunk?id=${encodeURIComponent(id)}&seq=${seq}`, { data: body, headers: { 'Content-Type': 'application/octet-stream' } });
    const id = await start();
    expect(typeof id).toBe('string');
    let r = await chunk(id, 0, pcm(16000));
    expect(r.status()).toBe(200);
    // out of order
    r = await chunk(id, 5, pcm(1600));
    expect(r.status()).toBe(409);
    expect((await r.json()).error).toBe('A piece of the recording went missing.');
    // damaged (odd byte count)
    r = await chunk(id, 1, Buffer.alloc(3));
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe('The recording arrived damaged.');
    // too big a part
    r = await chunk(id, 1, Buffer.alloc(1024 * 1024 + 2));
    expect(r.status()).toBe(413);
    expect((await r.json()).error).toBe('That piece of the recording is too big.');
    // finish: the words; then nothing more is accepted
    r = await api.post('/api/voice/dictate/finish', { data: { id } });
    expect(r.status()).toBe(200);
    expect((await r.json()).text).toBe('server words');
    r = await chunk(id, 1, pcm(1600));
    expect([404, 409]).toContain(r.status());
    // an unknown session
    r = await chunk('nope', 0, pcm(1600));
    expect(r.status()).toBe(404);
    expect((await r.json()).error).toBe('That dictation has ended.');
    // at most ~130 s of audio
    const long = await start();
    let seq = 0, status = 200;
    while (status === 200 && seq < 10) {
      status = (await chunk(long, seq, pcm(500_000))).status(); // ~31 s each
      if (status === 200) seq++;
    }
    expect(status).toBe(413);
    expect(seq).toBe(4);
    // cancel always answers ok, even for a session already gone
    expect(await (await api.post('/api/voice/dictate/cancel', { data: { id: long } })).json()).toEqual({ ok: true });
    expect(await (await api.post('/api/voice/dictate/cancel', { data: { id: 'nope' } })).json()).toEqual({ ok: true });
    r = await chunk(long, seq, pcm(1600));
    expect([404, 409]).toContain(r.status());
  });
});

test.describe('cancelling a dictation', () => {
  const leaves: [string, (page: any) => Promise<void>][] = [
    ['opening another deck', (page) => page.evaluate(() => { location.hash = '#c=Demo-Course&d=HW-1&s=1'; })],
    ['going home', (page) => page.evaluate(() => { location.hash = ''; })],
    ['opening the course page', (page) => page.evaluate(() => { location.hash = '#c=Demo-Course'; })],
    ['closing the tutor panel', (page) => page.getByRole('button', { name: 'Close the tutor' }).click()],
    ['starting a new chat', (page) => page.getByRole('button', { name: 'New chat' }).click()],
    ['starting a practice exercise from the panel', (page) => page.getByRole('button', { name: 'Try one on this ›' }).click()],
  ];
  for (const [what, leave] of leaves) {
    test(`VOICE-073 ${what} cancels a dictation quietly`, async ({ page, hub }) => {
      await panel(page, hub, [stt(), V.answerRule('An answer.', '^chat:')]);
      if (what.includes('practice')) {
        await V.ask(page, 'q');
        await expect(page.getByRole('button', { name: 'Try one on this ›' })).toBeVisible();
      }
      const cancels = V.recordRequests(page, '/api/voice/dictate/cancel');
      const finishes = V.recordRequests(page, '/api/voice/dictate/finish');
      await V.askBox(page).fill('keep me');
      const chunk = page.waitForRequest((r) => r.url().includes('/api/voice/dictate/chunk'));
      await V.mic(page).click();
      await chunk;
      await leave(page);
      await expect.poll(() => cancels.length).toBe(1);
      await page.waitForTimeout(1500);
      expect(finishes).toHaveLength(0);
      expect(await hub.calls('^stt$')).toHaveLength(0);
      await expect(page.locator('.toast')).toHaveCount(0); // locator: markup hook
      if (await V.mic(page).count()) await expect(V.mic(page)).toHaveText('🎙');
      if (await V.askBox(page).count()) await expect(V.askBox(page)).not.toHaveValue(new RegExp(HEARD));
      if (['closing the tutor panel', 'starting a new chat'].includes(what)) await expect(V.askBox(page)).toHaveValue('keep me');
    });
  }

  test('VOICE-073 turning slides within the same deck does not cancel', async ({ page, hub }) => {
    await panel(page, hub);
    const cancels = V.recordRequests(page, '/api/voice/dictate/cancel');
    const chunk = page.waitForRequest((r) => r.url().includes('/api/voice/dictate/chunk'));
    await V.mic(page).click();
    await chunk;
    await page.getByRole('button', { name: 'Next slide (→)' }).click();
    await expect(page.locator('main')).toContainText('2 / 3');
    await page.waitForTimeout(500);
    await expect(V.mic(page)).toHaveAttribute('aria-pressed', 'true');
    await V.mic(page).click();
    await V.micIdle(page);
    await expect(V.askBox(page)).toHaveValue(HEARD);
    expect(cancels).toHaveLength(0);
  });

  test('VOICE-074 words that come back after leaving the deck are dropped', async ({ page, hub }) => {
    await panel(page, hub);
    await page.route('**/api/voice/dictate/finish', async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue().catch(() => {});
    });
    const finish = page.waitForRequest((r) => r.url().includes('/api/voice/dictate/finish'));
    await V.dictate(page, 800);
    await finish;
    await page.evaluate(() => { location.hash = '#c=Demo-Course&d=HW-1&s=1'; });
    await expect(page.locator('main')).toContainText('1 / 2');
    await page.waitForTimeout(3500);
    await expect(V.askBox(page)).not.toHaveValue(new RegExp(HEARD));
    await expect(page.locator('.toast')).toHaveCount(0); // locator: markup hook
  });

  test('VOICE-075 a dictation cancelled before the hub opened its session gets that session closed once it opens', async ({ page, hub }) => {
    await panel(page, hub);
    let id = '';
    await page.route('**/api/voice/dictate/start', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      const res = await route.fetch();
      id = (await res.json()).id;
      await route.fulfill({ response: res });
    });
    const cancels: any[] = [];
    page.on('request', (r) => { if (r.url().includes('/api/voice/dictate/cancel')) cancels.push(r.postDataJSON()); });
    await V.mic(page).click();
    await expect(V.mic(page)).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'New chat' }).click();
    await V.micIdle(page);
    await expect.poll(() => cancels.length, { timeout: 5000 }).toBe(1);
    expect(cancels[0].id).toBe(id);
  });

  test('VOICE-076 the microphone is released after Stop and after a cancel', async ({ page, hub }) => {
    await V.exposeMicStream(page);
    await panel(page, hub);
    const ended = () => page.evaluate(() => (window as any).__stream.getTracks().every((t: MediaStreamTrack) => t.readyState === 'ended'));
    await V.dictate(page, 500);
    await V.micIdle(page);
    expect(await ended()).toBe(true);
    const chunk = page.waitForRequest((r) => r.url().includes('/api/voice/dictate/chunk'));
    await V.mic(page).click();
    await chunk;
    expect(await ended()).toBe(false);
    await page.getByRole('button', { name: 'New chat' }).click();
    await expect.poll(ended).toBe(true);
  });
});
