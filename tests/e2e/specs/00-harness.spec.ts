import { test, expect } from '../fixtures/hub';

// The harness itself: a hub starts on a copy of the example library, and the model double answers from its script.
test('the hub starts on a copy of the example library and the model double answers', async ({ page, hub, api }) => {
  const home = await (await api.get('/api/home')).json();
  expect(home.courses.map((c: any) => c.id)).toContain('Demo-Course');
  await hub.script([{ match: { label: '^chat:' }, reply: { text: 'Scripted answer HARNESS-OK' } }]);
  await page.goto('/#c=Demo-Course&d=S%26D-1&s=1');
  await expect(page.locator('main')).toContainText('1 / 3');
  const res = await api.post('/api/tutor', { data: { course: 'Demo-Course', tag: 'S&D-1', n: 1, mode: 'explain' } });
  expect((await res.json()).message.text).toContain('HARNESS-OK');
  expect(await hub.calls('^chat:explain$')).toHaveLength(1);
});
