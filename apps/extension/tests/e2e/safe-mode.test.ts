/* eslint-disable import/no-nodejs-modules */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { mockKiloApi } from './kilo-api-fixture';
import {
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';

test('safe mode conversation reads the selected tab with safe tools', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: [
        { choices: [{ delta: { content: 'I will read the page.' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    function: {
                      arguments: JSON.stringify({}),
                      name: 'get_page_snapshot',
                    },
                    id: 'call_snapshot_1',
                    index: 0,
                    type: 'function',
                  },
                ],
              },
            },
          ],
        },
      ],
      secondCompletionEvents: [
        {
          choices: [
            {
              delta: {
                content: 'The page is the Kilo extension fixture.',
              },
            },
          ],
        },
      ],
      toolNames: ['get_page_snapshot', 'get_element_details', 'find_in_page'],
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await expect(sidePanel.getByRole('button', { name: /Safe mode/u })).toBeVisible();
    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo extension fixture');

    await sidePanel.getByLabel('Message agent').fill('What is on this page?');
    await sidePanel.getByLabel('Message agent').press('Enter');

    await expect(sidePanel.getByText('get_page_snapshot completed')).toBeVisible();
    await expect(sidePanel.getByText('The page is the Kilo extension fixture.')).toBeVisible();
    await expect(sidePanel.getByText('Switch to dangerous mode')).toBeHidden();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('dangerous mode conversation can use safe read tools', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    function: {
                      arguments: JSON.stringify({}),
                      name: 'get_page_snapshot',
                    },
                    id: 'call_snapshot_1',
                    index: 0,
                    type: 'function',
                  },
                ],
              },
            },
          ],
        },
      ],
      secondCompletionEvents: [
        {
          choices: [
            {
              delta: {
                content: 'Dangerous mode read the page safely first.',
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
    await sidePanel.getByLabel('Message agent').fill('Read this page safely first');
    await sidePanel.getByLabel('Message agent').press('Enter');

    await expect(sidePanel.getByText('get_page_snapshot completed')).toBeVisible();
    await expect(sidePanel.getByText('Dangerous mode read the page safely first.')).toBeVisible();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
