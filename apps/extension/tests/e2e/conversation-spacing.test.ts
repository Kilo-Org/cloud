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

const getMaxObservedGap = (sidePanel: Page): Promise<number> =>
  sidePanel.evaluate(() => Number(Reflect.get(globalThis, '__kiloMaxConversationGap')));

test('short virtualized messages stay compactly spaced while appended', async () => {
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

    expect(await getMaxObservedGap(sidePanel)).toBeLessThanOrEqual(16);
    expect(Math.max(...(await getConversationGaps(sidePanel)))).toBeLessThanOrEqual(16);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
