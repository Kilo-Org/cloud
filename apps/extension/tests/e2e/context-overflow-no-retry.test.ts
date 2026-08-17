/* eslint-disable import/no-nodejs-modules */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import {
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';

// Issue #5191: a context-window overflow must cost exactly one billed request.
// Retrying the same messages cannot fit, so the turn keeps the partial text immediately.
test('a context-window overflow is not retried and keeps the partial text', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    const seenChatBodies: unknown[] = [];
    await mockKiloApi(context, {
      firstCompletionEvents: [
        { choices: [{ delta: { content: 'Partial answer before the overflow' } }] },
        { choices: [{ delta: {}, finish_reason: 'model_context_window_exceeded' }] },
      ],
      seenChatBodies,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByLabel('Message agent').fill('Summarize this page');
    await sidePanel.getByLabel('Message agent').press('Enter');

    await expect(sidePanel.getByText('Partial answer before the overflow')).toBeVisible();

    // The pre-fix retry tier fired again at +1s and +5s; outwait both before counting requests.
    await sidePanel.waitForTimeout(6000);
    expect(seenChatBodies).toHaveLength(1);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
