/* eslint-disable import/no-nodejs-modules */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { mockKiloApi } from './kilo-api-fixture';
import {
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';

const messageRowSelector = 'section[aria-label="Agent conversation"] [data-index]';
const safeToolNames = ['get_page_snapshot', 'get_element_details', 'find_in_page'];

const startConversationGapSampler = (sidePanel: Page): Promise<void> =>
  sidePanel.evaluate(() => {
    Reflect.set(globalThis, '__kiloMaxConversationGap', 0);
    Reflect.set(globalThis, '__kiloMinConversationGap', 0);
    requestAnimationFrame(function sampleMessageGaps(): void {
      const rows = [
        ...document.querySelectorAll('section[aria-label="Agent conversation"] [data-index]'),
      ]
        .map(element => {
          const rect = element.getBoundingClientRect();

          return { bottom: rect.bottom, top: rect.top };
        })
        .toSorted((first, second) => first.top - second.top);
      let previousBottom = 0;

      const gaps = rows
        .map(row => {
          const gap = row.top - previousBottom;

          previousBottom = row.bottom;

          return gap;
        })
        .slice(1);

      Reflect.set(
        globalThis,
        '__kiloMaxConversationGap',
        Math.max(Number(Reflect.get(globalThis, '__kiloMaxConversationGap')), ...gaps, 0)
      );
      Reflect.set(
        globalThis,
        '__kiloMinConversationGap',
        Math.min(Number(Reflect.get(globalThis, '__kiloMinConversationGap')), ...gaps, 0)
      );
      requestAnimationFrame(sampleMessageGaps);
    });
  });

const getConversationGaps = (sidePanel: Page): Promise<number[]> =>
  sidePanel.locator(messageRowSelector).evaluateAll(elements => {
    const rows = elements
      .map(element => {
        const rect = element.getBoundingClientRect();

        return { bottom: rect.bottom, top: rect.top };
      })
      .toSorted((first, second) => first.top - second.top);
    let previousBottom = 0;

    return rows
      .map(row => {
        const gap = row.top - previousBottom;

        previousBottom = row.bottom;

        return gap;
      })
      .slice(1);
  });

const getConversationVisualGaps = (sidePanel: Page): Promise<number[]> =>
  sidePanel.locator(messageRowSelector).evaluateAll(elements => {
    const rows = elements
      .flatMap(element => {
        const visualElement = element.firstElementChild;

        if (!(visualElement instanceof HTMLElement)) {
          return [];
        }

        const rect = visualElement.getBoundingClientRect();

        return [{ bottom: rect.bottom, top: rect.top }];
      })
      .toSorted((first, second) => first.top - second.top);
    let previousBottom = 0;

    return rows
      .map(row => {
        const gap = row.top - previousBottom;

        previousBottom = row.bottom;

        return gap;
      })
      .slice(1);
  });

const getMaxObservedGap = (sidePanel: Page): Promise<number> =>
  sidePanel.evaluate(() => Number(Reflect.get(globalThis, '__kiloMaxConversationGap')));

const getMinObservedGap = (sidePanel: Page): Promise<number> =>
  sidePanel.evaluate(() => Number(Reflect.get(globalThis, '__kiloMinConversationGap')));

test('short messages stay compactly spaced while appended', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: [{ choices: [{ delta: { content: 'Short reply 0.' } }] }],
      secondCompletionEvents: [{ choices: [{ delta: { content: 'Short reply 1.' } }] }],
      thirdCompletionEvents: [{ choices: [{ delta: { content: 'Short reply 2.' } }] }],
      toolNames: safeToolNames,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.setViewportSize({ height: 720, width: 360 });
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();
    await startConversationGapSampler(sidePanel);

    const messageInput = sidePanel.getByLabel('Message agent');

    await messageInput.fill('Short prompt 0');
    await messageInput.press('Enter');
    await expect(sidePanel.getByText('Short reply 0.')).toBeVisible();

    await messageInput.fill('Short prompt 1');
    await messageInput.press('Enter');
    await expect(sidePanel.getByText('Short reply 1.')).toBeVisible();

    await messageInput.fill('Short prompt 2');
    await messageInput.press('Enter');
    await expect(sidePanel.getByText('Short reply 2.')).toBeVisible();

    await expect
      .poll(() => sidePanel.locator(messageRowSelector).count())
      .toBeGreaterThanOrEqual(6);

    expect(await getMaxObservedGap(sidePanel)).toBeLessThanOrEqual(12);
    expect(await getMinObservedGap(sidePanel)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...(await getConversationGaps(sidePanel)))).toBeLessThanOrEqual(12);
    expect(Math.min(...(await getConversationGaps(sidePanel)))).toBeGreaterThanOrEqual(0);
    expect(Math.min(...(await getConversationVisualGaps(sidePanel)))).toBeGreaterThanOrEqual(7);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('tool rows stay spaced without overlapping message bubbles', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      firstCompletionEvents: [
        {
          choices: [
            {
              delta: {
                content: 'Let me take a look at the current page for you!',
              },
            },
          ],
        },
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
    await sidePanel.setViewportSize({ height: 720, width: 360 });
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();
    await startConversationGapSampler(sidePanel);

    await sidePanel.getByLabel('Message agent').fill('What do you see?');
    await sidePanel.getByLabel('Message agent').press('Enter');

    await expect(sidePanel.getByText('get_viewport_screenshot completed')).toBeVisible();
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible();
    await expect
      .poll(() => sidePanel.locator(messageRowSelector).count())
      .toBeGreaterThanOrEqual(4);

    const finalGaps = await getConversationGaps(sidePanel);
    const visualGaps = await getConversationVisualGaps(sidePanel);

    expect(await getMinObservedGap(sidePanel)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...finalGaps)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...visualGaps)).toBeGreaterThanOrEqual(7);
    expect(Math.max(...visualGaps)).toBeLessThanOrEqual(12);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
