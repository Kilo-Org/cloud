/* eslint-disable import/no-nodejs-modules */
import { expect, test } from '@playwright/test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  expectEvalCodeBlockNoHorizontalOverflow,
  mockKiloApi,
  readSidePanelScrollState,
  sendOverflowMessages,
} from './kilo-api-fixture';
import {
  extensionPath,
  launchExtensionContext,
  seedExtensionAuth,
  startFixtureServer,
} from './extension-context-fixture';

interface ExtensionManifest {
  readonly action:
    | {
        readonly default_popup: string | undefined;
      }
    | undefined;
  readonly content_scripts: unknown[] | undefined;
  readonly host_permissions: string[] | undefined;
  readonly permissions: string[] | undefined;
  readonly side_panel:
    | {
        readonly default_path: string | undefined;
      }
    | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const getStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    return undefined;
  }

  return value;
};

const getAction = (value: unknown): ExtensionManifest['action'] => {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    default_popup: typeof value['default_popup'] === 'string' ? value['default_popup'] : undefined,
  };
};

const getSidePanel = (value: unknown): ExtensionManifest['side_panel'] => {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    default_path: typeof value['default_path'] === 'string' ? value['default_path'] : undefined,
  };
};

const readOutputManifest = async (): Promise<ExtensionManifest> => {
  const manifestText = await readFile(join(extensionPath, 'manifest.json'), 'utf8');
  const manifest: unknown = JSON.parse(manifestText);

  if (!isRecord(manifest)) {
    throw new TypeError('Extension manifest was not an object.');
  }

  return {
    action: getAction(manifest['action']),
    content_scripts: Array.isArray(manifest['content_scripts'])
      ? manifest['content_scripts']
      : undefined,
    host_permissions: getStringArray(manifest['host_permissions']),
    permissions: getStringArray(manifest['permissions']),
    side_panel: getSidePanel(manifest['side_panel']),
  };
};

test('native side panel is outside the page DOM', async () => {
  const manifest = await readOutputManifest();
  expect(manifest.side_panel?.default_path).toBe('sidepanel.html');
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
    await sidePanel.getByLabel('Settings').click();
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
    await sidePanel.getByText('eval completed').click();
    await expect(sidePanel.getByText('Code')).toBeVisible();
    await expectEvalCodeBlockNoHorizontalOverflow(sidePanel);

    await sidePanel.getByLabel('New conversation').click();
    await expect(sidePanel.getByText('eval completed')).toBeHidden();
    await expect(sidePanel.getByText('Pick a tab, switch to dangerous mode')).toBeVisible();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});

test('only the message pane scrolls overflowing conversation content', async () => {
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    await mockKiloApi(context);

    const sidePanel = await context.newPage();
    await sidePanel.setViewportSize({ height: 420, width: 360 });
    await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await seedExtensionAuth(sidePanel);
    await sidePanel.reload();

    const messageInput = sidePanel.getByLabel('Message agent');
    await sendOverflowMessages(messageInput, 40);

    await expect(sidePanel.getByText('Pick a target tab first.').last()).toBeVisible();
    await expect(sidePanel.getByLabel('Agent conversation')).toBeVisible();

    const scrollState = await sidePanel.evaluate(readSidePanelScrollState);

    expect(scrollState.documentScrollHeight).toBe(scrollState.documentClientHeight);
    expect(scrollState.messagePaneScrollHeight).toBeGreaterThan(
      scrollState.messagePaneClientHeight
    );
    expect(
      scrollState.messagePaneScrollTop + scrollState.messagePaneClientHeight
    ).toBeGreaterThanOrEqual(scrollState.messagePaneScrollHeight - 4);
  } finally {
    await context.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
