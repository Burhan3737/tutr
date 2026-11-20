/**
 * 04 Voice — what is said: the speakable version of an answer's Markdown.
 * Spec: docs/functional-spec/04-voice.md §5 (VOICE-033..040).
 *
 * Each test scripts an answer, presses ▶ Play on it (the whole text is read at once) and checks the sentences the
 * hub was asked to say (hub.spoken()).
 */
import { test, expect } from '../../fixtures/hub';
import * as V from './helpers';

/** Answer `text`, read it with ▶ Play, return the pieces said. */
async function say(page: any, hub: any, text: string, slow = 0) {
  await hub.script([V.answerRule(text)]);
  if (slow) await V.slowVoice(page, slow);
  await V.openDeck(page);
  await V.openTutor(page);
  await V.ask(page, 'q');
  await expect(V.lastPlay(page)).toHaveText('▶ Play');
  await V.lastPlay(page).click();
  if (slow) return [] as string[];
  await expect.poll(async () => (await hub.spoken()).length).toBeGreaterThan(0);
  await expect(V.lastPlay(page)).toHaveText('▶ Play', { timeout: 15_000 });
  await expect(V.voiceRow(page)).toBeHidden();
  await page.waitForTimeout(300);
  return (await hub.spoken()).map((r) => r.text);
}

