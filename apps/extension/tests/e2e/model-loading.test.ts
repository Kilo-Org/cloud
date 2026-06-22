/* eslint-disable import/no-nodejs-modules */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { launchExtensionContext, seedExtensionAuth } from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';

test('model and thinking controls wait for the model catalog', async () => {
  const { promise: pendingModels, resolve: releaseModels } = Promise.withResolvers<void>();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      beforeModels: () => pendingModels,
    });

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await expect(sidePanel.getByLabel('Model')).toBeDisabled();
    await expect(sidePanel.getByLabel('Model')).toContainText('Loading models...');
    await expect(sidePanel.getByLabel('Thinking effort')).toBeDisabled();
    await sidePanel.getByLabel('Message agent').fill('Inspect this tab');
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeDisabled();

    releaseModels();

    await expect(sidePanel.getByLabel('Model')).toBeEnabled();
    await expect(sidePanel.getByLabel('Model')).toContainText('Claude Sonnet 4');
    await expect(sidePanel.getByLabel('Thinking effort')).toBeEnabled();
  } finally {
    releaseModels();
    await context.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
