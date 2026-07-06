/* eslint-disable import/no-nodejs-modules */
import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { expectEvalToolBoxNoHorizontalOverflow } from './eval-overflow-fixture';
import { mockKiloApi } from './kilo-api-fixture';
import {
  extensionPath,
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
  waitForStoredConversationText,
} from './extension-context-fixture';

const extensionManifestSchema = z.object({
  action: z.object({ default_popup: z.string().optional() }).optional(),
  content_scripts: z.array(z.unknown()).optional(),
  host_permissions: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),
  side_panel: z.object({ default_path: z.string().optional() }).optional(),
});
type ExtensionManifest = z.infer<typeof extensionManifestSchema>;

const requireBoundingBox = async (
  locator: Locator
): Promise<{ height: number; left: number; top: number; width: number }> => {
  const boundingBox = await locator.boundingBox();

  if (boundingBox === null) {
    throw new Error('Expected locator to have a bounding box.');
  }

  return {
    height: boundingBox.height,
    left: boundingBox.x,
    top: boundingBox.y,
    width: boundingBox.width,
  };
};

const expectNonErrorToolPanel = async (locator: Locator): Promise<void> => {
  const className = await locator.evaluate(element => element.getAttribute('class') ?? '');
  const panelColors = await locator.evaluate(element => {
    const style = getComputedStyle(element);

    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
    };
  });

  expect(className).not.toContain('red-');
  expect(panelColors.borderColor).not.toContain('239, 68, 68');
  expect(panelColors.backgroundColor).not.toContain('69, 10, 10');
};

const readOutputManifest = async (): Promise<ExtensionManifest> => {
  const manifestText = await readFile(join(extensionPath, 'manifest.json'), 'utf8');
  const manifest = extensionManifestSchema.safeParse(JSON.parse(manifestText));

  if (!manifest.success) {
    throw new TypeError('Extension manifest was not an object.');
  }

  return manifest.data;
};

