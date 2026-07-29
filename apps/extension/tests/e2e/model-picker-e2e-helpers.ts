import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const modelDialog = (sidePanel: Page) =>
  sidePanel.locator('[role="dialog"][aria-modal="true"][aria-label="Select model"]');

export const selectModelById = async (sidePanel: Page, modelId: string): Promise<void> => {
  await sidePanel.getByLabel('Model').click();

  const dialog = modelDialog(sidePanel);
  const option = dialog.locator(`button[data-model-id="${modelId}"]`);

  await expect(option).toBeVisible({ timeout: 30_000 });
  await option.click();
  await expect(dialog).toHaveCount(0);
};

export const expectSelectedModelId = async (sidePanel: Page, modelId: string): Promise<void> => {
  await expect(sidePanel.getByLabel('Model')).toHaveAttribute('data-model-id', modelId);
};
