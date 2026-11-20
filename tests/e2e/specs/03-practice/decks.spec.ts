/**
 * 03 · Practice decks vs lecture decks, and the solved state.  Spec: docs/functional-spec/03-practice-reviews-drills.md
 * (DECK-*). Practising a practice deck: practice.spec.ts / topic.spec.ts (DECK-001); weak points: drill.spec.ts (DECK-003).
 */
import { test, expect } from '../../fixtures/hub';
import type { Hub } from '../../fixtures/hub';
import { DEMO, addDeck, apiCheck, apiNew, practiceRules, seedWith } from './helpers';

test.describe('practice decks', () => {
  test.use({ seed: seedWith((hub: Hub) => {
    // [quirk] a lecture deck whose topic is literally "Practice"
    addDeck(hub, 'QZ', { tag: 'QZ-1', title: 'Quirky quiz', week: 2, topic: 'Practice', role: 'lecture' });
  }) });

  test('DECK-001 practice decks are listed under Practice, never in a topic or the drill range, and offered as papers', async ({ page, api }) => {
    await page.goto('/#c=Demo-Course');
    const practice = page.locator('.practice-list');   // locator: markup hook (the Practice list on the course page)
    await expect(practice.getByRole('heading', { name: 'Practice' })).toBeVisible();
    await expect(practice.getByRole('link', { name: /HW-1 · Homework 1/ })).toBeVisible();
    await expect(page.locator('.topic').getByRole('link', { name: /HW-1/ })).toHaveCount(0);   // locator: markup hook
    // pinned as-is: a lecture deck with topic "Practice" is treated as a practice deck
    await expect(practice.getByRole('link', { name: /QZ-1 · Quirky quiz/ })).toBeVisible();
    const setup = await (await api.get(`/api/drill/setup?course=${DEMO}`)).json();
    const range = setup.topics.flatMap((t: any) => t.decks.map((d: any) => d.tag));
    expect(range).toEqual(['S&D-1']);
    expect(setup.papers.map((p: any) => p.tag).sort()).toEqual(['HW-1', 'QZ-1']);
  });

  test('DECK-001 the model is told practice decks hold questions only, no solutions', async ({ api, hub }) => {
    await hub.script(practiceRules());
    await apiNew(api, { tag: 'HW-1', n: 1 });
    const [c] = await hub.calls('^practice:');
    expect(c.system).toMatch(/Practice: homework and practice exams \(questions only, no solutions\)\n- \[HW-1\]/);
  });
});

test('DECK-002 a deck counts as solved on home and the course page only after a clean solve', async ({ page, api, hub }) => {
  await page.goto('/');
  await expect(page.getByLabel('0 of 1 decks solved')).toBeVisible();
  await hub.script(practiceRules());
  const p = await (await apiNew(api, {})).json();
  await api.post('/api/practice/hint', { data: { id: p.id } });
  await apiCheck(api, p.id);                 // hinted: not solved
  await page.reload();
  await expect(page.getByLabel('0 of 1 decks solved')).toBeVisible();
  const q = await (await apiNew(api, { n: 1 })).json();
  await apiCheck(api, q.id);                 // clean
  await page.reload();
  await expect(page.getByLabel('1 of 1 decks solved')).toBeVisible();
  await page.goto('/#c=Demo-Course');
  await expect(page.getByTitle('1 of 1 decks solved')).toBeVisible();
});
