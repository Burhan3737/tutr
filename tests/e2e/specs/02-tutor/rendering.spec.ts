/**
 * 02 · Rendering answers (docs/functional-spec/02-tutor-and-chats.md §3: REN-*, DRW-*). The model double returns the
 * Markdown; the tests check what the page makes of it.
 *
 * Not covered: DRW-005 "strokes drawn on with a short pen animation" (visual only; the element-by-element arrival is
 * checked), DRW-004 the "Fits, but small" / "doesn't fit" notes beyond one oversized sheet (exact size thresholds).
 */
import { test, expect } from '../../fixtures/hub';
import { answers, openPanel, ask, settled, rule, stubPrint, sideSheets } from './helpers';

/** Ask once and wait for the (scripted) answer to be finished. */
async function answerWith(page: import('@playwright/test').Page, hub: import('../../fixtures/hub').Hub, text: string) {
  await hub.script([rule('^chat:ask$', { text })]);
  await openPanel(page);
  await ask(page, 'Show me');
  await settled(page);
  return answers(page).first();
}

test.describe('Markdown, maths, terms, hidden answers, citations, links', () => {
  test('REN-001 answers render as GitHub-flavoured Markdown', async ({ page, hub }) => {
    const a = await answerWith(page, hub, '## A heading\n\n- item one\n- item two\n\n1. first\n2. second\n\n**bold** and *italic*\n\n' +
      '| Col A | Col B |\n|---|---|\n| a1 | b1 |\n\n```\ncode block here\n```\n\n[a link](https://example.org/page)');
    await expect(a.getByRole('heading', { name: 'A heading' })).toBeVisible();
    await expect(a.getByRole('listitem')).toHaveCount(4);
    await expect(a.locator('strong')).toHaveText('bold');
    await expect(a.locator('em')).toHaveText('italic');
    await expect(a.getByRole('table')).toBeVisible();
    await expect(a.getByRole('cell', { name: 'b1' })).toBeVisible();
    await expect(a.locator('pre code')).toContainText('code block here');
    await expect(a.getByRole('link', { name: 'a link' })).toHaveAttribute('href', 'https://example.org/page');
  });

  test('REN-002 $…$ and $$…$$ render as maths; a broken formula shows its source; maths in code is left alone', async ({ page, hub }) => {
    const a = await answerWith(page, hub, 'Inline $Q_d = Q_s$ here.\n\n$$P^* = \\frac{a}{b}$$\n\nBroken $\\frac{1}{$ stays.\n\n`$x^2$ in code`');
    await expect(a.locator('.katex-display')).toHaveCount(1);
    expect(await a.locator('.katex').count()).toBeGreaterThanOrEqual(2);
    await expect(a.locator('code').filter({ hasText: '$x^2$ in code' })).toBeVisible();
    await expect(a).toContainText('stays');
    await expect(a).toContainText('Broken');
  });

  test('REN-003 [[term]] renders as a tappable term without brackets (maths inside rendered)', async ({ page, hub }) => {
    const a = await answerWith(page, hub, 'The [[equilibrium]] and the [[slope $b$]].');
    const term = a.getByRole('button', { name: 'equilibrium' });
    await expect(term).toHaveAttribute('title', 'Explain this on the side');
    await expect(a).not.toContainText('[[');
    await expect(a.getByRole('button', { name: /slope/ }).locator('.katex')).toHaveCount(1);
    await term.click();
    await expect(sideSheets(page)).toHaveCount(1);
  });

  test('REN-004 ||hidden|| answers reveal on click, Enter or Space; <details> answers are collapsed', async ({ page, hub }) => {
    const a = await answerWith(page, hub, 'One ||first secret||, two ||second secret||, three ||third secret||.\n\n' +
      '<details><summary>Answer</summary>\n\nDETAILS-SECRET\n\n</details>');
    const sp = a.locator('.spoiler'); // locator: markup hook
    await expect(sp).toHaveCount(3);
    await expect(sp.first()).toHaveAttribute('role', 'button');
    await expect(sp.first()).toHaveAttribute('title', 'Click to show the answer');
    await expect(sp.first()).not.toHaveClass(/shown/);
    await sp.nth(0).click();
    await expect(sp.nth(0)).toHaveClass(/shown/);
    await sp.nth(1).focus();
    await page.keyboard.press('Enter');
    await expect(sp.nth(1)).toHaveClass(/shown/);
    await sp.nth(2).focus();
    await page.keyboard.press('Space');
    await expect(sp.nth(2)).toHaveClass(/shown/);
    await expect(a.locator('details')).not.toHaveAttribute('open', /.*/);
    await expect(a.locator('details summary')).toHaveText('Answer');
    await expect(a.getByText('DETAILS-SECRET')).toBeHidden();
  });

  test('REN-005 slide citations become chips that open the slide; not in code, nor other courses\' tags', async ({ page, hub }) => {
    const a = await answerWith(page, hub, 'See [S&D-1 s3] and [HW-1 s1–s2]. Not [ECON-9 s2]. `[S&D-1 s1]` in code.');
    const chip = a.getByRole('button', { name: 'S&D-1 s3' });
    await expect(chip).toHaveAttribute('title', 'Open S&D-1 slide 3');
    await expect(a.getByRole('button', { name: /HW-1 s1/ })).toHaveAttribute('title', /Open HW-1 slide 1/);
    await expect(a.getByRole('button', { name: /ECON-9/ })).toHaveCount(0);
    await expect(a).toContainText('[ECON-9 s2]');
    await expect(a.locator('code')).toHaveText('[S&D-1 s1]');
    await chip.click();
    await expect(page).toHaveURL(/#c=Demo-Course&d=S%26D-1&s=3/);
    await expect(page.locator('#counter')).toHaveText('3 / 3'); // locator: markup hook
  });

  test('REN-006 web links open in a new tab; a bare URL shows its host without www.', async ({ page, hub }) => {
    const a = await answerWith(page, hub, 'Read [https://www.example.org/x](https://www.example.org/x) and [the docs](https://docs.example.com/y).');
    const bare = a.getByRole('link', { name: 'example.org', exact: true });
    await expect(bare).toHaveAttribute('href', 'https://www.example.org/x');
    await expect(bare).toHaveAttribute('target', '_blank');
    await expect(a.getByRole('link', { name: 'the docs' })).toHaveAttribute('target', '_blank');
  });

  test('REN-007 drawing cues and spoken-only lines are never shown, copied or printed; left as written in code', async ({ page, hub }) => {
    await stubPrint(page);
    const a = await answerWith(page, hub, 'The demand curve [#D] slopes down.\n[say: This line is only spoken.]\n\nNext.\n\n```\nkeep [#D] and\n[say: this]\n```');
    await expect(a.locator('p').first()).toHaveText('The demand curve slopes down.');
    await expect(a).not.toContainText('only spoken');
    await expect(a.locator('pre code')).toContainText('keep [#D] and');
    await expect(a.locator('pre code')).toContainText('[say: this]');
    await a.getByRole('button', { name: 'Copy', exact: true }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('The demand curve slopes down.');
    expect(copied).not.toContain('only spoken');
    await page.getByRole('button', { name: 'Print', exact: true }).click();
    const printed = page.locator('#print-root'); // locator: markup hook
    await expect(printed).toContainText('The demand curve slopes down.');
    await expect(printed).not.toContainText('only spoken');
  });
});

test.describe('drawings', () => {
  test('DRW-001 a mermaid block renders as a diagram; a broken one shows a note and its source', async ({ page, hub }) => {
    const a = await answerWith(page, hub, '```mermaid\nflowchart LR\n  D[Demand] --> P[Price]\n```\n\nThen:\n\n```mermaid\nflowchart LR\n  A-->\n```');
    const boxes = a.locator('.mermaid-box'); // locator: markup hook
    await expect(boxes.first().locator('svg')).toBeVisible({ timeout: 30_000 }); // (Mermaid loads lazily: slow on a busy machine)
    await expect(boxes.first()).toContainText('Demand');
    await expect(a).toContainText("Couldn't draw this diagram; here is its source.", { timeout: 30_000 });
    await expect(a.locator('pre').filter({ hasText: 'A-->' })).toBeVisible();
  });

  test('DRW-001 "Drawing the diagram…" shows until the diagram is drawn', async ({ page, hub }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    await page.route('**/vendor/mermaid.min.js', async (route) => { await gate; await route.continue(); });
    await hub.script([rule('^chat:ask$', { text: '```mermaid\nflowchart LR\n  D[Demand] --> P[Price]\n```\n\nDone.' })]);
    await openPanel(page);
    await ask(page, 'Diagram');
    await settled(page);
    await expect(answers(page).first()).toContainText('Drawing the diagram…');
    release();
    await expect(answers(page).first().locator('.mermaid-box svg')).toBeVisible({ timeout: 30_000 }); // locator: markup hook
    await expect(answers(page).first()).not.toContainText('Drawing the diagram…');
  });

  test('DRW-002 an svg block renders (no scripts, & and <br> tolerated, #arrow supplied); a broken one is reported', async ({ page, hub }) => {
    const svg = '<svg viewBox="0 0 100 60"><script>window.__pwned = 1</script><text id="lab" x="5" y="20">P & Q<br>R</text>' +
      '<line id="ln" x1="0" y1="50" x2="90" y2="50" stroke="black" marker-end="url(#arrow)"/><rect id="bx" x="10" y="25" width="10" height="10" onclick="window.__pwned=2"/></svg>';
    const a = await answerWith(page, hub, '```svg\n' + svg + '\n```\n\nAnd a broken one:\n\n```svg\n<svg><foo\n```');
    const drawn = a.locator('svg.cue-svg'); // locator: markup hook
    await expect(drawn).toBeVisible();
    await expect(drawn).toContainText('P & Q');
    await expect(drawn.locator('script')).toHaveCount(0);
    await expect(drawn.locator('marker')).toHaveCount(1);
    await a.locator('svg.cue-svg [id$="bx"]').dispatchEvent('click'); // locator: markup hook
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
    await expect(a).toContainText("This drawing couldn't be shown.");
  });

  test('DRW-003 a plot block is computed and drawn; log scale; a block without f: shows its source', async ({ page, hub }) => {
    const a = await answerWith(page, hub, '```plot\nf: 100 - 2*x, 3*x\nx: 0..50\ntitle: Demand and supply\n```\n\n' +
      '```plot\nf: 2^n, n^2\nx: 1..10\ny: log\n```\n\n```plot\nx: 0..5\n```');
    const plot = a.getByRole('img', { name: 'Demand and supply' });
    await expect(plot).toBeVisible();
    await expect(plot.locator('path, polyline').first()).toBeAttached();
    await expect(plot).toContainText('Demand and supply');
    await expect(a.locator('svg.plot')).toHaveCount(2); // locator: markup hook
    await expect(a.locator('svg.plot').nth(1)).toContainText('(log scale on y)');
    await expect(a.locator('.vis-note').filter({ hasText: /^Couldn't draw this \(.+\); here is its source\.$/ })).toHaveCount(1); // locator: markup hook
    await expect(a.locator('pre').filter({ hasText: 'x: 0..5' })).toBeVisible();
  });

  test('DRW-004 a sheet block renders as an A4 page with a note and its own Print / Save as PDF', async ({ page, hub }) => {
    await stubPrint(page);
    const a = await answerWith(page, hub, '```sheet\ncols: 2\ntitle: Formulas\n#### Elasticity\n- $E = \\frac{\\%\\Delta Q}{\\%\\Delta P}$\n- SHEET-LINE\n```');
    const sheet = a.locator('.sheet-box'); // locator: markup hook
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('SHEET-LINE');
    await expect(a).toContainText('One A4 side · 2 columns');
    await a.getByRole('button', { name: 'Print / Save as PDF' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__printed)).toBe(1);
  });

  test('DRW-004 a sheet too long for one side says so', async ({ page, hub }) => {
    const lines = Array.from({ length: 400 }, (_, i) => `- Line ${i} with a fair amount of text to fill the page up quickly`).join('\n');
    const a = await answerWith(page, hub, '```sheet\ncols: 1\n' + lines + '\n```');
    await expect(a).toContainText(/This doesn't fit on one side even at the smallest size|Fits, but small/);
  });

  test('DRW-005 an svg drawing appears element by element while the answer streams', async ({ page, hub }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await hub.script([rule('^chat:ask$', {
      chunks: ['Here:\n\n```svg\n<svg viewBox="0 0 100 100">\n', '<rect id="boxA" x="5" y="5" width="20" height="20"/>\n',
        '<circle id="ballB" cx="60" cy="60" r="10"/>\n', '</svg>\n```\n\nDone DRAWN-END', ' '],
      chunk_delay_ms: 1500,
      text: 'Here:\n\n```svg\n<svg viewBox="0 0 100 100">\n<rect id="boxA" x="5" y="5" width="20" height="20"/>\n<circle id="ballB" cx="60" cy="60" r="10"/>\n</svg>\n```\n\nDone DRAWN-END ' })]);
    await openPanel(page);
    await ask(page, 'Draw');
    const live = page.locator('#thread .ans.live'); // locator: markup hook
    await expect(live.locator('[id$="boxA"]')).toBeAttached({ timeout: 10_000 });
    await expect(live.locator('[id$="ballB"]')).toHaveCount(0);
    await expect(live).not.toContainText('<rect');
    await expect(live.locator('[id$="ballB"]')).toBeAttached({ timeout: 10_000 });
    await settled(page);
    const done = answers(page).first();
    await expect(done.locator('[id$="boxA"]')).toBeAttached();
    await expect(done.locator('[id$="ballB"]')).toBeAttached();
  });

  test('DRW-005 a drawing block left open at the end shows what was drawn, never broken markup', async ({ page, hub }) => {
    const a = await answerWith(page, hub, 'Start.\n\n```svg\n<svg viewBox="0 0 100 100">\n<rect id="boxA" x="5" y="5" width="20" height="20"/>\n');
    await expect(a).toContainText('Start.');
    // whatever was drawn stays, or else its source is shown as text (never a broken picture)
    if (await a.locator('svg [id$="boxA"]').count()) await expect(a).not.toContainText('<rect');
    else await expect(a.locator('pre').first()).toContainText('<rect id="boxA"');
    await expect(a.locator('img')).toHaveCount(0);
  });

  test('DRW-006 the parts named by the latest sentence are lit while it is written; all shown and none lit at the end', async ({ page, hub }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const svg = '```svg\n<svg viewBox="0 0 100 100">\n<rect id="boxA" x="5" y="5" width="20" height="20"/>\n<circle id="ballB" cx="60" cy="60" r="10"/>\n</svg>\n```\n\n';
    await hub.script([rule('^chat:ask$', {
      chunks: [svg, 'The box [#boxA] comes first. ', 'The ball [#ballB] comes next. ', 'That is all.\n\nCUE-END', ' '],
      chunk_delay_ms: 1800,
      text: svg + 'The box [#boxA] comes first. The ball [#ballB] comes next. That is all.\n\nCUE-END ' })]);
    await openPanel(page);
    await ask(page, 'Explain the drawing');
    const live = page.locator('#thread .ans.live'); // locator: markup hook
    const box = live.locator('[id$="boxA"]'), ball = live.locator('[id$="ballB"]');
    // (Text view: the drawing arrived before any cue named its parts, so they show at once; parts waiting hidden for
    // their sentence happen when the cues are known first, i.e. paced by the voice: see the voice specs.)
    await expect(live).toContainText('The box', { timeout: 10_000 });
    await expect(box).toHaveClass(/cue-on/);
    await expect(ball).not.toHaveClass(/cue-on/);
    await expect(live).toHaveClass(/cueing/);
    await expect(live).toContainText('The ball', { timeout: 10_000 });
    await expect(ball).not.toHaveClass(/cue-hide/);
    await expect(ball).toHaveClass(/cue-on/);
    await expect(box).not.toHaveClass(/cue-on/);
    await settled(page);
    const done = answers(page).first();
    await expect(done.locator('.cue-hide')).toHaveCount(0);
    await expect(done.locator('.cue-on')).toHaveCount(0);
  });

  test('DRW-007 tapping a paragraph lights the parts it names; tapping elsewhere clears; one answer at a time', async ({ page, hub }) => {
    const svg = '```svg\n<svg viewBox="0 0 100 100">\n<rect id="boxA" x="5" y="5" width="20" height="20"/>\n<circle id="ballB" cx="60" cy="60" r="10"/>\n</svg>\n```\n\n';
    await hub.script([
      { match: { label: '^chat:ask$' }, times: 1, reply: { text: svg + 'The box [#boxA] is here.\n\nThe ball [#ballB] is there.\n\nPlain paragraph.' } },
      { match: { label: '^chat:ask$' }, times: 1, reply: { text: svg + 'Second box [#boxA] again.\n\nOther plain words.' } },
    ]);
    await openPanel(page);
    await ask(page, 'one');
    await settled(page, 1);
    await ask(page, 'two');
    await settled(page, 2);
    const a1 = answers(page).nth(0), a2 = answers(page).nth(1);
    await a1.getByText('The ball').click();
    await expect(a1.locator('[id$="ballB"]')).toHaveClass(/cue-on/);
    await expect(a1.locator('[id$="boxA"]')).not.toHaveClass(/cue-on/);
    await a1.getByText('Plain paragraph.').click();
    await expect(a1.locator('.cue-on')).toHaveCount(0);
    await a1.getByText('The box').click();
    await expect(a1.locator('[id$="boxA"]')).toHaveClass(/cue-on/);
    await a2.getByText('Second box').click();
    await expect(a2.locator('[id$="boxA"]')).toHaveClass(/cue-on/);
    await expect(a1.locator('.cue-on')).toHaveCount(0);
  });

  test('DRW-008 a drawing that fails is reported to the hub log', async ({ page, hub }) => {
    const logged = page.waitForRequest((r) => r.url().includes('/api/client-log') && r.method() === 'POST');
    await answerWith(page, hub, '```mermaid\nflowchart LR\n  A-->\n```');
    const req = await logged;
    const body = req.postDataJSON();
    expect(body.kind).toBe('mermaid');
    expect(body.src).toContain('A-->');
    expect((await req.response())!.ok()).toBe(true);
  });
});
