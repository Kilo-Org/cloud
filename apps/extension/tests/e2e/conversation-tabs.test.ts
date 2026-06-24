/* eslint-disable import/no-nodejs-modules, max-lines */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { mockKiloApi } from './kilo-api-fixture';
import {
  launchExtensionContext,
  seedExtensionAuth,
  setExtensionStorage,
  startFixtureServer,
  waitForStoredConversationText,
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
    await waitForStoredConversationText(sidePanel, 'Second persisted reply.');

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

    sidePanel.once('dialog', async dialog => {
      expect(dialog.message()).toContain('Close this conversation tab?');
      await dialog.accept();
    });
    await sidePanel.getByLabel('Close Close this').click();

    await expect(sidePanel.getByRole('tab', { name: /Close this/u })).toBeHidden();
    await expect(sidePanel.getByText('Close this reply.')).toBeHidden();
    await expect(sidePanel.getByRole('tab', { name: /Keep this/u })).toBeVisible();
    await expect(sidePanel.getByText('Keep this reply.')).toBeVisible();

    await sidePanel.getByLabel('History').click();
    await sidePanel.getByLabel('Open Close this').click();

    await expect(sidePanel.getByRole('tab', { name: /Close this/u })).toBeVisible();
    await expect(sidePanel.getByText('Close this reply.')).toBeVisible();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('history can delete closed conversations without confirmation', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: [{ choices: [{ delta: { content: 'Delete later reply.' } }] }],
      secondCompletionEvents: [{ choices: [{ delta: { content: 'Keep open reply.' } }] }],
      toolNames: safeToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByLabel('Message agent').fill('Delete later');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText('Delete later reply.')).toBeVisible();

    await sidePanel.getByLabel('New conversation').click();
    await sidePanel.getByLabel('Message agent').fill('Keep open');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText('Keep open reply.')).toBeVisible();

    sidePanel.once('dialog', async dialog => {
      await dialog.accept();
    });
    await sidePanel.getByLabel('Close Delete later').click();
    await expect(sidePanel.getByRole('tab', { name: /Delete later/u })).toBeHidden();

    let sawDialog = false;
    sidePanel.once('dialog', async dialog => {
      sawDialog = true;
      await dialog.dismiss();
    });
    await sidePanel.getByLabel('History').click();
    await sidePanel.getByLabel('Delete Delete later').click();

    await expect(sidePanel.getByText('Delete later reply.')).toBeHidden();
    await expect(sidePanel.getByLabel('Open Delete later')).toBeHidden();
    expect(sawDialog).toBe(false);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('history reuses an empty inactive tab when opening a closed conversation', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: [{ choices: [{ delta: { content: 'Restore me reply.' } }] }],
      toolNames: safeToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByLabel('Message agent').fill('Restore me');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText('Restore me reply.')).toBeVisible();

    await sidePanel.getByLabel('New conversation').click();
    sidePanel.once('dialog', async dialog => {
      await dialog.accept();
    });
    await sidePanel.getByLabel('Close Restore me').click();

    await sidePanel.getByLabel('History').click();
    await sidePanel.getByLabel('Open Restore me').click();

    await expect(sidePanel.getByRole('tab')).toHaveCount(1);
    await expect(sidePanel.getByRole('tab', { name: /Restore me/u })).toBeVisible();
    await expect(sidePanel.getByText('Restore me reply.')).toBeVisible();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('history confirms and aborts before deleting an open running conversation', async () => {
  const fixture = await startFixtureServer();
  const { promise: pendingCompletion, resolve: releaseCompletion } = Promise.withResolvers<void>();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      beforeFirstCompletion: () => pendingCompletion,
      firstCompletionEvents: [{ choices: [{ delta: { content: 'Should not finish.' } }] }],
      toolNames: safeToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByLabel('Message agent').fill('Delete running');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByRole('button', { name: 'Stop' })).toBeVisible();

    await sidePanel.getByLabel('History').click();
    sidePanel.once('dialog', async dialog => {
      expect(dialog.message()).toContain('Delete this conversation and close its tab?');
      await dialog.accept();
    });
    await sidePanel.getByLabel('Delete Delete running').click();

    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible();
    await expect(sidePanel.getByRole('tab', { name: /Delete running/u })).toBeHidden();
    await expect(sidePanel.getByText('Delete running')).toBeHidden();
  } finally {
    releaseCompletion();
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('history virtualizes and pages large stored conversation lists', async () => {
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);

    const sidePanel = await context.newPage();
    await sidePanel.setViewportSize({ height: 520, width: 320 });
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await setExtensionStorage(sidePanel, {
      kiloAgentConversations: {
        activeConversationId: 'conversation-1',
        conversations: Array.from({ length: 250 }, (_value, index) => {
          const conversationNumber = index + 1;

          return {
            events: [],
            id: `conversation-${conversationNumber}`,
            title: `Seeded conversation ${conversationNumber}`,
            updatedAt: new Date(2026, 0, conversationNumber).toISOString(),
          };
        }),
        openConversationIds: ['conversation-1'],
      },
    });
    await sidePanel.reload();

    await sidePanel.getByLabel('History').click();
    const historyPanel = sidePanel.getByLabel('Conversation history');
    await expect(historyPanel).toBeVisible();
    await expect(sidePanel.getByText('250 conversations')).toBeVisible();
    await expect(sidePanel.getByText('Seeded conversation 250')).toBeVisible();
    await expect(sidePanel.getByLabel('Open Seeded conversation 120')).toBeHidden();

    const firstMountedRows = await historyPanel.locator('[data-history-index]').count();

    expect(firstMountedRows).toBeLessThan(100);

    await historyPanel.evaluate(element => {
      element.scrollTop = element.scrollHeight;
    });
    await sidePanel.getByRole('button', { name: 'Show 100 more conversations' }).click();
    await expect(sidePanel.getByText('Showing 200 of 250')).toBeVisible();
  } finally {
    await context.close();
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
