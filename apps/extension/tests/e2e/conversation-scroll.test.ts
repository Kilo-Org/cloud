/* eslint-disable import/no-nodejs-modules, max-lines */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { mockKiloApi, readSidePanelScrollState } from './kilo-api-fixture';
import {
  holdConversationScrolledUp,
  launchExtensionContext,
  seedExtensionAuth,
  setExtensionStorage,
  startFixtureServer,
  waitForStoredConversationText,
} from './extension-context-fixture';

const safeReadToolNames = ['get_page_snapshot', 'get_element_details', 'find_in_page'];

test('upward wheel on a non-scrollable conversation keeps auto-scroll enabled', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: [{ choices: [{ delta: { content: 'Still pinned.' } }] }],
      toolNames: safeReadToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.setViewportSize({ height: 720, width: 360 });
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    const conversationPane = sidePanel.getByLabel('Agent conversation');

    await conversationPane.hover();
    await sidePanel.mouse.wheel(0, -800);
    await expect(sidePanel.getByRole('button', { name: 'Jump to latest' })).toBeHidden();

    await sidePanel.getByLabel('Message agent').fill('Reply while still pinned');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText('Still pinned.')).toBeVisible();
    await expect(sidePanel.getByRole('button', { name: 'Jump to latest' })).toBeHidden();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('manual scroll up shows jump to latest without following new messages', async () => {
  const fixture = await startFixtureServer();
  const { promise: pendingFirstCompletion, resolve: releaseFirstCompletion } =
    Promise.withResolvers<void>();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      beforeFirstCompletion: () => pendingFirstCompletion,
      firstCompletionEvents: [{ choices: [{ delta: { content: 'Delayed reply arrived.' } }] }],
      toolNames: safeReadToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.setViewportSize({ height: 420, width: 360 });
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await setExtensionStorage(sidePanel, {
      kiloAgentConversation: Array.from({ length: 80 }, (_value, index) => ({
        id: `manual-scroll-${index}`,
        role: 'assistant',
        text: `Manual scroll content ${index}`,
        type: 'message',
      })),
    });
    await sidePanel.reload();

    await expect(sidePanel.getByText('Manual scroll content 79')).toBeVisible();

    await sidePanel.getByLabel('Message agent').fill('Wait before replying');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByRole('button', { name: 'Stop' })).toBeVisible();

    const conversationPane = sidePanel.getByLabel('Agent conversation');
    const bottomState = await sidePanel.evaluate(readSidePanelScrollState);

    await conversationPane.hover();
    await sidePanel.mouse.wheel(0, -2400);
    await expect
      .poll(async () => {
        const scrollState = await sidePanel.evaluate(readSidePanelScrollState);

        return scrollState.messagePaneScrollTop;
      })
      .toBeLessThan(bottomState.messagePaneScrollTop - 100);
    const scrolledUpState = await sidePanel.evaluate(readSidePanelScrollState);

    await expect(sidePanel.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

    releaseFirstCompletion();

    await waitForStoredConversationText(sidePanel, 'Delayed reply arrived.');

    const finalScrollState = await sidePanel.evaluate(readSidePanelScrollState);

    expect(finalScrollState.messagePaneScrollTop).toBeLessThanOrEqual(
      scrolledUpState.messagePaneScrollTop + 4
    );
    expect(
      finalScrollState.messagePaneScrollTop + finalScrollState.messagePaneClientHeight
    ).toBeLessThan(finalScrollState.messagePaneScrollHeight - 16);

    await sidePanel.getByRole('button', { name: 'Jump to latest' }).click();
    await expect(sidePanel.getByText('Delayed reply arrived.')).toBeVisible();
    await expect(sidePanel.getByRole('button', { name: 'Jump to latest' })).toBeHidden();

    const jumpedScrollState = await sidePanel.evaluate(readSidePanelScrollState);

    expect(
      jumpedScrollState.messagePaneScrollTop + jumpedScrollState.messagePaneClientHeight
    ).toBeGreaterThanOrEqual(jumpedScrollState.messagePaneScrollHeight - 16);
  } finally {
    releaseFirstCompletion();
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('dragging the scrollbar up pauses auto-scroll while a reply is being pinned', async () => {
  const fixture = await startFixtureServer();
  const { promise: pendingFirstCompletion, resolve: releaseFirstCompletion } =
    Promise.withResolvers<void>();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      beforeFirstCompletion: () => pendingFirstCompletion,
      firstCompletionEvents: [
        { choices: [{ delta: { content: 'Reply that must not steal scroll.' } }] },
      ],
      toolNames: safeReadToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.setViewportSize({ height: 420, width: 360 });
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await setExtensionStorage(sidePanel, {
      kiloAgentConversation: Array.from({ length: 80 }, (_value, index) => ({
        id: `drag-scroll-${index}`,
        role: 'assistant',
        text: `Drag scroll content ${index}`,
        type: 'message',
      })),
    });
    await sidePanel.reload();

    await expect(sidePanel.getByText('Drag scroll content 79')).toBeVisible();

    await sidePanel.getByLabel('Message agent').fill('Pin while I scroll up');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByRole('button', { name: 'Stop' })).toBeVisible();

    // Hold the scrollbar at the top with no wheel events while the reply streams in and the list keeps pinning the newest row. This is the gesture the old wheel-only pause path could not see.
    const sustainedScrollUp = holdConversationScrolledUp(sidePanel, 90);

    releaseFirstCompletion();
    await waitForStoredConversationText(sidePanel, 'Reply that must not steal scroll.');
    const holdResult = await sustainedScrollUp;

    // The reply must never have re-pinned the view to the bottom at any point during the hold, not merely by the time the hold ended.
    expect(holdResult.everRecapturedToBottom).toBe(false);

    await expect(sidePanel.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

    const finalScrollState = await sidePanel.evaluate(readSidePanelScrollState);

    expect(
      finalScrollState.messagePaneScrollTop + finalScrollState.messagePaneClientHeight
    ).toBeLessThan(finalScrollState.messagePaneScrollHeight - 16);
  } finally {
    releaseFirstCompletion();
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('the jump to latest button reactivates automatic scroll to new messages', async () => {
  const fixture = await startFixtureServer();
  const { promise: pendingFirstCompletion, resolve: releaseFirstCompletion } =
    Promise.withResolvers<void>();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      beforeFirstCompletion: () => pendingFirstCompletion,
      firstCompletionEvents: [{ choices: [{ delta: { content: 'First delayed reply.' } }] }],
      secondCompletionEvents: [
        { choices: [{ delta: { content: 'Second reply after returning to bottom.' } }] },
      ],
      toolNames: safeReadToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.setViewportSize({ height: 420, width: 360 });
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await setExtensionStorage(sidePanel, {
      kiloAgentConversation: Array.from({ length: 80 }, (_value, index) => ({
        id: `bottom-reactivation-${index}`,
        role: 'assistant',
        text: `Bottom reactivation content ${index}`,
        type: 'message',
      })),
    });
    await sidePanel.reload();

    await expect(sidePanel.getByText('Bottom reactivation content 79')).toBeVisible();

    const conversationPane = sidePanel.getByLabel('Agent conversation');

    await sidePanel.getByLabel('Message agent').fill('Wait before first reply');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByRole('button', { name: 'Stop' })).toBeVisible();

    const bottomState = await sidePanel.evaluate(readSidePanelScrollState);

    await conversationPane.hover();
    await sidePanel.mouse.wheel(0, -2400);
    await expect
      .poll(async () => {
        const scrollState = await sidePanel.evaluate(readSidePanelScrollState);

        return scrollState.messagePaneScrollTop;
      })
      .toBeLessThan(bottomState.messagePaneScrollTop - 100);
    await expect(sidePanel.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

    releaseFirstCompletion();
    await waitForStoredConversationText(sidePanel, 'First delayed reply.');

    await sidePanel.getByRole('button', { name: 'Jump to latest' }).click();
    await expect(sidePanel.getByRole('button', { name: 'Jump to latest' })).toBeHidden();
    await expect
      .poll(async () => {
        const scrollState = await sidePanel.evaluate(readSidePanelScrollState);

        return (
          scrollState.messagePaneScrollTop + scrollState.messagePaneClientHeight >=
          scrollState.messagePaneScrollHeight - 16
        );
      })
      .toBe(true);

    await sidePanel.getByLabel('Message agent').fill('Reply after bottom');
    await sidePanel.getByLabel('Message agent').press('Enter');

    await expect(sidePanel.getByText('Second reply after returning to bottom.')).toBeVisible();

    const finalScrollState = await sidePanel.evaluate(readSidePanelScrollState);

    expect(
      finalScrollState.messagePaneScrollTop + finalScrollState.messagePaneClientHeight
    ).toBeGreaterThanOrEqual(finalScrollState.messagePaneScrollHeight - 16);
  } finally {
    releaseFirstCompletion();
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('scrolling back to the bottom by wheel reactivates automatic scroll', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: [{ choices: [{ delta: { content: 'Reply after wheeling back.' } }] }],
      toolNames: safeReadToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.setViewportSize({ height: 420, width: 360 });
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await setExtensionStorage(sidePanel, {
      kiloAgentConversation: Array.from({ length: 80 }, (_value, index) => ({
        id: `wheel-reactivation-${index}`,
        role: 'assistant',
        text: `Wheel reactivation content ${index}`,
        type: 'message',
      })),
    });
    await sidePanel.reload();

    await expect(sidePanel.getByText('Wheel reactivation content 79')).toBeVisible();

    const conversationPane = sidePanel.getByLabel('Agent conversation');
    const bottomState = await sidePanel.evaluate(readSidePanelScrollState);

    // Wheel up to release auto-scroll, then wheel back down to the bottom.
    await conversationPane.hover();
    await sidePanel.mouse.wheel(0, -2400);
    await expect
      .poll(async () => {
        const scrollState = await sidePanel.evaluate(readSidePanelScrollState);

        return scrollState.messagePaneScrollTop;
      })
      .toBeLessThan(bottomState.messagePaneScrollTop - 100);
    await expect(sidePanel.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

    await sidePanel.mouse.wheel(0, 4000);

    // The jump button hides on its own — auto-scroll re-armed without a click.
    await expect(sidePanel.getByRole('button', { name: 'Jump to latest' })).toBeHidden();

    // A new reply now follows to the bottom automatically.
    await sidePanel.getByLabel('Message agent').fill('Reply after returning by wheel');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText('Reply after wheeling back.')).toBeVisible();

    await expect
      .poll(async () => {
        const scrollState = await sidePanel.evaluate(readSidePanelScrollState);

        return (
          scrollState.messagePaneScrollTop + scrollState.messagePaneClientHeight >=
          scrollState.messagePaneScrollHeight - 16
        );
      })
      .toBe(true);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
