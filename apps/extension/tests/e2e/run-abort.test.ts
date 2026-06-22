/* eslint-disable import/no-nodejs-modules */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import {
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';

test('new conversation aborts a running request', async () => {
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
    await sidePanel.evaluate(() => {
      const originalFetch = globalThis.fetch.bind(globalThis);
      const state = globalThis as typeof globalThis & { __kiloChatAborted?: boolean };

      state.__kiloChatAborted = false;
      globalThis.fetch = ((input, init) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            state.__kiloChatAborted = true;
          },
          { once: true }
        );

        return originalFetch(input, init);
      }) as typeof globalThis.fetch;
    });

    await sidePanel.getByRole('button', { name: /Safe mode/u }).click();
    await sidePanel.getByRole('button', { name: 'Dangerous' }).click();
    await sidePanel.getByLabel('Message agent').fill('Inspect this tab');
    await sidePanel.getByLabel('Message agent').press('Enter');

    await expect(sidePanel.getByRole('button', { name: 'Stop' })).toBeVisible();
    await sidePanel.getByLabel('New conversation').click();

    await expect
      .poll(() =>
        sidePanel.evaluate(() => {
          const state = globalThis as typeof globalThis & { __kiloChatAborted?: boolean };

          return state.__kiloChatAborted === true;
        })
      )
      .toBe(true);
  } finally {
    releaseCompletion();
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
