/* eslint-disable import/no-nodejs-modules */
import { expect, test } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mockKiloApi } from './kilo-api-fixture';
import {
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';

const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
);

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

test('viewport screenshot tool output expands to a captured image preview', async () => {
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
                      name: 'get_viewport_screenshot',
                    },
                    id: 'call_screenshot_1',
                    index: 0,
                    type: 'function',
                  },
                ],
              },
            },
          ],
        },
      ],
      modelInputModalities: ['text', 'image'],
      secondCompletionEvents: [
        {
          choices: [
            {
              delta: {
                content: 'I captured the viewport.',
              },
            },
          ],
        },
      ],
      toolNames: [
        'get_page_snapshot',
        'get_element_details',
        'find_in_page',
        'get_viewport_screenshot',
      ],
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByLabel('Message agent').fill('Capture this viewport.');
    await sidePanel.getByLabel('Message agent').press('Enter');

    const screenshotPanel = sidePanel
      .getByText('get_viewport_screenshot completed')
      .locator('xpath=ancestor::details[1]');
    const preview = screenshotPanel.getByRole('img', {
      name: 'Viewport screenshot captured by get_viewport_screenshot',
    });

    await expect(screenshotPanel).toBeVisible();
    await expect(preview).toBeHidden();

    await screenshotPanel.getByText('get_viewport_screenshot completed').click();

    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute('src', /^data:image\/png;base64,/u);
    await expect(sidePanel.getByText('I captured the viewport.')).toBeVisible();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('safe mode can capture a viewport screenshot from a local image file tab', async () => {
  const localFileDir = await mkdtemp(join(tmpdir(), 'kilo-extension-file-e2e-'));
  const imagePath = join(localFileDir, 'kilo-local-image.png');
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await writeFile(imagePath, onePixelPng);
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
                      name: 'get_viewport_screenshot',
                    },
                    id: 'call_screenshot_1',
                    index: 0,
                    type: 'function',
                  },
                ],
              },
            },
          ],
        },
      ],
      modelInputModalities: ['text', 'image'],
      secondCompletionEvents: [
        {
          choices: [
            {
              delta: {
                content: 'I captured the local image tab.',
              },
            },
          ],
        },
      ],
      toolNames: [
        'get_page_snapshot',
        'get_element_details',
        'find_in_page',
        'get_viewport_screenshot',
      ],
    });

    const page = await context.newPage();
    await page.goto(pathToFileURL(imagePath).href);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await expect(sidePanel.getByLabel('Target tab')).toContainText('kilo-local-image');

    await sidePanel.getByLabel('Message agent').fill('Capture this local image.');
    await sidePanel.getByLabel('Message agent').press('Enter');

    await expect(sidePanel.getByText('get_viewport_screenshot completed')).toBeVisible();
    await expect(sidePanel.getByText('I captured the local image tab.')).toBeVisible();
  } finally {
    await context.close();
    await rm(userDataDir, { force: true, recursive: true });
    await rm(localFileDir, { force: true, recursive: true });
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