test('native side panel is outside the page DOM', async () => {
  const manifest = await readOutputManifest();
  expect(manifest.side_panel?.default_path).toBe('sidepanel.html');
  expect(manifest.host_permissions).toContain('file:///*');
  expect(manifest.host_permissions).toContain('https://app.kilo.ai/*');
  expect(manifest.permissions).toContain('debugger');
  expect(manifest.permissions).toContain('sidePanel');
  expect(manifest.action?.default_popup).toBeUndefined();
  expect(manifest.content_scripts).toBeUndefined();

  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    const page = await context.newPage();
    await page.goto(fixture.url);

    await expect(page.locator('kilo-sidebar')).toHaveCount(0);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await expect(sidePanel.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(sidePanel.getByText('No actions yet')).toBeHidden();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('dangerous mode conversation can eval against a normal tab', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await expect(sidePanel.getByLabel('Settings')).toBeVisible();
    await expect(sidePanel.getByText('user@kilo.ai')).toBeHidden();
    await sidePanel.getByLabel('Settings').click();
    await expect(sidePanel.getByText('user@kilo.ai')).toBeVisible();
    await sidePanel.getByLabel('Close settings').click();
    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo extension fixture');

    await sidePanel.getByRole('button', { name: /Safe mode/u }).click();
    await sidePanel.getByRole('button', { name: 'Dangerous' }).click();
    const messageInput = sidePanel.getByLabel('Message agent');
    await messageInput.fill('Inspect this tab');
    await messageInput.press('Shift+Enter');
    await expect(messageInput).toHaveValue('Inspect this tab\n');
    await messageInput.fill('Inspect this tab and tell me the HTML length');
    await messageInput.press('Enter');

    await expect(sidePanel.getByText('eval completed')).toBeVisible();
    await expect(sidePanel.getByText('Code')).toBeHidden();
    await expect(sidePanel.getByText(/The selected tab HTML length is [0-9]+\./u)).toBeVisible();
    const evalPanel = sidePanel.getByText('eval completed').locator('xpath=ancestor::details[1]');
    await expectNonErrorToolPanel(evalPanel);
    const evalBox = sidePanel.getByText('eval completed').locator('..');
    const evalBoxRect = await requireBoundingBox(evalBox);

    await sidePanel.mouse.click(evalBoxRect.left + 4, evalBoxRect.top + 4);
    await expect(sidePanel.getByText('Code')).toBeVisible();
    await expectEvalToolBoxNoHorizontalOverflow(sidePanel);

    await sidePanel.getByLabel('New conversation').click();
    await expect(sidePanel.getByText('eval completed')).toBeHidden();
    await expect(sidePanel.getByText('Pick a tab and ask Kilo to inspect it.')).toBeVisible();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('running conversation can be stopped', async () => {
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

    await sidePanel.getByRole('button', { name: /Safe mode/u }).click();
    await sidePanel.getByRole('button', { name: 'Dangerous' }).click();
    const modeButton = sidePanel.getByRole('button', { name: /Danger mode/u });
    const targetTabSelect = sidePanel.getByLabel('Target tab');
    await expect(modeButton).toBeEnabled();
    await expect(targetTabSelect).toBeEnabled();
    await sidePanel.getByLabel('Message agent').fill('Inspect this tab');
    const sendButton = sidePanel.getByRole('button', { name: 'Send message' });
    const sendButtonRect = await sendButton.boundingBox();

    expect(sendButtonRect).not.toBeNull();
    await sidePanel.getByLabel('Message agent').press('Enter');

    const stopButton = sidePanel.getByRole('button', { name: 'Stop' });
    await expect(stopButton).toBeVisible();
    await expect(modeButton).toBeDisabled();
    await expect(targetTabSelect).toBeDisabled();
    const stopButtonRect = await stopButton.boundingBox();

    expect(stopButtonRect).toEqual(sendButtonRect);
    await stopButton.click();

    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeVisible();
    await expect(modeButton).toBeEnabled();
    await expect(targetTabSelect).toBeEnabled();
    await expect(sidePanel.getByText('Stopped.')).toBeVisible();
  } finally {
    releaseCompletion();
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('target tab list updates automatically', async () => {
  const fixture = await startFixtureServer();
  const refreshedFixture = await startFixtureServer({ title: 'Refreshed target tab' });
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo extension fixture');
    const refreshedPage = await context.newPage();
    await refreshedPage.goto(refreshedFixture.url);
    await expect(
      sidePanel.getByLabel('Target tab').locator('option', { hasText: 'Refreshed target tab' })
    ).toHaveCount(1);
  } finally {
    await context.close();
    await fixture.close();
    await refreshedFixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('closing the selected tab clears the target tab selection', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await expect(sidePanel.getByLabel('Target tab')).toContainText('Kilo extension fixture');
    await page.close();
    await expect(sidePanel.getByLabel('Target tab')).toContainText('No tab selected');
    await sidePanel.getByLabel('Message agent').fill('Inspect the closed tab');
    await expect(sidePanel.getByRole('button', { name: 'Send message' })).toBeDisabled();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('conversation survives side panel reload', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);

    const page = await context.newPage();
    await page.goto(fixture.url);

    const sidePanel = await context.newPage();
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    await sidePanel.getByRole('button', { name: /Safe mode/u }).click();
    await sidePanel.getByRole('button', { name: 'Dangerous' }).click();
    await sidePanel.getByLabel('Message agent').fill('Remember this after reload');
    await sidePanel.getByLabel('Message agent').press('Enter');
    await expect(
      sidePanel.getByLabel('Agent conversation').getByText('Remember this after reload')
    ).toBeVisible();
    await waitForStoredConversationText(sidePanel, 'Remember this after reload');

    await sidePanel.reload();

    await expect(
      sidePanel.getByLabel('Agent conversation').getByText('Remember this after reload')
    ).toBeVisible();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
