/* eslint-disable import/no-nodejs-modules, jest/no-conditional-in-test */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import {
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';
import { mockAgentsApi } from './agents-fixture';
import {
  installChatCompletionAbortObserver,
  mockKiloApi,
  safeToolNames,
  wasChatCompletionAborted,
} from './kilo-api-fixture';

test('a browser run keeps streaming while the Agents tab is open', async () => {
  const fixture = await startFixtureServer();
  const { promise: pendingCompletion, resolve: releaseCompletion } = Promise.withResolvers<void>();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    // Route ownership, verified in the fixtures: `mockAgentsApi` registers no
    // Chat-completions route and returns the same single model `mockKiloApi`
    // Returns by default, so the catalog is identical either way. Playwright
    // Matches routes in reverse registration order, so registering `mockKiloApi`
    // Last keeps its `/api/user`, `/api/organizations`, and models handlers in
    // Force together with its chat-body assertions. Do not reorder the two calls.
    await mockAgentsApi(context);
    await mockKiloApi(context, {
      beforeFirstCompletion: () => pendingCompletion,
      firstCompletionEvents: [{ choices: [{ delta: { content: 'Background run finished.' } }] }],
      toolNames: safeToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();
    await installChatCompletionAbortObserver(sidePanel);

    await sidePanel.getByLabel('Message agent').fill('Background run');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByRole('button', { name: 'Stop' })).toBeVisible();

    await sidePanel.getByRole('tab', { name: 'Agents' }).click();
    await expect(sidePanel.getByLabel('Message agent')).toBeHidden();
    await expect(sidePanel.getByRole('button', { exact: true, name: 'New session' })).toBeVisible();

    await expect.poll(() => wasChatCompletionAborted(sidePanel)).toBe(false);

    releaseCompletion();

    await sidePanel.getByRole('tab', { name: 'Browser' }).click();
    await expect(sidePanel.getByText('Background run finished.')).toBeVisible();
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible();
  } finally {
    releaseCompletion();
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('a message queued during a run starts the next turn', async () => {
  const fixture = await startFixtureServer();
  const { promise: pendingCompletion, resolve: releaseCompletion } = Promise.withResolvers<void>();
  const { context, extensionId, userDataDir } = await launchExtensionContext();
  const seenChatBodies: unknown[] = [];

  try {
    await mockKiloApi(context, {
      beforeFirstCompletion: () => pendingCompletion,
      firstCompletionEvents: [{ choices: [{ delta: { content: 'First turn done.' } }] }],
      secondCompletionEvents: [{ choices: [{ delta: { content: 'Second turn done.' } }] }],
      seenChatBodies,
      toolNames: safeToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByLabel('Message agent').fill('First message');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByRole('button', { name: 'Stop' })).toBeVisible();

    await expect(sidePanel.getByLabel('Model')).toBeDisabled();

    await sidePanel.getByLabel('Message agent').fill('Queued message');
    await sidePanel.getByLabel('Message agent').press('Enter');

    await expect(sidePanel.getByLabel('Message agent')).toHaveValue('');
    await expect(sidePanel.getByText('Queued: Queued message')).toBeVisible();
    await expect(sidePanel.getByRole('button', { name: 'Stop' })).toBeVisible();

    releaseCompletion();

    await expect(sidePanel.getByText('First turn done.')).toBeVisible();
    await expect(sidePanel.getByText('Second turn done.')).toBeVisible();
    await expect(
      sidePanel.getByLabel('Agent conversation').getByText('Queued message')
    ).toBeVisible();
    await expect(sidePanel.getByText('Queued: Queued message')).toHaveCount(0);

    await expect.poll(() => seenChatBodies.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(seenChatBodies[1])).toContain('First turn done.');
    expect(JSON.stringify(seenChatBodies[1])).toContain('Queued message');
  } finally {
    releaseCompletion();
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('Stop drops a queued message', async () => {
  const fixture = await startFixtureServer();
  const { promise: pendingCompletion, resolve: releaseCompletion } = Promise.withResolvers<void>();
  const { context, extensionId, userDataDir } = await launchExtensionContext();
  const seenChatBodies: unknown[] = [];

  try {
    await mockKiloApi(context, {
      beforeFirstCompletion: () => pendingCompletion,
      firstCompletionEvents: [{ choices: [{ delta: { content: 'First turn done.' } }] }],
      secondCompletionEvents: [{ choices: [{ delta: { content: 'Second turn done.' } }] }],
      seenChatBodies,
      toolNames: safeToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByLabel('Message agent').fill('First message');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByRole('button', { name: 'Stop' })).toBeVisible();

    await sidePanel.getByLabel('Message agent').fill('Queued message');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(sidePanel.getByText('Queued: Queued message')).toBeVisible();

    await sidePanel.getByRole('button', { name: 'Stop' }).click();

    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible();
    await expect(sidePanel.getByText('Queued: Queued message')).toHaveCount(0);
    await expect(
      sidePanel.getByLabel('Agent conversation').getByText('Queued message')
    ).toHaveCount(0);

    await sidePanel.waitForTimeout(500);
    expect(seenChatBodies.length).toBe(1);
  } finally {
    releaseCompletion();
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
