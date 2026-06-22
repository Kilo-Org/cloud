/* eslint-disable import/no-nodejs-modules, promise/avoid-new, promise/prefer-await-to-callbacks */
import { chromium } from '@playwright/test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

const extensionPath = resolvePath(import.meta.dirname, '../.output/chrome-mv3');

const startFixtureServer = async (): Promise<{ close: () => Promise<void>; url: string }> => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`
      <!doctype html>
      <html>
        <head><title>Kilo extension debug fixture</title></head>
        <body>
          <main>
            <h1>Kilo extension debug fixture</h1>
            <p>This page exists so the extension can be tested next to a normal HTTP tab.</p>
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

const userDataDir = await mkdtemp(join(tmpdir(), 'kilo-extension-debug-'));
const fixture = await startFixtureServer();
await access(join(extensionPath, 'manifest.json'));

const context = await chromium.launchPersistentContext(userDataDir, {
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  headless: false,
});

const [existingServiceWorker] = context.serviceWorkers();
const serviceWorker = existingServiceWorker ?? (await context.waitForEvent('serviceworker'));

const extensionId = new URL(serviceWorker.url()).host;
const fixturePage = await context.newPage();
await fixturePage.goto(fixture.url);

const sidePanelPage = await context.newPage();
await sidePanelPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);

console.log(`Extension ID: ${extensionId}`);
console.log(`Fixture page: ${fixture.url}`);
console.log(`Side panel page: chrome-extension://${extensionId}/sidepanel.html`);
console.log("Click the extension toolbar icon to open Chrome's native side panel.");
console.log('Press Ctrl+C to close the debug browser.');

const cleanup = async (): Promise<void> => {
  await context.close();
  await fixture.close();
  await rm(userDataDir, { force: true, recursive: true });
};

const shutdown = (): void => {
  void (async (): Promise<void> => {
    await cleanup();
    process.exit(0);
  })();
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await new Promise(() => {});
