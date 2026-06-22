/* eslint-disable import/no-nodejs-modules, promise/avoid-new, promise/prefer-await-to-callbacks */
import { chromium, expect, test } from '@playwright/test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';

const extensionPath = resolvePath(import.meta.dirname, '../../.output/chrome-mv3');

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

const getSidebar = (page: Page) => page.locator('kilo-sidebar aside');

test('popup toggles the full-height sidebar on a normal page', async () => {
  const fixture = await startFixtureServer();
  const { context, extensionId, userDataDir } = await launchExtensionContext();

  try {
    const page = await context.newPage();
    await page.goto(fixture.url);

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.getByRole('button', { name: 'Show sidebar' }).click();
    await expect(popup.getByText('Sidebar visible')).toBeVisible();

    const sidebar = getSidebar(page);
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveCSS('position', 'fixed');
    await expect(sidebar).toHaveCSS('right', '0px');
    await expect(sidebar).toHaveCSS('top', '0px');

    await popup.getByRole('button', { name: 'Hide sidebar' }).click();
    await expect(sidebar).toBeHidden();
  } finally {
    await context.close();
    await fixture.close();
    await rm(userDataDir, { force: true, recursive: true });
  }
});
