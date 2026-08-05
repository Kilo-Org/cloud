/* eslint-disable import/no-nodejs-modules, jest/no-conditional-in-test */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { launchExtensionContext, seedExtensionAuth } from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';
import { selectModelById } from './model-picker-e2e-helpers';

const catalog = [
  {
    id: 'stepfun/step-3.7-flash',
    isFree: true,
    name: 'StepFun: Step 3.7 Flash (free)',
    preferredIndex: 0,
    variants: { high: {}, instant: {}, low: {}, medium: {}, xhigh: {} },
  },
  {
    id: 'short/alpha',
    name: 'Alpha',
    variants: { high: {}, instant: {}, low: {}, medium: {}, xhigh: {} },
  },
  {
    id: 'short/beta',
    name: 'Beta',
    variants: { high: {}, instant: {}, low: {}, medium: {}, xhigh: {} },
  },
];

const assertLayoutAtWidth = async (
  sidePanel: Page,
  width: number,
  runTruncationChecks: boolean
): Promise<void> => {
  await sidePanel.setViewportSize({ height: 800, width });
  await sidePanel.waitForTimeout(100);

  const modeButton = sidePanel.getByLabel(/mode: /u);
  const modelButton = sidePanel.getByLabel('Model');
  const effortSelect = sidePanel.getByLabel('Thinking effort');
  const donut = sidePanel.getByLabel(/^Context usage:/u);
  const wrapper = modelButton.locator('xpath=..');
  const row = modelButton.locator('xpath=../..');

  const modeBox = await modeButton.boundingBox();
  const modelBox = await modelButton.boundingBox();
  const effortBox = await effortSelect.boundingBox();
  const donutBox = await donut.boundingBox();
  const wrapperBox = await wrapper.boundingBox();
  const rowBox = await row.boundingBox();

  expect(modeBox).not.toBeNull();
  expect(modelBox).not.toBeNull();
  expect(effortBox).not.toBeNull();
  expect(donutBox).not.toBeNull();
  expect(wrapperBox).not.toBeNull();
  expect(rowBox).not.toBeNull();

  if (!modeBox || !modelBox || !effortBox || !donutBox || !wrapperBox || !rowBox) {
    return;
  }

  const modeRight = modeBox.x + modeBox.width;
  const modelRight = modelBox.x + modelBox.width;
  const effortRight = effortBox.x + effortBox.width;

  // No overlap between consecutive controls (mode → model → effort → donut)
  expect(modeRight).toBeLessThanOrEqual(modelBox.x + 0.5);
  expect(modelRight).toBeLessThanOrEqual(effortBox.x + 0.5);
  expect(effortRight).toBeLessThanOrEqual(donutBox.x + 0.5);

  // Model trigger button does not overflow its wrapper
  expect(modelRight).toBeLessThanOrEqual(wrapperBox.x + wrapperBox.width + 0.5);

  // Donut summary is inside the model-controls row
  expect(donutBox.y).toBeGreaterThanOrEqual(rowBox.y - 0.5);
  expect(donutBox.y + donutBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height + 0.5);

  // Single row at 560px: all four controls' tops within 1px
  if (width === 560) {
    const tops = [modeBox.y, modelBox.y, effortBox.y, donutBox.y];
    const maxTop = Math.max(...tops);
    const minTop = Math.min(...tops);
    expect(maxTop - minTop).toBeLessThanOrEqual(1);
  }

  // 320px: model label truncates and effort label is fully readable
  if (runTruncationChecks) {
    const isTruncated = await modelButton
      .locator('span.truncate')
      .evaluate(element => element.scrollWidth > element.clientWidth);
    expect(isTruncated).toBe(true);

    const readableAreaFits = await effortSelect.evaluate(async select => {
      if (!(select instanceof HTMLSelectElement)) {
        return false;
      }

      const label = select.selectedOptions[0]?.textContent ?? '';
      await document.fonts.ready;
      const style = getComputedStyle(select);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');

      if (!context) {
        return false;
      }

      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

      return (
        context.measureText(label).width <=
        select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      );
    });
    expect(readableAreaFits).toBe(true);
  }

  // Donut opens its popover and closes on a second summary click
  await donut.click();
  await expect(sidePanel.getByRole('button', { name: 'Compact now' })).toBeVisible();
  await donut.click();
  await expect(sidePanel.getByRole('button', { name: 'Compact now' })).toHaveCount(0);
};

test('footer controls never overlap from 320px through 560px', async () => {
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, { models: [...catalog] });

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await selectModelById(sidePanel, 'stepfun/step-3.7-flash');
    await sidePanel.getByLabel('Thinking effort').selectOption('low');

    await assertLayoutAtWidth(sidePanel, 320, true);
    await assertLayoutAtWidth(sidePanel, 400, false);
    await assertLayoutAtWidth(sidePanel, 560, false);

    // Repeat 320px assertions with "instant" (the longest emitted label: "Instant", 7 chars)
    await sidePanel.getByLabel('Thinking effort').selectOption('instant');
    await assertLayoutAtWidth(sidePanel, 320, true);
  } finally {
    await context.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
