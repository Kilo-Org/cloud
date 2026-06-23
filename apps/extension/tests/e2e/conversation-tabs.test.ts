/* eslint-disable import/no-nodejs-modules */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { mockKiloApi } from './kilo-api-fixture';
import {
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';

const safeToolNames = ['get_page_snapshot', 'get_element_details', 'find_in_page'];

const clickNewConversationTimes = async (sidePanel: {
  getByLabel: (label: string) => { click: () => Promise<void> };
}): Promise<void> => {
  await Array.from({ length: 14 }).reduce(async (previousClicks): Promise<void> => {
    await previousClicks;
    await sidePanel.getByLabel('New conversation').click();
  }, Promise.resolve());
};

test('conversation tabs can run in parallel', async () => {
  const fixture = await startFixtureServer();
  const { promise: pendingFirstCompletion, resolve: releaseFirstCompletion } =
    Promise.withResolvers<void>();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      beforeFirstCompletion: () => pendingFirstCompletion,
      firstCompletionEvents: [{ choices: [{ delta: { content: 'First tab finished.' } }] }],
      secondCompletionEvents: [{ choices: [{ delta: { content: 'Second tab finished.' } }] }],
      toolNames: safeToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByLabel('Message agent').fill('First request');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByRole('button', { name: 'Stop' })).toBeVisible();

    await sidePanel.getByLabel('New conversation').click();
    await sidePanel.getByLabel('Message agent').fill('Second request');
    await sidePanel.getByLabel('Message agent').press('Enter');

    await expect(sidePanel.getByText('Second tab finished.')).toBeVisible();
    await sidePanel.getByRole('tab', { name: /First request/u }).click();
    await expect(sidePanel.getByRole('button', { name: 'Stop' })).toBeVisible();

    releaseFirstCompletion();

    await expect(sidePanel.getByText('First tab finished.')).toBeVisible();
    await sidePanel.getByRole('tab', { name: /Second request/u }).click();
    await expect(sidePanel.getByText('Second tab finished.')).toBeVisible();
  } finally {
    releaseFirstCompletion();
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('conversation tabs persist across side panel reloads', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: [{ choices: [{ delta: { content: 'First persisted reply.' } }] }],
      secondCompletionEvents: [{ choices: [{ delta: { content: 'Second persisted reply.' } }] }],
      toolNames: safeToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByLabel('Message agent').fill('First persisted');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText('First persisted reply.')).toBeVisible();

    await sidePanel.getByLabel('New conversation').click();
    await sidePanel.getByLabel('Message agent').fill('Second persisted');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText('Second persisted reply.')).toBeVisible();

    await sidePanel.reload();

    await expect(sidePanel.getByRole('tab', { name: /Second persisted/u })).toBeVisible();
    await expect(sidePanel.getByText('Second persisted reply.')).toBeVisible();
    await sidePanel.getByRole('tab', { name: /First persisted/u }).click();
    await expect(sidePanel.getByText('First persisted reply.')).toBeVisible();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('closing a conversation removes only that tab', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: [{ choices: [{ delta: { content: 'Keep this reply.' } }] }],
      secondCompletionEvents: [{ choices: [{ delta: { content: 'Close this reply.' } }] }],
      toolNames: safeToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByLabel('Message agent').fill('Keep this');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText('Keep this reply.')).toBeVisible();

    await sidePanel.getByLabel('New conversation').click();
    await sidePanel.getByLabel('Message agent').fill('Close this');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText('Close this reply.')).toBeVisible();

    await sidePanel.getByLabel('Close Close this').click();

    await expect(sidePanel.getByRole('tab', { name: /Close this/u })).toBeHidden();
    await expect(sidePanel.getByText('Close this reply.')).toBeHidden();
    await expect(sidePanel.getByRole('tab', { name: /Keep this/u })).toBeVisible();
    await expect(sidePanel.getByText('Keep this reply.')).toBeVisible();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('conversation tab bar scrolls horizontally', async () => {
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

    await clickNewConversationTimes(sidePanel);

    const tabBarState = await sidePanel.getByLabel('Conversation tabs').evaluate(element => ({
      clientWidth: element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
      scrollWidth: element.scrollWidth,
    }));

    expect(tabBarState.overflowX).toBe('auto');
    expect(tabBarState.scrollWidth).toBeGreaterThan(tabBarState.clientWidth);
    await expect(sidePanel.getByLabel('New conversation')).toBeVisible();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
