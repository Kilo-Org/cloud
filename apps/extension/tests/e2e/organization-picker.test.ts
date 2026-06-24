/* eslint-disable import/no-nodejs-modules */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import {
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';

test('settings organization picker sends org context to the gateway', async () => {
  const fixture = await startFixtureServer();
  const seenChatOrganizationIds: string[] = [];
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      organizations: [{ id: 'org-1', name: 'Acme' }],
      seenChatOrganizationIds,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByLabel('Settings').click();
    await sidePanel.getByLabel('Credit account').selectOption('org-1');
    await sidePanel.getByLabel('Close settings').click();

    await sidePanel.getByRole('button', { name: /Safe mode/u }).click();
    await sidePanel.getByRole('button', { name: 'Dangerous' }).click();
    await sidePanel.getByLabel('Message agent').fill('Inspect this tab');
    await sidePanel.getByLabel('Message agent').press('Enter');

    await expect(sidePanel.getByText(/The selected tab HTML length is [0-9]+\./u)).toBeVisible();
    expect(seenChatOrganizationIds).toContain('org-1');
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
