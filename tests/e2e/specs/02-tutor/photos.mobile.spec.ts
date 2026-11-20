/**
 * 02 · Photos on a phone (docs/functional-spec/02-tutor-and-chats.md PHOTO-001): 📷 offers the camera or a picture.
 */
import { test, expect } from '../../fixtures/hub';
import { SD1_S2, askBox, thumbs, uploads, jpgFile } from './helpers';

test('PHOTO-001 on a phone, 📷 offers "Take a photo" (camera) and "Choose a picture"', async ({ page, hub }) => {
  await page.goto('/' + SD1_S2);
  await expect(askBox(page)).toBeVisible();
  await page.getByRole('button', { name: 'Attach a photo' }).click();
  const menu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Take a photo' }) });
  await expect(menu.getByRole('menuitem')).toHaveText(['Take a photo', 'Choose a picture']);
  let chooser = page.waitForEvent('filechooser');
  await menu.getByRole('menuitem', { name: 'Take a photo' }).click();
  const camera = await chooser;
  expect(await camera.element().getAttribute('capture')).toBe('environment');
  expect(camera.isMultiple()).toBe(false);
  await camera.setFiles(jpgFile());
  await expect(thumbs(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Attach a photo' }).click();
  chooser = page.waitForEvent('filechooser');
  await menu.getByRole('menuitem', { name: 'Choose a picture' }).click();
  const pick = await chooser;
  expect(await pick.element().getAttribute('capture')).toBeNull();
  expect(pick.isMultiple()).toBe(true);
  await pick.setFiles([jpgFile('a.jpg', 2), jpgFile('b.jpg', 3)]);
  await expect(thumbs(page)).toHaveCount(3);
  await expect.poll(() => uploads(hub)).toHaveLength(3);
});
