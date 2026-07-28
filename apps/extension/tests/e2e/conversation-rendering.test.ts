/* eslint-disable import/no-nodejs-modules, jest/no-conditional-in-test */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { mockKiloApi, readSidePanelScrollState } from './kilo-api-fixture';
import {
  launchExtensionContext,
  seedExtensionAuth,
  setExtensionStorage,
  startFixtureServer,
} from './extension-context-fixture';
import {
  createNewConversation,
  delayConversationStoreHydration,
  getSelectedTargetTabLabel,
  getTargetTabOptionCount,
  releaseConversationStoreHydration,
  requireTwoOptionLabels,
} from './tab-selection-e2e-helpers';

const safeToolNames = [
  'get_page_snapshot',
  'get_element_details',
  'find_in_page',
  'search_memories',
  'get_memory',
];

test('fresh conversation shows the empty-state hint without a CTA button', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, { toolNames: safeToolNames });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    const conversation = sidePanel.getByLabel('Agent conversation');
    const emptyHint = conversation.getByText('Pick a tab and ask Kilo to inspect it.');
    await expect(emptyHint).toBeVisible();
    const hintBox = await emptyHint.boundingBox();
    expect(hintBox).not.toBeNull();
    expect(hintBox?.height ?? 0).toBeGreaterThan(0);
    expect(hintBox?.width ?? 0).toBeGreaterThan(0);
    await expect(conversation.getByRole('button')).toHaveCount(0);

    await sidePanel.getByLabel('Message agent').fill('First user message');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(conversation.getByText('First user message')).toBeVisible();
    await expect(conversation.getByText('Pick a tab and ask Kilo to inspect it.')).toHaveCount(0);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('new conversation does not inherit the selected target tab', async () => {
  // R3: create samples the active tab fresh; it must not copy conv1's manual pick.
  // Probe (A9) established locator.click() leaves the content tab active.
  const firstFixture = await startFixtureServer({ title: 'First target tab' });
  const secondFixture = await startFixtureServer({ title: 'Second target tab' });
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);

    const firstPage = await context.newPage();
    await firstPage.goto(firstFixture.url);
    const secondPage = await context.newPage();
    await secondPage.goto(secondFixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await expect.poll(() => getTargetTabOptionCount(sidePanel), { timeout: 10_000 }).toBe(2);

    const { firstListed, otherLabel: nonFirstListed } = await requireTwoOptionLabels(sidePanel);

    // Conv1 picks first-listed so inheritance would differ from activating non-first-listed.
    await sidePanel.getByLabel('Target tab').selectOption({ label: firstListed });
    await expect.poll(() => getSelectedTargetTabLabel(sidePanel)).toBe(firstListed);

    const pagesByLabel = new Map([
      ['First target tab', firstPage],
      ['Second target tab', secondPage],
    ]);
    const activatedPage = pagesByLabel.get(nonFirstListed);

    if (activatedPage === undefined) {
      throw new Error(`No page for label ${nonFirstListed}`);
    }

    await activatedPage.bringToFront();
    await createNewConversation(sidePanel);

    // New conversation defaults to the ACTIVATED tab — not conv1's pick (old inheritance).
    await expect
      .poll(() => getSelectedTargetTabLabel(sidePanel), { timeout: 10_000 })
      .toBe(nonFirstListed);
    expect(nonFirstListed).not.toBe(firstListed);
  } finally {
    await context.close();
    await firstFixture.close();
    await secondFixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('conversation controls wait for stored conversations to hydrate', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await setExtensionStorage(sidePanel, {
      kiloAgentConversations: {
        activeConversationId: 'conversation-1',
        conversations: [
          {
            events: [
              {
                id: 'persisted-message',
                role: 'assistant',
                text: 'Persisted conversation after hydration',
                type: 'message',
              },
            ],
            id: 'conversation-1',
            title: 'Persisted conversation',
            updatedAt: new Date().toISOString(),
          },
        ],
        openConversationIds: ['conversation-1'],
      },
    });
    await delayConversationStoreHydration(sidePanel);
    await sidePanel.reload();

    await expect(sidePanel.getByLabel('Settings')).toBeVisible();
    await expect(sidePanel.getByLabel('New conversation')).toBeDisabled();
    await expect(sidePanel.getByLabel('Target tab')).toBeDisabled();
    await expect(sidePanel.getByRole('button', { name: /Safe mode/u })).toBeDisabled();

    await releaseConversationStoreHydration(sidePanel);

    await expect(sidePanel.getByText('Persisted conversation after hydration')).toBeVisible();
    await expect(sidePanel.getByLabel('New conversation')).toBeEnabled();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('new conversation does not drop an immediately typed draft', async () => {
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

    await expect(sidePanel.getByLabel('Settings')).toBeVisible();
    await sidePanel.evaluate(`
      (() => {
        const storageLocal = globalThis.browser.storage.local;
        const originalRemove = storageLocal.remove.bind(storageLocal);
        storageLocal.remove = async keys => {
          await new Promise(resolve => {
            setTimeout(resolve, 100);
          });
          await originalRemove(keys);
        };
      })()
    `);

    await sidePanel.getByLabel('New conversation').click();
    await sidePanel.getByLabel('Message agent').fill('Fast follow-up');
    await sidePanel.waitForTimeout(150);

    await expect(sidePanel.getByLabel('Message agent')).toHaveValue('Fast follow-up');
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeEnabled();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('assistant messages render markdown', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: [
        {
          choices: [
            {
              delta: {
                content:
                  '### Markdown title\n\nThis has **bold text** and [a link](https://kilo.ai).\n\n- first item',
              },
            },
          ],
        },
      ],
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByRole('button', { name: /Safe mode/u }).click();
    await sidePanel.getByRole('button', { name: 'Dangerous' }).click();
    await sidePanel.getByLabel('Message agent').fill('Show markdown');
    await sidePanel.getByLabel('Message agent').press('Enter');

    await expect(sidePanel.getByRole('heading', { name: 'Markdown title' })).toBeVisible();
    await expect(sidePanel.locator('strong').filter({ hasText: 'bold text' })).toBeVisible();
    await expect(sidePanel.getByRole('link', { name: 'a link' })).toHaveAttribute(
      'href',
      'https://kilo.ai'
    );
    await expect(sidePanel.getByRole('listitem').filter({ hasText: 'first item' })).toBeVisible();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('only the message pane scrolls virtualized overflowing conversation content', async () => {
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);

    const sidePanel = await context.newPage();
    await sidePanel.setViewportSize({ height: 420, width: 360 });
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await setExtensionStorage(sidePanel, {
      kiloAgentConversation: Array.from({ length: 80 }, (_value, index) => ({
        id: `overflow-${index}`,
        role: 'assistant',
        text: `Overflow content ${index}`,
        type: 'message',
      })),
    });
    await sidePanel.reload();

    await expect(sidePanel.getByText('Overflow content 79')).toBeVisible();
    await expect(sidePanel.getByLabel('Agent conversation')).toBeVisible();

    const scrollState = await sidePanel.evaluate(readSidePanelScrollState);
    const mountedMessageItems = await sidePanel
      .locator('section[aria-label="Agent conversation"] [data-index]')
      .count();

    expect(scrollState.documentScrollHeight).toBe(scrollState.documentClientHeight);
    expect(scrollState.messagePaneScrollHeight).toBeGreaterThan(
      scrollState.messagePaneClientHeight
    );
    expect(mountedMessageItems).toBeLessThan(80);
    expect(
      scrollState.messagePaneScrollTop + scrollState.messagePaneClientHeight
    ).toBeGreaterThanOrEqual(scrollState.messagePaneScrollHeight - 4);
  } finally {
    await context.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
