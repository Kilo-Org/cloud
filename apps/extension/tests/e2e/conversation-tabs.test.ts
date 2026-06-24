/* eslint-disable import/no-nodejs-modules, jest/no-conditional-in-test, max-lines */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
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
const getSelectedOptionText = (page: Page, label: string): Promise<string> =>
  page.getByLabel(label).evaluate(element => {
    if (!(element instanceof HTMLSelectElement)) {
      return '';
    }

    return element.selectedOptions[0]?.textContent?.trim() ?? '';
  });
const getConversationScrollState = (
  page: Page
): Promise<{ isPinned: boolean; movedBackward: boolean }> =>
  page.getByLabel('Agent conversation').evaluate(element => {
    const samples =
      (globalThis as typeof globalThis & { __kiloScrollTops?: number[] }).__kiloScrollTops ?? [];

    return {
      isPinned: element.scrollTop + element.clientHeight >= element.scrollHeight - 16,
      movedBackward: samples.some((sample, index) => {
        const previousSample = samples[index - 1];

        return previousSample !== undefined && sample < previousSample - 2;
      }),
    };
  });
const getExtensionStorage = (page: Page, keys: string[]): Promise<Record<string, unknown>> =>
  page.evaluate(storageKeys => {
    const storage = (
      globalThis as typeof globalThis & {
        chrome?: {
          storage?: {
            local?: {
              get: (keys: string[]) => Promise<Record<string, unknown>>;
            };
          };
        };
      }
    ).chrome?.storage?.local;

    if (storage === undefined) {
      throw new Error('Extension runtime storage is unavailable.');
    }

    return storage.get(storageKeys);
  }, keys);
