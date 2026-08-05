/* eslint-disable import/no-nodejs-modules, jest/no-conditional-in-test, max-lines */
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import {
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';
import { expectSelectedModelId, selectModelById } from './model-picker-e2e-helpers';

const orgOneId = 'org-1';

const defaultVariants = { high: {}, low: {}, medium: {} } as const;

const catalogModels = [
  {
    id: 'preferred/alpha',
    isFree: true,
    name: 'Provider: Preferred Alpha',
    preferredIndex: 0,
    variants: defaultVariants,
  },
  {
    hasUserByokAvailable: true,
    id: 'byok/beta',
    name: 'Provider: Byok Beta',
    variants: defaultVariants,
  },
  {
    id: 'train/gamma',
    mayTrainOnYourPrompts: true,
    name: 'Provider: Train Gamma',
    variants: defaultVariants,
  },
  {
    id: 'plain/delta',
    name: 'Provider: Plain Delta',
    variants: defaultVariants,
  },
] as const;

const modelDialog = (sidePanel: Page): Locator =>
  sidePanel.locator('[role="dialog"][aria-modal="true"][aria-label="Select model"]');

const openModelPicker = async (sidePanel: Page): Promise<Locator> => {
  await sidePanel.getByLabel('Model').click();
  const dialog = modelDialog(sidePanel);
  await expect(dialog).toBeVisible();
  return dialog;
};

const closeModelPicker = async (sidePanel: Page): Promise<void> => {
  await sidePanel.getByLabel('Close model picker').click();
  await expect(modelDialog(sidePanel)).toHaveCount(0);
};

const sectionHeadersInOrder = async (dialog: Locator): Promise<string[]> => {
  const titles = await dialog.locator('p.type-eyebrow').allTextContents();
  return titles.map(title => title.trim());
};

const sectionHeader = (dialog: Locator, title: string): Locator =>
  dialog.locator('p.type-eyebrow', { hasText: new RegExp(`^${title}$`, 'u') });

/** Nearest preceding `p.type-eyebrow` section title for a model row, or null if absent. */
const sectionTitleForModel = (dialog: Locator, modelId: string): Promise<string | null> =>
  dialog.evaluate((root, id) => {
    const row = root.querySelector(`[data-model-row="${CSS.escape(id)}"]`);

    if (!row) {
      return null;
    }

    // Rows are wrapped in a keyed div; headers and wrappers are siblings in the list.
    let sibling: Element | null = row.parentElement?.previousElementSibling ?? null;

    while (sibling) {
      if (sibling.matches('p.type-eyebrow')) {
        return sibling.textContent?.trim() ?? null;
      }

      sibling = sibling.previousElementSibling;
    }

    return null;
  }, modelId);

const withSidePanel = async (
  run: (sidePanel: Page) => Promise<void>,
  mockOptions: Parameters<typeof mockKiloApi>[1] = {}
): Promise<void> => {
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, mockOptions);
    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();
    await run(sidePanel);
  } finally {
    await context.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
};

test('happy path selects a model and marks it current on reopen', async () => {
  await withSidePanel(
    async sidePanel => {
      await expect(sidePanel.getByLabel('Model')).toBeEnabled();

      const dialog = await openModelPicker(sidePanel);
      await expect(sectionHeader(dialog, 'RECOMMENDED')).toBeVisible();
      await expect(sectionHeader(dialog, 'ALL MODELS')).toBeVisible();
      expect(await sectionHeadersInOrder(dialog)).toStrictEqual(['RECOMMENDED', 'ALL MODELS']);

      await closeModelPicker(sidePanel);
      await selectModelById(sidePanel, 'plain/delta');
      await expectSelectedModelId(sidePanel, 'plain/delta');

      const reopened = await openModelPicker(sidePanel);
      await expect(reopened.locator('button[data-model-id="plain/delta"]')).toHaveAttribute(
        'aria-current',
        'true'
      );
    },
    { models: [...catalogModels] }
  );
});

test('row chrome shows Free, BYOK, and Data collected markers', async () => {
  await withSidePanel(
    async sidePanel => {
      const dialog = await openModelPicker(sidePanel);

      const freeRow = dialog.locator('[data-model-row="preferred/alpha"]');
      await expect(freeRow.getByText('Free', { exact: true })).toBeVisible();
      await expect(freeRow.getByText('BYOK', { exact: true })).toHaveCount(0);

      const byokRow = dialog.locator('[data-model-row="byok/beta"]');
      await expect(byokRow.getByText('BYOK', { exact: true })).toBeVisible();
      await expect(byokRow.getByText('Free', { exact: true })).toHaveCount(0);

      const trainRow = dialog.locator('[data-model-row="train/gamma"]');
      await expect(trainRow.getByRole('img', { name: 'Data collected' })).toBeVisible();
    },
    { models: [...catalogModels] }
  );
});