test.describe('spoken lines and visuals', () => {
  test('VOICE-033 a spoken line is said instead of the table under it, and is never shown or copied', async ({ page, hub }) => {
    const said = await say(page, hub, 'Look at this.\n\n[say: Two rows compared.]\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter the table.');
    const all = said.join(' ');
    expect(said).toContain('Two rows compared.');
    expect(all).toContain('After the table.');
    expect(all).not.toContain('|');
    expect(all).not.toContain('Have a look at the table.');
    await expect(V.answers(page).last()).not.toContainText('Two rows compared');
    await expect(V.answers(page).last()).not.toContainText('[say:');
    await V.answers(page).last().getByRole('button', { name: 'Copy' }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('After the table.');
    expect(copied).not.toContain('Two rows compared');
  });

  test('VOICE-033 the block under a spoken line is highlighted whole while the line is said', async ({ page, hub }) => {
    await say(page, hub, '[say: Two rows compared.]\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter the table, a sentence long enough to keep the voice busy for a while.', 2000);
    // locator: markup hook (the highlight)
    await expect(page.locator('#thread .ans').last().locator(':is(table.spoken, .spoken table)')).toHaveCount(1);
  });

  test('VOICE-034 visuals without a spoken line are summarised, drawings say nothing, long inline maths is "the formula on screen"', async ({ page, hub }) => {
    const text = [
      'Intro sentence.',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'Middle one.',
      '',
      '$$x^2+1$$',
      '',
      'Then code.',
      '',
      '```python',
      'print("SECRETCODE")',
      '```',
      '',
      'Now working.',
      '',
      '3 + 4 = 7',
      '7 * 2 = 14',
      '',
      'A drawing next.',
      '',
      '```svg',
      '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><text x="10" y="50">SECRETDRAW</text></svg>',
      '```',
      '',
      'The long one is $\\frac{a+b+c}{d+e+f}$ here.',
    ].join('\n');
    const all = (await say(page, hub, text)).join(' ');
    expect(all).toContain('Have a look at the table.');
    expect(all).toContain("The formula's on screen.");
    expect(all).toContain("The code's on screen.");
    expect(all).toContain("The working's on screen.");
    expect(all).toContain('The long one is the formula on screen here.');
    for (const never of ['SECRETCODE', 'SECRETDRAW', '7 * 2', '14', 'x^2', '| a']) expect(all).not.toContain(never);
    expect(all.indexOf('Intro sentence.')).toBeLessThan(all.indexOf('Have a look at the table.'));
    expect(all.indexOf('Have a look at the table.')).toBeLessThan(all.indexOf('Middle one.'));
  });
});

test.describe('maths, hidden things and marks', () => {
  test('VOICE-035 short maths is said in words and formatting commands are dropped', async ({ page, hub }) => {
    const text = 'Half is $\\frac{a}{b}$ and area is $x^2$ and cube is $a^3$ and $x \\le 5$ and $y \\ge 2$ and $p \\neq q$ '
      + 'and $z \\approx 3$ and $\\infty$ and $\\sqrt{4}$ and $\\pm 1$ and $2 \\times 3$ and $\\text{cost}$ end.';
    const all = (await say(page, hub, text)).join(' ');
    for (const w of ['a over b', 'x squared', 'a to the 3', 'x at most 5', 'y at least 2', 'p not equal to q', 'z about 3',
      'infinity', 'root of 4', 'plus or minus 1', '2 times 3', 'and cost end'])
      expect(all).toContain(w);
    for (const never of ['\\', '$', '^', '{', 'text']) expect(all).not.toContain(never);
  });

  test('VOICE-036 hidden answers, hub notes, cues, citations, link addresses, Markdown symbols and HTML are never spoken', async ({ page, hub }) => {
    const text = [
      '# Heading words',
      '',
      'See **bold words** and `tick words` and <b>tagged words</b> here [S&D-1 s2].',
      '',
      '- item words',
      '',
      'A [link words](http://example.com/SECRETURL) to follow.',
      '',
      'Spoiler ||SECRETSPOILER|| skipped.',
      '',
      '<details><summary>Show</summary>SECRETDETAILS</details>',
      '',
      '<!-- SECRETNOTE -->',
      '',
      'A cue here [#A] is silent.',
    ].join('\n');
    const all = (await say(page, hub, text)).join(' ');
    for (const w of ['Heading words', 'bold words', 'tick words', 'tagged words', 'item words', 'link words', 'A cue here is silent.'])
      expect(all).toContain(w);
    for (const never of ['SECRETURL', 'http', 'SECRETSPOILER', 'SECRETDETAILS', 'SECRETNOTE', 'S&D-1 s2', '[#A]', '#', '**', '`', '<', '>', '||'])
      expect(all).not.toContain(never);
  });

  test('VOICE-037 marked terms are read as plain words', async ({ page, hub }) => {
    const all = (await say(page, hub, 'Here [[price elasticity]] matters a lot.')).join(' ');
    expect(all).toContain('Here price elasticity matters a lot.');
    expect(all).not.toContain('[[');
  });
});

test.describe('how the text is cut into pieces', () => {
  test('VOICE-038 abbreviations do not end a sentence', async ({ page, hub }) => {
    const said = await say(page, hub, 'Goods, e.g. bread vs. butter etc. are normal. Next sentence follows.');
    expect(said[0]).toBe('Goods, e.g. bread vs. butter etc. are normal.');
    const said2 = (await hub.spoken()).map((r) => r.text);
    expect(said2.every((t) => !/(e\.g\.|vs\.|etc\.)$/.test(t))).toBe(true);
  });

  test('VOICE-039 very long pieces are split under ~1,000 characters, nothing lost', async ({ page, hub }) => {
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`);
    const text = `Start here. ${words.join(' ')} and the end`;
    const said = await say(page, hub, text);
    expect(text.length).toBeGreaterThan(2500);
    expect(said.length).toBeGreaterThan(3);
    for (const t of said) expect(t.length).toBeLessThanOrEqual(1000);
    const all = said.join(' ');
    for (const w of ['word0 ', 'word199 ', 'word399 ', 'and the end']) expect(all).toContain(w);
  });

  test('VOICE-040 a sentence that refers to a drawing part starts a piece of its own', async ({ page, hub }) => {
    const text = [
      'Here is a drawing.',
      '',
      '```svg',
      '<svg viewBox="0 0 320 420" xmlns="http://www.w3.org/2000/svg"><g id="A"><rect x="10" y="10" width="50" height="50"/></g><g id="B"><circle cx="100" cy="100" r="20"/></g></svg>',
      '```',
      '',
      'The box is here [#A]. The circle is there [#B]. Both matter.',
    ].join('\n');
    const said = await say(page, hub, text);
    // each cued sentence starts a piece of its own, so its part lights up as it starts to be said
    expect(said.some((t) => t.startsWith('The box is here.'))).toBe(true);
    expect(said.some((t) => t.startsWith('The circle is there.'))).toBe(true);
    expect(said.some((t) => t.includes('The box is here.') && t.includes('The circle is there.'))).toBe(false);
  });
});
