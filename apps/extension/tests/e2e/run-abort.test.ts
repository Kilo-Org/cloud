/* eslint-disable import/no-nodejs-modules */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import {
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';
import {
  installChatCompletionAbortObserver,
  mockKiloApi,
  wasChatCompletionAborted,
} from './kilo-api-fixture';

test('new conversation keeps the running request in its original tab', async () => {
  const fixture = await startFixtureServer();
  const { promise: pendingCompletion, resolve: releaseCompletion } = Promise.withResolvers<void>();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      beforeFirstCompletion: () => pendingCompletion,
      firstCompletionEvents: [{ choices: [{ delta: { content: 'Original tab completed.' } }] }],
      toolNames: ['get_page_snapshot', 'get_element_details', 'find_in_page'],
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();
    await installChatCompletionAbortObserver(sidePanel);

    await sidePanel.getByLabel('Message agent').fill('Original tab');
    await sidePanel.getByLabel('Message agent').press('Enter');

    await expect(sidePanel.getByRole('button', { name: 'Stop' })).toBeVisible();
    await sidePanel.getByLabel('New conversation').click();

    await expect(sidePanel.getByText('Pick a tab and ask Kilo to inspect it.')).toBeVisible();
    await expect.poll(() => wasChatCompletionAborted(sidePanel)).toBe(false);
    await sidePanel.getByRole('tab', { name: /Original tab/u }).click();
    await expect(sidePanel.getByRole('button', { name: 'Stop' })).toBeVisible();
    releaseCompletion();
    await expect(sidePanel.getByText('Original tab completed.')).toBeVisible();
  } finally {
    releaseCompletion();
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('closing the selected tab aborts a running request', async () => {
  const fixture = await startFixtureServer();
  const { promise: pendingCompletion, resolve: releaseCompletion } = Promise.withResolvers<void>();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      beforeFirstCompletion: () => pendingCompletion,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();
    await installChatCompletionAbortObserver(sidePanel);

    await sidePanel.getByRole('button', { name: /Safe mode/u }).click();
    await sidePanel.getByRole('button', { name: 'Dangerous' }).click();
    await sidePanel.getByLabel('Message agent').fill('Inspect this tab');
    await sidePanel.getByLabel('Message agent').press('Enter');

    await expect(sidePanel.getByRole('button', { name: 'Stop' })).toBeVisible();
    await page.close();

    await expect(sidePanel.getByLabel('Target tab')).toContainText('No tab selected');
    await expect.poll(() => wasChatCompletionAborted(sidePanel)).toBe(true);
    releaseCompletion();
    await expect(sidePanel.getByText('Stopped.')).toBeVisible();
  } finally {
    releaseCompletion();
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
