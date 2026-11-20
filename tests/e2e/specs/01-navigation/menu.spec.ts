/**
 * 01 Navigation · J. The ⋯ menu (NAV-086 … NAV-094).
 *
 * // Not covered: NAV-089 "only when the page is viewed on the computer running the hub" (the browser in these tests
 * //   is always on the hub's own machine, on loopback; a phone on another address can't be simulated)
 * // Not covered: NAV-087 providers beyond Claude Code depend on what is installed (the harness fixes the OpenCode list)
 */
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../fixtures/hub';
import { DEMO, SD1_HASH, addCourse, addDeck, seedWith, atSlide } from './helpers';

const moreBtn = (page) => page.getByRole('button', { name: 'More' });
const menu = (page) => page.getByRole('menu');
const usageItem = (page) => menu(page).getByRole('menuitem', { name: /^Usage/ });
const usageDlg = (page) => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Usage' }) });

async function openMenu(page) {
  // The menu reads the current course when it opens: let the page render first.
  await expect(page.locator('#main > *').first()).toBeAttached();   // locator: markup hook (page rendered)
  await moreBtn(page).click();
  await expect(menu(page)).toBeVisible();
}

async function askTutor(api, mode = 'explain') {
  const r = await api.post('/api/tutor', { data: { course: DEMO, tag: 'S&D-1', n: 1, mode } });
  return r;
}

test.describe('NAV-086 menu behaviour', () => {
  test('NAV-086 items in order; closes on a second click, a click elsewhere, Escape and any navigation', async ({ page }) => {
    await page.goto(`/#c=${DEMO}`);
    await expect(page.getByRole('heading', { level: 1, name: DEMO })).toBeVisible();   // the course is loaded
    await expect(moreBtn(page)).toHaveAttribute('aria-expanded', 'false');
    await openMenu(page);
    await expect(moreBtn(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(menu(page).locator(':scope > *:visible')).toHaveText([      // locator: markup hook (menu rows in order)
      /^History$/, /^Model/, /^\s*Stick to slides\s+Demo-Course$/, /^\s*Show words while dictating$/, /^Usage/,
    ]);
    await moreBtn(page).click();
    await expect(menu(page)).toBeHidden();
    await openMenu(page);
    await page.getByRole('heading', { level: 1 }).click();
    await expect(menu(page)).toBeHidden();
    await openMenu(page);
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await openMenu(page);
    await page.evaluate(() => { location.hash = '#c=Demo-Course&d=S%26D-1&s=2'; });
    await atSlide(page, '2 / 3');
    await expect(menu(page)).toBeHidden();
  });
});

test.describe('NAV-087 model picker', () => {
  test('NAV-087 every model grouped by provider, "<label> · <score>", the default selected; remembered across reloads', async ({ page }) => {
    await page.goto('/');
    await openMenu(page);
    const pick = menu(page).getByRole('combobox', { name: 'Model' });
    const groups = await pick.locator('optgroup').evaluateAll((gs) => gs.map((g) => [
      g.getAttribute('label'), [...g.querySelectorAll('option')].map((o) => o.textContent)]));
    expect(groups).toEqual([
      ['Claude Code', ['Opus 5.5 · 96', 'Sonnet 5.5 · 88', 'Haiku 4.5 · 74']],
      ['OpenCode', ['Fake Big · 60', 'Fake Small · 40']],
    ]);
    await expect(pick.locator('option:checked')).toHaveText('Opus 5.5 · 96');
    await pick.selectOption({ label: 'Fake Big · 60' });
    await page.reload();
    await openMenu(page);
    await expect(menu(page).getByRole('combobox', { name: 'Model' }).locator('option:checked')).toHaveText('Fake Big · 60');
  });

  test('NAV-087 a remembered model that is no longer offered falls back to the default', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('model', JSON.stringify('retired-model-x')));
    await page.goto('/');
    await openMenu(page);
    await expect(menu(page).getByRole('combobox', { name: 'Model' }).locator('option:checked')).toHaveText('Opus 5.5 · 96');
  });

  test('NAV-087 the chosen model is used for the tutor\'s requests from this browser', async ({ page, hub }) => {
    await page.goto(`/${SD1_HASH}&s=1`);
    await openMenu(page);
    await menu(page).getByRole('combobox', { name: 'Model' }).selectOption({ label: 'Fake Small · 40' });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Open the tutor' }).click();
    await page.getByRole('button', { name: 'Explain simply' }).click();
    await expect.poll(async () => (await hub.calls('^chat:')).length).toBe(1);
    expect((await hub.calls('^chat:'))[0].model).toBe('opencode/fake-small');
  });
});

