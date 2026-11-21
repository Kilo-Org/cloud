/* eslint-disable import/no-nodejs-modules */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import {
  launchExtensionContext,
  seedExtensionAuth,
  setExtensionStorage,
  startFixtureServer,
} from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';

const errorTitle = 'The server is busy. Try again in a moment.';

const systemEnvironment = [
  '<system_environment>',
  'Selected tab title: Kilo extension fixture',
  'Selected tab URL: http://127.0.0.1/',
  'Current time: 2026-06-24T10:00:00.000Z',
  'Timezone: UTC',
  '</system_environment>',
].join('\n');

const seededConversationStore = (model: string): Record<string, unknown> => ({
  kiloAgentConversations: {
    activeConversationId: 'conversation-1',
    conversations: [
      {
        events: [
          {
            id: 'retry-user-message',
            role: 'user',
            systemEnvironment,
            text: 'Summarize this page',
            type: 'message',
          },
          {
            id: 'retry-error',
            retry: 'turn',
            title: errorTitle,
            type: 'error',
          },
        ],
        id: 'conversation-1',
        model,
        title: 'Summarize this page',
        updatedAt: '2026-06-24T10:00:00.000Z',
      },
    ],
    openConversationIds: ['conversation-1'],
  },
});

test('retry waits for the model catalog to offer the conversation model', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    const seenChatBodies: unknown[] = [];
    await mockKiloApi(context, {
      /*
       * The models route never succeeds, so no catalog loads and the conversation
       * keeps the model id it was stored with.
       */
      modelFailuresBeforeSuccess: 1000,
      models: [{ id: 'retired/model-x', name: 'Retired model' }],
      seenChatBodies,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await setExtensionStorage(sidePanel, seededConversationStore('retired/model-x'));
    await sidePanel.reload();

    const alert = sidePanel.getByRole('alert').filter({ hasText: errorTitle });
    await expect(alert).toBeVisible();
    // The target tab resolves to the fixture page, so the catalog is the only gate left.
    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo extension fixture');
    await expect(sidePanel.getByText('Could not load models.')).toBeVisible();

    await alert.getByRole('button', { exact: true, name: 'Retry' }).click();

    // A bounded settle window: any turn start would have reached the gateway by now.
    await sidePanel.waitForTimeout(1500);

    expect(seenChatBodies).toHaveLength(0);
    await expect(alert).toBeVisible();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('retry starts a turn for the stored model when the catalog contains it', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    const seenChatBodies: unknown[] = [];
    await mockKiloApi(context, {
      firstCompletionEvents: [{ choices: [{ delta: { content: 'Retry answered.' } }] }],
      models: [{ id: 'anthropic/claude-sonnet-4', name: 'Anthropic: Claude Sonnet 4' }],
      seenChatBodies,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await setExtensionStorage(sidePanel, seededConversationStore('anthropic/claude-sonnet-4'));
    await sidePanel.reload();

    const alert = sidePanel.getByRole('alert').filter({ hasText: errorTitle });
    await expect(alert).toBeVisible();
    await expect(sidePanel.getByLabel('Model')).toContainText('Claude Sonnet 4');

    await alert.getByRole('button', { exact: true, name: 'Retry' }).click();

    await expect.poll(() => seenChatBodies.length).toBe(1);
    expect(seenChatBodies[0]).toMatchObject({ model: 'anthropic/claude-sonnet-4' });
    await expect(sidePanel.getByText('Retry answered.')).toBeVisible();
    await expect.poll(() => seenChatBodies.length).toBe(1);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