test('search filters by name and id case-insensitively', async () => {
  await withSidePanel(
    async sidePanel => {
      const dialog = await openModelPicker(sidePanel);
      const search = dialog.getByLabel('Search models');

      await search.fill('PLAIN DELTA');
      await expect(dialog.locator('button[data-model-id="plain/delta"]')).toBeVisible();
      await expect(dialog.locator('button[data-model-id="preferred/alpha"]')).toHaveCount(0);
      await expect(dialog.locator('button[data-model-id="byok/beta"]')).toHaveCount(0);
      expect(await sectionHeadersInOrder(dialog)).toStrictEqual(['ALL MODELS']);

      await search.fill('TRAIN/GAMMA');
      await expect(dialog.locator('button[data-model-id="train/gamma"]')).toBeVisible();
      await expect(dialog.locator('button[data-model-id="plain/delta"]')).toHaveCount(0);
      expect(await sectionHeadersInOrder(dialog)).toStrictEqual(['ALL MODELS']);

      await search.fill('preferred');
      await expect(dialog.locator('button[data-model-id="preferred/alpha"]')).toBeVisible();
      expect(await sectionHeadersInOrder(dialog)).toStrictEqual(['RECOMMENDED']);
    },
    { models: [...catalogModels] }
  );
});

test('no-match empty state clears search and restores rows', async () => {
  await withSidePanel(
    async sidePanel => {
      const dialog = await openModelPicker(sidePanel);
      const search = dialog.getByLabel('Search models');
      const query = 'zzzz-no-such-model';

      await search.fill(query);
      await expect(dialog.getByText(`No models match "${query}".`)).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Clear search' })).toBeVisible();
      await expect(dialog.locator('button[data-model-id]')).toHaveCount(0);

      await dialog.getByRole('button', { name: 'Clear search' }).click();
      await expect(search).toHaveValue('');
      await expect(dialog.locator('button[data-model-id="preferred/alpha"]')).toBeVisible();
      await expect(dialog.locator('button[data-model-id="plain/delta"]')).toBeVisible();
      await expect(dialog.getByText(`No models match "${query}".`)).toHaveCount(0);
    },
    { models: [...catalogModels] }
  );
});

