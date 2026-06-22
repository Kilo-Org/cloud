/* eslint-disable import/no-nodejs-modules, promise/avoid-new, promise/prefer-await-to-callbacks */
import { chromium, expect, test } from '@playwright/test';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import type { BrowserContext } from '@playwright/test';

const extensionPath = resolvePath(import.meta.dirname, '../../.output/chrome-mv3');

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

const startFixtureServer = async (): Promise<{ close: () => Promise<void>; url: string }> => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`
      <!doctype html>
      <html>
        <head><title>Kilo extension fixture</title></head>
        <body>
          <main>
            <h1>Kilo extension fixture page</h1>
            <p>This page exists so content scripts run in a normal HTTP tab.</p>
          </main>
        </body>
      </html>
    `);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Fixture server did not start on a TCP port.');
  }

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
    url: `http://127.0.0.1:${address.port}`,
  };
};

const launchExtensionContext = async (): Promise<{
  context: BrowserContext;
  extensionId: string;
  userDataDir: string;
}> => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'kilo-extension-e2e-'));
  await access(join(extensionPath, 'manifest.json'));

  const context = await chromium.launchPersistentContext(userDataDir, {
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    headless: false,
  });

  const [existingServiceWorker] = context.serviceWorkers();
  const serviceWorker = existingServiceWorker ?? (await context.waitForEvent('serviceworker'));

  const extensionId = new URL(serviceWorker.url()).host;

  return { context, extensionId, userDataDir };
};

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