test.describe('NAV-088 stick to slides', () => {
  test.use({
    seed: seedWith((hub) => {
      addCourse(hub, 'Other-Course', { code: 'OTH 1', title: 'Other' });
      addDeck(hub, 'Other-Course', 'O-1', { tag: 'O-1', title: 'Other deck', topic: 'T', week: 1, pages: 2 });
    }),
  });

  test('NAV-088 labelled with the current course; per course, remembered; on home the suggested course', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Start session · Demo-Course' })).toBeVisible();
    await openMenu(page);
    await expect(menu(page).getByRole('checkbox', { name: 'Stick to slides Demo-Course' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.goto(`/#c=${DEMO}`);
    await expect(page.getByRole('heading', { level: 1, name: DEMO })).toBeVisible();
    await openMenu(page);
    const box = menu(page).getByRole('checkbox', { name: /Stick to slides/ });
    await expect(box).toHaveAccessibleName('Stick to slides Demo-Course');
    await expect(box).not.toBeChecked();
    await box.check();
    await page.reload();
    await openMenu(page);
    await expect(box).toBeChecked();
    await page.keyboard.press('Escape');
    await page.goto('/#c=Other-Course');
    await expect(page.getByRole('heading', { level: 1, name: 'OTH 1' })).toBeVisible();
    await openMenu(page);
    await expect(box).toHaveAccessibleName('Stick to slides OTH 1');
    await expect(box).not.toBeChecked();
  });

  test('NAV-088 when on, the tutor\'s requests for that course do not use web search', async ({ page, hub }) => {
    await page.goto(`/${SD1_HASH}&s=1`);
    await page.getByRole('button', { name: 'Open the tutor' }).click();
    await page.getByRole('button', { name: 'Explain simply' }).click();
    await expect.poll(async () => (await hub.calls('^chat:')).length).toBe(1);
    expect((await hub.calls('^chat:'))[0].web).toBe(true);
    await openMenu(page);
    await menu(page).getByRole('checkbox', { name: /Stick to slides/ }).check();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Worked example' }).click();
    await expect.poll(async () => (await hub.calls('^chat:')).length).toBe(2);
    expect((await hub.calls('^chat:'))[1].web).toBe(false);
  });

  test.describe('no course', () => {
    test.use({ seed: seedWith((hub) => fs.rmSync(hub.library, { recursive: true, force: true })) });
    test('NAV-088 with no current course the option is not shown', async ({ page }) => {
      await page.goto('/');
      await openMenu(page);
      await expect(menu(page).getByRole('checkbox', { name: /Stick to slides/ })).toBeHidden();
      await expect(menu(page).getByRole('menuitem', { name: 'History' })).toBeVisible();
    });
  });
});

test.describe('NAV-089 open on your phone', () => {
  test('NAV-089 not shown when the hub was started for this computer only', async ({ page }) => {
    await page.goto('/');
    await openMenu(page);
    await expect(menu(page).getByRole('menuitem', { name: 'Open on your phone' })).toBeHidden();
  });

  test.describe('same Wi-Fi', () => {
    test.use({ phoneUrl: 'http://192.168.0.9:8765/' });
    test('NAV-089 a dialog with a QR code, the link and the same-Wi-Fi instructions; closed with ×', async ({ page }) => {
      await page.goto('/');
      await openMenu(page);
      await menu(page).getByRole('menuitem', { name: 'Open on your phone' }).click();
      const dlg = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Open on your phone' }) });
      await expect(dlg).toBeVisible();
      await expect(dlg.locator('svg')).toBeVisible();                      // locator: markup hook (the QR code)
      await expect(dlg).toContainText('http://192.168.0.9:8765/');
      await expect(dlg).toContainText('Connect your phone to the same Wi-Fi, then scan this with its camera. Keep this computer on while you use it.');
      await dlg.getByRole('button', { name: 'Close' }).click();
      await expect(dlg).toBeHidden();
    });
  });

  test.describe('public link', () => {
    test.use({ phoneUrl: 'https://quiet-river.trycloudflare.com/' });
    test('NAV-089 a public https link says it works anywhere and warns not to share it', async ({ page }) => {
      await page.goto('/');
      await openMenu(page);
      await menu(page).getByRole('menuitem', { name: 'Open on your phone' }).click();
      const dlg = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Open on your phone' }) });
      await expect(dlg).toContainText('https://quiet-river.trycloudflare.com/');
      await expect(dlg).toContainText("Scan this with your phone's camera. It works on any Wi-Fi or mobile data while this computer is on. Anyone with the link can open the hub, so don't share it.");
    });
  });
});

test.describe('NAV-091 usage', () => {
  test('NAV-091 with no calls this run: no summary in the menu, "No answers yet this run."', async ({ page }) => {
    await page.goto('/');
    await openMenu(page);
    await expect(usageItem(page)).toHaveText('Usage');
    await usageItem(page).click();
    await expect(usageDlg(page)).toBeVisible();
    await expect(usageDlg(page)).toContainText(/This run · since \d{4}-\d\d-\d\d \d\d:\d\d0 tokens · \$0\.000 answers0 new · 0 cache read · 0 cache write · 0 out/);
    await expect(usageDlg(page)).toContainText('No answers yet this run.');
    await expect(usageDlg(page)).not.toContainText('All runs');
    await expect(usageDlg(page)).not.toContainText('Earlier runs');
    await usageDlg(page).getByRole('button', { name: 'Close' }).click();
    await expect(usageDlg(page)).toBeHidden();
  });

  test('NAV-091 after an answer: "1.6k · $0.01" in the menu; the call listed with time, kind, course, model, seconds, split', async ({ page, api }) => {
    await askTutor(api);
    await page.goto('/');
    await openMenu(page);
    await expect(usageItem(page)).toHaveText('Usage 1.6k · $0.01');
    await usageItem(page).click();
    const d = usageDlg(page);
    await expect(d).toContainText('1.6k tokens · $0.01');
    await expect(d).toContainText('1 answer1.0k new · 200 cache read · 100 cache write · 300 out');
    await expect(d).toContainText(/\d\d:\d\d:\d\d · [\w:]+ · Demo-Course · Opus 5\.5 · 1 s/);
    await expect(d).not.toContainText('No answers yet this run.');
  });

  test('NAV-091 failed attempts, unknown tokens/cost, 4-decimal costs under a cent and M token counts', async ({ page, hub, api }) => {
    await hub.script([
      { match: { label: '^chat:explain$' }, reply: { error: 'Model fell over' } },
      { match: { label: '^chat:example$' }, reply: { cost: 0.005, ms: 2600, tokens: { in: 2_300_000, cache_read: 0, cache_write: 0, out: 5 } } },
    ]);
    const failed = await askTutor(api, 'explain');
    expect(failed.ok(), `the failing call should reach the model and fail: ${failed.status()} ${await failed.text()}`).toBe(false);
    expect(await hub.calls('^chat:explain$')).toHaveLength(1);
    await askTutor(api, 'example');
    await page.goto('/');
    await openMenu(page);
    await usageItem(page).click();
    const d = usageDlg(page);
    await expect(d).toContainText('1 answer · 1 failed · 1 not fully known');
    await expect(d).toContainText('Failed · Tokens unknown · cost unknown');
    await expect(d).toContainText('Model fell over');
    await expect(d).toContainText('2.3M tokens · $0.0050');
    await expect(d).toContainText(/ · 3 s/);
    // Newest first.
    const rows = await d.locator('b').allTextContents();
    expect(rows.findIndex((t) => t.startsWith('2.3M'))).toBeLessThan(rows.findIndex((t) => t.startsWith('Failed')));
  });

  test.describe('earlier runs on record', () => {
    test.use({
      seed: seedWith((hub) => {
        const rec = (at: string, cost: number) => JSON.stringify({ run: '2026-01-01 10:00:00', at, kind: 'ask', course: DEMO,
          model: 'claude-opus-5-5', ms: 2000, cost, tokens: { in: 1, cache_read: 0, cache_write: 0, out: 1 } });
        fs.mkdirSync(path.join(hub.work, 'cache'), { recursive: true });
        fs.writeFileSync(path.join(hub.work, 'cache', 'usage.jsonl'),
          rec('2026-01-01 10:01:00', 0.5) + '\n' + rec('2026-01-01 10:02:00', 0.25) + '\n');
      }),
    });
    test('NAV-091 All runs totals and Earlier runs rows that expand to their calls', async ({ page, api }) => {
      await askTutor(api);
      await page.goto('/');
      await openMenu(page);
      await usageItem(page).click();
      const d = usageDlg(page);
      await expect(d).toContainText(/All runs · 2 runs1\.6k tokens · \$0\.76/);
      await expect(d).toContainText('Earlier runs');
      const run = d.getByRole('button', { name: /^2026-01-01 10:00 · 4 tokens · \$0\.75\s*2 answers ›$/ });
      await expect(run).toHaveAttribute('aria-expanded', 'false');
      await run.click();
      await expect(run).toHaveAttribute('aria-expanded', 'true');
      await expect(d).toContainText('2 tokens · $0.50');
      await expect(d).toContainText('10:01:00 · ask · Demo-Course · Opus 5.5 · 2 s');
    });
  });

  test('NAV-091 usage history persists across hub restarts; a new run starts with the hub', async ({ page, hub, api }) => {
    await askTutor(api);
    await page.waitForTimeout(1100);   // runs are identified to the second: make sure the restarted hub starts a new one
    await hub.restart();
    await page.goto(hub.url + '/');
    await openMenu(page);
    await expect(usageItem(page)).toHaveText('Usage');
    await usageItem(page).click();
    const d = usageDlg(page);
    await expect(d).toContainText('No answers yet this run.');
    await expect(d).toContainText('Earlier runs');
    await expect(d.getByRole('button', { name: /1\.6k tokens · \$0\.01\s*1 answer ›/ })).toBeVisible();
  });

  test('NAV-091 when usage can\'t be loaded: "Couldn\'t load usage."', async ({ page }) => {
    await page.goto('/');
    await page.route('**/api/usage*', (r) => r.abort());
    await openMenu(page);
    await usageItem(page).click();
    await expect(usageDlg(page)).toContainText("Couldn't load usage.");
  });
});

test.describe('NAV-092 history', () => {
  test('NAV-092 History opens "History · <code>" listing the course\'s tutor chats', async ({ page }) => {
    test.fail(true, 'BROKEN in current app: the ⋯ menu\'s History calls showHistory(), removed in commit ba5fb76 '
      + '(ReferenceError); the menu closes and nothing opens. See docs/functional-spec/01-navigation-and-library.md NAV-092');
    await page.goto(`/#c=${DEMO}`);
    await openMenu(page);
    await menu(page).getByRole('menuitem', { name: 'History' }).click();
    const dlg = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'History · Demo-Course' }) });
    await expect(dlg).toBeVisible({ timeout: 3000 });
    await expect(dlg).toContainText('No tutor chats in Demo-Course yet.');
  });

  test('NAV-092 on home, History lists every course\'s chats ("No tutor chats yet.")', async ({ page }) => {
    test.fail(true, 'BROKEN in current app: History does nothing (showHistory removed in ba5fb76), see NAV-092');
    await page.goto('/');
    await openMenu(page);
    await menu(page).getByRole('menuitem', { name: 'History' }).click();
    const dlg = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'History', exact: true }) });
    await expect(dlg).toBeVisible({ timeout: 3000 });
    await expect(dlg).toContainText('No tutor chats yet.');
  });
});

test.describe('NAV-094 show words while dictating', () => {
  test('NAV-094 a per-browser checkbox, remembered across reloads', async ({ page }) => {
    await page.goto('/');
    await openMenu(page);
    const box = menu(page).getByRole('checkbox', { name: 'Show words while dictating' });
    await expect(box).not.toBeChecked();
    await box.check();
    await page.reload();
    await openMenu(page);
    await expect(box).toBeChecked();
    await box.uncheck();
    await page.reload();
    await openMenu(page);
    await expect(box).not.toBeChecked();
  });
});