test('favorites toggle is stateful across overlay close and reopen', async () => {
  await withSidePanel(
    async sidePanel => {
      const dialog = await openModelPicker(sidePanel);
      await expect(sectionHeader(dialog, 'FAVORITES')).toHaveCount(0);
      expect(await sectionTitleForModel(dialog, 'plain/delta')).toBe('ALL MODELS');

      const star = dialog.getByLabel('Add Plain Delta to favorites');
      await expect(star).toBeEnabled();
      await expect(star).toHaveAttribute('aria-pressed', 'false');
      await star.click();

      await expect(sectionHeader(dialog, 'FAVORITES')).toBeVisible();
      await expect(dialog.getByLabel('Remove Plain Delta from favorites')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(await sectionHeadersInOrder(dialog)).toStrictEqual([
        'FAVORITES',
        'RECOMMENDED',
        'ALL MODELS',
      ]);
      // Placement: starred row moves under FAVORITES and leaves ALL MODELS.
      await expect(dialog.locator('[data-model-row="plain/delta"]')).toHaveCount(1);
      expect(await sectionTitleForModel(dialog, 'plain/delta')).toBe('FAVORITES');

      await closeModelPicker(sidePanel);

      const reopened = await openModelPicker(sidePanel);
      await expect(sectionHeader(reopened, 'FAVORITES')).toBeVisible();
      await expect(reopened.getByLabel('Remove Plain Delta from favorites')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      await expect(reopened.locator('[data-model-row="plain/delta"]')).toHaveCount(1);
      expect(await sectionTitleForModel(reopened, 'plain/delta')).toBe('FAVORITES');

      await reopened.getByLabel('Remove Plain Delta from favorites').click();
      await expect(sectionHeader(reopened, 'FAVORITES')).toHaveCount(0);
      await expect(reopened.getByLabel('Add Plain Delta to favorites')).toHaveAttribute(
        'aria-pressed',
        'false'
      );
      expect(await sectionTitleForModel(reopened, 'plain/delta')).toBe('ALL MODELS');
    },
    { models: [...catalogModels] }
  );
});

test('retryable favorites load failure shows Retry and keeps selection working', async () => {
  await withSidePanel(
    async sidePanel => {
      const dialog = await openModelPicker(sidePanel);
      await expect(dialog.getByText("Couldn't load favorites.")).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Retry' })).toBeVisible();
      await expect(dialog.locator('button[data-model-id="plain/delta"]')).toBeVisible();

      await closeModelPicker(sidePanel);
      await selectModelById(sidePanel, 'plain/delta');
      await expectSelectedModelId(sidePanel, 'plain/delta');

      const reopened = await openModelPicker(sidePanel);
      await expect(reopened.getByText("Couldn't load favorites.")).toBeVisible();
      await reopened.getByRole('button', { name: 'Retry' }).click();
      await expect(reopened.getByText("Couldn't load favorites.")).toHaveCount(0);
      await expect(reopened.getByRole('button', { name: 'Retry' })).toHaveCount(0);
      await expect(reopened.getByLabel('Add Plain Delta to favorites')).toBeVisible();
    },
    {
      modelPreferencesGetFailuresBeforeSuccess: 1,
      models: [...catalogModels],
    }
  );
});

test('terminal favorites forbidden hides stars and has no Retry', async () => {
  await withSidePanel(
    async sidePanel => {
      const dialog = await openModelPicker(sidePanel);
      await expect(dialog.getByText("Favorites aren't available here.")).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Retry' })).toHaveCount(0);
      await expect(dialog.locator('button[aria-pressed]')).toHaveCount(0);

      await closeModelPicker(sidePanel);
      await selectModelById(sidePanel, 'byok/beta');
      await expectSelectedModelId(sidePanel, 'byok/beta');
    },
    {
      modelPreferencesGetStatus: 403,
      models: [...catalogModels],
    }
  );
});

test('favorite toggle failure rolls back and succeeds on retry', async () => {
  await withSidePanel(
    async sidePanel => {
      const dialog = await openModelPicker(sidePanel);
      const star = dialog.getByLabel('Add Plain Delta to favorites');
      await expect(star).toBeEnabled();
      await star.click();

      await expect(dialog.getByText("Couldn't update favorites.")).toBeVisible();
      await expect(sectionHeader(dialog, 'FAVORITES')).toHaveCount(0);
      await expect(dialog.getByLabel('Add Plain Delta to favorites')).toHaveAttribute(
        'aria-pressed',
        'false'
      );

      await dialog.getByLabel('Add Plain Delta to favorites').click();
      await expect(dialog.getByText("Couldn't update favorites.")).toHaveCount(0);
      await expect(sectionHeader(dialog, 'FAVORITES')).toBeVisible();
      await expect(dialog.getByLabel('Remove Plain Delta from favorites')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
    },
    {
      modelPreferencesMutationFailuresBeforeSuccess: 1,
      models: [...catalogModels],
    }
  );
});

test('empty catalog keeps the trigger disabled and the dialog closed', async () => {
  await withSidePanel(
    async sidePanel => {
      const trigger = sidePanel.getByLabel('Model');
      await expect(trigger).toBeDisabled();
      await expect(trigger).toContainText('Loading models...');

      await trigger.click({ force: true });
      await expect(modelDialog(sidePanel)).toHaveCount(0);
    },
    { models: [] }
  );
});

test('model preferences get omits input until an organization is selected', async () => {
  const seenModelPreferencesGetUrls: string[] = [];
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      models: [...catalogModels],
      organizations: [{ id: orgOneId, name: 'Acme' }],
      seenModelPreferencesGetUrls,
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await expect(sidePanel.getByLabel('Model')).toBeEnabled();
    await expect.poll(() => seenModelPreferencesGetUrls.length).toBeGreaterThan(0);

    const personalUrls = [...seenModelPreferencesGetUrls];
    for (const url of personalUrls) {
      expect(new URL(url).searchParams.has('input')).toBe(false);
    }

    const urlsBeforeOrg = seenModelPreferencesGetUrls.length;
    await sidePanel.getByLabel('Settings').click();
    await sidePanel.getByLabel('Credit account').selectOption(orgOneId);
    await sidePanel.getByLabel('Close settings').click();

    await expect.poll(() => seenModelPreferencesGetUrls.length).toBeGreaterThan(urlsBeforeOrg);

    const orgEncodedInput = encodeURIComponent(JSON.stringify({ organizationId: orgOneId }));
    const orgUrls = seenModelPreferencesGetUrls.slice(urlsBeforeOrg);
    expect(orgUrls.some(url => url.includes(`input=${orgEncodedInput}`))).toBe(true);
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('selected model near the end of a long catalog scrolls into view on open', async () => {
  const longCatalog = Array.from({ length: 60 }, (_slot, index) => {
    const ordinal = String(index + 1).padStart(2, '0');

    return {
      id: `long/model-${ordinal}`,
      name: `Provider: Long Model ${ordinal}`,
      variants: defaultVariants,
      ...(index === 0 ? { preferredIndex: 0 } : {}),
    };
  });
  const targetId = 'long/model-55';

  await withSidePanel(
    async sidePanel => {
      await selectModelById(sidePanel, targetId);
      await expectSelectedModelId(sidePanel, targetId);

      const dialog = await openModelPicker(sidePanel);
      const selected = dialog.locator('button[aria-current="true"][data-model-id]');
      await expect(selected).toHaveAttribute('data-model-id', targetId);

      const isInView = await selected.evaluate((row, dialogLabel) => {
        const dialogElement = document.querySelector(
          `[role="dialog"][aria-modal="true"][aria-label="${dialogLabel}"]`
        );

        if (!(dialogElement instanceof HTMLElement) || !(row instanceof HTMLElement)) {
          return false;
        }

        const rowBox = row.getBoundingClientRect();
        const dialogBox = dialogElement.getBoundingClientRect();

        return (
          rowBox.top >= dialogBox.top - 1 &&
          rowBox.bottom <= dialogBox.bottom + 1 &&
          rowBox.left >= dialogBox.left - 1 &&
          rowBox.right <= dialogBox.right + 1
        );
      }, 'Select model');

      expect(isInView).toBe(true);
    },
    { models: longCatalog }
  );
});
