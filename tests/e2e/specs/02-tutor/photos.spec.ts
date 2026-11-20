/**
 * 02 · Photos in the Ask box (docs/functional-spec/02-tutor-and-chats.md §6: PHOTO-*; also TUT-013, TUT-017 thumbnails,
 * ERR-003). Photos are saved as JPEG in <course>/me/uploads/ask-<id>.jpg and listed in me/drafts.json.
 *
 * PHOTO-001 on a phone: photos.mobile.spec.ts.
 * Not covered: PHOTO-002 "longest side at most 2000 px" is checked with one large image; the 12 MB limit only through
 * the hub (a browser-side image never gets that big after resizing).
 */
import { test, expect } from '../../fixtures/hub';
import type { Page } from '@playwright/test';
import {
  DEMO, askBox, questions, errors, tray, thumbs, toast, openPanel, openSlide, ask, settled, action, rule, onlyChat,
  uploads, drafts, attach, jpgFile, jpg, devices, closeAll,
} from './helpers';

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** A PNG of w×h pixels made in the page (any decodable image works). */
async function bigPng(page: Page, w: number, h: number): Promise<Buffer> {
  const b64 = await page.evaluate(([w, h]) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d')!; g.fillStyle = '#c33'; g.fillRect(0, 0, w, h);
    return c.toDataURL('image/png').split(',')[1];
  }, [w, h]);
  return Buffer.from(b64, 'base64');
}

