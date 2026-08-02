/* eslint-disable import/no-nodejs-modules, jest/no-conditional-in-test */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { mockKiloApi } from './kilo-api-fixture';
import {
  launchExtensionContext,
  seedExtensionAuth,
  setExtensionStorage,
  startFixtureServer,
} from './extension-context-fixture';

const PENDING_DRAFT_KEY = 'kiloPendingAgentMemoryDraft';

test('header panels fill the side panel and enabled controls use pointer cursor', async () => {
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

    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo extension fixture');

    const settingsButtonCursor = await sidePanel
      .getByLabel('Settings')
      .evaluate(element => getComputedStyle(element).cursor);
    const targetTabCursor = await sidePanel
      .getByLabel('Target tab')
      .evaluate(element => getComputedStyle(element).cursor);

    expect(settingsButtonCursor).toBe('pointer');
    expect(targetTabCursor).toBe('pointer');

    await sidePanel.getByLabel('Settings').click();
    const settingsPanel = sidePanel.getByLabel('Settings panel');
    await expect(settingsPanel).toBeVisible();
    await expect(settingsPanel).toHaveJSProperty('clientWidth', 320);
    await expect(settingsPanel).toHaveJSProperty('clientHeight', 520);

    await sidePanel.getByLabel('Close settings').click();
    await sidePanel.getByLabel('History').click();
    const historyPanel = sidePanel.getByLabel('Conversation history');
    await expect(historyPanel).toBeVisible();
    await expect(historyPanel).toHaveJSProperty('clientWidth', 320);
    await expect(historyPanel).toHaveJSProperty('clientHeight', 520);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('add-to-memory overlay stacks above the open context-usage popover', async () => {
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

    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo extension fixture');

    // Open the context-donut popover (z-20) before the memory card appears.
    const contextDonut = sidePanel.getByLabel(/^Context usage:/u);
    await expect(contextDonut).toBeVisible();
    await contextDonut.click();
    await expect(sidePanel.getByRole('button', { name: 'Compact now' })).toBeVisible();

    await setExtensionStorage(sidePanel, {
      [PENDING_DRAFT_KEY]: {
        createdAt: 1_700_000_000_000,
        pageTitle: 'Docs page',
        pageUrl: 'https://docs.example.com/guide',
        text: 'Stacking check draft for memory overlay.',
      },
    });

    const card = sidePanel.getByRole('dialog', { name: 'Add to memory' });
    await expect(card).toBeVisible();

    // Card (z-[25]) must be the topmost interactive layer above the z-20 popover.
    const stacking = await sidePanel.evaluate(() => {
      const memoryCard = document.querySelector('[aria-label="Add to memory"]');
      const compactButton = [...document.querySelectorAll('button')].find(
        button => button.textContent?.trim() === 'Compact now'
      );
      if (!(memoryCard instanceof HTMLElement) || !(compactButton instanceof HTMLElement)) {
        return null;
      }

      const cardZ = Number.parseFloat(getComputedStyle(memoryCard).zIndex);
      // Walk up from the compact button to the elevated popover surface.
      let popover: HTMLElement | null = compactButton;
      let popoverZ = Number.NaN;
      while (popover !== null) {
        const zIndex = Number.parseFloat(getComputedStyle(popover).zIndex);
        if (Number.isFinite(zIndex) && zIndex > 0) {
          popoverZ = zIndex;
          break;
        }
        popover = popover.parentElement;
      }

      const cardBox = memoryCard.getBoundingClientRect();
      const sampleX = cardBox.left + cardBox.width / 2;
      const sampleY = cardBox.top + cardBox.height / 2;
      const topElement = document.elementFromPoint(sampleX, sampleY);
      const cardIsTopmost =
        topElement !== null && (memoryCard === topElement || memoryCard.contains(topElement));

      return {
        cardIsTopmost,
        cardZ,
        cardZAbovePopover: Number.isFinite(popoverZ) ? cardZ > popoverZ : false,
        popoverZ,
      };
    });

    expect(stacking).not.toBeNull();
    expect(stacking?.cardZAbovePopover).toBe(true);
    expect(stacking?.cardIsTopmost).toBe(true);

    // Card remains interactive above the popover.
    await expect(card.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await card.getByRole('button', { name: 'Cancel' }).click();
    await expect(card).toBeHidden();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
