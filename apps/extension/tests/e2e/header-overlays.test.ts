/* eslint-disable import/no-nodejs-modules */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { mockKiloApi } from './kilo-api-fixture';
import {
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';

test('header panels fill the side panel and enabled controls use pointer cursor', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.setViewportSize({ height: 520, width: 320 });
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo extension fixture');

    const settingsButtonCursor = await sidePanel
      .getByLabel('Settings')
      .evaluate(element => getComputedStyle(element).cursor);
    const targetTabCursor = await sidePanel
      .getByLabel('Target tab')
      .evaluate(element => getComputedStyle(element).cursor);

    expect(settingsButtonCursor).toBe('pointer');
    expect(targetTabCursor).toBe('pointer');

    await sidePanel.getByLabel('Settings').click();
    const settingsPanel = sidePanel.getByLabel('Settings panel');
    await expect(settingsPanel).toBeVisible();
    await expect(settingsPanel).toHaveJSProperty('clientWidth', 320);
    await expect(settingsPanel).toHaveJSProperty('clientHeight', 520);

    await sidePanel.getByLabel('Close settings').click();
    await sidePanel.getByLabel('History').click();
    const historyPanel = sidePanel.getByLabel('Conversation history');
    await expect(historyPanel).toBeVisible();
    await expect(historyPanel).toHaveJSProperty('clientWidth', 320);
    await expect(historyPanel).toHaveJSProperty('clientHeight', 520);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