const installTimedChatStream = async (page: Page, chunks: string[]): Promise<void> => {
  await page.evaluate(streamChunks => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    const encoder = new TextEncoder();

    globalThis.fetch = ((input, init) => {
      let url = '';

      if (typeof input === 'string') {
        url = input;
      } else if (input instanceof Request) {
        ({ url } = input);
      } else if (input instanceof URL) {
        ({ href: url } = input);
      }

      if (!url.endsWith('/api/gateway/v1/chat/completions')) {
        return originalFetch(input, init);
      }

      let chunkIndex = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const push = (): void => {
            const chunk = streamChunks[chunkIndex];

            if (chunk === undefined) {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
              return;
            }

            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`
              )
            );
            chunkIndex += 1;
            setTimeout(push, 1);
          };

          push();
        },
      });

      return Promise.resolve(
        new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
          status: 200,
        })
      );
    }) as typeof globalThis.fetch;
  }, chunks);
};

const conversationStoreWithTitle = (title: string): unknown => ({
  activeConversationId: 'conversation-1',
  conversations: [
    {
      events: [],
      id: 'conversation-1',
      title,
      updatedAt: '2026-06-24T10:00:00.000Z',
    },
  ],
  openConversationIds: ['conversation-1'],
});

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

test('inactive conversation completion does not switch the selected conversation', async () => {
  const fixture = await startFixtureServer();
  const { promise: pendingFirstCompletion, resolve: releaseFirstCompletion } =
    Promise.withResolvers<void>();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      beforeFirstCompletion: () => pendingFirstCompletion,
      firstCompletionEvents: [{ choices: [{ delta: { content: 'Inactive tab finished.' } }] }],
      secondCompletionEvents: [{ choices: [{ delta: { content: 'Visible tab finished.' } }] }],
      toolNames: safeToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByLabel('Message agent').fill('Inactive request');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await sidePanel.getByLabel('New conversation').click();
    await sidePanel.getByLabel('Message agent').fill('Visible request');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText('Visible tab finished.')).toBeVisible();

    releaseFirstCompletion();

    await expect(sidePanel.getByRole('tab', { selected: true })).toContainText('Visible request');
    await expect(sidePanel.getByText('Inactive tab finished.')).toBeHidden();
    await sidePanel.getByRole('tab', { name: /Inactive request/u }).click();
    await expect(sidePanel.getByText('Inactive tab finished.')).toBeVisible();
  } finally {
    releaseFirstCompletion();
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('conversation controls stay tied to the selected conversation', async () => {
  const firstFixture = await startFixtureServer({ title: 'First target tab' });
  const secondFixture = await startFixtureServer({ title: 'Second target tab' });
  const seenChatBodies: unknown[] = [];
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: [{ choices: [{ delta: { content: 'First settings reply.' } }] }],
      models: [
        {
          id: 'model-one',
          name: 'Provider: First Model',
          variants: { high: {}, low: {}, medium: {} },
        },
        {
          id: 'model-two',
          name: 'Provider: Second Model',
          variants: { high: {}, low: {}, medium: {} },
        },
      ],
      secondCompletionEvents: [{ choices: [{ delta: { content: 'Second settings reply.' } }] }],
      seenChatBodies,
      toolNames: safeToolNames,
    });

    const firstPage = await context.newPage();
    await firstPage.goto(firstFixture.url);
    const secondPage = await context.newPage();
    await secondPage.goto(secondFixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await expect(sidePanel.getByLabel('Target tab')).toContainText('First target tab');
    await sidePanel.getByLabel('Target tab').selectOption({ label: 'First target tab' });
    await sidePanel.getByLabel('Model').selectOption('model-one');
    await sidePanel.getByLabel('Thinking effort').selectOption('low');

    await sidePanel.getByLabel('Message agent').fill('First settings');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText('First settings reply.')).toBeVisible();

    await sidePanel.getByLabel('New conversation').click();
    await expect(sidePanel.getByRole('tab', { selected: true })).toContainText('Conversation 2');
    await sidePanel.getByLabel('Target tab').selectOption({ label: 'Second target tab' });
    await sidePanel.getByLabel('Model').selectOption('model-two');
    await sidePanel.getByLabel('Thinking effort').selectOption('high');
    await expect
      .poll(() => getSelectedOptionText(sidePanel, 'Target tab'))
      .toBe('Second target tab');
    await expect(sidePanel.getByLabel('Model')).toHaveValue('model-two');
    await expect(sidePanel.getByLabel('Thinking effort')).toHaveValue('high');

    await sidePanel.getByLabel('Message agent').fill('Second settings');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText('Second settings reply.')).toBeVisible();

    await sidePanel.getByRole('tab', { name: /First settings/u }).click();
    await expect
      .poll(() => getSelectedOptionText(sidePanel, 'Target tab'))
      .toBe('First target tab');
    await expect(sidePanel.getByLabel(/Safe mode/u)).toBeVisible();
    await expect(sidePanel.getByLabel('Model')).toHaveValue('model-one');
    await expect(sidePanel.getByLabel('Thinking effort')).toHaveValue('low');

    await sidePanel.getByRole('tab', { name: /Second settings/u }).click();
    await expect
      .poll(() => getSelectedOptionText(sidePanel, 'Target tab'))
      .toBe('Second target tab');
    await expect(sidePanel.getByLabel('Model')).toHaveValue('model-two');
    await expect(sidePanel.getByLabel('Thinking effort')).toHaveValue('high');

    expect(JSON.stringify(seenChatBodies[0])).toContain('First target tab');
    expect(JSON.stringify(seenChatBodies[0])).toContain('"model":"model-one"');
    expect(JSON.stringify(seenChatBodies[0])).toContain('"effort":"low"');
    expect(JSON.stringify(seenChatBodies[1])).toContain('Second target tab');
    expect(JSON.stringify(seenChatBodies[1])).toContain('"model":"model-two"');
    expect(JSON.stringify(seenChatBodies[1])).toContain('"effort":"high"');
  } finally {
    await context.close();
    await firstFixture.close();
    await secondFixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('conversation mode controls the selected conversation request tools', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: [{ choices: [{ delta: { content: 'Dangerous mode reply.' } }] }],
      toolNames: [...safeToolNames, 'eval'],
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await setExtensionStorage(sidePanel, {
      kiloAgentConversations: {
        activeConversationId: 'conversation-2',
        conversations: [
          {
            events: [],
            id: 'conversation-1',
            mode: 'safe',
            title: 'Safe saved conversation',
            updatedAt: '2026-06-24T10:00:00.000Z',
          },
          {
            events: [],
            id: 'conversation-2',
            mode: 'dangerous',
            title: 'Dangerous saved conversation',
            updatedAt: '2026-06-24T11:00:00.000Z',
          },
        ],
        openConversationIds: ['conversation-1', 'conversation-2'],
      },
    });
    await sidePanel.reload();

    await expect(sidePanel.getByRole('tab', { selected: true })).toContainText(
      'Dangerous saved conversation'
    );
    await sidePanel.getByLabel('Message agent').fill('Use dangerous tools');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText('Dangerous mode reply.')).toBeVisible();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('streaming messages stay pinned to latest without scroll bounce', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();
  const chunks = Array.from({ length: 80 }, (_value, index) => ({
    choices: [{ delta: { content: `chunk-${index} ` } }],
  }));

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: chunks,
      toolNames: safeToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByLabel('Agent conversation').evaluate(element => {
      const state = globalThis as typeof globalThis & { __kiloScrollTops?: number[] };

      state.__kiloScrollTops = [];
      element.addEventListener('scroll', () => {
        state.__kiloScrollTops?.push(element.scrollTop);
      });
    });
    await sidePanel.getByLabel('Message agent').fill('Stream a long response');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText(/chunk-79/u)).toBeVisible();

    const scrollState = await getConversationScrollState(sidePanel);

    expect(scrollState).toStrictEqual({ isPinned: true, movedBackward: false });
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('rapid streaming does not flicker conversation bubbles', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();
  const chunks = Array.from({ length: 80 }, (_value, index) => `chunk-${index} `);

  try {
    await mockKiloApi(context, {
      toolNames: safeToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();
    await installTimedChatStream(sidePanel, chunks);
    await sidePanel.getByLabel('Agent conversation').evaluate(element => {
      const state = globalThis as typeof globalThis & {
        __kiloBubbleTextChanges?: number;
        __kiloLastBubbleText?: string;
      };

      state.__kiloBubbleTextChanges = 0;
      state.__kiloLastBubbleText = element.textContent ?? '';
      new MutationObserver(() => {
        const text = element.textContent ?? '';

        if (text !== state.__kiloLastBubbleText) {
          state.__kiloBubbleTextChanges = (state.__kiloBubbleTextChanges ?? 0) + 1;
          state.__kiloLastBubbleText = text;
        }
      }).observe(element, { characterData: true, childList: true, subtree: true });
    });

    await sidePanel.getByLabel('Message agent').fill('Stream quickly');
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeEnabled();
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText(/chunk-70/u)).toBeVisible();
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible();

    const textChangeCount = await sidePanel.evaluate(() => {
      const state = globalThis as typeof globalThis & { __kiloBubbleTextChanges?: number };

      return state.__kiloBubbleTextChanges ?? 0;
    });

    expect(textChangeCount).toBeLessThan(200);
  } finally {
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

test('conversation remount loads current storage instead of cached query history', async () => {
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);
    await context.route('https://app.kilo.ai/api/device-auth/codes?app=1', route =>
      route.fulfill({
        json: { code: 'ABCD-2345', verificationUrl: 'https://app.kilo.ai/device-auth' },
        status: 200,
      })
    );
    await context.route('https://app.kilo.ai/api/device-auth/codes/ABCD-2345', route =>
      route.fulfill({
        json: { token: 'token-2', userEmail: 'user@kilo.ai' },
        status: 200,
      })
    );

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await setExtensionStorage(sidePanel, {
      kiloAgentConversations: conversationStoreWithTitle('Cached old conversation'),
      kiloLogoutSentinel: { retained: true },
    });
    await sidePanel.reload();

    await sidePanel.getByLabel('History').click();
    await expect(
      sidePanel.getByLabel('Conversation history').getByText('Cached old conversation')
    ).toBeVisible();
    await sidePanel.getByLabel('Close history').click();

    await sidePanel.getByLabel('Settings').click();
    await sidePanel.getByRole('button', { name: 'Sign out' }).click();
    await expect(sidePanel.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect
      .poll(() =>
        getExtensionStorage(sidePanel, ['kiloAuth', 'kiloAgentConversations', 'kiloLogoutSentinel'])
      )
      .toStrictEqual({});
    await setExtensionStorage(sidePanel, {
      kiloAgentConversations: conversationStoreWithTitle('Fresh stored conversation'),
    });
    await sidePanel.evaluate(`
      (() => {
        const chromeApi = globalThis.chrome;
        const browserApi = globalThis.browser;
        const storageLocal = browserApi?.storage?.local;

        if (chromeApi?.tabs) {
          chromeApi.tabs.create = () => Promise.resolve();
        }
        if (browserApi?.tabs) {
          browserApi.tabs.create = () => Promise.resolve();
        }
        if (typeof storageLocal?.get === "function") {
          const originalGet = storageLocal.get.bind(storageLocal);

          storageLocal.get = async (...args) => {
            await new Promise(resolve => {
              setTimeout(resolve, 100);
            });

            return originalGet(...args);
          };
        }
      })()
    `);

    await sidePanel.getByRole('button', { name: 'Sign in' }).click();
    await expect(sidePanel.getByRole('tab', { name: /Fresh stored conversation/u })).toBeVisible({
      timeout: 10_000,
    });
    await sidePanel.getByLabel('History').click();

    const historyPanel = sidePanel.getByLabel('Conversation history');

    await expect(historyPanel.getByText('Fresh stored conversation')).toBeVisible();
    await expect(historyPanel.getByText('Cached old conversation')).toBeHidden();
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
