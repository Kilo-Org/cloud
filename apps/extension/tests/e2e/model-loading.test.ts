/* eslint-disable import/no-nodejs-modules */
import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import {
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';
import { mockKiloApi } from './kilo-api-fixture';

const orgOneId = 'org-1';
const orgTwoId = 'org-2';

const delaySecondOrgOneModelRequest = ({
  pendingOrgOneModels,
  markOrgOneModelsRequested,
}: {
  markOrgOneModelsRequested: () => void;
  pendingOrgOneModels: Promise<void>;
}): ((organizationId: string) => Promise<void>) => {
  let orgOneModelCalls = 0;

  return organizationId => {
    if (organizationId !== orgOneId) {
      return Promise.resolve();
    }

    orgOneModelCalls += 1;

    if (orgOneModelCalls === 2) {
      markOrgOneModelsRequested();
      return pendingOrgOneModels;
    }

    return Promise.resolve();
  };
};

const delayOrgTwoModels =
  ({
    markOrgTwoModelsRequested,
    pendingOrgTwoModels,
  }: {
    markOrgTwoModelsRequested: () => void;
    pendingOrgTwoModels: Promise<void>;
  }): ((organizationId: string) => Promise<void>) =>
  organizationId => {
    if (organizationId !== orgTwoId) {
      return Promise.resolve();
    }

    markOrgTwoModelsRequested();
    return pendingOrgTwoModels;
  };

const markSecondOrgOneModelResponse = (markOrgOneModelsFulfilled: () => void) => {
  let orgOneModelResponses = 0;

  return (organizationId: string): void => {
    if (organizationId !== orgOneId) {
      return;
    }

    orgOneModelResponses += 1;
    if (orgOneModelResponses === 2) {
      markOrgOneModelsFulfilled();
    }
  };
};

test('model and thinking controls wait for the model catalog', async () => {
  const { promise: pendingModels, resolve: releaseModels } = Promise.withResolvers<void>();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      beforeModels: () => pendingModels,
    });

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await expect(sidePanel.getByLabel('Model')).toBeDisabled();
    await expect(sidePanel.getByLabel('Model')).toContainText('Loading models...');
    await expect(sidePanel.getByLabel('Thinking effort')).toBeDisabled();
    await sidePanel.getByLabel('Message agent').fill('Inspect this tab');
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeDisabled();

    releaseModels();

    await expect(sidePanel.getByLabel('Model')).toBeEnabled();
    await expect(sidePanel.getByLabel('Model')).toContainText('Claude Sonnet 4');
    await expect(sidePanel.getByLabel('Thinking effort')).toBeEnabled();
  } finally {
    releaseModels();
    await context.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('model catalog failures can be retried', async () => {
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      modelFailuresBeforeSuccess: 1,
    });

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await expect(sidePanel.getByText('Could not load models.')).toBeVisible();
    await expect(sidePanel.getByLabel('Model')).toBeDisabled();

    await sidePanel.getByRole('button', { name: 'Retry models' }).click();

    await expect(sidePanel.getByLabel('Model')).toBeEnabled();
    await expect(sidePanel.getByLabel('Model')).toContainText('Claude Sonnet 4');
  } finally {
    await context.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('switching credit accounts clears the model while the next catalog loads', async () => {
  const fixture = await startFixtureServer();
  const { promise: pendingOrgTwoModels, resolve: releaseOrgTwoModels } =
    Promise.withResolvers<void>();
  const { promise: orgTwoModelsRequested, resolve: markOrgTwoModelsRequested } =
    Promise.withResolvers<void>();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      beforeModels: delayOrgTwoModels({
        markOrgTwoModelsRequested,
        pendingOrgTwoModels,
      }),
      modelNameByOrganizationId: {
        [orgTwoId]: 'Provider: Org Two Model',
      },
      organizations: [{ id: orgTwoId, name: 'Beta' }],
    });

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await expect(sidePanel.getByLabel('Model')).toContainText('Claude Sonnet 4');
    await sidePanel.getByLabel('Message agent').fill('Inspect this tab');
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeEnabled();

    await sidePanel.getByLabel('Settings').click();
    await sidePanel.getByLabel('Credit account').selectOption(orgTwoId);
    await orgTwoModelsRequested;
    await sidePanel.getByLabel('Close settings').click();

    await expect(sidePanel.getByLabel('Model')).toBeDisabled();
    await expect(sidePanel.getByLabel('Model')).toContainText('Loading models...');
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeDisabled();

    releaseOrgTwoModels();

    await expect(sidePanel.getByLabel('Model')).toContainText('Org Two Model');
  } finally {
    releaseOrgTwoModels();
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('stale organization model loads cannot overwrite the current catalog', async () => {
  const { promise: pendingOrgOneModels, resolve: releaseOrgOneModels } =
    Promise.withResolvers<void>();
  const { promise: orgOneModelsRequested, resolve: markOrgOneModelsRequested } =
    Promise.withResolvers<void>();
  const { promise: staleOrgOneModelsFulfilled, resolve: markStaleOrgOneModelsFulfilled } =
    Promise.withResolvers<void>();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context, {
      afterModels: markSecondOrgOneModelResponse(markStaleOrgOneModelsFulfilled),
      beforeModels: delaySecondOrgOneModelRequest({
        markOrgOneModelsRequested,
        pendingOrgOneModels,
      }),
      modelFailuresBeforeSuccessByOrganizationId: { [orgOneId]: 1 },
      modelNameByOrganizationId: {
        [orgOneId]: 'Provider: Org One Model',
        [orgTwoId]: 'Provider: Org Two Model',
      },
      organizations: [
        { id: orgOneId, name: 'Acme' },
        { id: orgTwoId, name: 'Beta' },
      ],
    });

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByLabel('Settings').click();
    await sidePanel.getByLabel('Credit account').selectOption(orgOneId);
    await sidePanel.getByLabel('Close settings').click();
    await expect(sidePanel.getByText('Could not load models.')).toBeVisible();
    await sidePanel.getByRole('button', { name: 'Retry models' }).click();
    await orgOneModelsRequested;
    await sidePanel.getByLabel('Settings').click();
    await sidePanel.getByLabel('Credit account').selectOption(orgTwoId);
    await sidePanel.getByLabel('Close settings').click();
    await expect(sidePanel.getByLabel('Model')).toContainText('Org Two Model');

    releaseOrgOneModels();
    await staleOrgOneModelsFulfilled;

    await expect(sidePanel.getByLabel('Model')).toContainText('Org Two Model');
  } finally {
    releaseOrgOneModels();
    await context.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
