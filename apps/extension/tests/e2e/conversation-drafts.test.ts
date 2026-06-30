/* eslint-disable import/no-nodejs-modules */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { mockKiloApi } from './kilo-api-fixture';
import {
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';

test('per-conversation drafts are preserved when switching tabs', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    const input = sidePanel.getByLabel('Message agent');

    // Wait for the panel to be ready (model loaded)
    await expect(sidePanel.getByLabel('Model')).not.toContainText('Loading');

    // Type a draft in conversation 1
    await input.fill('draft A');
    await expect(input).toHaveValue('draft A');

    // Open a new conversation — input should be empty
    await sidePanel.getByLabel('New conversation').click();
    await expect(input).toHaveValue('');

    // Type a draft in conversation 2
    await input.fill('draft B');
    await expect(input).toHaveValue('draft B');

    // Switch back to conversation 1 — draft A restored
    await sidePanel.getByRole('tab', { name: /Conversation 1/u }).click();
    await expect(input).toHaveValue('draft A');

    // Switch to conversation 2 — draft B restored
    await sidePanel.getByRole('tab', { name: /Conversation 2/u }).click();
    await expect(input).toHaveValue('draft B');
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