test.describe('attaching', () => {
  test('PHOTO-001 PHOTO-002 📷 opens a file chooser; the photo shows as a thumbnail and is saved as JPEG', async ({ page, hub }) => {
    await openPanel(page);
    const btn = page.getByRole('button', { name: 'Attach a photo' });
    await expect(btn).toHaveAttribute('title', 'Attach a photo: it goes with your next question');
    await attach(page, [{ name: 'tiny.png', mimeType: 'image/png', buffer: PNG_1x1 }]);
    await expect(thumbs(page)).toHaveCount(1);
    await expect(tray(page).getByRole('button', { name: 'Remove this photo' })).toBeVisible();
    await expect.poll(() => uploads(hub)).toHaveLength(1);
    expect(uploads(hub)[0]).toMatch(/^ask-[0-9a-f]{12}\.jpg$/);
    const bytes = hub.read(DEMO, 'me', 'uploads', uploads(hub)[0]).slice(0, 0);
    void bytes;
    const head = require('fs').readFileSync(hub.path(DEMO, 'me', 'uploads', uploads(hub)[0])).subarray(0, 3);
    expect([...head]).toEqual([0xff, 0xd8, 0xff]);
    // the thumbnail opens the full image in a new tab
    const link = tray(page).getByRole('link').first();
    await expect(link).toHaveAttribute('target', '_blank');
    const res = await page.request.get(await link.getAttribute('href') as string);
    expect(res.ok()).toBe(true);
  });

  test('PHOTO-001 several images at once', async ({ page, hub }) => {
    await openPanel(page);
    await attach(page, [jpgFile('a.jpg', 1), jpgFile('b.jpg', 2), jpgFile('c.jpg', 3)]);
    await expect(thumbs(page)).toHaveCount(3);
    await expect.poll(() => uploads(hub)).toHaveLength(3);
  });

  test('PHOTO-001 an image can be pasted into the Ask box or dropped onto it', async ({ page, hub }) => {
    await openPanel(page);
    const b64 = jpg().toString('base64');
    await askBox(page).evaluate((ta, data) => {
      const bin = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bin], 'pasted.jpg', { type: 'image/jpeg' }));
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, b64);
    await expect(thumbs(page)).toHaveCount(1);
    await askBox(page).evaluate((ta, data) => {
      const bin = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bin], 'dropped.jpg', { type: 'image/jpeg' }));
      ta.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      ta.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, b64);
    await expect(thumbs(page)).toHaveCount(2);
    await expect.poll(() => uploads(hub)).toHaveLength(2);
  });

  test('PHOTO-002 "Adding…" shows while a photo uploads; big photos are resized to at most 2000 px', async ({ page, hub }) => {
    await openPanel(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    await page.route('**/api/draft/photo', async (route) => { await gate; await route.continue(); });
    const png = await bigPng(page, 3000, 1200);
    await attach(page, [{ name: 'big.png', mimeType: 'image/png', buffer: png }]);
    await expect(tray(page).getByText('Adding…')).toBeVisible();
    release();
    await expect(thumbs(page)).toHaveCount(1);
    await expect(tray(page).getByText('Adding…')).toHaveCount(0);
    const size = await thumbs(page).first().evaluate(async (img: HTMLImageElement) => {
      if (!img.complete) await new Promise((r) => { img.onload = r; });
      return [img.naturalWidth, img.naturalHeight];
    });
    expect(Math.max(...size)).toBeLessThanOrEqual(2000);
    expect(size[0]).toBeGreaterThan(size[1]);
    void hub;
  });

  test('PHOTO-003 attached photos show on every device, are kept in drafts.json and survive a reload and restart', async ({ browser, hub }) => {
    const [d1, d2] = await devices(browser, hub, 2);
    await attach(d1.page, [jpgFile()]);
    await expect(thumbs(d1.page)).toHaveCount(1);
    await expect(thumbs(d2.page)).toHaveCount(1);
    const file = uploads(hub)[0];
    await expect.poll(() => drafts(hub)[DEMO]?.photos).toEqual([`me/uploads/${file}`]);
    await d2.page.reload();
    await expect(thumbs(d2.page)).toHaveCount(1);
    await closeAll([d1, d2]);
    await hub.restart();
    const ctx = await browser.newContext({ baseURL: hub.url });
    const p = await ctx.newPage();
    await openSlide(p);
    await expect(thumbs(p)).toHaveCount(1);
    await ctx.close();
  });

  test('PHOTO-004 × removes the photo from every device and deletes its file', async ({ browser, hub }) => {
    const [d1, d2] = await devices(browser, hub, 2);
    await attach(d1.page, [jpgFile('a.jpg', 1), jpgFile('b.jpg', 2)]);
    await expect(thumbs(d2.page)).toHaveCount(2);
    await expect.poll(() => uploads(hub)).toHaveLength(2);
    await tray(d2.page).getByRole('button', { name: 'Remove this photo' }).first().click();
    await expect(thumbs(d2.page)).toHaveCount(1);
    await expect(thumbs(d1.page)).toHaveCount(1);
    await expect.poll(() => uploads(hub)).toHaveLength(1);
    await expect.poll(() => drafts(hub)[DEMO]?.photos?.length).toBe(1);
    await closeAll([d1, d2]);
  });

  test('PHOTO-006 at most 8 photos per question; a file that is not an image', async ({ page, hub }) => {
    await openPanel(page);
    await attach(page, Array.from({ length: 9 }, (_, i) => jpgFile(`p${i}.jpg`, (i % 3) + 1)));
    await expect(toast(page, 'A question can have 8 photos at most.')).toBeVisible({ timeout: 20_000 });
    await expect(thumbs(page)).toHaveCount(8);
    await tray(page).getByRole('button', { name: 'Remove this photo' }).first().click();
    await expect(thumbs(page)).toHaveCount(7);
    await attach(page, [{ name: 'notes.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('this is not really an image') }]);
    await expect(toast(page, "That file isn't an image the browser can open.")).toBeVisible();
    await expect(thumbs(page)).toHaveCount(7);
    void hub;
  });

  test('PHOTO-006 the hub refuses a non-image and a photo over 12 MB', async ({ api }) => {
    let r = await api.post('/api/draft/photo', { data: { course: DEMO, client: 'x', data: 'data:text/plain;base64,aGVsbG8=' } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe("That isn't an image.");
    const big = 'data:image/jpeg;base64,' + Buffer.alloc(13 * 1024 * 1024, 1).toString('base64');
    r = await api.post('/api/draft/photo', { data: { course: DEMO, client: 'x', data: big } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe('That photo is too large (over 12 MB).');
  });

  test('PHOTO-008 only photos saved in a course\'s me/uploads can be fetched', async ({ api, hub }) => {
    const r0 = await api.post('/api/draft/photo', { data: { course: DEMO, client: 'x', data: 'data:image/jpeg;base64,' + jpg().toString('base64') } });
    const p = (await r0.json()).photos[0];
    expect(p).toMatch(/^me\/uploads\/ask-[0-9a-f]{12}\.jpg$/);
    let r = await api.get(`/api/upload?course=${DEMO}&path=${encodeURIComponent(p)}`);
    expect(r.ok()).toBe(true);
    expect(r.headers()['content-type']).toContain('image/jpeg');
    for (const bad of ['me/progress.md', 'course.json', 'me/uploads/../progress.md', 'decks/SD-1/s001.jpg', 'me/uploads/nope.jpg']) {
      r = await api.get(`/api/upload?course=${DEMO}&path=${encodeURIComponent(bad)}`);
      expect(r.status(), bad).toBe(404);
      expect((await r.json()).error, bad).toBe('No such photo.');
    }
    void hub;
  });
});

test.describe('sending photos', () => {
  test('TUT-013 PHOTO-005 a photo-only question asks "See the photo."; photos leave every box and go with the question', async ({ browser, hub }) => {
    const [d1, d2] = await devices(browser, hub, 2);
    await attach(d1.page, [jpgFile()]);
    await expect(thumbs(d2.page)).toHaveCount(1);
    const file = uploads(hub)[0];
    await d1.page.locator('#ask-send').click(); // locator: markup hook (Ask, active with a photo)
    await settled(d1.page);
    await expect(questions(d1.page).first()).toContainText('See the photo.');
    await expect(questions(d1.page).first().locator('img[alt="Attached photo"]')).toHaveCount(1);
    await expect(thumbs(d1.page)).toHaveCount(0);
    await expect(thumbs(d2.page)).toHaveCount(0);
    await expect(questions(d2.page).first().locator('img[alt="Attached photo"]')).toHaveCount(1);
    const [c] = await hub.calls('^chat:ask$');
    expect(c.prompt).toContain(`me/uploads/${file}`);
    const chat = onlyChat(hub);
    expect(chat.messages[0]).toMatchObject({ text: 'See the photo.', photos: [`me/uploads/${file}`] });
    expect(chat.title).toBe('See the photo. · s2');
    expect(uploads(hub)).toEqual([file]);          // a sent photo's file is kept
    await expect.poll(() => drafts(hub)[DEMO]?.photos).toEqual([]);
    await closeAll([d1, d2]);
  });

  test('TUT-013 several photos: "See the photos."; TUT-017 the bubble thumbnails open the image in a new tab', async ({ page, hub }) => {
    await openPanel(page);
    await attach(page, [jpgFile('a.jpg', 1), jpgFile('b.jpg', 2)]);
    await expect(thumbs(page)).toHaveCount(2);
    await askBox(page).press('Enter');
    await settled(page);
    await expect(questions(page).first()).toContainText('See the photos.');
    const imgs = questions(page).first().locator('a:has(img[alt="Attached photo"])');
    await expect(imgs).toHaveCount(2);
    await expect(imgs.first()).toHaveAttribute('target', '_blank');
    const [c] = await hub.calls('^chat:ask$');
    expect(c.prompt.match(/me\/uploads\/ask-[0-9a-f]{12}\.jpg/g)).toHaveLength(2);
  });

  test('PHOTO-005 photos go with a quick action too', async ({ page, hub }) => {
    await openPanel(page);
    await attach(page, [jpgFile()]);
    await expect(thumbs(page)).toHaveCount(1);
    await action(page, 'Worked example').click();
    await settled(page);
    await expect(questions(page).first().locator('img[alt="Attached photo"]')).toHaveCount(1);
    const [c] = await hub.calls('^chat:example$');
    expect(c.prompt).toMatch(/me\/uploads\/ask-[0-9a-f]{12}\.jpg/);
    expect(onlyChat(hub).messages[0].photos).toHaveLength(1);
  });

  test('ERR-003 photos of a failed question come back in the Ask box on every device', async ({ browser, hub }) => {
    await hub.script([rule('^chat:', { error: 'Claude reported an error. Try again in a moment.' })]);
    const [d1, d2] = await devices(browser, hub, 2);
    await attach(d1.page, [jpgFile()]);
    await expect(thumbs(d2.page)).toHaveCount(1);
    await ask(d1.page, 'With a photo');
    await expect(errors(d1.page)).toBeVisible();
    await expect(thumbs(d1.page)).toHaveCount(1);
    await expect(thumbs(d2.page)).toHaveCount(1);
    await closeAll([d1, d2]);
  });
});

test.describe('from the phone', () => {
  test.use({ phoneUrl: 'http://127.0.0.1:9/' });

  test('PHOTO-001 PHOTO-007 with a phone link, 📷 offers "Choose a file" / "Take it with your phone" and the QR flow', async ({ page, hub, browser }) => {
    await openPanel(page);
    await page.getByRole('button', { name: 'Attach a photo' }).click();
    const menu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Take it with your phone' }) });
    await expect(menu.getByRole('menuitem')).toHaveText(['Choose a file', 'Take it with your phone']);
    await menu.getByRole('menuitem', { name: 'Take it with your phone' }).click();
    const qr = page.getByRole('dialog');
    await expect(qr).toBeVisible();
    await expect(qr).toContainText('Send a photo from your phone');
    await expect(qr).toContainText("Scan this with your phone's camera and take a photo: it goes into the Ask box here, with your next question.");
    await expect(qr.locator('svg')).toBeVisible();
    // the phone
    const phone = await browser.newContext({ baseURL: hub.url, viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
    const pp = await phone.newPage();
    await pp.goto('/#upload=ask-Demo-Course');
    const take = pp.getByRole('button', { name: 'Take a photo of your working' });
    await expect(take).toBeVisible();
    const chooser = pp.waitForEvent('filechooser');
    await take.click();
    await (await chooser).setFiles(jpgFile());
    await expect(pp.getByText('Sent ✓ (1 photo in the Ask box). Check your laptop, or add another.')).toBeVisible();
    await expect(pp.getByRole('button', { name: 'Add another photo' })).toBeVisible();
    await expect(thumbs(page)).toHaveCount(1);
    await expect(qr).toBeHidden();
    await phone.close();
  });
});
